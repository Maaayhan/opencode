// ============================================================
// registry.ts — 工具注册表（Tool Registry）
//
// 【整体职责】
//   统一管理所有可供 LLM 使用的工具，包括：
//   1. 内置工具（BashTool、ReadTool、EditTool 等）
//   2. 用户自定义工具（从配置目录的 tool/*.ts 或 tools/*.ts 加载）
//   3. 插件提供的工具（Plugin.list() 中的 tool 定义）
//
// 【工具的生命周期】
//   注册 → 初始化（init）→ 过滤（按 model/provider 过滤）→ 交给 prompt.ts 封装
//
// 【与 prompt.ts 的关系】
//   prompt.ts 的 resolveTools() 调用 ToolRegistry.tools() 获取工具列表，
//   然后将每个工具包裹进 AI SDK 的 tool() 函数（添加权限检查、插件钩子等）
// ============================================================

import { QuestionTool } from "./question"
import { BashTool } from "./bash"
import { EditTool } from "./edit"
import { GlobTool } from "./glob"
import { GrepTool } from "./grep"
import { BatchTool } from "./batch"
import { ReadTool } from "./read"
import { TaskTool } from "./task"
import { TodoWriteTool, TodoReadTool } from "./todo"
import { WebFetchTool } from "./webfetch"
import { WriteTool } from "./write"
import { InvalidTool } from "./invalid"
import { SkillTool } from "./skill"
import type { Agent } from "../agent/agent"
import { Tool } from "./tool"
import { Instance } from "../project/instance"
import { Config } from "../config/config"
import path from "path"
import { type ToolContext as PluginToolContext, type ToolDefinition } from "@opencode-ai/plugin"
import z from "zod"
import { Plugin } from "../plugin"
import { WebSearchTool } from "./websearch"
import { CodeSearchTool } from "./codesearch"
import { Flag } from "@/flag/flag"
import { Log } from "@/util/log"
import { LspTool } from "./lsp"
import { Truncate } from "./truncation"
import { PlanExitTool, PlanEnterTool } from "./plan"
import { ApplyPatchTool } from "./apply_patch"
import { Glob } from "../util/glob"

export namespace ToolRegistry {
  const log = Log.create({ service: "tool.registry" })

  /**
   * state — 惰性单例，按项目实例缓存自定义工具列表
   *
   * 初始化时：
   * 1. 扫描配置目录中的 tool/*.ts 和 tools/*.ts 文件
   * 2. 动态 import 这些文件，将导出的 ToolDefinition 转为 Tool.Info
   * 3. 扫描已安装插件，加载插件提供的工具
   */
  export const state = Instance.state(async () => {
    const custom = [] as Tool.Info[]

    // ── 扫描用户自定义工具文件 ────────────────────────────
    // 在所有配置目录（~/.config/opencode、项目 .opencode 等）中查找 tool/*.{js,ts}
    const matches = await Config.directories().then((dirs) =>
      dirs.flatMap((dir) =>
        Glob.scanSync("{tool,tools}/*.{js,ts}", { cwd: dir, absolute: true, dot: true, symlink: true }),
      ),
    )
    // 等待配置中的依赖加载完成（可能有异步初始化）
    if (matches.length) await Config.waitForDependencies()
    for (const match of matches) {
      const namespace = path.basename(match, path.extname(match))  // 取文件名作为命名空间
      const mod = await import(match)
      for (const [id, def] of Object.entries<ToolDefinition>(mod)) {
        // 如果导出名是 "default"，工具 ID 就是文件名；否则是 "文件名_导出名"
        custom.push(fromPlugin(id === "default" ? namespace : `${namespace}_${id}`, def))
      }
    }

    // ── 加载已安装插件的工具 ──────────────────────────────
    const plugins = await Plugin.list()
    for (const plugin of plugins) {
      for (const [id, def] of Object.entries(plugin.tool ?? {})) {
        custom.push(fromPlugin(id, def))
      }
    }

    return { custom }
  })

  /**
   * fromPlugin — 将插件/自定义工具的 ToolDefinition 转换为内部 Tool.Info 格式
   *
   * 主要差异：
   * - Plugin 工具使用 PluginToolContext（含 directory、worktree）
   * - 输出结果自动经过 Truncate.output() 截断（避免超长输出撑爆上下文）
   */
  function fromPlugin(id: string, def: ToolDefinition): Tool.Info {
    return {
      id,
      init: async (initCtx) => ({
        parameters: z.object(def.args),        // 从 ToolDefinition 的 args 构建 zod schema
        description: def.description,
        execute: async (args, ctx) => {
          // 补充 plugin 需要的额外上下文（工作目录和 worktree 路径）
          const pluginCtx = {
            ...ctx,
            directory: Instance.directory,
            worktree: Instance.worktree,
          } as unknown as PluginToolContext
          const result = await def.execute(args as any, pluginCtx)
          // 截断过长的输出（写到临时文件，返回文件路径而不是全文）
          const out = await Truncate.output(result, {}, initCtx?.agent)
          return {
            title: "",
            output: out.truncated ? out.content : result,
            metadata: { truncated: out.truncated, outputPath: out.truncated ? out.outputPath : undefined },
          }
        },
      }),
    }
  }

  /**
   * register — 动态注册一个工具（运行时添加）
   *
   * 如果同名工具已存在则替换，否则追加到末尾。
   * 主要用于测试和插件热加载场景。
   */
  export async function register(tool: Tool.Info) {
    const { custom } = await state()
    const idx = custom.findIndex((t) => t.id === tool.id)
    if (idx >= 0) {
      custom.splice(idx, 1, tool)  // 替换已有工具
      return
    }
    custom.push(tool)
  }

  /**
   * all — 返回所有工具的完整列表（内置 + 自定义）
   *
   * 注意：某些工具有条件启用逻辑：
   * - QuestionTool：只有 app/cli/desktop 客户端或特定 flag 才启用
   * - codesearch/websearch：只有 zen Provider 或 EXA flag 才启用
   * - apply_patch：只对特定 GPT 模型启用（替代 edit/write）
   * - LspTool、BatchTool、PlanExitTool：实验性，需要 flag 开启
   */
  async function all(): Promise<Tool.Info[]> {
    const custom = await state().then((x) => x.custom)
    const config = await Config.get()
    // 只有带 UI 的客户端或明确开启 flag 时才启用 question 工具
    const question = ["app", "cli", "desktop"].includes(Flag.OPENCODE_CLIENT) || Flag.OPENCODE_ENABLE_QUESTION_TOOL

    return [
      InvalidTool,                                        // 工具调用失败时的 fallback 工具
      ...(question ? [QuestionTool] : []),                // 向用户提问的工具
      BashTool,                                           // 执行 shell 命令
      ReadTool,                                           // 读取文件内容
      GlobTool,                                           // 文件名模式匹配
      GrepTool,                                           // 文本内容搜索
      EditTool,                                           // 编辑文件（字符串替换）
      WriteTool,                                          // 写入/创建文件
      TaskTool,                                           // 派发子 Agent 任务
      WebFetchTool,                                       // 获取网页内容
      TodoWriteTool,                                      // 写入 Todo 任务列表
      // TodoReadTool,                                    // 已暂时禁用
      WebSearchTool,                                      // 网络搜索（需要 zen 或 EXA）
      CodeSearchTool,                                     // 语义代码搜索（需要 zen 或 EXA）
      SkillTool,                                          // 执行 skill（预定义的提示词模板）
      ApplyPatchTool,                                     // 应用 unified diff patch（GPT 系列专用）
      ...(Flag.OPENCODE_EXPERIMENTAL_LSP_TOOL ? [LspTool] : []),           // LSP 工具（实验性）
      ...(config.experimental?.batch_tool === true ? [BatchTool] : []),     // 批量工具（实验性）
      ...(Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE && Flag.OPENCODE_CLIENT === "cli" ? [PlanExitTool, PlanEnterTool] : []),
      ...custom,                                          // 用户自定义工具（排在最后）
    ]
  }

  /** 返回所有工具的 ID 列表 */
  export async function ids() {
    return all().then((x) => x.map((t) => t.id))
  }

  /**
   * tools — 获取针对特定模型和 Agent 初始化好的工具列表
   *
   * @param model  - 当前使用的模型（用于按 provider/model 过滤工具）
   * @param agent  - 当前使用的 Agent（传给工具的 init 上下文）
   * @returns 初始化好的工具对象数组（含 description、parameters、execute）
   *
   * 过滤逻辑：
   * - codesearch/websearch：只对 zen Provider 或启用了 EXA 的情况开放
   * - apply_patch：只对使用 apply_patch 格式的 GPT 模型开放
   * - edit/write：当模型使用 apply_patch 时禁用（二选一）
   */
  export async function tools(
    model: {
      providerID: string
      modelID: string
    },
    agent?: Agent.Info,
  ) {
    const tools = await all()
    const result = await Promise.all(
      tools
        .filter((t) => {
          // zen Provider 专属工具（或明确启用 EXA 搜索）
          if (t.id === "codesearch" || t.id === "websearch") {
            return model.providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
          }

          // GPT 系列（非 OSS、非 gpt-4 旧版）使用 apply_patch 替代 edit/write
          const usePatch =
            model.modelID.includes("gpt-") && !model.modelID.includes("oss") && !model.modelID.includes("gpt-4")
          if (t.id === "apply_patch") return usePatch
          if (t.id === "edit" || t.id === "write") return !usePatch

          return true
        })
        .map(async (t) => {
          using _ = log.time(t.id)  // 记录每个工具 init 耗时（性能监控）
          // 初始化工具（传入 agent 上下文，某些工具会根据 agent 调整行为）
          const tool = await t.init({ agent })
          const output = {
            description: tool.description,
            parameters: tool.parameters,
          }
          // 允许插件修改工具的描述和参数 schema
          await Plugin.trigger("tool.definition", { toolID: t.id }, output)
          return {
            id: t.id,
            ...tool,
            description: output.description,
            parameters: output.parameters,
          }
        }),
    )
    return result
  }
}
