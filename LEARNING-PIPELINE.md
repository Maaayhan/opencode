# OpenCode Agent 主链路学习笔记（一 ~ 十五）

学习分支：`learn/opencode`。本文件是导航索引，每个条目点击即可跳转到对应代码位置（VSCode / GitHub 均支持 `#L行号` 跳转）。

## 整体流程图

```
用户提交消息 (一)
  → runLoop 主循环总览 (三)
    → 每轮：任务/压缩排队检查、熔断 (四、五)
    → 创建 assistant 占位消息 (六)
    → 工具集组装：七(适配层) + 八(工具从哪来)
    → 调模型 (九，一次 handle.process())
      → process()：调 llm.stream + 消费事件 + drain (十)
        → llm.stream()：跟 provider 打交道，吐统一事件流 (十一)
        → handleEvent：逐事件落库/推送，工具结果闭环 (十二)
    → 这一轮收尾：stop/compact/continue (十三)
  → 并发保护，同 session 单例循环 (十四)
→ 结果通过 SSE 推给前端 (十五，终点，闭环回一)
```

## 导航索引（按学习顺序）

| # | 主题 | 位置 | 重要度 |
|---|---|---|---|
| 一 | 请求入口：同步 prompt / 异步 promptAsync | [session.ts#L296](packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts#L296) | 精读 |
| 二 | 提交用户消息，Agent 主链路入口 | [prompt.ts#L1058](packages/opencode/src/session/prompt.ts#L1058) | 精读 |
| 三 | Agent 核心循环总览 `runLoop`（while true） | [prompt.ts#L1094](packages/opencode/src/session/prompt.ts#L1094) | 精读 |
| 四 | 为什么不能只信 `finish_reason` | [prompt.ts#L1148](packages/opencode/src/session/prompt.ts#L1148) | 精读（工程细节） |
| 五 | 会话标题生成 / 子任务 / 压缩排队 / 熔断 | [prompt.ts#L1184](packages/opencode/src/session/prompt.ts#L1184) | 粗略 |
| 六 | 创建 assistant 占位消息 + 中断兜底 | [prompt.ts#L1253](packages/opencode/src/session/prompt.ts#L1253) | 精读 |
| 七 | 工具解析适配层：ToolRegistry → AI SDK 格式 | [tools.ts#L39](packages/opencode/src/session/tools.ts#L39) | 精读 |
| 八 | 工具注册表：builtin / custom / plugin 三来源 | [registry.ts#L115](packages/opencode/src/tool/registry.ts#L115) | 精读 |
| 九 | 唯一真正调用大模型的地方 + 收尾三道关卡 | [prompt.ts#L1374](packages/opencode/src/session/prompt.ts#L1374) | 精读 |
| 十 | `process()`：驱动 llm.stream + 消费事件 + drain | [processor.ts#L643](packages/opencode/src/session/processor.ts#L643) | 粗略（核心就 3 行，外层是重试/中断防护壳） |
| 十一 | Provider 抽象层，统一事件流，`AbortController` 生命周期 | [llm.ts#L54](packages/opencode/src/session/llm.ts#L54) | 精读开头设计动机 + abort 部分，具体 provider 适配细节可跳过 |
| 十二 | `handleEvent`：逐事件落库（打字机效果来源）+ doom_loop 检测 | [processor.ts#L276](packages/opencode/src/session/processor.ts#L276) | 精读（挑一组 case 看透模式即可，其余同构可扫过） |
| 十三 | 这一轮收尾：stop / compact / continue | [prompt.ts#L1450](packages/opencode/src/session/prompt.ts#L1450) | 精读（短，是九的延续） |
| 十四 | 并发保护：同一 session 同时只有一个 runLoop | [prompt.ts#L1479](packages/opencode/src/session/prompt.ts#L1479) | 粗略 |
| 十五（终点） | SSE 事件流出口，链路闭环回一 | [event.ts#L26](packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts#L26) | 精读（短但概念关键） |

## 专题：模型调用 ↔ 工具调用的调度循环（十一 补充，含 AI SDK 源码验证）

这是对十一「llm.stream()」的一次深挖，追踪了「模型返回 tool call → 执行工具 →
结果喂回模型」这整条调度逻辑到底是谁负责的。不是根据 AI SDK 文档/注释推测，
是实际跳进 `node_modules/ai@6.0.168` 的 `dist/index.js` 源码验证过的。

### 核心结论（跟直觉相反的地方）

"工具执行完，再调一次模型" 这个决定和动作，**不是** AI SDK 的 `streamText()`
内部自动做的，而是 OpenCode 应用层的 `runLoop`（`prompt.ts` 的 `while(true)`）
靠重新发起一次全新的 `process()`/`streamText()` 实现的。

原因：`llm.ts` 调 `streamText()` 时没有传 `stopWhen` / `prepareStep`
（[llm.ts#L300](packages/opencode/src/session/llm.ts#L300)），AI SDK 的默认值是
`stopWhen = stepCountIs(1)`（`ai/dist/index.js:6459` 的解构参数默认值，
`stepCountIs` 实现在 `ai/dist/index.js:3929-3931`：`({steps}) => steps.length === stepCount`）。
也就是说**每次 `streamText()` 调用最多只跑 1 个 step**：如果模型这一步请求了
工具，AI SDK 确实会在这次调用内部自动执行 `tool.execute()`（内部函数
`executeToolCall` @ `ai/dist/index.js:2862`，通过 `tool2.execute.bind(tool2)`
直接调用 OpenCode 在 `tools.ts` 里注册的 execute），但工具跑完之后，因为
`steps.length === 1` 已经满足停止条件，AI SDK **不会**自动把结果塞回去再发
第二次模型请求，而是直接 `finish` 这个 stream（判断逻辑在 `ai/dist/index.js:7601-7627`）。

### 5 个具体问题的答案

| 问题 | 答案 | 位置 |
|---|---|---|
| "再调模型"的决定在哪 | `runLoop` 的 `while(true)`，检查 `hasToolCalls` | [prompt.ts#L1166](packages/opencode/src/session/prompt.ts#L1166) |
| 是 streamText 内部继续，还是外层重开 | 外层 `runLoop` 重开一次全新的 `process()` | [prompt.ts#L1112](packages/opencode/src/session/prompt.ts#L1112) |
| stopWhen/maxSteps/prepareStep 传了什么 | 都没传，全部用 AI SDK 默认值 `stepCountIs(1)`；OpenCode 自己的 `agent.steps` 熔断是应用层概念，跟这个无关 | [llm.ts#L300](packages/opencode/src/session/llm.ts#L300)、[prompt.ts#L1245](packages/opencode/src/session/prompt.ts#L1245)（`maxSteps = agent.steps ?? Infinity`） |
| handleEvent 会不会触发下一次模型调用 | 不会，它只负责消费事件落库/推送 | [processor.ts#L399](packages/opencode/src/session/processor.ts#L399) |
| 工具结果在哪被塞回下一次请求的 messages | `toModelMessagesEffect` 内部调 AI SDK 的 `convertToModelMessages()` | [message-v2.ts#L406](packages/opencode/src/session/message-v2.ts#L406)，调用方 [prompt.ts#L1379](packages/opencode/src/session/prompt.ts#L1379) |

### 完整调用链（时间顺序）

```
runLoop while(true) 第 N 轮 (prompt.ts:1112)
  → 读 DB：msgs = filterCompactedEffect()          (prompt.ts:1137)   ← 上一轮的 tool-result 已经在里面
  → hasToolCalls 判断，是否 break                    (prompt.ts:1166)
  → toModelMessagesEffect → convertToModelMessages()  (message-v2.ts:131-414)  ⭐ 工具结果重新变回 messages
  → handle.process({ messages, tools })              (prompt.ts:1398)
    → processor.ts process()                          (processor.ts:650)
      → llm.stream() → streamText({...})              (llm.ts:300)  ⭐ 真正发 HTTP 请求，无 stopWhen/maxSteps
        → 【AI SDK 内部一个 step】
          a) 发请求给 provider，返回 tool-call
          b) AI SDK 自动执行工具：executeToolCall() → tools.ts:128 execute() → item.execute (真正工具逻辑)
          c) isStopConditionMet(stepCountIs(1)) === true → 不再自动发第二次模型请求，finish 这个 stream
      → Stream.tap(handleEvent) 逐事件落库             (processor.ts:666)
        tool-call → running 态落库                     (processor.ts:336)
        tool-result → completed 态落库 ⭐               (processor.ts:399)
      → Stream.runDrain，process() 返回 "continue"      (processor.ts:706-708)
  → outcome = "continue" → continue                   (prompt.ts:1470)
  回到最顶端，while(true) 下一轮迭代 —— 此时读到的 msgs 已包含刚落库的 tool-result
  ......
  直到某一轮 hasToolCalls=false 且 finish≠tool-calls → break，runLoop 结束
```

### 术语区分

| 概念 | 定义 | 与其他概念的数量关系 |
|---|---|---|
| 一次模型 API 调用 | provider 收到一次 HTTP 请求、吐一次响应，对应 AI SDK 内部一个 step | — |
| 一次工具执行 | `tool.execute()` 被调一次，发生在某个 step **内部**，由 AI SDK 直接触发 | 一个 step 内可以有多次（并行工具调用） |
| 一次 `streamText()` | `llm.ts:300` 的一次函数调用 | 当前配置（`stopWhen` 未覆盖）下 = 恰好 1 个 step = 最多 1 次模型 API 调用 |
| 一次 `process()` | `processor.ts:650`，包一层 `llm.stream()` + `handleEvent` 消费 + `runDrain` | 与"一次 `streamText()`" 1:1 |
| 一次 `runLoop` 迭代 | `prompt.ts:1112` 的 `while(true)` 转一圈 | 与"一次 `process()`" 1:1（子任务/压缩任务拦截的那种迭代除外，完全不调模型） |

## 专题二：doom-loop 权限阻断 / Part 持久化架构 / snapshot 语义（十二、十五 补充，含 AI SDK 源码验证）

这是对十二（`handleEvent`）的第二次深挖，追踪了三件事：doom_loop 的 `permission.ask()`
到底能不能挡住工具执行、Part 到底怎么落库、snapshot 拍的到底是什么。同样是跳进
`node_modules/ai@6.0.168` 源码验证过的，不是根据注释推测。

### 核心结论

1. **doom_loop 的 `permission.ask()` 挡不住"当前这次"工具执行。** AI SDK 的
   `runToolsTransformation`（`ai/dist/index.js:6293-6376`）里，`controller.enqueue(toolCall)`
   推出 tool-call 事件后，**同一个不 await 的同步代码块**里立刻调
   `executeToolCall(...)`——不等任何下游消费者。等 `permission.ask()` 真正被
   用户点击唤醒时（要等人类反应时间），工具大概率已经执行完了。OpenCode 自己
   在 [processor.ts#L98](packages/opencode/src/session/processor.ts#L98)（`create()` 里
   `initialSnapshot` 那行）的英文注释就是这个坑的第一手证据："AI SDK may execute
   tools internally before emitting start-step events"。
2. **Allow once 恢复的是 OpenCode 自己的一个 `Deferred`，不是工具执行本身。**
   `permission/index.ts` 的 `ask()`（[L67](packages/opencode/src/permission/index.ts#L67)）
   挂起等待，`reply()`（[L122](packages/opencode/src/permission/index.ts#L122)）里
   `Deferred.succeed`（once/always 共用同一行）只是唤醒调用方那个被挂起的 Effect
   fiber，让 `handleEvent` 的 case 分支返回、`Stream.tap` 能继续消费下一个排队事件
   （大概率是早就产出的 `tool-result`）——工具本身从未被这个 Deferred 控制过。
3. **权限请求纯内存，不跨进程可恢复。** `state.pending: Map<...>`（`permission/index.ts:50`）
   绑定当次进程的 `InstanceState`，进程退出/服务重启时的 finalizer（`permission/index.ts:54-61`）
   会把所有还没回复的请求自动 `Deferred.fail` 成拒绝，不会留到下次启动继续等。
4. **`session.updatePart`（全量）和 `session.updatePartDelta`（增量）不是同一量级的持久化。**
   `updatePart` 发布的 `PartUpdated` 事件带 `durable` 标记（`schema/v1/session.ts:618-626`
   的 `...options`），会在同一个 SQLite 事务里被
   [projector.ts#L312](packages/core/src/session/projector.ts#L312) 的 projector 写进
   `PartTable`（Drizzle ORM + `bun:sqlite`/`node:sqlite`，默认路径
   `~/.local/share/opencode/opencode.db`）。`updatePartDelta` 发布的 `PartDelta`
   事件**没有** `durable` 标记（`schema/v1/session.ts:638-647`），全程只走内存
   `PubSub`（`event.ts:393` 的非 durable 分支），**从不落库**——前端全靠字符串
   `+=` 拼出完整文本（`event-reducer.ts:298-322`），断线重连是重新拉 REST
   （`sync.tsx:594-599`），不是重放 delta。
   **进程崩溃会不会丢文字要分两种情况**：① 优雅停止（用户主动停止、Effect
   scope 正常退出）——`Effect.ensuring(cleanup())`（`processor.ts:701` 附近）
   保证 `cleanup()` 一定会跑，把 `ctx.currentText` 里累积的完整文本兜底
   `updatePart` 一次，通常能保住停止前收到的全部内容；② 硬崩溃（`kill -9`、
   断电、运行时直接崩溃、被 OS 杀掉）——`cleanup()` 根本没机会执行，数据库里
   只停在上一次全量 `updatePart` 的内容（通常是 `text-start` 时写的空字符串），
   `text-start` 到崩溃之间的所有 delta 全部丢失，因为它们全程只存在于后端
   RAM/前端 RAM/非持久化 PubSub 里，没有任何一份是持久化的。
5. **snapshot 拍的是一个"影子 git 仓库"里的 tree hash，不是 commit、不是完整文件拷贝。**
   `snapshot/index.ts` 的 `track()`（[L318](packages/opencode/src/snapshot/index.ts#L318)）
   用独立的 `--git-dir`（指向 `Global.Path.data/snapshot/<projectID>/<hash>`，跟项目
   自己的 `.git` 无关）把改动/新增文件 `git add` 进暂存区，`git write-tree` 产出一个
   tree hash；`patch(hash)`（[L362](packages/opencode/src/snapshot/index.ts#L362)）
   拿这个 hash 跟当前工作区 diff 出改动文件列表；`restore()`/`revert()`
   （[L402](packages/opencode/src/snapshot/index.ts#L402)）能真正回滚文件，不只是展示 diff。
   非 Git 项目直接跳过整套机制。

### 最终完整心智模型

把上面几条结论拼成两张图——这是整个「专题一 + 专题二」最后应该留在脑子里的东西。

**工具调用 ↔ 权限 ↔ 落库：**

```text
Provider 模型流
  ↓
AI SDK TransformStream 状态机
  ↓
识别 tool-call
  ├──────────────────────────────┐
  │                              │
  │ 立即执行 tool.execute        │ enqueue tool-call 事件
  │                              │
  ↓                              ↓
真实文件/命令副作用            OpenCode handleEvent
  ↓                              ↓
产生 tool-result               doom-loop permission.ask
  │                              ↓
  │                              等用户
  └──────── 结果排队等待 ─────────┘
                                 ↓
                          用户 Allow once
                                 ↓
                          Effect 消费者恢复
                                 ↓
                          处理排队的 tool-result
                                 ↓
                          completeToolCall
                                 ↓
                          durable PartUpdated event
                                 ↓
                          projector
                                 ↓
                          SQLite
```

关键：左边那条"真实副作用"支线跟右边"权限询问"支线是**并行、互不等待**的两条线——
`permission.ask()` 挡的从来只是右边这条线自己往下走，不是左边。

**文本流（对比：不经过权限，但也分两种落库力度）：**

```text
text-delta
  ↓
后端 RAM += delta
  ↓
非持久化 PartDelta event
  ↓
内存 PubSub
  ↓
SSE
  ↓
前端 store += delta
  ↓
UI 实时显示

text-end
  ↓
完整文本 updatePart
  ↓
durable event
  ↓
projector
  ↓
SQLite
```

上半段（`text-delta`）全程不落库，只在四层内存/传输里跑一圈就消失；
下半段（`text-end`）才是唯一真正写进 SQLite 的动作——这也是为什么「进程崩溃
会不会丢文字」要分优雅停止/硬崩溃两种情况看（见上面核心结论 4）。

### 严格时序图：doom_loop 的真实执行顺序

```text
provider 返回 tool-call chunk
  ↓
ai/dist/index.js:6295  parseToolCall()（schema 校验/repair）
ai/dist/index.js:6303  controller.enqueue(toolCall)          ─┐ 同一同步块，
ai/dist/index.js:6346  executeToolCall(...).then(...)        ─┘ 之间无 await
        ↓（并行两条线，无同步关系）
线A（消费端，可能因等用户操作而慢）        线B（AI SDK 内部执行，几乎立刻开始）
processor.ts handleEvent "tool-call"        tools.ts:128 execute()
  doom_loop 检测 → permission.ask()             → tools.ts:140 item.execute()（真正工具逻辑/副作用发生）
  Deferred.await(...) 挂起，等人点击          执行完，resolve
（数秒~数十秒后）用户点 Allow once           ai/dist/index.js:6361
  permission.ts:155 Deferred.succeed(...)      toolResultsStreamController.enqueue(result)
ask() 返回，handleEvent 继续 ───────────────────────┘
Stream.tap 处理下一个排队事件（大概率就是早已产出的 tool-result）
processor.ts case "tool-result" → completeToolCall() → session.updatePart（落库）
```

### 完整源码索引

| 结论 | 文件:行 | 函数 |
|---|---|---|
| tool-call enqueue 后立刻执行、不等消费者 | `node_modules/ai/dist/index.js:6293-6376` | `runToolsTransformation` |
| 单个工具执行的完整封装 | `node_modules/ai/dist/index.js:2862` | `executeToolCall` |
| OpenCode 自己的坑位证据 | [processor.ts#L98](packages/opencode/src/session/processor.ts#L98) | `SessionProcessor.create` |
| doom_loop 检测 + permission.ask | [processor.ts#L395](packages/opencode/src/session/processor.ts#L395) | `handleEvent` case `"tool-call"` |
| 权限挂起/唤醒机制 | [permission/index.ts#L67](packages/opencode/src/permission/index.ts#L67)、[#L122](packages/opencode/src/permission/index.ts#L122) | `ask` / `reply` |
| 权限纯内存、不可跨进程恢复 | [permission/index.ts#L46](packages/opencode/src/permission/index.ts#L46) | `Permission.state` 的 finalizer |
| updatePart 只发事件，真正写库在别处 | [session.ts#L637](packages/opencode/src/session/session.ts#L637) | `updatePart` |
| updatePart 真正落库的地方 | [projector.ts#L312](packages/core/src/session/projector.ts#L312) | `PartUpdated` projector |
| updatePartDelta 纯广播不落库 | [session.ts#L879](packages/opencode/src/session/session.ts#L879) | `updatePartDelta` |
| durable vs 非 durable 事件定义 | [schema/v1/session.ts#L618](packages/schema/src/v1/session.ts#L618)（`PartUpdated`）、[#L638](packages/schema/src/v1/session.ts#L638)（`PartDelta`） | `Event.PartUpdated` / `PartDelta` |
| 前端靠字符串拼接组装全文 | [event-reducer.ts#L298](packages/app/src/context/global-sync/event-reducer.ts#L298) | `case "message.part.delta"` |
| 默认数据库路径/驱动 | `packages/core/src/database/database.ts:43-55`、`sqlite.bun.ts:1,158` | `path()` |
| snapshot 拍的是 git tree hash | [snapshot/index.ts#L318](packages/opencode/src/snapshot/index.ts#L318) | `track` |
| patch 怎么 diff 出改动文件 | [snapshot/index.ts#L362](packages/opencode/src/snapshot/index.ts#L362) | `patch` |
| snapshot 能真正回滚 | [snapshot/index.ts#L402](packages/opencode/src/snapshot/index.ts#L402) | `restore` |

### 尚未确认（诚实标注，不是事实）

- `SnapshotPart`（独立 Part 类型）在主链路里具体由哪行创建——只确认了 `StepStartPart`/`StepFinishPart` 各自带的 `snapshot` 字段赋值点。
- `patch()` 对 rename 的具体呈现——没有传 `--no-renames`，行为依赖 git 默认启发式，未验证。

## 主链路之外可以深挖的方向（未编号旁支）

这些子系统在主链路里被提到过，但没有展开细看，是否深挖看兴趣：

| 方向 | 位置 | 关联点 |
|---|---|---|
| Permission 系统（ruleset 合并、allow/deny/ask 判定） | [permission/index.ts](packages/opencode/src/permission/index.ts) / [evaluate.ts](packages/opencode/src/permission/evaluate.ts) | 七里 `ctx.ask`、十二里的 doom_loop 询问都走这 |
| 压缩 Compaction（超限自动摘要） | [session/compaction.ts](packages/opencode/src/session/compaction.ts) | 十三里 `result === "compact"` 时调用 |
| Agent 系统（角色/模式/权限定义） | [agent/agent.ts](packages/opencode/src/agent/agent.ts) / [subagent-permissions.ts](packages/opencode/src/agent/subagent-permissions.ts) | 贯穿全程的 `agent: Agent.Info` |
| Provider / Model 解析与鉴权 | [provider/provider.ts](packages/opencode/src/provider/provider.ts) / [provider/auth.ts](packages/opencode/src/provider/auth.ts) | 十一 llm.ts 依赖的 Provider 抽象 |
| MCP 集成（外部工具/资源服务器） | [mcp/index.ts](packages/opencode/src/mcp/index.ts) | 七里 `MCP.Service`，工具的第四条来源 |
| 事件总线（SSE 背后的发布/订阅） | [event-v2-bridge.ts](packages/opencode/src/event-v2-bridge.ts) / [bus/global.ts](packages/opencode/src/bus/global.ts) | 十五 SSE 出口背后的总线实现 |
| Session 存储/CRUD | [session/session.ts](packages/opencode/src/session/session.ts) | 贯穿全程的 `Session.Service` |
| 前端消费侧（TUI / App 怎么接 SSE、渲染 Part） | `packages/tui/` / `packages/app/` | 十五之后，SSE 事件到界面的最后一步 |
