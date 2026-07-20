import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { Image } from "@/image/image"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import { Cause, Deferred, Effect, Exit, Layer, Context, Scope, Schema } from "effect"
import * as Stream from "effect/Stream"
import { Agent } from "@/agent/agent"
import { Config } from "@/config/config"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { Snapshot } from "@/snapshot"
import { Session } from "./session"
import { LLM } from "./llm"
import { MessageV2 } from "./message-v2"
import { isOverflow } from "./overflow"
import { PartID } from "./schema"
import type { SessionID } from "./schema"
import { SessionRetry } from "./retry"
import { SessionStatus } from "./status"
import { SessionSummary } from "./summary"
import type { Provider } from "@/provider/provider"
import { Question } from "@/question"
import { errorMessage } from "@/util/error"
import { isRecord } from "@/util/record"
import { EventV2Bridge } from "@/event-v2-bridge"
import { Database } from "@opencode-ai/core/database/database"
import { Usage, type LLMEvent } from "@opencode-ai/llm"

const DOOM_LOOP_THRESHOLD = 3
export type Result = "compact" | "stop" | "continue"

export interface Handle {
  readonly message: SessionV1.Assistant
  readonly updateToolCall: (
    toolCallID: string,
    update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
  ) => Effect.Effect<SessionV1.ToolPart | undefined>
  readonly completeToolCall: (
    toolCallID: string,
    output: {
      title: string
      metadata: Record<string, any>
      output: string
      attachments?: SessionV1.FilePart[]
    },
  ) => Effect.Effect<void>
  readonly process: (streamInput: LLM.StreamInput) => Effect.Effect<Result>
}

type Input = {
  assistantMessage: SessionV1.Assistant
  sessionID: SessionID
  model: Provider.Model
}

export interface Interface {
  readonly create: (input: Input) => Effect.Effect<Handle>
}

type ToolCall = {
  partID: SessionV1.ToolPart["id"]
  messageID: SessionV1.ToolPart["messageID"]
  sessionID: SessionV1.ToolPart["sessionID"]
  done: Deferred.Deferred<void>
}

interface ProcessorContext extends Input {
  toolcalls: Record<string, ToolCall>
  shouldBreak: boolean
  snapshot: string | undefined
  blocked: boolean
  needsCompaction: boolean
  currentText: SessionV1.TextPart | undefined
  reasoningMap: Record<string, SessionV1.ReasoningPart>
}

type StreamEvent = LLMEvent

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionProcessor") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const session = yield* Session.Service
    const config = yield* Config.Service
    const snapshot = yield* Snapshot.Service
    const agents = yield* Agent.Service
    const llm = yield* LLM.Service
    const permission = yield* Permission.Service
    const plugin = yield* Plugin.Service
    const summary = yield* SessionSummary.Service
    const scope = yield* Scope.Scope
    const status = yield* SessionStatus.Service
    const image = yield* Image.Service
    const events = yield* EventV2Bridge.Service
    const database = yield* Database.Service

    const create = Effect.fn("SessionProcessor.create")(function* (input: Input) {
      // Pre-capture snapshot before the LLM stream starts. The AI SDK
      // may execute tools internally before emitting start-step events,
      // so capturing inside the event handler can be too late.
      //
      // 【补充：这条注释就是"AI SDK 生产端不等消费端"的第一手证据】
      // 这里之所以要把快照挪到流开始之前，而不是等 case "step-start"
      // 里再 track()，正是因为 AI SDK 的工具执行（executeToolCall）跟它
      // emit 事件之间没有同步关系——见 case "tool-call" 里 doom_loop
      // 那段补充注释、以及 node_modules/ai dist/index.js:6293-6376。
      // 如果在 step-start 事件处理器里才拍快照，工具可能已经把文件改完了，
      // 快照就成了"改完之后"的状态，没法再当基线去 diff 出改动。
      const initialSnapshot = yield* snapshot.track()
      const ctx: ProcessorContext = {
        assistantMessage: input.assistantMessage,
        sessionID: input.sessionID,
        model: input.model,
        toolcalls: {},
        shouldBreak: false,
        snapshot: initialSnapshot,
        blocked: false,
        needsCompaction: false,
        currentText: undefined,
        reasoningMap: {},
      }
      let aborted = false

      const parse = (e: unknown) =>
        MessageV2.fromError(e, {
          providerID: input.model.providerID,
          aborted,
        })

      const settleToolCall = Effect.fn("SessionProcessor.settleToolCall")(function* (toolCallID: string) {
        const done = ctx.toolcalls[toolCallID]?.done
        delete ctx.toolcalls[toolCallID]
        if (done) yield* Deferred.succeed(done, undefined).pipe(Effect.ignore)
      })

      const readToolCall = Effect.fn("SessionProcessor.readToolCall")(function* (toolCallID: string) {
        const call = ctx.toolcalls[toolCallID]
        if (!call) return undefined
        const part = yield* session.getPart({
          partID: call.partID,
          messageID: call.messageID,
          sessionID: call.sessionID,
        })
        if (!part || part.type !== "tool") {
          delete ctx.toolcalls[toolCallID]
          return undefined
        }
        return { call, part }
      })

      const updateToolCall = Effect.fn("SessionProcessor.updateToolCall")(function* (
        toolCallID: string,
        update: (part: SessionV1.ToolPart) => SessionV1.ToolPart,
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match) return undefined
        const part = yield* session.updatePart(update(match.part))
        ctx.toolcalls[toolCallID] = {
          ...match.call,
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return part
      })

      const completeToolCall = Effect.fn("SessionProcessor.completeToolCall")(function* (
        toolCallID: string,
        output: {
          title: string
          metadata: Record<string, any>
          output: string
          attachments?: SessionV1.FilePart[]
        },
      ) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "completed",
            input: match.part.state.input,
            output: output.output,
            metadata: output.metadata,
            title: output.title,
            time: { start: match.part.state.time.start, end: Date.now() },
            attachments: output.attachments,
          },
        })
        yield* settleToolCall(toolCallID)
      })

      const failToolCall = Effect.fn("SessionProcessor.failToolCall")(function* (toolCallID: string, error: unknown) {
        const match = yield* readToolCall(toolCallID)
        if (!match || match.part.state.status !== "running") return false
        yield* session.updatePart({
          ...match.part,
          state: {
            status: "error",
            input: match.part.state.input,
            error: errorMessage(error),
            time: { start: match.part.state.time.start, end: Date.now() },
          },
        })
        if (error instanceof PermissionV1.RejectedError || error instanceof Question.RejectedError) {
          ctx.blocked = ctx.shouldBreak
        }
        yield* settleToolCall(toolCallID)
        return true
      })

      const finishReasoning = Effect.fn("SessionProcessor.finishReasoning")(function* (reasoningID: string) {
        if (!(reasoningID in ctx.reasoningMap)) return
        // oxlint-disable-next-line no-self-assign -- reactivity trigger
        ctx.reasoningMap[reasoningID].text = ctx.reasoningMap[reasoningID].text
        ctx.reasoningMap[reasoningID].time = { ...ctx.reasoningMap[reasoningID].time, end: Date.now() }
        yield* session.updatePart(ctx.reasoningMap[reasoningID])
        delete ctx.reasoningMap[reasoningID]
      })

      const ensureToolCall = Effect.fn("SessionProcessor.ensureToolCall")(function* (input: {
        id: string
        name: string
        providerExecuted?: boolean
      }) {
        const existing = yield* readToolCall(input.id)
        if (existing) {
          if (!input.providerExecuted || existing.part.metadata?.providerExecuted) return existing
          const part = yield* session.updatePart({
            ...existing.part,
            metadata: { ...existing.part.metadata, providerExecuted: true },
          })
          ctx.toolcalls[input.id] = {
            ...existing.call,
            partID: part.id,
            messageID: part.messageID,
            sessionID: part.sessionID,
          }
          return { call: ctx.toolcalls[input.id], part }
        }
        const part = yield* session.updatePart({
          id: PartID.ascending(),
          messageID: ctx.assistantMessage.id,
          sessionID: ctx.assistantMessage.sessionID,
          type: "tool",
          tool: input.name,
          callID: input.id,
          state: { status: "pending", input: {}, raw: "" },
          metadata: input.providerExecuted ? { providerExecuted: true } : undefined,
        } satisfies SessionV1.ToolPart)
        ctx.toolcalls[input.id] = {
          done: yield* Deferred.make<void>(),
          partID: part.id,
          messageID: part.messageID,
          sessionID: part.sessionID,
        }
        return { call: ctx.toolcalls[input.id], part }
      })

      const isFilePart = (value: unknown): value is SessionV1.FilePart => Schema.is(SessionV1.FilePart)(value)

      const toolResultOutput = (
        value: Extract<StreamEvent, { type: "tool-result" }>,
      ): { title: string; metadata: Record<string, any>; output: string; attachments?: SessionV1.FilePart[] } => {
        if (isRecord(value.result.value) && typeof value.result.value.output === "string") {
          return {
            title: typeof value.result.value.title === "string" ? value.result.value.title : value.name,
            metadata: isRecord(value.result.value.metadata) ? value.result.value.metadata : {},
            output: value.result.value.output,
            attachments: Array.isArray(value.result.value.attachments)
              ? value.result.value.attachments.filter(isFilePart)
              : undefined,
          }
        }
        return {
          title: value.name,
          metadata: value.result.type === "json" && isRecord(value.result.value) ? value.result.value : {},
          output:
            typeof value.result.value === "string" ? value.result.value : (JSON.stringify(value.result.value) ?? ""),
        }
      }

      // 【学习顺序：十二】十二.一 —— 流式事件消费入口
      // llm.stream()（十一）吐出的是 provider 无关的统一事件流（reasoning-*/text-*/
      // tool-input-*/tool-call/tool-result/finish...），这里按事件类型 switch，
      // 核心模式是：每来一个事件就立刻调 updatePart 或 updatePartDelta 一次，
      // 这正是"边生成边展示"打字机效果的来源。
      // （虽然定义在文件靠前的位置，但实际是被十.三的 Stream.tap 调用的）
      //
      // 【追踪结论：updatePart 和 updatePartDelta 并不是同一量级的持久化】
      // updatePart（全量 Part）发布的是 durable 事件（PartUpdated），会在同一个
      // SQLite 事务里被 projector 写进 PartTable（packages/core/src/session/
      // projector.ts:312-330），是唯一真正落库的写入路径。
      // updatePartDelta 发布的是 PartDelta（schema/v1/session.ts:638-647 的定义
      // 没有 durable 字段），走的是纯内存 PubSub（event.ts:393 notify(event,false)），
      // 从头到尾不碰数据库——每个 delta 单独来看是不落库的，"进程崩溃也不丢"
      // 这个说法不准确，实际要分两种情况（细节见下面 text-delta/text-end 的注释）：
      //   · 优雅停止（用户主动停止、Effect scope 正常退出）：cleanup() 会跑，
      //     把 ctx.currentText 里累积的完整文本兜底 updatePart 一次，通常能保住
      //     停止前收到的全部内容；
      //   · 硬崩溃（kill -9、断电、运行时直接崩溃、被操作系统杀掉）：
      //     cleanup() 根本没机会跑，数据库里这个 TextPart 只停在上一次全量
      //     updatePart 的内容（通常是 text-start 时写的空字符串），
      //     text-start 到崩溃之间的所有 delta 全部丢失——它们只存在于
      //     后端 RAM（ctx.currentText）、前端 RAM、和已经广播出去但不落库的
      //     PubSub 事件里，没有任何一份是持久化的。
      const handleEvent = Effect.fnUntraced(function* (value: StreamEvent) {
        switch (value.type) {
          case "reasoning-start":
            // 模型开始吐"思考"内容（如 extended thinking / reasoning token）。
            // 用 value.id 建一条新的 reasoning part 并立即落库；
            // ctx.reasoningMap 按 id 索引，因为同一轮里可能有多段并行的 reasoning。
            if (value.id in ctx.reasoningMap) return
            ctx.reasoningMap[value.id] = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "reasoning",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.reasoningMap[value.id])
            return

          case "reasoning-delta":
            // Match dev: silently drop orphan deltas (no preceding reasoning-start).
            if (!(value.id in ctx.reasoningMap)) return
            ctx.reasoningMap[value.id].text += value.text
            if (value.providerMetadata) ctx.reasoningMap[value.id].metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.reasoningMap[value.id].sessionID,
              messageID: ctx.reasoningMap[value.id].messageID,
              partID: ctx.reasoningMap[value.id].id,
              field: "text",
              delta: value.text,
            })
            return

          case "reasoning-end":
            // 这段 reasoning 流结束：补上最后一次 providerMetadata，
            // 再调 finishReasoning 写入 end 时间戳并做最终落库、清出 reasoningMap。
            if (value.providerMetadata && value.id in ctx.reasoningMap) {
              ctx.reasoningMap[value.id].metadata = value.providerMetadata
            }
            yield* finishReasoning(value.id)
            return

          case "tool-input-start":
            // 模型开始流式吐出某个工具调用的入参（此时 JSON 参数还没吐完）。
            // 生成"摘要"（压缩历史用的 summary 消息）时不允许再调工具，直接抛错中断。
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            return

          case "tool-input-delta":
            // 工具入参 JSON 的增量片段，ensureToolCall 负责按 id 找到/创建对应 part 并追加。
            yield* ensureToolCall(value)
            return

          case "tool-input-end": {
            // 入参 JSON 流式吐完（还只是原始字符串阶段，未必已解析成可执行的结构化 input）。
            yield* ensureToolCall(value)
            return
          }

          case "tool-call": {
            // 入参已经解析完整、工具即将真正执行前的事件：把 part 状态切到 running，
            // 并记录 providerExecuted（部分 provider 如 Anthropic 的内置工具会自己执行，
            // 不走【学习顺序：七】那套本地 execute()）。同一 summary 限制在这里再校验一次。
            if (ctx.assistantMessage.summary) {
              throw new Error(`Tool call not allowed while generating summary: ${value.name}`)
            }
            yield* ensureToolCall(value)
            const input = isRecord(value.input) ? value.input : { value: value.input }
            yield* updateToolCall(value.id, (match) => ({
              ...match,
              tool: value.name,
              state:
                match.state.status === "running"
                  ? { ...match.state, input }
                  : {
                      status: "running",
                      input,
                      time: { start: Date.now() },
                    },
              metadata: match.metadata?.providerExecuted
                ? { ...value.providerMetadata, providerExecuted: true }
                : value.providerMetadata,
            }))

            const parts = yield* MessageV2.parts(ctx.assistantMessage.id).pipe(
              Effect.provideService(Database.Service, database),
            )
            const recentParts = parts.slice(-DOOM_LOOP_THRESHOLD)

            if (
              recentParts.length !== DOOM_LOOP_THRESHOLD ||
              !recentParts.every(
                (part) =>
                  part.type === "tool" &&
                  part.tool === value.name &&
                  part.state.status !== "pending" &&
                  JSON.stringify(part.state.input) === JSON.stringify(input),
              )
            ) {
              return
            }

            // 十二.二 —— "死循环"检测（doom_loop）【工程实践：熔断/限流式防御】
            // 不是在代码里判断"这个工具有没有副作用"，而是用行为模式（连续同参数重复调用）
            // 做通用熔断——不针对具体工具白名单，天然能覆盖未来新增的工具。
            // 工程上的一个防御设计：如果最近连续 DOOM_LOOP_THRESHOLD(=3) 次
            // 工具调用都是同一个工具、同样的入参，说明模型大概率卡在死循环里
            // 空转（比如反复读同一个文件却没有进展）。这种情况不会自动 kill
            // 会话，而是转成一次权限询问，交给用户判断是否要继续放行。
            const agent = yield* agents.get(ctx.assistantMessage.agent)
            // 【追踪结论：这个 permission.ask() 挡不住"当前这第三次"工具的执行】
            // 时序真相（源码验证于 node_modules/ai@6.0.168 dist/index.js）：
            // AI SDK 的 runToolsTransformation（dist/index.js:6293 case "tool-call"）
            // 里，controller.enqueue(toolCall) 推出这个 tool-call 事件之后，
            // 紧接着（同一同步代码块、不 await）就调了 executeToolCall(...)
            // （dist/index.js:6346，内部走到 tools.ts:128 的 execute()）——
            // enqueue 不等任何下游消费者处理完，Stream.tap(handleEvent) 也不会
            // 对 AI SDK 的生产端形成背压。等这里的 yield* permission.ask(...)
            // 真正被用户点击 Allow/Deny 唤醒时（通常要等几秒到几十秒的人类反应
            // 时间），这第三次工具调用大概率已经执行完了。
            // 参考本文件上面 create() 里 initialSnapshot 那行注释——作者自己
            // 也踩过这个坑（"AI SDK may execute tools internally before
            // emitting start-step events"），是同一个时序问题的另一个体现。
            // 所以这个 doom_loop 询问的实际作用是：
            //   1) Deny 时把错误抛出去，让本轮流提前结束（halt()），
            //      阻止模型在同一轮里继续瞎调工具——但已发生的副作用无法撤销；
            //   2) Allow once/always 时只是让 handleEvent 这个 case 正常返回，
            //      Stream.tap 才能继续消费下一个事件（大概率是早就产出的
            //      tool-result）——不是"重新执行"或"恢复暂停的调用"。
            yield* permission.ask({
              permission: "doom_loop",
              patterns: [value.name],
              sessionID: ctx.assistantMessage.sessionID,
              metadata: { tool: value.name, input },
              always: [value.name],
              ruleset: agent.permission,
            })
            return
          }

          // 十二.三 —— 工具的真正执行（读写文件/跑命令等）不在这个文件里发生——
          // 真正的 execute() 挂在 AI SDK 的 tool() 定义上（对应【学习顺序：七】session/tools.ts），
          // AI SDK 在内部跑完工具后才会吐出这个 tool-result 事件，
          // 这里只是把结果规范化（图片等附件处理）后落库、并唤醒等待方
          // 到这里，一整轮"调模型 -> 收流 -> 执行工具 -> 结果落库"就闭环了，
          // 回到【学习顺序：十三】(session/prompt.ts 里 result 处理那段)
          //
          // 【补充】"AI SDK 在内部跑完工具"具体是指：streamText() 收到模型的
          // tool-call 后，在同一次调用内部同步执行 tool.execute()（源码见
          // node_modules/ai dist/index.js 的 executeToolCall/executeTools），
          // 这个 tool-result 事件就是那次内部执行的结果，被 llm.ts 的
          // LLMAISDK.toLLMEvents 转成统一格式后流出来的。执行完这一步，
          // streamText() 这次调用就会因为 stopWhen 默认 stepCountIs(1) 直接
          // finish——不会自己再拿着这个结果去问模型。真正"拿结果再问模型"
          // 由外层 prompt.ts 的 runLoop 检测到未消化的 tool part 后，
          // 发起下一轮全新的 process() 完成，不在这个文件的职责范围内。
          case "tool-result": {
            // 【工程实践】幂等/竞态防御：读不到 toolCall 又是 error 结果，说明这个调用
            // 可能已经被别处（比如中断/doom_loop 提前拒绝）处理过了，直接丢弃而不是硬报错。
            const toolCall = yield* readToolCall(value.id)
            if (!toolCall && value.result.type === "error") return
            if (value.result.type === "error") {
              yield* failToolCall(value.id, value.result.value)
              return
            }
            const rawOutput = toolResultOutput(value)
            // 【工程实践】"部分失败不拖垮整体"：这里没有用 Effect.forEach 的默认失败语义
            // （一个 attachment 处理失败就整批 fail），而是用 Effect.exit 把每个 attachment 的
            // 成功/失败都转成一个值（相当于 Effect 版的 Promise.allSettled），
            // 再配合 Effect.catchIf 只窄化捕获 ResizerUnavailableError 这一种可预期的失败——
            // 其他未预料的错误仍会照常抛出、不会被静默吞掉。
            const normalized = yield* Effect.forEach(rawOutput.attachments ?? [], (attachment) =>
              attachment.mime.startsWith("image/")
                ? image.normalize(attachment).pipe(
                    Effect.catchIf(
                      (error) => error instanceof Image.ResizerUnavailableError,
                      () => Effect.succeed(attachment),
                    ),
                    Effect.exit,
                  )
                : Effect.succeed(Exit.succeed<SessionV1.FilePart>(attachment)),
            )
            const omitted = normalized.filter(Exit.isFailure).length
            const attachments = normalized.filter(Exit.isSuccess).map((item) => item.value)
            // 【工程实践】优雅降级而非报错中断：处理失败的图片直接从结果里剔除，
            // 并在文本里追加一句人类可读的提示（而不是让整个 tool-result 失败），
            // 保证工具调用本身仍能成功推进主循环。
            const output = {
              ...rawOutput,
              output:
                omitted === 0
                  ? rawOutput.output
                  : `${rawOutput.output}\n\n[${omitted} image${omitted === 1 ? "" : "s"} omitted: could not be resized below the image size limit.]`,
              attachments: attachments.length ? attachments : undefined,
            }
            yield* completeToolCall(value.id, output)
            return
          }

          case "tool-error": {
            // 和 tool-result 里 result.type === "error" 不同：这是 AI SDK/provider 层面
            // 执行工具时直接抛出的异常（而不是工具正常返回了一个"错误结果"），统一走 failToolCall 落库为失败态。
            yield* failToolCall(value.id, value.error ?? new Error(value.message))
            return
          }

          case "provider-error":
            // LLM provider 返回的错误（比如 API 报错），这里直接抛出，
            // 会被外层 process() 的 halt() 捕获并落成消息级错误、结束本轮。
            throw new Error(value.message)

          case "step-start":
            // AI SDK 里"一个 step"大致对应模型的一次响应轮次（可能包含若干工具调用）。
            // 第一次进入 step 时打一次工作区快照（snapshot.track），用于 step-finish 时 diff 出文件改动。
            if (!ctx.snapshot) ctx.snapshot = yield* snapshot.track()
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              snapshot: ctx.snapshot,
              type: "step-start",
            })
            return

          case "step-finish": {
            // 一个 step 结束：收尾这个 step 里所有还开着的 reasoning part，
            // 结算这一 step 的 token 用量/花费并累加到 assistantMessage 上，
            // 再和 step-start 时的快照 diff 出文件补丁（patch part），
            // 顺带异步触发一次历史摘要检查，以及是否需要触发上下文压缩（needsCompaction）。
            const completedSnapshot = yield* snapshot.track()
            yield* Effect.forEach(Object.keys(ctx.reasoningMap), finishReasoning)
            const usage = Session.getUsage({
              model: ctx.model,
              usage: value.usage ?? new Usage({}),
              metadata: value.providerMetadata,
            })
            ctx.assistantMessage.finish = value.reason
            ctx.assistantMessage.cost += usage.cost
            ctx.assistantMessage.tokens = usage.tokens
            yield* session.updatePart({
              id: PartID.ascending(),
              reason: value.reason,
              snapshot: completedSnapshot,
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "step-finish",
              tokens: usage.tokens,
              cost: usage.cost,
            })
            yield* session.updateMessage(ctx.assistantMessage)
            // 【补充：patch part 的正常产出点就是这里，cleanup() 里那份是异常兜底】
            // ctx.snapshot 是 create() 里流开始前拍的基线（见上面 initialSnapshot
            // 那段注释）。这里拿它跟当前工作区 diff 出这个 process() 调用期间
            // （因为 stopWhen 默认 stepCountIs(1)，等于这一整轮 streamText()）
            // 工具改动过的文件列表，写一条 PatchPart，然后把 ctx.snapshot 清空。
            // 正常走完 step-finish 就会在这里消费掉它；如果流中途被中断/报错、
            // 根本没走到这个 case，本文件下面 cleanup()（Effect.ensuring 保证
            // 任何退出路径都会跑）里有一份几乎一样的兜底代码，兜底同样会
            // 消费 ctx.snapshot——两处互斥，谁先跑就由谁产出这条 PatchPart。
            if (ctx.snapshot) {
              const patch = yield* snapshot.patch(ctx.snapshot)
              if (patch.files.length) {
                yield* session.updatePart({
                  id: PartID.ascending(),
                  messageID: ctx.assistantMessage.id,
                  sessionID: ctx.sessionID,
                  type: "patch",
                  hash: patch.hash,
                  files: patch.files,
                })
              }
              ctx.snapshot = undefined
            }
            // 【工程实践】Effect.forkIn(scope) + Effect.ignore：这是"即发即忘"
            // (fire-and-forget) 的正确写法——摘要检查不阻塞当前这一 step 继续往下走，
            // 但又不是裸 fork 到全局，而是挂在传入的 scope 上，
            // 保证会话/进程关闭时这个后台任务也会跟着被清理，不会变成孤儿 fiber。
            // Effect.ignore 表示这个后台任务失败了也无所谓、不影响主流程。
            yield* summary
              .summarize({
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.parentID,
              })
              .pipe(Effect.ignore, Effect.forkIn(scope))
            if (
              !ctx.assistantMessage.summary &&
              isOverflow({ cfg: yield* config.get(), tokens: usage.tokens, model: ctx.model })
            ) {
              ctx.needsCompaction = true
            }
            return
          }

          case "text-start":
            // 模型开始吐正文文本（区别于 reasoning）。ctx.currentText 全局只保留"当前正在写的一段"，
            // 因为同一时刻不会有两段文本并行流式输出。
            // 【工程实践】用单个可变字段而不是 Map/数组，是因为这里天然满足"至多一个未闭合项"的不变量——
            // 比 reasoningMap 那种要按 id 索引的场景更简单，不用为不存在的并发情况多写防御代码。
            ctx.currentText = {
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.assistantMessage.sessionID,
              type: "text",
              text: "",
              time: { start: Date.now() },
              metadata: value.providerMetadata,
            }
            yield* session.updatePart(ctx.currentText)
            return

          case "text-delta":
            // 文本增量 token：本地累加到 currentText.text（这是本进程 RAM 里的
            // 一个普通闭包变量，ctx 生命周期绑定这一次 process() 调用）的同时，
            // 用 updatePartDelta 只把这一小段 delta 广播出去。
            // 【追踪结论】"广播"而不是"落库"：updatePartDelta 发的 PartDelta
            // 事件不是 durable 事件，只走内存 PubSub → SSE 推给前端，数据库里
            // 完全没有这条 delta 的记录。真正的全量文本只有下面 text-end 时的
            // 那次 session.updatePart(ctx.currentText) 才会落库——如果进程在
            // 两次 text-end 之间硬崩溃（没机会跑 cleanup 兜底），数据库里这个
            // TextPart 会停在上一次全量写入的内容，中间的 delta 全部丢失，
            // 前端断线重连也是重新拉取这个"上次全量写入的值"，不会重放 delta。
            if (!ctx.currentText) return
            ctx.currentText.text += value.text
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePartDelta({
              sessionID: ctx.currentText.sessionID,
              messageID: ctx.currentText.messageID,
              partID: ctx.currentText.id,
              field: "text",
              delta: value.text,
            })
            return

          case "text-end":
            // 这段文本流结束：先跑一次 experimental.text.complete 插件钩子（可能改写最终文本，
            // 比如做后处理/过滤），再补上 end 时间戳，最后整段 updatePart 落库一次并清空 currentText。
            // 【工程实践】插件钩子（plugin.trigger）只在 text-end 这一个收口点触发，
            // 而不是每个 text-delta 都触发——既避免逐 token 调用插件的性能开销，
            // 也让插件拿到的是"完整的一段文本"而不是残缺片段，语义上更好处理。
            // "experimental." 前缀是一种命名约定：标记这个扩展点接口还不稳定，未来可能改。
            if (!ctx.currentText) return
            // oxlint-disable-next-line no-self-assign -- reactivity trigger
            ctx.currentText.text = ctx.currentText.text
            ctx.currentText.text = (yield* plugin.trigger(
              "experimental.text.complete",
              {
                sessionID: ctx.sessionID,
                messageID: ctx.assistantMessage.id,
                partID: ctx.currentText.id,
              },
              { text: ctx.currentText.text },
            )).text
            {
              const end = Date.now()
              ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
            }
            if (value.providerMetadata) ctx.currentText.metadata = value.providerMetadata
            yield* session.updatePart(ctx.currentText)
            ctx.currentText = undefined
            return

          case "finish":
            // 整个 stream 结束的信号事件，这里无需额外处理——
            // 真正的收尾（usage 结算、快照 diff）已经在每个 step 的 step-finish 里做完了，
            // "跑完流"这件事由外层 process() 的 Stream.runDrain 感知。
            return
        }
      })

      const cleanup = Effect.fn("SessionProcessor.cleanup")(function* () {
        if (ctx.snapshot) {
          const patch = yield* snapshot.patch(ctx.snapshot)
          if (patch.files.length) {
            yield* session.updatePart({
              id: PartID.ascending(),
              messageID: ctx.assistantMessage.id,
              sessionID: ctx.sessionID,
              type: "patch",
              hash: patch.hash,
              files: patch.files,
            })
          }
          ctx.snapshot = undefined
        }

        if (ctx.currentText) {
          const end = Date.now()
          ctx.currentText.time = { start: ctx.currentText.time?.start ?? end, end }
          yield* session.updatePart(ctx.currentText)
          ctx.currentText = undefined
        }

        for (const part of Object.values(ctx.reasoningMap)) {
          const end = Date.now()
          yield* session.updatePart({
            ...part,
            time: { start: part.time.start ?? end, end },
          })
        }
        ctx.reasoningMap = {}

        yield* Effect.forEach(
          Object.values(ctx.toolcalls),
          (call) => Deferred.await(call.done).pipe(Effect.timeout("250 millis"), Effect.ignore),
          { concurrency: "unbounded" },
        )

        for (const toolCallID of Object.keys(ctx.toolcalls)) {
          const match = yield* readToolCall(toolCallID)
          if (!match) continue
          const part = match.part
          const end = Date.now()
          const metadata = "metadata" in part.state && isRecord(part.state.metadata) ? part.state.metadata : {}
          yield* session.updatePart({
            ...part,
            state: {
              ...part.state,
              status: "error",
              error: "Tool execution aborted",
              metadata: { ...metadata, interrupted: true },
              time: { start: "time" in part.state ? part.state.time.start : end, end },
            },
          })
        }
        ctx.toolcalls = {}
        ctx.assistantMessage.time.completed = Date.now()
        yield* session.updateMessage(ctx.assistantMessage)
      })

      const halt = Effect.fn("SessionProcessor.halt")(function* (e: unknown) {
        yield* Effect.logError("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
          error: errorMessage(e),
          stack: e instanceof Error ? e.stack : undefined,
        })
        const error = parse(e)
        if (SessionV1.ContextOverflowError.isInstance(error)) {
          if ((yield* config.get()).compaction?.auto === false && !ctx.assistantMessage.summary) {
            ctx.assistantMessage.error = error
            ctx.assistantMessage.finish = "error"
            yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
            yield* status.set(ctx.sessionID, { type: "idle" })
            return
          }
          ctx.needsCompaction = true
          yield* events.publish(Session.Event.Error, { sessionID: ctx.sessionID, error })
          return
        }
        ctx.assistantMessage.error = error
        yield* events.publish(Session.Event.Error, {
          sessionID: ctx.assistantMessage.sessionID,
          error: ctx.assistantMessage.error,
        })
        yield* status.set(ctx.sessionID, { type: "idle" })
      })

      // 【学习顺序：十】十.一 —— process()：这一轮里唯一真正"打模型"的地方
      // 被 prompt.ts 的 runLoop 在每轮循环里调用一次（对应【学习顺序：九】）。核心三行是：
      //   1. const stream = llm.stream(streamInput)   —— 发起流式请求，去看【学习顺序：十一】(session/llm.ts)
      //   2. Stream.tap(handleEvent)                  —— 每个事件都实时落库/推送，去看【学习顺序：十二】(本文件上方 handleEvent)
      //   3. Stream.runDrain                           —— 把流耗尽，等这一轮彻底结束
      // 外层包了三层防护：中断处理(onInterrupt)、按 provider 定制的重试策略
      // (SessionRetry.policy，比如 429 限流退避)、以及兜底 halt() 落错误。
      //
      // 【补充】一次 process() = 一次 llm.stream()（即 llm.ts 里一次 streamText()
      // 调用）。因为 streamText() 没被传 stopWhen，AI SDK 默认 stopWhen=
      // stepCountIs(1)，工具会在这次调用内部被自动执行，但结果不会被
      // AI SDK 自动喂回去发起第二次模型请求——这次 process() 跑完就结束了。
      // "工具结果需要再问一次模型" 不是这个函数的职责，是外层 runLoop
      // 检测到还有未处理的 tool part 后，重新调一次全新的 process()。
      const process = Effect.fn("SessionProcessor.process")(function* (streamInput: LLM.StreamInput) {
        yield* Effect.logInfo("process", {
          "session.id": input.sessionID,
          messageID: input.assistantMessage.id,
        })
        ctx.needsCompaction = false
        ctx.shouldBreak = (yield* config.get()).experimental?.continue_loop_on_deny !== true

        return yield* Effect.gen(function* () {
          yield* Effect.gen(function* () {
            ctx.currentText = undefined
            ctx.reasoningMap = {}
            yield* status.set(ctx.sessionID, { type: "busy" })
            const stream = llm.stream(streamInput) // 十.二 —— 真正发请求，见【学习顺序：十一】session/llm.ts

            yield* stream.pipe(
              Stream.tap((event) => handleEvent(event)), // 十.三 —— 逐事件消费、落库，见【学习顺序：十二】
              Stream.takeUntil(() => ctx.needsCompaction), // 一旦发现要压缩就提前掐断流，不用等模型说完
              Stream.runDrain,
            )
          }).pipe(
            Effect.onInterrupt(() =>
              Effect.gen(function* () {
                aborted = true
                if (!ctx.assistantMessage.error) {
                  yield* halt(new DOMException("Aborted", "AbortError"))
                }
              }),
            ),
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) => Effect.fail(Cause.squash(cause)),
            ),
            // 十.四 —— provider 相关的自动重试（限流/瞬时错误等），带指数退避，
            // 重试期间通过 status.set 把"重试中"状态推给前端而不是假装卡住
            Effect.retry(
              SessionRetry.policy({
                provider: input.model.providerID,
                parse,
                set: (info) => {
                  return status.set(ctx.sessionID, {
                    type: "retry",
                    attempt: info.attempt,
                    message: info.message,
                    action: info.action,
                    next: info.next,
                  })
                },
              }),
            ),
            Effect.catch(halt),
            Effect.ensuring(cleanup()),
          )

          // 十.五 —— 这个返回值就是 prompt.ts 里 runLoop 拿到的 result（回到【学习顺序：九】旁边的 result）：
          // 决定下一轮是"排队压缩"还是"直接结束"还是"继续问模型"
          if (ctx.needsCompaction) return "compact"
          if (ctx.blocked || ctx.assistantMessage.error) return "stop"
          return "continue"
        })
      })

      return {
        get message() {
          return ctx.assistantMessage
        },
        updateToolCall,
        completeToolCall,
        process,
      } satisfies Handle
    })

    return Service.of({ create })
  }),
)

export const node = LayerNode.make({
  service: Service,
  layer: layer,
  deps: [
    Session.node,
    Config.node,
    Snapshot.node,
    Agent.node,
    LLM.node,
    Permission.node,
    Plugin.node,
    SessionSummary.node,
    SessionStatus.node,
    Image.node,
    EventV2Bridge.node,
    Database.node,
  ],
})

export * as SessionProcessor from "./processor"
