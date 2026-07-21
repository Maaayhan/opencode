# OpenCode Agent 主链路 —— 中文注释全文汇编

本文件是对 `learn/opencode` 分支上所有中文学习注释的**逐字汇编**(不改写、不总结、不翻译),
按用户请求的端到端业务流顺序(一 ~ 十五,对应 `LEARNING-PIPELINE.md` 的编号)排列。

规则说明:
- 每段注释保留原文的编号(一.一、七.三……)、【】标题、破折号、换行等所有格式。
- 每段注释前用 `位置:` 标出文件路径和行号,方便跳转核对原文。
- 分散在多个文件里但属于同一话题的"补充"注释(源码里自己用【】标了同一个话题名,比如
  【任务管理补充】【结构化输出补充】【追踪结论】),按话题合并成独立小节,跟在相关主链路
  步骤之后 —— 这是源码作者自己的分类方式,不是本文档新加的分类。
- 只跟单一代码位置绑定的补充(比如某个 case 分支旁边的【工程实践】短注释),原地保留在对应
  编号步骤里,不拆出去。

---

## 一、请求入口

### 一.一 同步 prompt

位置: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:295-304`
```
============================================================
【学习顺序：一】请求入口 一.一 —— 同步 prompt
整条 Agent 链路真正的"第一站"：TUI/App 通过 SDK 调 POST .../prompt，
请求打到这里。yield* promptSvc.prompt(...) 直接调的就是
session/prompt.ts 里的 SessionPrompt.prompt，会一路阻塞到
runLoop 整个跑完（模型问完、工具都执行完）才返回最终消息。
适合"一次性问答"式调用（比如 SDK/脚本调用），但不适合交互式 UI——
界面早就想边跑边看流式内容了，不会傻等一次性返回。
下一步：去看 一.二（本文件下方 promptAsync）
============================================================
```

### 一.二 异步 promptAsync(TUI/App 实际用的是这条)

位置: `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts:321-331`
```
【学习顺序：一】请求入口 一.二 —— 异步 promptAsync（TUI/App 实际用的是这条）
关键区别：Effect.forkIn(scope, { startImmediately: true }) 把整个
runLoop 扔到后台 fiber 里跑，HTTP 请求立刻返回 204 NoContent。
界面拿到"已受理"的确认后，通过另一条 SSE 长连接
(event.subscribe，见下方/别处 EventV2Bridge 用法) 去订阅这个 session
后续产生的所有事件，实时渲染。这就是"提交"和"执行结果展示"
被拆成两条独立通道的原因——避免一个长轮询 HTTP 请求把连接占死。
循环内部出的任何未捕获错误在这里兜底捕获，转成一条 Error 事件发布出去，
而不是让整个后台 fiber 静默死掉、前端却毫无感知。
下一步：这里调用的 promptSvc.prompt(...) 是入口的终点，
真正的主循环在 packages/opencode/src/session/prompt.ts —— 去看【学习顺序：二】
```

---

## 二、提交用户消息 —— Agent 主链路入口

位置: `packages/opencode/src/session/prompt.ts:1058-1062`
```
【学习顺序：二】提交用户消息 —— Agent 主链路入口
前端 (TUI/App) 通过 SDK 调 session.prompt -> httpapi handler(一) -> 最终落到这里。
职责很单一：把用户这条消息存库，然后把"跑一轮 Agent"这件事交给 loop()。
注意这个函数本身不包含循环逻辑，是"提交"，不是"执行"。
下一步：去看【学习顺序：三】下方的 runLoop
```

位置: `prompt.ts:1068`(行尾)
```
用户消息落库（含图片/附件解析）
```

位置: `prompt.ts:1071`
```
单次请求可以临时覆盖这个 session 的工具权限（例如某次请求禁用某个工具）
```

位置: `prompt.ts:1081`(行尾)
```
只存消息、不触发模型（比如纯记录场景）
```

位置: `prompt.ts:1082`(行尾)
```
真正驱动 Agent 跑起来
```

---

## 三、Agent 核心循环总览 —— runLoop

位置: `prompt.ts:1093-1116`
```
【学习顺序：三】Agent 核心循环总览 —— runLoop
整个 Agent 系统的心脏，本质是一个显式状态机：
  读取当前会话最新状态 -> 判断该做什么(结束/压缩/子任务/正常问模型)
  -> 调用一次 LLM (handle.process) -> 处理结果(工具调用/结束/压缩)
  -> 决定 break 还是 continue -> 重复
下面循环体内部按顺序对应【学习顺序：四】到【学习顺序：九】，
就是这个状态机每一轮具体在做的事，跟着走一遍就等于走完一轮 Agent。
关键设计：循环状态不放在内存变量里，而是每轮都从数据库重新读消息列表
(MessageV2.filterCompactedEffect)。这样进程重启/中断后可以从数据库恢复，
不需要额外的持久化状态机。

【补充：模型调用 ↔ 工具调用调度循环，核心结论】
"工具执行完，再调一次模型"这个决定就是在这个 while(true) 里做的，
不是 AI SDK 的 streamText() 内部自动继续的。原因：llm.ts 调 streamText()
时没传 stopWhen，AI SDK 默认 stopWhen = stepCountIs(1)（见 ai/dist/index.js:6459），
也就是每次 streamText() 最多只跑 1 个 step——工具会在这一个 step 内被
AI SDK 自动执行，但执行完不会自动把结果喂回去再问模型，而是直接
finish 这个 stream。真正"拿着工具结果再问一次模型"，靠的是本循环
下一轮重新读 DB（此时上一轮的 tool-result 已经落库）、重新拼 messages、
重新发起一次全新的 process()/streamText()。详见下面 hasToolCalls
判断处和 toModelMessagesEffect 调用处的补充注释；完整链路见
LEARNING-PIPELINE.md「专题：模型调用 ↔ 工具调用的调度循环」。
```

位置: `prompt.ts:1121`(行尾)
```
当前是第几轮模型调用，用于 maxSteps 熔断和首轮特殊逻辑
```

位置: `prompt.ts:1125`(行尾)
```
每轮开始先把会话状态置为"忙"，前端据此显示 loading
```

位置: `prompt.ts:1128-1148`
```
每轮都重新从库里拉最新消息（而不是维护内存状态），
这样中断恢复/多进程场景下状态天然一致
```

(下接【任务管理补充合集】里的 `latest()` 说明,见本文档「五、附:任务管理补充合集」——这段
comment 在 prompt.ts 与 message-v2.ts 的 `latest()` 定义处内容基本一致,为避免重复,完整文本
放在任务管理补充合集里统一呈现。)

---

## 四、为什么不能只信 finish_reason(工程细节)

### 四.一

位置: `prompt.ts:1160-1165`
```
【学习顺序：四】四.一 —— 为什么不能只信 finish_reason（工程细节，面试可以提）
部分 provider 在 assistant 消息里明明带了 tool_use block，
但 finish_reason 却返回 "stop" 而不是 "tool-calls"。
如果只看 finish_reason 会导致漏跑工具、任务提前"假完成"。
所以这里不完全信任 finish_reason，而是直接检查消息里有没有未被
provider 自己执行、且非"清理标记为孤儿"的 tool part。
```

位置: `prompt.ts:1171-1175`
```
【补充】这行 hasToolCalls，就是"要不要再调一次模型"的真正判定点。
上一轮 streamText() 因为 stopWhen 默认 stepCountIs(1) 只跑了 1 个
step，跑完工具就直接结束了，不会自己再问模型。所以这里必须由
OpenCode 自己检查"上一条 assistant 消息里是不是还挂着没消化的
tool part"——如果有，就不能 break，得进下一轮循环重新问模型。
```

### 四.二 循环退出条件

位置: `prompt.ts:1177-1179`
```
四.二 —— 循环退出条件
同时满足：有明确的非 tool-calls 结束原因 && 确实没有待处理的工具调用
&& 最后一条是 assistant 消息（不是刚提交完用户消息还没跑）-> 才退出
```

---

## 五、会话标题生成 / 子任务 / 压缩排队 / 熔断

### 五.一 首轮顺便异步生成会话标题

位置: `prompt.ts:1202-1204`
```
【学习顺序：五】五.一 —— 首轮顺便异步生成会话标题
forkIn(scope) 意味着不阻塞主循环，失败了也无所谓 (Effect.ignore)
——标题生成不是关键路径
```

位置: `prompt.ts:1220`(行尾)
```
待处理的"虚拟任务"队列：子任务(subagent) / 上下文压缩
```

### 五.二 子任务优先处理

位置: `prompt.ts:1222-1224`
```
五.二 —— 子任务优先处理
子任务不走"问模型"这条路，而是单独起一个子 Agent 会话跑完，
结果写回后 continue 到下一轮循环，本轮不调用 LLM
```

### 五.三 压缩任务优先处理

位置: `prompt.ts:1230`
```
五.三 —— 压缩任务优先处理（同样是"本轮不调模型，先处理排队任务"的模式）
```

### 五.四 主动式压缩检查

位置: `prompt.ts:1243-1244`
```
五.四 —— 主动式压缩检查：发现上一轮 token 用量已经超过阈值，
提前排一个压缩任务，下一轮循环会被上面的 task.type === "compaction" 接住
```

### 五.五 熔断机制

位置: `prompt.ts:1262`
```
五.五 —— 熔断机制：每个 Agent 可配置最大步数（防止死循环无限调工具/烧 token）
```

### 附:任务管理补充合集

源码里凡是标了【任务管理补充】的注释,不管落在哪个文件,说的都是同一套"虚拟任务队列"
机制(subtask / compaction 怎么被现算出来、怎么排优先级)。按逻辑顺序合并如下:

位置: `packages/opencode/src/session/message-v2.ts:594-612`(`latest()` 函数定义之前,与 prompt.ts:1128-1148 处内容一致的完整版)
```
【任务管理补充：latest() 是任务队列的"现算"入口】
msgs 是这个 session 的全量消息历史（user + assistant 都在内，来自上面
stream() 分页查出来的完整列表，不是只留最后一条）。prompt.ts 的 runLoop
每一轮循环开头都会重新调一次本函数——没有任何内存状态跨轮传递，
纯粹是"数据库现在长什么样就现算什么样"。

finished 就是一根"边界指针"：最新一条已经带 finish 值的 assistant 消息。
不要求 finish==="stop"，只要有 finish 值就算数（哪怕是 "tool-calls"，
也代表这个 assistant 回合已经走完一次收尾流程了）。

tasks 只统计 id > finished.id 的消息里、类型是 compaction/subtask 的 part
——这两种是系统级"绕开模型直接处理"的任务标记，跟模型自己发起的
普通工具调用（type: "tool"，挂在 assistant 消息上）是两套不同机制，
后者在同一次 LLM 流式请求里就同步执行完了，不需要这套跨轮扫描。

msgs 里消息顺序 = MessageID.ascending() 保证的创建顺序，所以 tasks 数组
天然是"越晚创建的排越后"。prompt.ts 里 tasks.pop() 取的是数组最后一个，
也就是最晚创建的任务——这让"临时插入的压缩任务"能自动排到最前面被处理，
不需要额外的优先级字段（细节见 compaction.ts 的 create()）。
```

位置: `prompt.ts:1214-1219`(`const task = tasks.pop()` 上方)
```
【任务管理补充】tasks 不是持久化的栈，是 message-v2.ts 的 latest()
每轮现算出来的临时数组（按创建时间顺序，即消息 ID 大小顺序）。
用 pop() 取"最后一个/最新创建的"而不是 shift() 取最旧的，是故意的：
compaction.create() 每次都会造一条 id 更大的新消息，所以只要有
紧急压缩任务被插入，它必然排在数组最后，pop() 就能让它插队到
比更早排队的 subtask 优先处理——不需要额外的优先级字段。
```

位置: `packages/opencode/src/session/compaction.ts:513-521`(`create()` 函数定义之前)
```
【任务管理补充：compaction 任务是怎么"挂"上去的】
这里没有任何真人输入，纯粹是系统代码自己造了一条 role:"user" 的消息
（只是为了有个地方挂 compaction part，本身没有文本内容）。调用方通常是
prompt.ts runLoop 的主动溢出检测（token 超阈值），或某轮 handle.process()
返回 "compact" 信号。
关键点：MessageID.ascending() 保证这条新消息的 id 比之前所有消息都大，
所以它在 message-v2.ts 的 latest() 现算 tasks 数组时，一定排在最后一位
——配合 prompt.ts 里 tasks.pop() 取末位的逻辑，压缩任务永远能插队到
比它更早排队的 subtask 前面被优先处理，不需要单独的优先级字段。
```

位置: `prompt.ts:1613-1619`(斜杠命令 `isSubtask` 判断上方)
```
【任务管理补充：什么情况会挂 subtask】只在斜杠命令（/xxx）这条路径触发，
两种条件命中其一即可：
  1) 命令绑定的 agent 本身是 mode:"subagent"（比如内置的 general/explore），
     且命令没有显式设 subtask:false 去禁用
  2) 命令配置里直接写死 subtask:true（不管 agent 是什么模式）——
     内置的 /review 命令就是这么做的（见 command/index.ts），
     因为"审查"这种任务想要一个干净独立的上下文，不希望污染主对话
```

位置: `prompt.ts:1621-1623`
```
命中 subtask 时，这条命令只产出一个 subtask 类型的 part（不是把模板
文本当成普通 text part 发给当前 agent），后续走 handleSubtask() 那条
"绕开模型直接跑子任务"的路径，而不是让当前对话的模型来回答
```

位置: `packages/opencode/src/command/index.ts:30-33`(`Info` schema 中 `subtask` 字段之前)
```
【任务管理补充】true 时强制这个命令走 subtask 队列（不管绑定的 agent
是不是 subagent 模式），false 时强制禁用；不设置则由 prompt.ts 的
command() 按 agent.mode==="subagent" 自动判断。触发逻辑见 prompt.ts
里 isSubtask 那行的注释。
```

位置: `command/index.ts:90-92`(内置 `/review` 命令定义中 `subtask: true` 字段之前)
```
【任务管理补充】真实例子：内置 /review 命令硬编码 subtask:true，
让"审查"跑在独立子任务上下文里，不把一堆 diff/文件读取塞进
当前对话的上下文——跑完只把审查结论带回来
```

位置: `packages/core/src/session/sql.ts:68-73`(`MessageTable` 定义之前)
```
【任务管理补充：message/part 表的真实存储形态】
role（user/assistant）、finish（tool-calls/stop）这些字段并不是这张表的
SQL 列，全部塞在下面 data 这一个 JSON TEXT 列里。数据库本身只知道
"这行属于哪个 session、id 是多少"，具体这条消息是不是 user、有没有
finish，要等应用层用 Effect Schema 解码 data 之后才知道
（对应 message-v2.ts 里的 info()/part() 两个转换函数）。
```

位置: `sql.ts:88-90`(`PartTable` 定义之前)
```
同理，type（compaction/subtask/tool/text/...）也在 data 这个 JSON 列里，
不是 SQL 列。message-v2.ts 的 latest()/tasks 就是把这张表全量查出来、
解出 data 之后在内存里用普通数组方法筛选，不是数据库层面的 SQL 过滤
```

---

## 六、创建 assistant 占位消息 + 中断兜底

### 六.一 创建 assistant 占位消息

位置: `prompt.ts:1271-1273`
```
【学习顺序：六】六.一 —— 创建 assistant 占位消息
先创建一个"空壳" assistant 消息占位并落库，
后面 processor 会在流式过程中不断往这条消息上追加内容
```

### 六.二 中途取消/断连兜底

位置: `prompt.ts:1291-1292`
```
六.二 —— 中途取消/断连兜底：把这条未完成的消息标记为已中止，
避免留下一条永远"进行中"的僵尸消息
```

### 六.三 processor.create

位置: `prompt.ts:1303-1305`
```
六.三 —— processor.create：拿到这一轮的 stream 处理句柄
真正"调 LLM + 流式落库"发生在下面 handle.process() 里，
详见 session/processor.ts（SessionProcessor），对应【学习顺序：十】
```

### 六.四 工具集组装

位置: `prompt.ts:1319-1323`
```
六.四 —— 工具集组装
每一轮都重新解析一次可用工具：内置工具 + MCP 工具 + 插件工具，
并结合当前 Agent 的权限规则过滤/包装（权限检查在工具真正执行时触发）
下一步：这里调的 SessionTools.resolve 详见【学习顺序：七】，
它内部又依赖 ToolRegistry，即【学习顺序：八】
```

### 六.五 结构化输出:临时注入伪工具

位置: `prompt.ts:1340-1356`
```
六.五 —— 用户要求结构化输出时，临时注入一个"伪工具"：模型必须调用它来交答案，
这是一个常见工程技巧——把"结构化输出"复用成"工具调用"协议来做，
而不是让每个 provider 自己适配 JSON mode
```

(紧接的两段【结构化输出补充】完整文本,见下方「附:结构化输出补充合集」)

位置: `prompt.ts:1361`(行尾)
```
execute() 里被调用，见 createStructuredOutputTool 定义处的补充注释
```

### 六.六 拼装 system prompt

位置: `prompt.ts:1371-1373`
```
六.六 —— 拼装 system prompt
组成部分：运行环境信息 + AGENTS.md 等 instruction 文件 + MCP server
说明 + skills 说明。这几块并行拉取（Effect.all）以减少延迟。
```

位置: `prompt.ts:1379-1384`(`MessageV2.toModelMessagesEffect(msgs, model)` 之上)
```
把内部消息格式转成 provider 需要的消息格式。
【补充】这一步就是"工具结果被塞回下一次模型请求"的具体发生地：
msgs 里已经带着上一轮落库的 tool-result（第 2 步 filterCompactedEffect
现读出来的），toModelMessagesEffect 内部把它转成 tool-* UIMessage part，
再调 AI SDK 官方的 convertToModelMessages() 转成 ModelMessage[]
（实现见 message-v2.ts 的 toModelMessagesEffect，尾部那次 convertToModelMessages 调用）。
```

位置: `message-v2.ts:406-414`(`convertToModelMessages(...)` 调用之前,更完整的版本)
```
【补充：工具结果重新进入模型上下文的具体落点】上面 for 循环已经把
DB 里状态为 completed 的 tool part（上一轮工具执行结果）转成了
`tool-${name}` 类型、state: "output-available" 的 UIMessage part
（见上面 part.type === "tool" 分支）。这里调 AI SDK 官方的
convertToModelMessages() 把它们连同 toolCallId/input/output 一起
编译成 ModelMessage[] 里配对的 tool-call + tool-result content block
——这就是 prompt.ts runLoop 每轮重新调用本函数后，能让模型"看到"
上一轮工具结果的地方。调用方见 prompt.ts 的
`MessageV2.toModelMessagesEffect(msgs, model)`。
```

### 附:结构化输出补充合集

源码里标了【结构化输出补充】的注释全部围绕同一件事:怎么把"结构化输出"复用成
"强制工具调用"来实现,以及它的成功/失败判定关卡。按逻辑顺序合并:

位置: `prompt.ts:82-87`(`STRUCTURED_OUTPUT_SYSTEM_PROMPT` 常量定义上方)
```
【结构化输出补充：这只是"引导"，不是"保证"】没有任何机制能 100% 保证模型
一定调用 StructuredOutput 工具——这段系统提示词是硬性"洗脑"模型必须用这个
工具，配合调用处的 toolChoice:"required"（强制这轮必须调某个工具，但不保证
一定是这一个），是两层"尽量让模型听话"的手段。真正兜底的是失败检测：
如果这轮模型说完了但还是没拿到结构化结果，会显式报 StructuredOutputError
而不是假装成功（见 handle.process() 调用之后 result 处理那段的补充注释）。
```

位置: `packages/schema/src/v1/session.ts:69-74`(`OutputFormatJsonSchema` 定义之前)
```
【结构化输出补充】schema 字段是调用 session.prompt(...) 的调用方自己传进来的
JSON Schema（不是模型生成的），描述了想要的 key/类型；session/prompt.ts 里
把它包成一个叫 StructuredOutput 的工具塞给模型。retryCount 默认值是 2，
看名字像是"结构化输出失败后自动重试几次"，但目前全仓库没有任何代码读取
这个字段——是设计了但还没接上的半成品，session/prompt.ts 里失败时是直接
报 StructuredOutputError，没有真正的自动重试。
```

位置: `prompt.ts:1340-1356`(六.五 紧接段落)
```
【结构化输出补充：schema 是谁定的】lastUser.format 不是模型自己生成的，
是调用 session.prompt(...) 这个 API 时，调用方在请求体里传进来的
（见 PromptInput 的 format 字段、schema/v1/session.ts 的
OutputFormatJsonSchema）。也就是说，这不是聊天框里普通用户能用的
功能，而是给"程序化调用方"用的：谁调接口，谁提前把想要的 JSON
结构（具体 key、类型）写成一份 JSON Schema 传进来。

【结构化输出补充：schema 内容怎么传给模型】下面 inputSchema 直接
就是这份 schema 本身——这个工具跟其他工具（read/write/bash）一样
被塞进 tools 字典，一路传到 llm.stream()，最终由 AI SDK/provider
API 把工具的 name+description+inputSchema 序列化进请求体发给模型。
这是"工具调用协议"本身自带的能力，不需要专门写代码把 schema 文本
塞进 system prompt。
```

位置: `prompt.ts:1394-1395`
```
【结构化输出补充】引导手段①：塞进 system prompt 硬性要求；
引导手段②见下面 handle.process() 里的 toolChoice
```

位置: `prompt.ts:1427-1430`(`toolChoice: format.type === "json_schema" ? "required" : undefined` 之上)
```
【结构化输出补充】引导手段②："required" 只保证这轮必须调用
某一个工具，不保证一定是 StructuredOutput——如果这轮还有别的
工具可选，模型理论上还是可能调错。真正让模型倾向选对工具的，
主要靠上面塞进 system prompt 的硬性文字要求。
```

位置: `prompt.ts:1434-1437`(关卡①,`if (structured !== undefined)` 分支之上)
```
【结构化输出补充：关卡①——成功路径提前 return】
structured 是上面 createStructuredOutputTool 的 onSuccess 回调
设置的闭包变量。只要模型这轮真的调用过 StructuredOutput 且参数
校验通过，这里就已经 return 掉了，不会往下走到关卡②③。
```

位置: `prompt.ts:1445-1449`(关卡②)
```
【结构化输出补充：关卡②——这轮是不是真的"说完了"】
finish 是 "tool-calls" 说明模型还在调用工具（可能包括调用
StructuredOutput 但参数不合法、还没修正完），此时 finished 为
false，会直接 continue 到下一轮，把工具报错结果喂回去，
给模型机会自己纠正重试——不会走到下面的报错分支。
```

位置: `prompt.ts:1464-1471`(关卡③)
```
【结构化输出补充：关卡③——真正的失败判定】能走到这一行，说明
上面两关都已经排除了"成功"和"还在处理中"的情况：structured
仍是 undefined（没拿到结果）且 finished 为真（模型确实把话
说完了，不是还在调工具）。这时候才认定为真失败——模型完全
没搭理 StructuredOutput，直接用大白话回复了。retries: 0 是
写死的值，目前没有自动重试逻辑消费它（Format.retryCount 这个
schema 字段也一样，定义了但全仓库没人读它），所以现状就是
直接报错给调用方，不会自动重试。
```

位置: `prompt.ts:1749-1757`(`createStructuredOutputTool` 函数定义之前)
```
【结构化输出补充：伪工具的完整实现】这就是被塞进 tools 字典的那个
"StructuredOutput" 工具的真身。关键点都在这几行里：
  - inputSchema 直接等于调用方传进来的 schema——工具的参数定义就是
    用户要的 JSON 结构本身，靠 AI SDK 的工具协议免费把它传给模型
  - execute() 能被调用，前提是 AI SDK 已经拿 inputSchema 校验过模型
    传来的参数（校验不通过就不会走到这里，而是产生一次工具调用错误，
    反馈给模型让它重试）
  - execute() 里除了记录结果（input.onSuccess，就是六.五里设置 structured
    变量的那个回调）什么真正的活都没干，纯粹是"接住模型交上来的答案"
```

---

## 七、工具解析适配层:ToolRegistry → AI SDK 格式

### 七.一 总览

位置: `packages/opencode/src/session/tools.ts:39-46`
```
【学习顺序：七】七.一 —— 工具解析总览：把 ToolRegistry 里的工具"翻译"成 AI SDK 认识的格式
每一轮循环都会重新调用一次（见 prompt.ts runLoop 的六.四）。核心工作：
  1. 从 ToolRegistry 拿到这个 Agent/Model 组合下可用的工具定义列表（七.二）
  2. 用 AI SDK 的 tool() 包一层，真正的 execute 桥接到 Effect 世界执行（七.三）
  3. 权限检查(ask)/进度上报(metadata)都通过 Tool.Context 注入给工具实现
也就是说，"工具"这个概念在两层世界里长得不一样：ToolRegistry 里是
Effect-based 的纯函数式实现，AI SDK 层面看到的是普通 async execute()。
这个函数就是两者之间的适配层。
```

位置: `tools.ts:64-67`(`context()` 工厂函数定义之上)
```
context() 是个工厂函数：每次某个工具真正 execute() 时都会重新调用一次，
用这次调用自己的 options.toolCallId 生成一份专属的 Tool.Context ——
下面 metadata/ask 两个闭包都捕获的是"这一次调用"的 toolCallId，
不会跟同一 session、甚至同一工具的其它调用互相影响。
```

位置: `tools.ts:76-78`(`metadata` 字段之上)
```
metadata：工具执行过程中上报"进度信息"用的（比如标题、当前在干嘛），
只更新这一次 toolCallId 对应的那条 ToolPart 记录，跟权限无关。
如果这条记录已经 complete/error 了就不再覆盖（防止异步上报把状态错误地改回 running）。
```

位置: `tools.ts:93-95`(`ask` 字段之上)
```
ask：真正管权限的地方。工具实现里如果需要用户确认（比如 bash/task 这类敏感操作），
调 ctx.ask(...) 会走到 Permission.Service，按 agent + session 的权限规则
（ruleset）判断要不要弹确认框、或者直接放行/拒绝。
```

### 七.二 registry.tools 过滤

位置: `tools.ts:107-109`
```
七.二 —— registry.tools(...) 按当前 model/provider/agent 过滤出这次能用的工具集
（不同模型对工具数量/schema 复杂度有限制，不同 Agent 有不同工具白名单）
这里的 registry 就是 ToolRegistry.Service，工具的来源汇总见【学习顺序：八】
```

位置: `tools.ts:115-118`(【架构分层 · 第①层】)
```
【架构分层 · 第①层：AI SDK Tool Wrapper】这里往下到 execute() 结束，
是整条链路里唯一跟"AI SDK 要求工具长什么样"打交道的地方——只关心
"怎么包一层壳给 AI SDK 用"，不关心工具内部具体干了什么业务逻辑。
下一层（②工具抽象层 Tool.define/wrap）在 tool/tool.ts。
```

### 七.三 execute 桥接

位置: `tools.ts:123-134`
```
七.三 —— AI SDK 要求 execute 是返回 Promise 的普通函数，但工具的真正实现
(item.execute) 是 Effect。run.promise(...) 就是 EffectBridge 提供的
"把一段 Effect 当 Promise 跑起来"的桥接方法——这是整个工程里
Effect 生态和外部 JS 生态（这里是 AI SDK）打交道的典型模式。
下一步：工具从哪来 —— 看【学习顺序：八】(packages/opencode/src/tool/registry.ts)

【补充】这个 execute 不是被 OpenCode 自己的代码调用的，而是被 AI SDK
内部的 executeToolCall()（node_modules/ai dist/index.js，`tool2.execute
.bind(tool2)`）在 streamText() 收到模型的 tool-call 后同步调用的——
也就是说，从"模型吐出 tool-call"到"这个函数被执行"，中间没有经过
OpenCode 的 runLoop/processor，是 AI SDK 一条内部路径直接触发的。
调用时机是同一次 streamText() 内部的当前 step，不是下一次模型调用。
```

位置: `tools.ts:139-141`
```
【plugin.trigger 补充】只是"钩子总线"：遍历所有已加载插件，
谁实现了同名 hook 就调一下，本身不做功能，效果取决于插件实现。
before/after 这两个点目前没有任何内置插件占用，是留给自定义插件的空位。
```

位置: `tools.ts:147`(行尾)
```
真正的工具逻辑（读文件/写文件/跑命令...）
```

位置: `tools.ts:148-150`
```
【attachments/part 补充】这里不是新建一条独立 Part，而是把产出的文件
塞进这条 ToolPart 自己的 state.attachments 里（长得跟 FilePart 一样，
有自己的 id/sessionID/messageID，方便 UI 复用同一套渲染组件）。
```

位置: `tools.ts:165-169`
```
【abort 检查补充】options.abortSignal 是活的共享对象，不是快照值——
item.execute 跑的这段时间里，外部（用户点停止）可能异步把它 abort 掉。
正常落库靠 processor.ts 的 tool-result 流事件，但流一旦被中断，
那个事件大概率不会再来，所以这里执行完顺便自己兜底写一次，
防止这条 ToolPart 永远卡在 running（僵尸记录）。
```

位置: `tools.ts:179-184`
```
【七.三 到此结束】小结：七.三就是这个 execute()——用 run.promise 把 Effect
桥接成 AI SDK 要的 Promise，前后触发 plugin 钩子，中间调 item.execute 跑真正的
工具逻辑。看到这里，主链路（七.一→七.二→七.三）就完整了，可以直接跳去
【学习顺序：八】(tool/registry.ts) 看工具是从哪、怎么汇总出来的。
下面到 hasMcpResourceServer 为止是 MCP resource 相关的几个内置工具注册，
是主链路的旁支细节，不影响理解八，可以先跳过。
```

---

## 八、工具注册表:builtin / custom / plugin 三来源

### 八.一 三来源汇总

位置: `packages/opencode/src/tool/registry.ts:89-94`(RuntimeFlags 补充)
```
【flag 补充】RuntimeFlags.Service（effect/runtime-flags.ts）：一批"功能开关"，
大部分是读环境变量（比如 OPENCODE_ENABLE_EXA / OPENCODE_EXPERIMENTAL_LSP_TOOL），
没设置就用默认值（通常是 false）。跟这个项目里其它 Service 一样走 DI 注入，
谁想用就 yield* 一下。作用：控制实验性功能/工具要不要暴露出来，
不用改代码结构，改环境变量就能灰度开关（比如上面 questionEnabled、
flags.experimentalLspTool、flags.enableExa 这些判断）。
```

位置: `registry.ts:115-121`
```
【学习顺序：八】八.一 —— 工具注册表：统一收拢三类工具来源
1) builtin：内置工具（read/write/edit/grep/glob/shell/task/...），代码里直接 import
2) custom：项目目录下 tool/*.ts、tools/*.ts 里用户自定义的工具文件（动态 import）
3) plugin：插件系统注册的工具（p.tool）
（注：MCP server 提供的工具不在这张表里统一管理，是在 session/tools.ts
里单独通过 MCP.Service 合并进最终工具集的，属于另一条来源）
InstanceState.make 表示这份状态是"每个工作目录一份"、懒加载并缓存的
```

位置: `registry.ts:124`
```
1. 准备 custom 工具
```

位置: `registry.ts:127-131`(fromPlugin,旁支)
```
【八.一 旁支，可跳过】fromPlugin：把"插件/自定义工具"作者写的 ToolDefinition
（用 Zod 描述参数）适配成内部统一的 Tool.Def（用 JSON Schema）。
只有你自己要写插件工具、或者好奇 Zod→JSON Schema 怎么转时才需要细看，
不影响理解"工具是怎么流转到 LLM 的"这条主线，可以直接跳到下面 204 行。
2. 定义一个转换器；Plugin ToolDefinition -》fromPlugin -》 Internal Tool.Def
```

位置: `registry.ts:141` / `146` / `163` / `170`
```
2.1. 转参数 schema
2.2. 返回统一工具格式
调插件自己的 execute, def.execute(...), 把Promise变成Effect
整理输出
```

位置: `registry.ts:194-197`(custom 来源汇总,旁支)
```
【八.一 旁支，可跳过】custom 来源汇总：扫描项目目录下 tool/*.ts、tools/*.ts
动态 import，再加上所有插件里 p.tool 挂出来的工具，统一走 fromPlugin() 适配。
这部分只是"custom 工具从哪来"的细节，主线不需要逐行看。
3. 找项目里的自定义工具
```

位置: `registry.ts:214`
```
4. 找插件提供的工具
```

位置: `registry.ts:223-224`
```
【八.一 主线，从这开始要看】questionEnabled 是个典型的"功能开关"写法：
新工具/新客户端能力上线前先用 flag 挡住，而不是直接全量放开。
```

位置: `registry.ts:227-229`
```
Tool.init(...) 这一串就是"内置工具"的真正清单——每个都是代码里 import 进来的
具体实现（read/write/edit/shell/task/...），跟上面 custom（用户/插件工具）是两条不同来源。
5. 初始化内置工具
```

位置: `registry.ts:249-252`
```
builtin 数组：注意 question/lsp/plan 是用 `...(flag ? [x] : [])` 这种写法
按 flags 条件性塞进去的——同样是"功能开关"模式，实验性工具先只在部分
客户端/配置下暴露给模型，验证稳定了再放开给所有人。
6. 返回全量工具注册表
```

位置: `registry.ts:278-279`
```
【八.一 到此结束】小结：state 就是"全量工具表"，builtin + custom 两条来源，
每个工作目录懒加载一次、缓存住（InstanceState）。看到这就够了。
```

位置: `registry.ts:281-282`
```
下面 all/ids 只是读 state 的简单 getter，describeTask 是给 task 工具生成
"有哪些 subagent 可调"的说明文字，都是次要细节，可以直接跳到八.二。
```

### 八.二 每次调模型前按 model 再过滤

位置: `registry.ts:307-311`
```
八.二 —— 每次调模型前实际拿到的工具集：在全量工具基础上按 model/provider 再过滤一层。
典型例子：部分 GPT 模型更适配 apply_patch 风格而不是 edit/write 风格，
这里按 modelID 字符串特征做二选一，而不是把两套工具都暴露给模型增加干扰。
这就是 tools.ts 七.二里调的 registry.tools(...)。
下一步：回到【学习顺序：九】(session/prompt.ts 里 handle.process() 调用处)
```

位置: `registry.ts:313-314`
```
【工程点】这里没有维护一张"模型能力表"，而是直接按 modelID 字符串特征
（比如包含 "gpt-"）临时判断——简单粗暴但好维护，新模型不用改结构只加个条件。
```

位置: `registry.ts:328-329`
```
concurrency: "unbounded" ——纯 CPU/内存操作居多（就一次 plugin.trigger 可能是 async），
没有需要限流的外部资源，所以不设并发上限，能并行就都并行跑。
```

位置: `registry.ts:338-341`
```
【新 hook 补充】tool.definition：跟之前讲过的 tool.execute.before/after
是同一套钩子机制，但触发时机更早——在"要不要把这个工具给这轮 LLM"
之前，插件还能顺手改一次它的 description/schema（等于是运行期动态改
工具说明书，而不是改工具的执行逻辑）。
```

位置: `registry.ts:361-363`
```
【八.二 到此结束】小结：filter（按 model 二选一/开关）+ tool.definition 钩子
+ 拼 task 工具的动态说明文字，就是每轮真正塞给 LLM 的工具集怎么来的。
主线到这里结束，可以直接回【学习顺序：九】(session/prompt.ts)。
```

位置: `registry.ts:365-367`
```
下面 named()/Service.of(...)/node 都是标准的 DI 收尾（跟其它 Service 文件同一套写法），
329 行往后（isZodType...normalizeZodJsonSchema）是 Zod→JSON Schema 的兼容层细节，
只在给插件工具的参数 schema 排查问题时才需要看，主线可以直接跳过、不用往下翻了。
```

### 附:四层架构具体走查(以 glob 为例)

位置: `packages/opencode/src/tool/glob.ts:10-16`
```
【工具补充：一个最小的工具长什么样】以 glob 为例，三件套：
1) Parameters —— Schema 描述参数，每个字段的 description 会被转成 JSON Schema
   发给模型看（对应【学习顺序：七】tools.ts 里的 ToolJsonSchema.fromTool）
2) description（DESCRIPTION，从 glob.txt 读的一段文字）—— 工具本身的说明书
3) execute —— 真正干活的地方，返回值形状是 tool.ts 里的 ExecuteResult
   { title, metadata, output, attachments? }，跟七.三/processor.ts 存进
   ToolPart.state 的字段完全对应
```

**第②层:OpenCode Tool 抽象层**

位置: `packages/opencode/src/tool/tool.ts:99-103`
```
【架构分层 · 第②层：OpenCode Tool 抽象层】wrap() 是所有工具共用的一层壳，
跟具体某个工具（glob/read/bash...）无关：统一做参数校验/解码（Schema）、
校验失败转成 InvalidArgumentsError、执行完统一跑一遍 truncate.output。
每个具体工具（第③层）只需要提供 { description, parameters, execute }，
这些"通用麻烦事"在这里一次性做掉，不用每个工具自己重复写。
```

**第③层:具体工具业务层(GlobTool)**

位置: `glob.ts:24-27`
```
【架构分层 · 第③层：具体工具业务层】GlobTool 自己不知道、也不关心 AI SDK
或 wrap() 怎么包装它——它只负责"glob 搜索"这一件具体业务：参数长什么样、
权限怎么问、结果怎么整理成文本。它依赖的 Ripgrep.Service（第④层）是
更底层的通用能力，随便哪个工具想搜文件都能复用，不必自己再实现一遍。
```

位置: `glob.ts:36-38`
```
execute 收到的 params 已经是按上面 Parameters 校验/解码过的（校验逻辑在
tool.ts 的 wrap() 里做，校验失败会变成 InvalidArgumentsError 让模型重写参数）；
ctx 就是 session/tools.ts 七.一里那个 context()，metadata/ask 都在这传进来
```

位置: `glob.ts:42-44`
```
这个工具自己的权限检查：调用前问一下"能不能按这个 pattern 搜文件"，
走的还是七.一 context() 里那个 ctx.ask，最终到 Permission.Service
1. 权限检查
```

位置: `glob.ts:55` / `57` / `59` / `64` / `69` / `74`
```
2. 决定搜索目录
3. 转绝对路径
4. 检查是不是文件
5. 检查是否访问项目外目录
6. 真正搜索
7. 整理模型能读懂的结果
```

位置: `glob.ts:87-89`
```
返回值就是 ExecuteResult：title 给 UI 显示一行摘要，output 是真正
喂回给模型当"工具结果"的文本，metadata 是给 UI/插件用的结构化附加信息
8. 返回 Tool Result
```

**第④层:底层能力层(Ripgrep.Service)**

位置: `packages/core/src/ripgrep.ts:85-89`
```
【架构分层 · 第④层：底层能力层】Ripgrep.Service 不知道"工具""AI SDK""LLM"
这些概念的存在——它就是对 rg（ripgrep 二进制）这个外部程序的一层薄封装
（下面 glob/grep 实现最终都是 spawn 子进程去跑 rg，见 run() 里的 process.spawn）。
谁都能用：GlobTool 用它做文件名匹配，GrepTool 用它做内容搜索。
复用的是"能力"，不是"工具"——这一层完全不关心调用方是不是在响应模型请求。
```

---

## 九、唯一真正调用大模型的地方 + 收尾三道关卡

位置: `prompt.ts:1398-1411`
```
【学习顺序：九】整个循环里唯一一次真正调用大模型的地方
一轮 = 一次 handle.process()。内部会调用 llm.stream() 发起流式请求，
边收流边把 text/tool-call 等增量事件持久化并推给前端，
工具调用也在这内部被执行、结果被塞回。这里只关心它的返回结果
(stop / compact / 其它)，具体怎么消费 stream 是 processor.ts 的事
——去看【学习顺序：十】(packages/opencode/src/session/processor.ts)

【补充：这一次 handle.process() = 一次 streamText() = 最多一次模型
API 调用】llm.ts 调 streamText() 时没传 stopWhen，AI SDK 默认
stopWhen=stepCountIs(1)，所以哪怕这一步模型请求了工具、AI SDK
也只会在这一次调用内部自动把工具跑完，不会自己再发第二次模型
请求。工具结果需要"喂回模型"的话，靠的是外层 runLoop 检测到
hasToolCalls 为真后，回到 while(true) 顶部重新走一遍本函数、
重新发起一次新的 handle.process()——即下一轮的这一行。
```

位置: `prompt.ts:1421-1422`
```
到达最大步数前的最后一轮，追加一条提示让模型收尾，
而不是硬生生掐断
```

位置: `prompt.ts:1482-1486`(【学习顺序：十三】提前列在这里,因为紧跟在 handle.process() 之后)
```
【学习顺序：十三】这一轮怎么收尾，决定 continue 还是 break
三种收尾方式：正常结束(stop) / 发现超限需要压缩(compact，排队下一轮处理)
/ 其余情况一律 continue —— 意味着有 tool-calls，下一轮 while 循环
会重新读库拿到工具执行结果，继续喂给模型
（回到【学习顺序：三】的 while(true)，形成完整闭环）
```

---

## 十、process():驱动 llm.stream + 消费事件 + drain

位置: `packages/opencode/src/session/processor.ts:768-781`
```
【学习顺序：十】十.一 —— process()：这一轮里唯一真正"打模型"的地方
被 prompt.ts 的 runLoop 在每轮循环里调用一次（对应【学习顺序：九】）。核心三行是：
  1. const stream = llm.stream(streamInput)   —— 发起流式请求，去看【学习顺序：十一】(session/llm.ts)
  2. Stream.tap(handleEvent)                  —— 每个事件都实时落库/推送，去看【学习顺序：十二】(本文件上方 handleEvent)
  3. Stream.runDrain                           —— 把流耗尽，等这一轮彻底结束
外层包了三层防护：中断处理(onInterrupt)、按 provider 定制的重试策略
(SessionRetry.policy，比如 429 限流退避)、以及兜底 halt() 落错误。

【补充】一次 process() = 一次 llm.stream()（即 llm.ts 里一次 streamText()
调用）。因为 streamText() 没被传 stopWhen，AI SDK 默认 stopWhen=
stepCountIs(1)，工具会在这次调用内部被自动执行，但结果不会被
AI SDK 自动喂回去发起第二次模型请求——这次 process() 跑完就结束了。
"工具结果需要再问一次模型" 不是这个函数的职责，是外层 runLoop
检测到还有未处理的 tool part 后，重新调一次全新的 process()。
```

位置: `processor.ts:795`(行尾)
```
十.二 —— 真正发请求，见【学习顺序：十一】session/llm.ts
```

位置: `processor.ts:798`(行尾)
```
十.三 —— 逐事件消费、落库，见【学习顺序：十二】
```

位置: `processor.ts:799`(行尾)
```
一旦发现要压缩就提前掐断流，不用等模型说完
```

位置: `processor.ts:815-816`
```
十.四 —— provider 相关的自动重试（限流/瞬时错误等），带指数退避，
重试期间通过 status.set 把"重试中"状态推给前端而不是假装卡住
```

位置: `processor.ts:836-837`
```
十.五 —— 这个返回值就是 prompt.ts 里 runLoop 拿到的 result（回到【学习顺序：九】旁边的 result）：
决定下一轮是"排队压缩"还是"直接结束"还是"继续问模型"
```

---

## 十一、Provider 抽象层,统一事件流,AbortController 生命周期

### 十一.一 总览(精读)

位置: `packages/opencode/src/session/llm.ts:54-65`
```
【学习顺序：十一】十一.一 —— Provider 抽象层（精读，54~65 行，到下面 `class Service` 那行结束）
processor.ts（十）只认识一种东西：Stream<LLMEvent>（provider 无关的统一事件流）。
这个模块负责把"任意 provider 的具体请求方式"适配成这一种流，屏蔽掉
OpenAI/Anthropic/Gemini 等各家 API 形态的差异。内部实际有两条实现路径
(见下面 stream 的实现，十一.二)：默认走 Vercel AI SDK 的 streamText；
灰度开关 experimentalNativeLlm 打开时走自研的 @opencode-ai/llm 原生实现。
两条路径最终都被拍平成同一种 LLMEvent 流，processor.ts 完全不关心走的是哪条。

读完这 12 行就可以直接跳到本文件 364 行的十一.二（对外入口 stream 函数）。
中间 67~362 行（下面 `live` 这个 Layer 的实现，核心是 run() 函数）是选读：
装的是 GitLab Workflow 特判、native/ai-sdk 路径切换、streamText 参数拼装
这些"某个 provider 具体怎么适配"的细节，不影响理解主链路。
```

位置: `llm.ts:97-101`(选读部分导览)
```
────────── 92~362 行是 run() 的实现：选读，想跳过直接看第 364 行的十一.二 ──────────
只有两条路径最终产出 LLMEvent 流：native runtime（233 行起，灰度开关
experimentalNativeLlm）和默认的 AI SDK streamText（278 行起，最终 return 的那个）。
中间 122~213 行是 GitLab Workflow 模型的特判逻辑（工具执行桥接 + 审批流程），
只有 language 是 GitLabWorkflowLanguageModel 时才会触发，可以先跳过不看。
```

位置: `llm.ts:244`
```
← 调用大模型（灰度路径）：走自研 @opencode-ai/llm，绕开 AI SDK 直接发请求
```

位置: `llm.ts:298-310`(`streamText({...` 之前 —— 全文档里最关键的一段工程结论之一)
```
← 调用大模型（默认路径）：Vercel AI SDK 的 streamText，真正发 HTTP 请求给
provider 的地方就是这一行；下面一大坨都是传给它的参数（工具、消息、温度等）

【补充：关键——这里没有传 stopWhen / prepareStep】AI SDK 的默认值是
stopWhen = stepCountIs(1)（ai/dist/index.js:6459，即 streamText 解构
参数默认值），意味着这一次 streamText() 调用内部最多只跑 1 个 step：
如果模型这一步请求了工具，AI SDK 会在这次调用内部自动执行
tool.execute()（tools.ts 里注册的那个），但执行完因为 stepCountIs(1)
已经满足停止条件，不会自动把工具结果塞回去再发第二次模型请求，
而是直接 finish 这个 stream。"工具结果喂回模型" 这件事是 OpenCode
在应用层自己实现的（prompt.ts 的 runLoop while(true) + hasToolCalls
判断），跟 AI SDK 自带的多 step 循环能力（stopWhen 调大就能用）无关，
当前代码根本没启用后者。
```

### 十一.二 对外唯一入口

位置: `llm.ts:388-395`
```
十一.二 —— 对外唯一入口（精读，364~392 行，到下面 `)` 收尾那行结束）：
processor.ts 十.二里的 `llm.stream(streamInput)` 调的就是这个。
Stream.scoped + AbortController：session 中断/超时时通过 scope 释放
自动触发 abort，不需要在每个调用点手动管生命周期。
拿到这个事件流后，回到【学习顺序：十二】(processor.ts 的 handleEvent) 继续看怎么消费

到这里十一就读完了。394~416 行是 Service/Layer/node 的装配样板代码，
跟其他模块长得几乎一样（对照 registry.ts 八就认得），不用细看。
```

---

## 十二、handleEvent:逐事件落库(打字机效果来源)+ doom_loop 检测

### 十二.一 流式事件消费入口

位置: `processor.ts:284-307`
```
【学习顺序：十二】十二.一 —— 流式事件消费入口
llm.stream()（十一）吐出的是 provider 无关的统一事件流（reasoning-*/text-*/
tool-input-*/tool-call/tool-result/finish...），这里按事件类型 switch，
核心模式是：每来一个事件就立刻调 updatePart 或 updatePartDelta 一次，
这正是"边生成边展示"打字机效果的来源。
（虽然定义在文件靠前的位置，但实际是被十.三的 Stream.tap 调用的）

【追踪结论：updatePart 和 updatePartDelta 并不是同一量级的持久化】
updatePart（全量 Part）发布的是 durable 事件（PartUpdated），会在同一个
SQLite 事务里被 projector 写进 PartTable（packages/core/src/session/
projector.ts:312-330），是唯一真正落库的写入路径。
updatePartDelta 发布的是 PartDelta（schema/v1/session.ts:638-647 的定义
没有 durable 字段），走的是纯内存 PubSub（event.ts:393 notify(event,false)），
从头到尾不碰数据库——每个 delta 单独来看是不落库的，"进程崩溃也不丢"
这个说法不准确，实际要分两种情况（细节见下面 text-delta/text-end 的注释）：
  · 优雅停止（用户主动停止、Effect scope 正常退出）：cleanup() 会跑，
    把 ctx.currentText 里累积的完整文本兜底 updatePart 一次，通常能保住
    停止前收到的全部内容；
  · 硬崩溃（kill -9、断电、运行时直接崩溃、被操作系统杀掉）：
    cleanup() 根本没机会跑，数据库里这个 TextPart 只停在上一次全量
    updatePart 的内容（通常是 text-start 时写的空字符串），
    text-start 到崩溃之间的所有 delta 全部丢失——它们只存在于
    后端 RAM（ctx.currentText）、前端 RAM、和已经广播出去但不落库的
    PubSub 事件里，没有任何一份是持久化的。
```

位置: `processor.ts:311-313` / `342-343` / `351-352` / `360` / `365` / `371-373`(reasoning/tool-input 各 case)
```
模型开始吐"思考"内容（如 extended thinking / reasoning token）。
用 value.id 建一条新的 reasoning part 并立即落库；
ctx.reasoningMap 按 id 索引，因为同一轮里可能有多段并行的 reasoning。

这段 reasoning 流结束：补上最后一次 providerMetadata，
再调 finishReasoning 写入 end 时间戳并做最终落库、清出 reasoningMap。

模型开始流式吐出某个工具调用的入参（此时 JSON 参数还没吐完）。
生成"摘要"（压缩历史用的 summary 消息）时不允许再调工具，直接抛错中断。

工具入参 JSON 的增量片段，ensureToolCall 负责按 id 找到/创建对应 part 并追加。

入参 JSON 流式吐完（还只是原始字符串阶段，未必已解析成可执行的结构化 input）。

入参已经解析完整、工具即将真正执行前的事件：把 part 状态切到 running，
并记录 providerExecuted（部分 provider 如 Anthropic 的内置工具会自己执行，
不走【学习顺序：七】那套本地 execute()）。同一 summary 限制在这里再校验一次。
```

### 十二.二 死循环检测(doom_loop)

位置: `processor.ts:413-419`
```
十二.二 —— "死循环"检测（doom_loop）【工程实践：熔断/限流式防御】
不是在代码里判断"这个工具有没有副作用"，而是用行为模式（连续同参数重复调用）
做通用熔断——不针对具体工具白名单，天然能覆盖未来新增的工具。
工程上的一个防御设计：如果最近连续 DOOM_LOOP_THRESHOLD(=3) 次
工具调用都是同一个工具、同样的入参，说明模型大概率卡在死循环里
空转（比如反复读同一个文件却没有进展）。这种情况不会自动 kill
会话，而是转成一次权限询问，交给用户判断是否要继续放行。
```

位置: `processor.ts:421-439`
```
【追踪结论：这个 permission.ask() 挡不住"当前这第三次"工具的执行】
时序真相（源码验证于 node_modules/ai@6.0.168 dist/index.js）：
AI SDK 的 runToolsTransformation（dist/index.js:6293 case "tool-call"）
里，controller.enqueue(toolCall) 推出这个 tool-call 事件之后，
紧接着（同一同步代码块、不 await）就调了 executeToolCall(...)
（dist/index.js:6346，内部走到 tools.ts:128 的 execute()）——
enqueue 不等任何下游消费者处理完，Stream.tap(handleEvent) 也不会
对 AI SDK 的生产端形成背压。等这里的 yield* permission.ask(...)
真正被用户点击 Allow/Deny 唤醒时（通常要等几秒到几十秒的人类反应
时间），这第三次工具调用大概率已经执行完了。
参考本文件上面 create() 里 initialSnapshot 那行注释——作者自己
也踩过这个坑（"AI SDK may execute tools internally before
emitting start-step events"），是同一个时序问题的另一个体现。
所以这个 doom_loop 询问的实际作用是：
  1) Deny 时把错误抛出去，让本轮流提前结束（halt()），
     阻止模型在同一轮里继续瞎调工具——但已发生的副作用无法撤销；
  2) Allow once/always 时只是让 handleEvent 这个 case 正常返回，
     Stream.tap 才能继续消费下一个事件（大概率是早就产出的
     tool-result）——不是"重新执行"或"恢复暂停的调用"。
```

**附:permission.ask()/reply() 挂起-唤醒机制的具体实现**

位置: `packages/opencode/src/permission/index.ts:49-54`(finalizer)
```
【追踪结论：pending 是纯内存 Map，不落库、不跨进程可恢复】
权限请求（doom_loop、文件写入确认等）只存在于这个进程当次运行的
InstanceState 里，没有对应的数据库表或事件溯源记录。下面这个
finalizer 就是证据：一旦这个 Service/Layer 的 scope 结束（进程退出
或服务重启），所有还没被回复的请求会被自动 Deferred.fail 成
RejectedError——也就是自动拒绝，而不是留到下次进程启动后继续等。
```

位置: `permission/index.ts:73-79`(`ask()`)
```
【追踪结论：ask() 挡的是"要不要继续往下跑这段代码"，不是"工具能不能跑"】
调用方（比如 processor.ts 的 doom_loop 检测）yield* 这个函数时，如果命中
needsAsk，会在下面 Deferred.await(deferred) 真正挂起当前 Effect fiber，
直到 reply() 被调用。但这个 Deferred 只存在于 OpenCode 自己的调用链里——
如果调用方是在 AI SDK 已经把工具丢出去执行之后才调 ask()（doom_loop 正是
这种情况，AI SDK 的 executeToolCall 不等任何消费者），那么工具本身的
执行早已跟这个 Deferred 脱钩、独立跑着，ask() 挂起/恢复对它没有任何影响。
```

位置: `permission/index.ts:155-162`(`reply()`)
```
【追踪结论：Allow once 和 Always allow 共用同一行 Deferred.succeed】
区别只在这行之后：once 直接 return，不碰 approved；always 才会往
approved（进程内存数组，同样不落库）里追加规则，并且顺便把其它
命中新规则的 pending 请求也一并唤醒（下面 166-179 行）。
唤醒这个 Deferred 之后，真正发生的事情是：调用方那边 yield*
permission.ask(...) 挂起的那一行恢复执行——不是重新调用工具，
工具本身是否已经执行完全不受这次唤醒影响（doom_loop 场景下几乎
总是已经执行完了，见 processor.ts 里 doom_loop 那段补充注释）。
```

### 十二.三 工具执行结果落库

位置: `processor.ts:451-466`
```
十二.三 —— 工具的真正执行（读写文件/跑命令等）不在这个文件里发生——
真正的 execute() 挂在 AI SDK 的 tool() 定义上（对应【学习顺序：七】session/tools.ts），
AI SDK 在内部跑完工具后才会吐出这个 tool-result 事件，
这里只是把结果规范化（图片等附件处理）后落库、并唤醒等待方
到这里，一整轮"调模型 -> 收流 -> 执行工具 -> 结果落库"就闭环了，
回到【学习顺序：十三】(session/prompt.ts 里 result 处理那段)

【补充】"AI SDK 在内部跑完工具"具体是指：streamText() 收到模型的
tool-call 后，在同一次调用内部同步执行 tool.execute()（源码见
node_modules/ai dist/index.js 的 executeToolCall/executeTools），
这个 tool-result 事件就是那次内部执行的结果，被 llm.ts 的
LLMAISDK.toLLMEvents 转成统一格式后流出来的。执行完这一步，
streamText() 这次调用就会因为 stopWhen 默认 stepCountIs(1) 直接
finish——不会自己再拿着这个结果去问模型。真正"拿结果再问模型"
由外层 prompt.ts 的 runLoop 检测到未消化的 tool part 后，
发起下一轮全新的 process() 完成，不在这个文件的职责范围内。
```

位置: `processor.ts:468-469` / `477-481` / `495-497` / `511-512` / `518-519`
```
【工程实践】幂等/竞态防御：读不到 toolCall 又是 error 结果，说明这个调用
可能已经被别处（比如中断/doom_loop 提前拒绝）处理过了，直接丢弃而不是硬报错。

【工程实践】"部分失败不拖垮整体"：这里没有用 Effect.forEach 的默认失败语义
（一个 attachment 处理失败就整批 fail），而是用 Effect.exit 把每个 attachment 的
成功/失败都转成一个值（相当于 Effect 版的 Promise.allSettled），
再配合 Effect.catchIf 只窄化捕获 ResizerUnavailableError 这一种可预期的失败——
其他未预料的错误仍会照常抛出、不会被静默吞掉。

【工程实践】优雅降级而非报错中断：处理失败的图片直接从结果里剔除，
并在文本里追加一句人类可读的提示（而不是让整个 tool-result 失败），
保证工具调用本身仍能成功推进主循环。

和 tool-result 里 result.type === "error" 不同：这是 AI SDK/provider 层面
执行工具时直接抛出的异常（而不是工具正常返回了一个"错误结果"），统一走 failToolCall 落库为失败态。

LLM provider 返回的错误（比如 API 报错），这里直接抛出，
会被外层 process() 的 halt() 捕获并落成消息级错误、结束本轮。
```

### 附:snapshot(工作区快照)在 handleEvent 里的落点

位置: `processor.ts:99-109`(`create()` 内 `initialSnapshot`)
```
【补充：这条注释就是"AI SDK 生产端不等消费端"的第一手证据】
这里之所以要把快照挪到流开始之前，而不是等 case "step-start"
里再 track()，正是因为 AI SDK 的工具执行（executeToolCall）跟它
emit 事件之间没有同步关系——见 case "tool-call" 里 doom_loop
那段补充注释、以及 node_modules/ai dist/index.js:6293-6376。
如果在 step-start 事件处理器里才拍快照，工具可能已经把文件改完了，
快照就成了"改完之后"的状态，没法再当基线去 diff 出改动。
```

位置: `processor.ts:523-524`(`case "step-start"`)
```
AI SDK 里"一个 step"大致对应模型的一次响应轮次（可能包含若干工具调用）。
第一次进入 step 时打一次工作区快照（snapshot.track），用于 step-finish 时 diff 出文件改动。
```

位置: `processor.ts:536-539`(`case "step-finish"`)
```
一个 step 结束：收尾这个 step 里所有还开着的 reasoning part，
结算这一 step 的 token 用量/花费并累加到 assistantMessage 上，
再和 step-start 时的快照 diff 出文件补丁（patch part），
顺带异步触发一次历史摘要检查，以及是否需要触发上下文压缩（needsCompaction）。
```

位置: `processor.ts:561-569`
```
【补充：patch part 的正常产出点就是这里，cleanup() 里那份是异常兜底】
ctx.snapshot 是 create() 里流开始前拍的基线（见上面 initialSnapshot
那段注释）。这里拿它跟当前工作区 diff 出这个 process() 调用期间
（因为 stopWhen 默认 stepCountIs(1)，等于这一整轮 streamText()）
工具改动过的文件列表，写一条 PatchPart，然后把 ctx.snapshot 清空。
正常走完 step-finish 就会在这里消费掉它；如果流中途被中断/报错、
根本没走到这个 case，本文件下面 cleanup()（Effect.ensuring 保证
任何退出路径都会跑）里有一份几乎一样的兜底代码，兜底同样会
消费 ctx.snapshot——两处互斥，谁先跑就由谁产出这条 PatchPart。
```

位置: `processor.ts:584-588`
```
【工程实践】Effect.forkIn(scope) + Effect.ignore：这是"即发即忘"
(fire-and-forget) 的正确写法——摘要检查不阻塞当前这一 step 继续往下走，
但又不是裸 fork 到全局，而是挂在传入的 scope 上，
保证会话/进程关闭时这个后台任务也会跟着被清理，不会变成孤儿 fiber。
Effect.ignore 表示这个后台任务失败了也无所谓、不影响主流程。
```

**snapshot 的三个核心函数(track / patch / restore)**

位置: `packages/opencode/src/snapshot/index.ts:318-330`(`track()`)
```
【追踪结论：track() 拍的是一个"影子 git 仓库"里的 tree hash，不是 commit】
--git-dir 指向 state.gitdir（上面 71 行：Global.Path.data/snapshot/
<projectID>/<worktree的hash>）——完全独立于项目自己的 .git，
--work-tree 才是真实项目目录。核心三步都在下面：
  1) add()：把"已跟踪但被改的文件"+"未跟踪的新文件"（排除 .gitignore
     命中、排除 >2MB 的未跟踪大文件）git add 进这个影子仓库的暂存区；
  2) git write-tree：把暂存区状态写成一个 tree 对象，返回它的 hash；
     —— 注意这只是 tree，不是 commit（没有 parent、没有 commit message）；
  3) 文件内容确实被完整存进了这个影子仓库的 git 对象库（blob），
     不是只记文件名/mtime，seed() 还会共享真实 .git 的对象库做加速。
非 Git 项目/配置关闭快照时，enabled() 为假，这里直接 return undefined，
调用方（processor.ts）里 ctx.snapshot 会一直是 falsy，整个快照/patch
链路自动跳过。
```

位置: `snapshot/index.ts:362-368`(`patch()`)
```
【追踪结论：patch.hash 就是传进来的这个基线 hash 本身，不是 diff 的 hash】
逻辑：先 add() 把当前工作区最新状态重新暂存一遍，再用
`git diff --cached --name-only <基线hash>` 对比"暂存区 vs 基线 tree"，
只拿到"哪些路径变了"的列表——注意只用了 --name-only，没有
--name-status，所以 patch.files 本身不区分新增/修改/删除，
需要的话要另外调 diffFull()。返回值里的 hash 原样透传，
是调用方后续做 restore()/revert() 时用来定位这棵基线 tree 的钥匙。
```

位置: `snapshot/index.ts:402-406`(`restore()`)
```
【追踪结论：snapshot 不只是用来展示 diff，restore()/revert() 能真正回滚】
git read-tree <hash> 把索引换成基线 tree 的内容，
git checkout-index -a -f 强制把工作区文件也覆盖成索引里的内容——
这是真实的文件回滚操作，不是只读展示。revert()（下面）还支持
按文件粒度回滚到某个具体 patch 的基线。
```

### 附:text-delta / text-start / text-end 与 durable / non-durable 持久化

位置: `processor.ts:605-608`(`case "text-start"`)
```
模型开始吐正文文本（区别于 reasoning）。ctx.currentText 全局只保留"当前正在写的一段"，
因为同一时刻不会有两段文本并行流式输出。
【工程实践】用单个可变字段而不是 Map/数组，是因为这里天然满足"至多一个未闭合项"的不变量——
比 reasoningMap 那种要按 id 索引的场景更简单，不用为不存在的并发情况多写防御代码。
```

位置: `processor.ts:622-631`(`case "text-delta"`)
```
文本增量 token：本地累加到 currentText.text（这是本进程 RAM 里的
一个普通闭包变量，ctx 生命周期绑定这一次 process() 调用）的同时，
用 updatePartDelta 只把这一小段 delta 广播出去。
【追踪结论】"广播"而不是"落库"：updatePartDelta 发的 PartDelta
事件不是 durable 事件，只走内存 PubSub → SSE 推给前端，数据库里
完全没有这条 delta 的记录。真正的全量文本只有下面 text-end 时的
那次 session.updatePart(ctx.currentText) 才会落库——如果进程在
两次 text-end 之间硬崩溃（没机会跑 cleanup 兜底），数据库里这个
TextPart 会停在上一次全量写入的内容，中间的 delta 全部丢失，
前端断线重连也是重新拉取这个"上次全量写入的值"，不会重放 delta。
```

位置: `processor.ts:645-650`(`case "text-end"`)
```
这段文本流结束：先跑一次 experimental.text.complete 插件钩子（可能改写最终文本，
比如做后处理/过滤），再补上 end 时间戳，最后整段 updatePart 落库一次并清空 currentText。
【工程实践】插件钩子（plugin.trigger）只在 text-end 这一个收口点触发，
而不是每个 text-delta 都触发——既避免逐 token 调用插件的性能开销，
也让插件拿到的是"完整的一段文本"而不是残缺片段，语义上更好处理。
"experimental." 前缀是一种命名约定：标记这个扩展点接口还不稳定，未来可能改。
```

位置: `processor.ts:673-675`(`case "finish"`)
```
整个 stream 结束的信号事件，这里无需额外处理——
真正的收尾（usage 结算、快照 diff）已经在每个 step 的 step-finish 里做完了，
"跑完流"这件事由外层 process() 的 Stream.runDrain 感知。
```

**updatePart / updatePartDelta 的真正实现(session.ts 服务层)**

位置: `packages/opencode/src/session/session.ts:637-648`(`updatePart`)
```
【追踪结论：updatePart 本身不写数据库，只发一个 durable 事件】
这里看起来只是 events.publish，真正的 SQL 写入（db.insert(PartTable)
.onConflictDoUpdate(...)）发生在 packages/core/src/session/projector.ts:
312-330 —— 那是订阅 SessionV1.Event.PartUpdated 的一个 projector，
跟这次 publish 一起跑在同一个 db.transaction 里（packages/core/src/
event.ts:240 commitDurableEvent()）。之所以能这样，是因为 PartUpdated
这个事件定义带了 durable 标记（schema/v1/session.ts:618-626 的
...options 展开了 durable:{aggregate:"sessionID",version:1}）——
这是一套事件溯源(event sourcing)架构：先写事件日志(EventTable)，
projector 在同一事务里把事件"物化"进业务表(PartTable)。
对比下面的 updatePartDelta：那个事件定义没有 durable 标记，
完全走内存 PubSub，不会触发这整套事务/projector 逻辑。
```

位置: `session.ts:891-901`(`updatePartDelta`)
```
【追踪结论：这是全链路里唯一"只广播、完全不落库"的写入方法】
MessageV2.Event.PartDelta 的定义（schema/v1/session.ts:638-647）没有
spread 那个 durable options，跟上面 updatePart 用的 PartUpdated 正好
相反。events.publish 内部（core/src/event.ts:369-396 publishEvent）
一看 definition.durable 是假的，直接跳过 commitDurableEvent/db.transaction，
只做一次纯内存 PubSub.publish（event.ts:406-417 notify）。
后果：这一个 delta 字符串只存在于"当次广播"这一瞬间，SQLite 里没有
任何记录；前端收到后是自己在内存 store 里拿 += 累加出全文的
（packages/app/src/context/global-sync/event-reducer.ts:298-322）。
真正把累积出来的全文落库，要靠调用方后续再调一次 updatePart（全量），
例如 processor.ts 的 text-end case。
```

**projector 真正落库的地方**

位置: `packages/core/src/session/projector.ts:312-318`
```
【追踪结论：这就是 session.updatePart() 真正写 SQLite 的地方】
opencode/src/session/session.ts 的 updatePart() 只 events.publish 了
一个 PartUpdated 事件；因为该事件定义带 durable 标记（schema/v1/
session.ts 的 ...options），event.ts 的 commitDurableEvent() 会在一个
db.transaction 里跑完所有注册的 projector 再提交——下面这个 project()
回调就是那个 projector：INSERT ... ON CONFLICT DO UPDATE 进 PartTable，
跟事件日志本身（EventTable）的写入在同一个事务里，要么都成功要么都回滚。
```

**durable vs 非 durable 的事件定义本身**

位置: `packages/schema/src/v1/session.ts:618-623`(`PartUpdated`)
```
【追踪结论】...options 展开了 durable:{aggregate:"sessionID",version:1}——
这一个标记决定了 events.publish 会不会真正落库（走 db.transaction +
projector，见 packages/core/src/event.ts 的 commitDurableEvent 和
packages/core/src/session/projector.ts:312-330 对 PartUpdated 的处理）。
对照最下面的 PartDelta：那个 define() 没有 spread ...options，
所以是非 durable 事件，只走内存 PubSub，永远不会出现在 SQLite 里。
```

位置: `schema/v1/session.ts:644-648`(`PartDelta`)
```
【追踪结论：故意不带 durable 标记】跟上面 PartUpdated 对比着看——这里没有
spread ...options，所以 events.publish(PartDelta, ...) 不会走
commitDurableEvent/db.transaction，纯粹是内存 PubSub 广播（给 SSE 用）。
数据库里不会有任何一条 PartDelta 的记录，session/session.ts 的
updatePartDelta() 就是唯一的发布点。
```

**前端怎么拼出完整文本**

位置: `packages/app/src/context/global-sync/event-reducer.ts:298-305`
```
【追踪结论：这里的 += 就是"为什么不会只看到最后一个 delta"的全部原因】
这个事件（message.part.delta，后端见 session.ts 的 updatePartDelta）
从后端到这里全程没有落库，是纯 SSE 广播；后端也没有 sequence
number/幂等机制。前端能拼出完整文本，纯粹靠下面 318 行的
(existing ?? "") + props.delta —— 字符串拼接而不是赋值覆盖。
断线重连时这个内存 store 会被清空重建，届时是重新拉一次 REST
（session.messages），读到的是后端数据库里最后一次全量 updatePart
写入的内容，不会重放这里累积过的 delta。
```

---

## 十三、这一轮收尾:stop / compact / continue

(主体文本已在「九」结尾处给出,此处不重复。四种收尾方式的判断逻辑见 `prompt.ts:1482-1486`。)

---

## 十四、并发保护:同一 session 同时只有一个 runLoop

位置: `prompt.ts:1511-1516`
```
【学习顺序：十四】并发保护：同一个 session 同一时间只允许一个 runLoop 在跑。
如果已经有一个在跑（比如用户又发了一条消息），ensureRunning 会复用
现有的那个 Effect fiber 而不是重新起一个，避免同一会话被并发写坏。
下一步：模型说完、工具都跑完之后，结果怎么被用户看到？
保证同一个 Session 在同一时刻只有一条 Agent 主流程（runLoop）在运行，避免并发把会话状态写乱
去看【学习顺序：十五】(packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts)
```

---

## 十五、SSE 事件流出口,链路闭环回一

位置: `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts:25-35`
```
============================================================
【学习顺序：十五（终点）】十五.一 —— 结果出口：SSE 事件流，Agent 链路的最后一环
prompt.ts / processor.ts 里到处出现的 `events.publish(...)`
（文本增量、工具状态变化、错误、finish 等）最终都汇聚到这里对外广播。
前端（TUI/App）连上这一条长连接后，同一个工作目录里发生的所有事件都会
实时推过来，不管是哪个 session、哪一轮循环触发的——由前端自己按 sessionID
分发去更新对应的会话界面。这也是为什么 promptAsync（一.二）可以直接返回：
真正的内容展示完全依赖这条独立的 SSE 通道，而不是那次 HTTP 请求的响应体。
走到这里，"用户敲回车 -> 提交 -> 循环调度 -> 调模型 -> 执行工具 -> 结果推回界面"
一整条链路就闭环了。
============================================================
```

位置: `event.ts:42-43`
```
十五.二 —— 先订阅、用一个无界队列把事件缓冲住，再慢慢转成 HTTP 流吐出去——
避免"连接建立"和"开始收事件"之间有个空档期导致事件丢失
```

位置: `event.ts:47-49`
```
十五.三 —— EventV2Bridge 内部是全进程共享的总线（一个进程可能同时服务多个工作目录/
session），这里按当前连接所属的 directory/workspace 过滤，
确保这条 SSE 连接只收到"跟自己相关"的事件
```

链路闭环:走到这里,回到本文档开头的「一、请求入口」——下一次用户发消息,同一条链路重新跑一遍。

---

## 汇编说明

本文件覆盖以下 20 个已加中文注释的文件,共约 700+ 行原文注释:

- `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts`
- `packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/session/llm.ts`
- `packages/opencode/src/session/tools.ts`
- `packages/opencode/src/session/message-v2.ts`
- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/session.ts`
- `packages/opencode/src/tool/registry.ts`
- `packages/opencode/src/tool/tool.ts`
- `packages/opencode/src/tool/glob.ts`
- `packages/core/src/ripgrep.ts`
- `packages/core/src/session/sql.ts`
- `packages/core/src/session/projector.ts`
- `packages/opencode/src/command/index.ts`
- `packages/opencode/src/permission/index.ts`
- `packages/opencode/src/snapshot/index.ts`
- `packages/schema/src/v1/session.ts`
- `packages/app/src/context/global-sync/event-reducer.ts`

如需查看导航索引/整体流程图/尚未确认事项,见 `LEARNING-PIPELINE.md`。
