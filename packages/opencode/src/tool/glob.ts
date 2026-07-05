import path from "path"
import { Effect, Schema } from "effect"
import { InstanceState } from "@/effect/instance-state"
import { FSUtil } from "@opencode-ai/core/fs-util"
import { Ripgrep } from "@opencode-ai/core/ripgrep"
import { assertExternalDirectoryEffect } from "./external-directory"
import DESCRIPTION from "./glob.txt"
import * as Tool from "./tool"

// 【工具补充：一个最小的工具长什么样】以 glob 为例，三件套：
// 1) Parameters —— Schema 描述参数，每个字段的 description 会被转成 JSON Schema
//    发给模型看（对应【学习顺序：七】tools.ts 里的 ToolJsonSchema.fromTool）
// 2) description（DESCRIPTION，从 glob.txt 读的一段文字）—— 工具本身的说明书
// 3) execute —— 真正干活的地方，返回值形状是 tool.ts 里的 ExecuteResult
//    { title, metadata, output, attachments? }，跟七.三/processor.ts 存进
//    ToolPart.state 的字段完全对应
export const Parameters = Schema.Struct({
  pattern: Schema.String.annotate({ description: "The glob pattern to match files against" }),
  path: Schema.optional(Schema.String).annotate({
    description: `The directory to search in. If not specified, the current working directory will be used. IMPORTANT: Omit this field to use the default directory. DO NOT enter "undefined" or "null" - simply omit it for the default behavior. Must be a valid directory path if provided.`,
  }),
})

// 【架构分层 · 第③层：具体工具业务层】GlobTool 自己不知道、也不关心 AI SDK
// 或 wrap() 怎么包装它——它只负责"glob 搜索"这一件具体业务：参数长什么样、
// 权限怎么问、结果怎么整理成文本。它依赖的 Ripgrep.Service（第④层）是
// 更底层的通用能力，随便哪个工具想搜文件都能复用，不必自己再实现一遍。
export const GlobTool = Tool.define(
  "glob",
  Effect.gen(function* () {
    const fs = yield* FSUtil.Service
    const ripgrep = yield* Ripgrep.Service
    return {
      description: DESCRIPTION,
      parameters: Parameters,
      // execute 收到的 params 已经是按上面 Parameters 校验/解码过的（校验逻辑在
      // tool.ts 的 wrap() 里做，校验失败会变成 InvalidArgumentsError 让模型重写参数）；
      // ctx 就是 session/tools.ts 七.一里那个 context()，metadata/ask 都在这传进来
      execute: (params: { pattern: string; path?: string }, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const ins = yield* InstanceState.context
          // 这个工具自己的权限检查：调用前问一下"能不能按这个 pattern 搜文件"，
          // 走的还是七.一 context() 里那个 ctx.ask，最终到 Permission.Service
          // 1. 权限检查
          yield* ctx.ask({
            permission: "glob",
            patterns: [params.pattern],
            always: ["*"],
            metadata: {
              pattern: params.pattern,
              path: params.path,
            },
          })

          // 2. 决定搜索目录
          let search = params.path ?? ins.directory
          // 3. 转绝对路径
          search = path.isAbsolute(search) ? search : path.resolve(ins.directory, search)
          // 4. 检查是不是文件
          const info = yield* fs.stat(search).pipe(Effect.catch(() => Effect.succeed(undefined)))
          if (info?.type === "File") {
            throw new Error(`glob path must be a directory: ${search}`)
          }
          // 5. 检查是否访问项目外目录
          yield* assertExternalDirectoryEffect(ctx, search, {
            bypass: false,
            kind: "directory",
          })
          // 6. 真正搜索
          const limit = 100
          const files = yield* ripgrep.glob({ cwd: search, pattern: params.pattern, limit })
          const truncated = files.length === limit

          // 7. 整理模型能读懂的结果
          const output = []
          if (files.length === 0) output.push("No files found")
          if (files.length > 0) {
            output.push(...files.map((file) => path.resolve(search, file.path)))
            if (truncated) {
              output.push("")
              output.push(
                `(Results are truncated: showing first ${limit} results. Consider using a more specific path or pattern.)`,
              )
            }
          }

          // 返回值就是 ExecuteResult：title 给 UI 显示一行摘要，output 是真正
          // 喂回给模型当"工具结果"的文本，metadata 是给 UI/插件用的结构化附加信息
          // 8. 返回 Tool Result
          return {
            title: path.relative(ins.worktree, search),
            metadata: {
              count: files.length,
              truncated,
            },
            output: output.join("\n"),
          }
        }).pipe(Effect.orDie),
    }
  }),
)
