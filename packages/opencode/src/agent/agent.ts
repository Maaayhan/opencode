// ============================================================
// agent.ts — Agent（代理）系统的核心定义文件
//
// 【整体职责】
//   负责定义并管理所有"Agent"（代理）的配置。
//   一个 Agent 就是 AI 的一种"角色"或"运行模式"，
//   不同 Agent 有不同的权限规则、系统提示词、模型选择等。
//
// 【内置 Agent 一览】
//   - build   : 默认 Agent，可使用绝大多数工具，可进入 plan 模式
//   - plan    : 计划模式，禁止所有编辑工具
//   - general : 通用子 Agent，可并行执行多个任务
//   - explore : 只读探索 Agent，只能搜索/读取文件
//   - compaction / title / summary : 内部隐藏 Agent，用于上下文压缩、标题生成、摘要
// ============================================================

import { Config } from "../config/config"
import z from "zod"
import { Provider } from "../provider/provider"
import { generateObject, streamObject, type ModelMessage } from "ai"
import { SystemPrompt } from "../session/system"
import { Instance } from "../project/instance"
import { Truncate } from "../tool/truncation"
import { Auth } from "../auth"
import { ProviderTransform } from "../provider/transform"

// 导入各 Agent 用到的系统提示词文本（从 .txt 文件读取）
import PROMPT_GENERATE from "./generate.txt"
import PROMPT_COMPACTION from "./prompt/compaction.txt"
import PROMPT_EXPLORE from "./prompt/explore.txt"
import PROMPT_SUMMARY from "./prompt/summary.txt"
import PROMPT_TITLE from "./prompt/title.txt"
import { PermissionNext } from "@/permission/next"
import { mergeDeep, pipe, sortBy, values } from "remeda"
import { Global } from "@/global"
import path from "path"
import { Plugin } from "@/plugin"
import { Skill } from "../skill"

export namespace Agent {
  // ──────────────────────────────────────────────
  // Agent.Info — 描述一个 Agent 的完整配置结构
  // ──────────────────────────────────────────────
  export const Info = z
    .object({
      name: z.string(),                              // Agent 的唯一标识名（如 "build", "plan"）
      description: z.string().optional(),           // 对用户展示的描述文字
      mode: z.enum(["subagent", "primary", "all"]), // 运行模式：primary=主 Agent，subagent=子 Agent，all=两者均可
      native: z.boolean().optional(),               // 是否为内置（系统自带）Agent
      hidden: z.boolean().optional(),               // 是否对用户隐藏（内部使用的 Agent）
      topP: z.number().optional(),                  // LLM 参数：nucleus sampling 概率阈值
      temperature: z.number().optional(),           // LLM 参数：输出随机性（0=确定性最高）
      color: z.string().optional(),                 // UI 颜色（在终端界面显示）
      permission: PermissionNext.Ruleset,           // 权限规则集：决定哪些操作被允许/拒绝/询问
      model: z
        .object({
          modelID: z.string(),
          providerID: z.string(),
        })
        .optional(),                                // 指定特定模型（不指定则用用户默认模型）
      variant: z.string().optional(),              // 模型变体（如 "fast", "extended-thinking"）
      prompt: z.string().optional(),               // 覆盖默认系统提示词的自定义提示词
      options: z.record(z.string(), z.any()),      // 透传给 Provider 的额外选项
      steps: z.number().int().positive().optional(), // 最大工具调用步数（不设则无限）
    })
    .meta({
      ref: "Agent",
    })
  export type Info = z.infer<typeof Info>

  // ──────────────────────────────────────────────
  // state — 惰性单例，按 Instance（项目实例）缓存所有 Agent 的配置
  // Instance.state 确保同一个项目只初始化一次
  // ──────────────────────────────────────────────
  const state = Instance.state(async () => {
    const cfg = await Config.get()

    // 获取所有 skill 目录，用于白名单权限（允许访问 skill 文件）
    const skillDirs = await Skill.dirs()
    const whitelistedDirs = [Truncate.GLOB, ...skillDirs.map((dir) => path.join(dir, "*"))]

    // ──────────────────────────────────────────────
    // defaults — 所有 Agent 共享的默认权限规则
    // 优先级从上到下，后面的 merge 会覆盖前面的规则
    // ──────────────────────────────────────────────
    const defaults = PermissionNext.fromConfig({
      "*": "allow",                    // 默认允许所有操作
      doom_loop: "ask",                // 检测到死循环时需询问用户
      external_directory: {
        "*": "ask",                    // 访问项目外部目录时询问
        ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
      },
      question: "deny",                // 默认禁止 question 工具（需明确允许才可用）
      plan_enter: "deny",              // 默认禁止进入 plan 模式
      plan_exit: "deny",               // 默认禁止退出 plan 模式
      // 参照 github.com/github/gitignore Node.gitignore 的 .env 文件规则
      read: {
        "*": "allow",
        "*.env": "ask",                // 读取 .env 文件时询问用户
        "*.env.*": "ask",
        "*.env.example": "allow",      // .env.example 是示例文件，直接允许
      },
    })
    // 用户在配置文件中自定义的权限规则（优先级最高）
    const user = PermissionNext.fromConfig(cfg.permission ?? {})

    // ──────────────────────────────────────────────
    // 内置 Agent 定义
    // ──────────────────────────────────────────────
    const result: Record<string, Info> = {
      // ── build：默认的主 Agent ──
      // 可以使用所有工具，包括 question 工具和 plan_enter
      build: {
        name: "build",
        description: "The default agent. Executes tools based on configured permissions.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",    // 允许 question 工具（可向用户提问）
            plan_enter: "allow",  // 允许进入 plan 模式
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },

      // ── plan：计划模式 Agent ──
      // 只能读取/搜索，不能编辑代码（除了特定的 plans 目录下的 .md 文件）
      plan: {
        name: "plan",
        description: "Plan mode. Disallows all edit tools.",
        options: {},
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            question: "allow",
            plan_exit: "allow",  // 允许退出 plan 模式
            external_directory: {
              [path.join(Global.Path.data, "plans", "*")]: "allow",
            },
            edit: {
              "*": "deny",       // 禁止编辑所有文件
              // 只允许编辑 plans 目录下的 markdown 文件
              [path.join(".opencode", "plans", "*.md")]: "allow",
              [path.relative(Instance.worktree, path.join(Global.Path.data, path.join("plans", "*.md")))]: "allow",
            },
          }),
          user,
        ),
        mode: "primary",
        native: true,
      },

      // ── general：通用子 Agent ──
      // 专用于被 TaskTool 调度，可并行执行多个研究/任务单元
      // 禁用 todo 工具（避免干扰主 Agent 的任务列表）
      general: {
        name: "general",
        description: `General-purpose agent for researching complex questions and executing multi-step tasks. Use this agent to execute multiple units of work in parallel.`,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            todoread: "deny",
            todowrite: "deny",
          }),
          user,
        ),
        options: {},
        mode: "subagent",
        native: true,
      },

      // ── explore：只读探索 Agent ──
      // 专门用于快速搜索代码库，只开放读取/搜索类工具
      // 明确关闭了所有写入/编辑工具
      explore: {
        name: "explore",
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",          // 默认禁止所有
            grep: "allow",        // 文本搜索
            glob: "allow",        // 文件名匹配
            list: "allow",        // 列出文件
            bash: "allow",        // 命令执行（用于搜索）
            webfetch: "allow",    // 获取网页
            websearch: "allow",   // 网络搜索
            codesearch: "allow",  // 代码语义搜索
            read: "allow",        // 读取文件
            external_directory: {
              "*": "ask",
              ...Object.fromEntries(whitelistedDirs.map((dir) => [dir, "allow"])),
            },
          }),
          user,
        ),
        description: `Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (eg. "src/components/**/*.tsx"), search code for keywords (eg. "API endpoints"), or answer questions about the codebase (eg. "how do API endpoints work?"). When calling this agent, specify the desired thoroughness level: "quick" for basic searches, "medium" for moderate exploration, or "very thorough" for comprehensive analysis across multiple locations and naming conventions.`,
        prompt: PROMPT_EXPLORE,
        options: {},
        mode: "subagent",
        native: true,
      },

      // ── compaction：上下文压缩 Agent（隐藏）──
      // 当会话上下文接近模型 token 限制时，自动触发压缩
      // 禁止使用任何工具（纯文本摘要任务）
      compaction: {
        name: "compaction",
        mode: "primary",
        native: true,
        hidden: true,           // 对用户不可见
        prompt: PROMPT_COMPACTION,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",        // 禁止所有工具
          }),
          user,
        ),
        options: {},
      },

      // ── title：标题生成 Agent（隐藏）──
      // 根据会话内容自动生成会话标题
      title: {
        name: "title",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        temperature: 0.5,       // 稍高的随机性，使标题更多样
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_TITLE,
      },

      // ── summary：摘要生成 Agent（隐藏）──
      // 为每次用户消息生成简短摘要，用于 UI 显示
      summary: {
        name: "summary",
        mode: "primary",
        options: {},
        native: true,
        hidden: true,
        permission: PermissionNext.merge(
          defaults,
          PermissionNext.fromConfig({
            "*": "deny",
          }),
          user,
        ),
        prompt: PROMPT_SUMMARY,
      },
    }

    // ──────────────────────────────────────────────
    // 合并用户在配置文件（opencode.json）中自定义的 Agent
    // 用户可以：禁用内置 Agent、修改内置 Agent 配置、新建自定义 Agent
    // ──────────────────────────────────────────────
    for (const [key, value] of Object.entries(cfg.agent ?? {})) {
      if (value.disable) {
        // 用户明确禁用此 Agent，从结果中删除
        delete result[key]
        continue
      }
      let item = result[key]
      if (!item)
        // 不存在时创建新 Agent（用户自定义 Agent）
        item = result[key] = {
          name: key,
          mode: "all",
          permission: PermissionNext.merge(defaults, user),
          options: {},
          native: false,
        }
      // 依次合并用户配置（用户配置优先级高于内置默认值）
      if (value.model) item.model = Provider.parseModel(value.model)
      item.variant = value.variant ?? item.variant
      item.prompt = value.prompt ?? item.prompt
      item.description = value.description ?? item.description
      item.temperature = value.temperature ?? item.temperature
      item.topP = value.top_p ?? item.topP
      item.mode = value.mode ?? item.mode
      item.color = value.color ?? item.color
      item.hidden = value.hidden ?? item.hidden
      item.name = value.name ?? item.name
      item.steps = value.steps ?? item.steps
      item.options = mergeDeep(item.options, value.options ?? {})
      item.permission = PermissionNext.merge(item.permission, PermissionNext.fromConfig(value.permission ?? {}))
    }

    // ──────────────────────────────────────────────
    // 最终保证：确保 Truncate.GLOB（截断输出文件目录）始终被允许访问
    // 除非用户明确配置了 deny
    // ──────────────────────────────────────────────
    for (const name in result) {
      const agent = result[name]
      const explicit = agent.permission.some((r) => {
        if (r.permission !== "external_directory") return false
        if (r.action !== "deny") return false
        return r.pattern === Truncate.GLOB
      })
      if (explicit) continue

      result[name].permission = PermissionNext.merge(
        result[name].permission,
        PermissionNext.fromConfig({ external_directory: { [Truncate.GLOB]: "allow" } }),
      )
    }

    return result
  })

  // ──────────────────────────────────────────────
  // 公开 API
  // ──────────────────────────────────────────────

  /** 根据名称获取单个 Agent 配置 */
  export async function get(agent: string) {
    return state().then((x) => x[agent])
  }

  /**
   * 获取所有可用 Agent 列表
   * 默认 Agent（cfg.default_agent 或 "build"）排在最前面
   */
  export async function list() {
    const cfg = await Config.get()
    return pipe(
      await state(),
      values(),
      sortBy([(x) => (cfg.default_agent ? x.name === cfg.default_agent : x.name === "build"), "desc"]),
    )
  }

  /**
   * 获取默认 Agent 的名称
   * 规则：优先使用 config.default_agent，其次找第一个 primary+可见的 Agent
   */
  export async function defaultAgent() {
    const cfg = await Config.get()
    const agents = await state()

    if (cfg.default_agent) {
      const agent = agents[cfg.default_agent]
      if (!agent) throw new Error(`default agent "${cfg.default_agent}" not found`)
      if (agent.mode === "subagent") throw new Error(`default agent "${cfg.default_agent}" is a subagent`)
      if (agent.hidden === true) throw new Error(`default agent "${cfg.default_agent}" is hidden`)
      return agent.name
    }

    const primaryVisible = Object.values(agents).find((a) => a.mode !== "subagent" && a.hidden !== true)
    if (!primaryVisible) throw new Error("no primary visible agent found")
    return primaryVisible.name
  }

  /**
   * generate — 用 AI 生成一个新的 Agent 配置
   *
   * 根据用户提供的描述，让 LLM 输出一个结构化的 Agent 配置对象
   * （包含 identifier、whenToUse、systemPrompt 三个字段）
   *
   * 支持两种模式：
   * - 普通模式：调用 generateObject（同步生成）
   * - OpenAI OAuth 模式：调用 streamObject（流式生成）
   */
  export async function generate(input: { description: string; model?: { providerID: string; modelID: string } }) {
    const cfg = await Config.get()
    const defaultModel = input.model ?? (await Provider.defaultModel())
    const model = await Provider.getModel(defaultModel.providerID, defaultModel.modelID)
    const language = await Provider.getLanguage(model)

    const system = [PROMPT_GENERATE]
    await Plugin.trigger("experimental.chat.system.transform", { model }, { system })
    const existing = await list()

    const params = {
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
        },
      },
      temperature: 0.3,
      messages: [
        ...system.map(
          (item): ModelMessage => ({
            role: "system",
            content: item,
          }),
        ),
        {
          role: "user",
          content: `Create an agent configuration based on this request: \"${input.description}\".\n\nIMPORTANT: The following identifiers already exist and must NOT be used: ${existing.map((i) => i.name).join(", ")}\n  Return ONLY the JSON object, no other text, do not wrap in backticks`,
        },
      ],
      model: language,
      schema: z.object({
        identifier: z.string(),
        whenToUse: z.string(),
        systemPrompt: z.string(),
      }),
    } satisfies Parameters<typeof generateObject>[0]

    // OpenAI OAuth（Codex）使用 streamObject 模式
    if (defaultModel.providerID === "openai" && (await Auth.get(defaultModel.providerID))?.type === "oauth") {
      const result = streamObject({
        ...params,
        providerOptions: ProviderTransform.providerOptions(model, {
          instructions: SystemPrompt.instructions(),
          store: false,
        }),
        onError: () => {},
      })
      for await (const part of result.fullStream) {
        if (part.type === "error") throw part.error
      }
      return result.object
    }

    // 标准模式：直接生成对象
    const result = await generateObject(params)
    return result.object
  }
}
