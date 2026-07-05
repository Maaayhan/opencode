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
