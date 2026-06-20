// ============================================================
// processor.ts — 会话流式处理器（SessionProcessor）
//
// 【整体职责】
//   负责消费来自 LLM 的流式输出（stream），并将每一个事件
//   实时持久化到数据库（通过 Session.updatePart）。
//
// 【核心流程】
//   1. LLM.stream() 发出一连串事件（text, reasoning, tool-call 等）
//   2. SessionProcessor.process() 用 for-await 逐一处理这些事件
//   3. 每种事件对应不同的副作用：创建/更新消息"片段"(Part)
//   4. 遇到可重试错误则自动等待后重试
//   5. 最终返回 "continue" / "stop" / "compact" 三种信号
//      给外层 loop（prompt.ts）决定下一步行为
//
// 【死循环检测（Doom Loop）】
//   连续 3 次相同工具+相同参数 → 触发权限询问，让用户决定是否继续
// ============================================================

import { MessageV2 } from "./message-v2"
import { Log } from "@/util/log"
import { Identifier } from "@/id/id"
import { Session } from "."
import { Agent } from "@/agent/agent"
import { Snapshot } from "@/snapshot"
import { SessionSummary } from "./summary"
import { Bus } from "@/bus"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { Plugin } from "@/plugin"
import type { Provider } from "@/provider/provider"
import { LLM } from "./llm"
import { Config } from "@/config/config"
import { SessionCompaction } from "./compaction"
import { PermissionNext } from "@/permission/next"
import { Question } from "@/question"

export namespace SessionProcessor {
  // 连续同样工具调用多少次算作"死循环"（Doom Loop）
  const DOOM_LOOP_THRESHOLD = 3
  const log = Log.create({ service: "session.processor" })

  export type Info = Awaited<ReturnType<typeof create>>
  export type Result = Awaited<ReturnType<Info["process"]>>

  /**
   * create — 工厂函数，为"一条 assistant 消息"创建一个处理器实例
   *
   * @param assistantMessage - 本次 LLM 回复对应的消息对象（已预先创建）
   * @param sessionID        - 所属会话 ID
   * @param model            - 使用的模型信息（用于计算 token 费用）
   * @param abort            - 取消信号（用户点击停止时触发）
   */
  export function create(input: {
    assistantMessage: MessageV2.Assistant
    sessionID: string
    model: Provider.Model
    abort: AbortSignal
  }) {
    // ── 内部状态 ──────────────────────────────────────────
    const toolcalls: Record<string, MessageV2.ToolPart> = {}  // 正在进行的工具调用，key=callID
    let snapshot: string | undefined  // 当前 step 开始前的文件快照（用于 diff）
    let blocked = false               // 是否因权限拒绝而需要停止循环
    let attempt = 0                   // 当前重试次数
    let needsCompaction = false       // 是否需要触发上下文压缩

    const result = {
      /** 获取当前正在处理的 assistant 消息对象 */
      get message() {
        return input.assistantMessage
      },
      /** 根据 tool call ID 获取对应的工具调用 Part */
      partFromToolCall(toolCallID: string) {
        return toolcalls[toolCallID]
      },

      /**
       * process — 主处理函数，消费 LLM 流直到结束
       *
       * 返回值（决定 loop 的下一步行为）：
       * - "continue"  : 正常结束，继续下一轮对话循环
       * - "stop"      : 因权限拒绝或错误，停止整个循环
       * - "compact"   : 上下文溢出，需要先压缩再继续
       */
      async process(streamInput: LLM.StreamInput) {
        log.info("process")
        needsCompaction = false
        // 配置：权限被拒绝时是否继续循环（默认停止）
        const shouldBreak = (await Config.get()).experimental?.continue_loop_on_deny !== true

        // ── 重试循环 ──────────────────────────────────────
        // 正常情况只跑一次；遇到可重试错误（网络超时、速率限制等）会重新进入
        while (true) {
          try {
            let currentText: MessageV2.TextPart | undefined          // 当前正在积累的文本片段
            let reasoningMap: Record<string, MessageV2.ReasoningPart> = {}  // 正在积累的推理片段

            // 启动 LLM 流
            const stream = await LLM.stream(streamInput)

            // ── 逐事件处理 ──────────────────────────────
            for await (const value of stream.fullStream) {
              // 检查取消信号，如果用户已取消则抛出异常跳出
              input.abort.throwIfAborted()

              switch (value.type) {
                // ── 流开始 ──
                case "start":
                  // 将会话状态设为"忙碌"，通知 UI
                  SessionStatus.set(input.sessionID, { type: "busy" })
                  break

                // ── 推理文本开始（CoT / 思维链）──
                // 某些模型（如 claude-3-7-sonnet extended-thinking）会先输出推理过程
                case "reasoning-start":
                  if (value.id in reasoningMap) {
                    continue
                  }
                  const reasoningPart = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "reasoning" as const,
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  reasoningMap[value.id] = reasoningPart
                  // 立即写入数据库（创建空的 reasoning part）
                  await Session.updatePart(reasoningPart)
                  break

                // ── 推理文本增量更新 ──
                case "reasoning-delta":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text += value.text  // 拼接新增文本
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    // 只发送增量，避免每次写全量（性能优化）
                    await Session.updatePartDelta({
                      sessionID: part.sessionID,
                      messageID: part.messageID,
                      partID: part.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                // ── 推理文本结束 ──
                case "reasoning-end":
                  if (value.id in reasoningMap) {
                    const part = reasoningMap[value.id]
                    part.text = part.text.trimEnd()  // 去掉末尾空白
                    part.time = {
                      ...part.time,
                      end: Date.now(),
                    }
                    if (value.providerMetadata) part.metadata = value.providerMetadata
                    await Session.updatePart(part)
                    delete reasoningMap[value.id]
                  }
                  break

                // ── 工具调用开始（LLM 开始输出工具名和参数）──
                // 此时参数还没完整，先创建一个 pending 状态的 ToolPart
                case "tool-input-start":
                  const part = await Session.updatePart({
                    id: toolcalls[value.id]?.id ?? Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "tool",
                    tool: value.toolName,
                    callID: value.id,
                    state: {
                      status: "pending",  // 等待参数输入完成
                      input: {},
                      raw: "",
                    },
                  })
                  toolcalls[value.id] = part as MessageV2.ToolPart
                  break

                // ── 工具参数增量（流式参数，目前不处理）──
                case "tool-input-delta":
                  break

                // ── 工具参数结束（目前不处理）──
                case "tool-input-end":
                  break

                // ── 工具调用完整触发（参数已完整，开始执行）──
                case "tool-call": {
                  const match = toolcalls[value.toolCallId]
                  if (match) {
                    // 将 ToolPart 状态从 pending 更新为 running
                    const part = await Session.updatePart({
                      ...match,
                      tool: value.toolName,
                      state: {
                        status: "running",
                        input: value.input,
                        time: {
                          start: Date.now(),
                        },
                      },
                      metadata: value.providerMetadata,
                    })
                    toolcalls[value.toolCallId] = part as MessageV2.ToolPart

                    // ── 死循环检测 ──────────────────────────
                    // 查看当前消息的最后 3 个 Part
                    const parts = await MessageV2.parts(input.assistantMessage.id)
                    const lastThree = parts.slice(-DOOM_LOOP_THRESHOLD)

                    if (
                      lastThree.length === DOOM_LOOP_THRESHOLD &&
                      lastThree.every(
                        (p) =>
                          p.type === "tool" &&
                          p.tool === value.toolName &&
                          p.state.status !== "pending" &&
                          // 参数完全相同（深度比较）→ 确认是死循环
                          JSON.stringify(p.state.input) === JSON.stringify(value.input),
                      )
                    ) {
                      // 向用户发出权限询问，让用户决定是否继续
                      const agent = await Agent.get(input.assistantMessage.agent)
                      await PermissionNext.ask({
                        permission: "doom_loop",
                        patterns: [value.toolName],
                        sessionID: input.assistantMessage.sessionID,
                        metadata: {
                          tool: value.toolName,
                          input: value.input,
                        },
                        always: [value.toolName],
                        ruleset: agent.permission,
                      })
                    }
                  }
                  break
                }

                // ── 工具调用结果返回 ──
                case "tool-result": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    // 将 ToolPart 状态更新为 completed，写入输出结果
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "completed",
                        input: value.input ?? match.state.input,
                        output: value.output.output,
                        metadata: value.output.metadata,
                        title: value.output.title,
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                        attachments: value.output.attachments,
                      },
                    })
                    // 从追踪 map 中移除（已完成）
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                // ── 工具调用出错 ──
                case "tool-error": {
                  const match = toolcalls[value.toolCallId]
                  if (match && match.state.status === "running") {
                    // 将 ToolPart 状态更新为 error
                    await Session.updatePart({
                      ...match,
                      state: {
                        status: "error",
                        input: value.input ?? match.state.input,
                        error: (value.error as any).toString(),
                        time: {
                          start: match.state.time.start,
                          end: Date.now(),
                        },
                      },
                    })

                    // 权限拒绝或用户拒绝提问 → 标记为需要停止循环
                    if (
                      value.error instanceof PermissionNext.RejectedError ||
                      value.error instanceof Question.RejectedError
                    ) {
                      blocked = shouldBreak
                    }
                    delete toolcalls[value.toolCallId]
                  }
                  break
                }

                // ── 流级别错误（抛出让外层 catch 处理）──
                case "error":
                  throw value.error

                // ── 一个"步骤"开始（AI SDK 的多步骤工具调用机制）──
                // 每个 step 对应一次 LLM 调用（可以包含多个并行工具调用）
                case "start-step":
                  // 在步骤开始时为当前文件状态创建快照（用于后续 diff）
                  snapshot = await Snapshot.track()
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.sessionID,
                    snapshot,
                    type: "step-start",
                  })
                  break

                // ── 一个"步骤"结束 ──
                case "finish-step":
                  // 计算本次 step 消耗的 token 和费用
                  const usage = Session.getUsage({
                    model: input.model,
                    usage: value.usage,
                    metadata: value.providerMetadata,
                  })
                  input.assistantMessage.finish = value.finishReason
                  input.assistantMessage.cost += usage.cost
                  input.assistantMessage.tokens = usage.tokens
                  // 写入 step-finish Part（记录本步骤的 token 消耗）
                  await Session.updatePart({
                    id: Identifier.ascending("part"),
                    reason: value.finishReason,
                    snapshot: await Snapshot.track(),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "step-finish",
                    tokens: usage.tokens,
                    cost: usage.cost,
                  })
                  await Session.updateMessage(input.assistantMessage)
                  // 如果有文件变化，生成 patch Part（用于 UI 显示变更 diff）
                  if (snapshot) {
                    const patch = await Snapshot.patch(snapshot)
                    if (patch.files.length) {
                      await Session.updatePart({
                        id: Identifier.ascending("part"),
                        messageID: input.assistantMessage.id,
                        sessionID: input.sessionID,
                        type: "patch",
                        hash: patch.hash,
                        files: patch.files,
                      })
                    }
                    snapshot = undefined
                  }
                  // 触发摘要生成（异步，不阻塞主流程）
                  SessionSummary.summarize({
                    sessionID: input.sessionID,
                    messageID: input.assistantMessage.parentID,
                  })
                  // 检查上下文是否即将溢出
                  if (await SessionCompaction.isOverflow({ tokens: usage.tokens, model: input.model })) {
                    needsCompaction = true
                  }
                  break

                // ── 文本输出开始 ──
                case "text-start":
                  currentText = {
                    id: Identifier.ascending("part"),
                    messageID: input.assistantMessage.id,
                    sessionID: input.assistantMessage.sessionID,
                    type: "text",
                    text: "",
                    time: {
                      start: Date.now(),
                    },
                    metadata: value.providerMetadata,
                  }
                  // 立即写入空的 text Part（占位）
                  await Session.updatePart(currentText)
                  break

                // ── 文本输出增量 ──
                case "text-delta":
                  if (currentText) {
                    currentText.text += value.text  // 拼接增量文本
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    // 只发送增量（性能优化：避免每次写全量文本）
                    await Session.updatePartDelta({
                      sessionID: currentText.sessionID,
                      messageID: currentText.messageID,
                      partID: currentText.id,
                      field: "text",
                      delta: value.text,
                    })
                  }
                  break

                // ── 文本输出结束 ──
                case "text-end":
                  if (currentText) {
                    currentText.text = currentText.text.trimEnd()
                    // 触发插件钩子（插件可以修改最终文本内容）
                    const textOutput = await Plugin.trigger(
                      "experimental.text.complete",
                      {
                        sessionID: input.sessionID,
                        messageID: input.assistantMessage.id,
                        partID: currentText.id,
                      },
                      { text: currentText.text },
                    )
                    currentText.text = textOutput.text
                    currentText.time = {
                      start: Date.now(),
                      end: Date.now(),
                    }
                    if (value.providerMetadata) currentText.metadata = value.providerMetadata
                    await Session.updatePart(currentText)
                  }
                  currentText = undefined
                  break

                // ── 流正常结束（不需要特殊处理）──
                case "finish":
                  break

                // ── 未知事件类型（记录日志）──
                default:
                  log.info("unhandled", {
                    ...value,
                  })
                  continue
              }
              // 如果检测到需要压缩，立即跳出内层事件循环
              if (needsCompaction) break
            }
          } catch (e: any) {
            // ── 错误处理 ──────────────────────────────────
            log.error("process", {
              error: e,
              stack: JSON.stringify(e.stack),
            })
            const error = MessageV2.fromError(e, { providerID: input.model.providerID })
            if (MessageV2.ContextOverflowError.isInstance(error)) {
              // TODO: 处理上下文溢出错误
            }
            // 检查是否可重试（网络超时、速率限制等临时错误）
            const retry = SessionRetry.retryable(error)
            if (retry !== undefined) {
              attempt++
              const delay = SessionRetry.delay(attempt, error.name === "APIError" ? error : undefined)
              // 更新 UI 状态为"重试中"，显示倒计时
              SessionStatus.set(input.sessionID, {
                type: "retry",
                attempt,
                message: retry,
                next: Date.now() + delay,
              })
              // 等待后重试（等待期间如果用户取消，catch 吞掉错误）
              await SessionRetry.sleep(delay, input.abort).catch(() => {})
              continue  // 重新进入 while(true) 循环
            }
            // 不可重试 → 将错误记录到消息，通知 UI
            input.assistantMessage.error = error
            Bus.publish(Session.Event.Error, {
              sessionID: input.assistantMessage.sessionID,
              error: input.assistantMessage.error,
            })
            SessionStatus.set(input.sessionID, { type: "idle" })
          }

          // ── 流结束后的清理 ──────────────────────────────
          // 如果最后一个 step 有文件变化（异常中断时也需处理）
          if (snapshot) {
            const patch = await Snapshot.patch(snapshot)
            if (patch.files.length) {
              await Session.updatePart({
                id: Identifier.ascending("part"),
                messageID: input.assistantMessage.id,
                sessionID: input.sessionID,
                type: "patch",
                hash: patch.hash,
                files: patch.files,
              })
            }
            snapshot = undefined
          }

          // 将所有仍在运行状态的工具调用标记为 error（流异常中断）
          const p = await MessageV2.parts(input.assistantMessage.id)
          for (const part of p) {
            if (part.type === "tool" && part.state.status !== "completed" && part.state.status !== "error") {
              await Session.updatePart({
                ...part,
                state: {
                  ...part.state,
                  status: "error",
                  error: "Tool execution aborted",
                  time: {
                    start: Date.now(),
                    end: Date.now(),
                  },
                },
              })
            }
          }

          // 标记消息完成时间
          input.assistantMessage.time.completed = Date.now()
          await Session.updateMessage(input.assistantMessage)

          // ── 返回信号给外层 loop ──────────────────────────
          if (needsCompaction) return "compact"  // 触发上下文压缩
          if (blocked) return "stop"             // 因权限拒绝停止
          if (input.assistantMessage.error) return "stop"  // 发生错误停止
          return "continue"                      // 正常继续
        }
      },
    }
    return result
  }
}
