// ============================================================
// llm.ts — LLM 流式调用层（LLM Streaming Layer）
//
// 【整体职责】
//   封装与 LLM Provider（Anthropic、OpenAI、Gemini 等）的实际通信。
//   对外暴露一个统一的 LLM.stream() 函数，屏蔽不同 Provider 的差异。
//
// 【主要功能】
//   1. 组装系统提示词（agent prompt + system env + 用户自定义 system）
//   2. 合并模型参数（temperature、topP、providerOptions 等）
//   3. 处理特殊 Provider（OpenAI OAuth/Codex、LiteLLM 代理）
//   4. 将所有工具（内置工具 + MCP 工具）注册到 streamText 调用中
//   5. 工具调用失败时自动修复（小写化工具名、fallback 到 invalid 工具）
//
// 【与 processor.ts 的关系】
//   llm.ts 负责"建立连接和发送请求"
//   processor.ts 负责"消费 llm.ts 返回的流，处理每个事件"
// ============================================================

import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
} from "ai"
import { mergeDeep, pipe } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Config } from "@/config/config"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { PermissionNext } from "@/permission/next"
import { Auth } from "@/auth"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  // 最大输出 token 数（从 ProviderTransform 取，不同模型不同）
  export const OUTPUT_TOKEN_MAX = ProviderTransform.OUTPUT_TOKEN_MAX

  /**
   * StreamInput — 调用 LLM 流式接口所需的完整参数
   */
  export type StreamInput = {
    user: MessageV2.User        // 触发本次调用的用户消息（用于获取 variant、format 等）
    sessionID: string           // 当前会话 ID（用于日志和 header 透传）
    model: Provider.Model       // 使用的模型（包含 providerID、modelID 等）
    agent: Agent.Info           // 当前使用的 Agent（决定提示词、权限、温度等）
    system: string[]            // 额外注入的系统提示词数组
    abort: AbortSignal          // 取消信号
    messages: ModelMessage[]    // 已转换为 AI SDK 格式的历史消息
    small?: boolean             // 是否使用"小模型"模式（用于摘要等轻量任务）
    tools: Record<string, Tool> // 已初始化好的工具 map（tool id → AI SDK Tool 对象）
    retries?: number            // 最大重试次数（默认 0，不重试）
    toolChoice?: "auto" | "required" | "none"  // 工具调用策略
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  /**
   * stream — 向 LLM 发起流式请求，返回 AI SDK 的 StreamTextResult
   *
   * 调用者（processor.ts）通过迭代 result.fullStream 来消费事件。
   */
  export async function stream(input: StreamInput) {
    // 创建带有上下文标签的日志实例（方便调试时定位是哪个 session/model/agent）
    const l = log
      .clone()
      .tag("providerID", input.model.providerID)
      .tag("modelID", input.model.id)
      .tag("sessionID", input.sessionID)
      .tag("small", (input.small ?? false).toString())
      .tag("agent", input.agent.name)
      .tag("mode", input.agent.mode)
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })

    // 并行获取所有依赖数据（减少等待时间）
    const [language, cfg, provider, auth] = await Promise.all([
      Provider.getLanguage(input.model),   // 获取 AI SDK 语言模型对象
      Config.get(),                         // 全局配置（用于 telemetry）
      Provider.getProvider(input.model.providerID), // provider 配置（含自定义 headers 等）
      Auth.get(input.model.providerID),    // 认证信息（区分 OAuth vs API Key）
    ])
    // OpenAI OAuth = GitHub Copilot / Codex 模式（特殊处理）
    const isCodex = provider.id === "openai" && auth?.type === "oauth"

    // ── 系统提示词组装 ─────────────────────────────────────
    // 按优先级合并：agent prompt > provider prompt > 额外 system > 用户 system
    const system = []
    system.push(
      [
        // agent.prompt 存在时用 agent 自定义提示词，否则用 provider 默认提示词
        // Codex 模式下跳过 provider prompt（会通过 options.instructions 发送）
        ...(input.agent.prompt ? [input.agent.prompt] : isCodex ? [] : SystemPrompt.provider(input.model)),
        // 额外注入的 system 提示词（如 STRUCTURED_OUTPUT_SYSTEM_PROMPT）
        ...input.system,
        // 用户在本次消息中附带的自定义 system
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    // 允许插件转换系统提示词（实验性功能）
    const header = system[0]
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    // 维持 2-part 结构以利用 Anthropic 的提示词缓存（cache_control）
    // 只有当 header 未被插件修改时才合并
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    // ── 模型参数组装（优先级从低到高：base < model.options < agent.options < variant）──
    // variant 是模型的特殊变体配置（如 "extended-thinking"）
    const variant =
      !input.small && input.model.variants && input.user.variant ? input.model.variants[input.user.variant] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)   // 小模型：精简参数
      : ProviderTransform.options({                    // 正常模式：完整参数
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    // 用 mergeDeep 层层合并（后面的覆盖前面的）
    const options: Record<string, any> = pipe(
      base,
      mergeDeep(input.model.options),
      mergeDeep(input.agent.options),
      mergeDeep(variant),
    )
    // Codex 特殊：instructions 通过 options 字段传递（而不是 system message）
    if (isCodex) {
      options.instructions = SystemPrompt.instructions()
    }

    // 允许插件修改聊天参数（temperature、topP、topK 等）
    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    // 允许插件添加自定义 HTTP headers
    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    // Codex 和 GitHub Copilot 不限制输出 token（由平台侧管理）
    const maxOutputTokens =
      isCodex || provider.id.includes("github-copilot") ? undefined : ProviderTransform.maxOutputTokens(input.model)

    // 解析工具（根据 agent 权限过滤掉被禁用的工具）
    const tools = await resolveTools(input)

    // ── LiteLLM 代理兼容处理 ──────────────────────────────
    // LiteLLM 和某些 Anthropic 代理要求：
    // 如果消息历史中有工具调用记录，即使当前不需要工具，也必须传 tools 参数
    // 解决方案：添加一个永远不会被调用的 dummy tool
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    // ── 调用 AI SDK streamText ──────────────────────────────
    return streamText({
      onError(error) {
        l.error("stream error", {
          error,
        })
      },

      /**
       * experimental_repairToolCall — 工具调用自动修复
       *
       * 当 LLM 调用了一个不存在的工具时尝试修复：
       * 1. 如果工具名大小写不对（如 "Read" 应为 "read"），自动转小写
       * 2. 否则替换为 "invalid" 工具，向 LLM 报告错误
       */
      async experimental_repairToolCall(failed) {
        const lower = failed.toolCall.toolName.toLowerCase()
        if (lower !== failed.toolCall.toolName && tools[lower]) {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: lower,
          })
          return {
            ...failed.toolCall,
            toolName: lower,
          }
        }
        return {
          ...failed.toolCall,
          input: JSON.stringify({
            tool: failed.toolCall.toolName,
            error: failed.error.message,
          }),
          toolName: "invalid",  // fallback 到 invalid 工具
        }
      },

      // 模型参数
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),

      // 工具相关参数
      activeTools: Object.keys(tools).filter((x) => x !== "invalid"),  // 对 LLM 可见的工具（排除 invalid）
      tools,
      toolChoice: input.toolChoice,

      // 其他参数
      maxOutputTokens,
      abortSignal: input.abort,

      // ── HTTP 请求头 ──────────────────────────────────────
      headers: {
        // opencode 专用 Provider（zen）附加特殊追踪 header
        ...(input.model.providerID.startsWith("opencode")
          ? {
              "x-opencode-project": Instance.project.id,
              "x-opencode-session": input.sessionID,
              "x-opencode-request": input.user.id,
              "x-opencode-client": Flag.OPENCODE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `opencode/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,  // 默认不自动重试（由 processor.ts 手动管理重试）

      // 消息列表：system message + 历史对话
      messages: [
        ...system.map(
          (x): ModelMessage => ({
            role: "system",
            content: x,
          }),
        ),
        ...input.messages,
      ],

      // 通过 middleware 转换消息格式（处理不同 Provider 的特殊消息格式要求）
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              if (args.type === "stream") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
          },
        ],
      }),

      // OpenTelemetry 遥测（实验性功能，需在配置中启用）
      experimental_telemetry: {
        isEnabled: cfg.experimental?.openTelemetry,
        metadata: {
          userId: cfg.username ?? "unknown",
          sessionId: input.sessionID,
        },
      },
    })
  }

  /**
   * resolveTools — 根据 Agent 权限规则过滤工具
   *
   * 将被禁用的工具从 tools 对象中删除，
   * 确保 LLM 看不到它没有权限使用的工具。
   */
  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    // 找出在当前 agent 权限中被 deny 的工具
    const disabled = PermissionNext.disabled(Object.keys(input.tools), input.agent.permission)
    for (const tool of Object.keys(input.tools)) {
      // 用户消息级别禁用 或 agent 权限级别禁用 → 从工具 map 中删除
      if (input.user.tools?.[tool] === false || disabled.has(tool)) {
        delete input.tools[tool]
      }
    }
    return input.tools
  }

  /**
   * hasToolCalls — 检查消息历史中是否包含工具调用记录
   *
   * 用于判断是否需要为 LiteLLM 代理添加 dummy tool。
   */
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }
}
