# OpenCode Backend Core - Learning Guide

This branch (`learn/backend-core`) strips the repo to **backend/agent logic only** — no web app, desktop, docs, or other frontends. Use it to learn, debug, and test the core agent.

## What's Included

| Package | Purpose |
|---------|---------|
| `packages/opencode` | Core agent logic, server, CLI, TUI |
| `packages/plugin` | Plugin system & types |
| `packages/script` | Build/utility scripts |
| `packages/sdk/js` | API client & types (server ↔ client) |
| `packages/util` | Shared utilities |

## How to Run

```bash
# Install (Bun 1.3.9+)
bun install

# TUI (terminal UI) in current directory
bun dev .

# Headless API server (port 4096)
bun run serve

# Or with custom port
bun run serve -- --port 8080
```

---

## Agent Core Logic - Where to Start

### 1. Entry Points

- **CLI** → `packages/opencode/src/index.ts`
- **Serve command** → `packages/opencode/src/cli/cmd/serve.ts`
- **Server (Hono)** → `packages/opencode/src/server/server.ts`

### 2. Main Agent Loop

The core loop is in **`packages/opencode/src/session/prompt.ts`**:

- `SessionPrompt.loop()` — main conversation loop
- Resolves tools via `resolveTools()`
- Uses `SessionProcessor` to process LLM stream
- Handles tool calls, permissions, retries

### 3. Session Processing

**`packages/opencode/src/session/processor.ts`**:

- `SessionProcessor.create()` — creates a processor for one assistant message
- `process(streamInput)` — consumes LLM stream, handles:
  - `reasoning-start/delta/end`
  - `tool-input-start/delta/end`
  - `tool-call` / `tool-result`
  - Text chunks

### 4. Agent Definitions

**`packages/opencode/src/agent/agent.ts`**:

- `Agent.get(name)` — returns agent config (build, plan, etc.)
- Defines permissions, model, steps per agent
- Used to choose behavior and tools per request

### 5. Tools

**`packages/opencode/src/tool/`**:

- `registry.ts` — tool registration, plugin tools
- `task.ts` — mcp_task subagent
- `read.ts`, `grep.ts`, etc. — built-in tools

### 6. Providers & LLM

- **`packages/opencode/src/provider/`** — model providers (OpenAI, Anthropic, etc.)
- **`packages/opencode/src/session/llm.ts`** — LLM streaming

### 7. Server Routes

**`packages/opencode/src/server/routes/`**:

- `session.ts` — session/message CRUD
- `project.ts` — project config
- `provider.ts` — model providers
- `permission.ts` — permission requests
- etc.

---

## Recommended Reading Order

1. `packages/opencode/src/index.ts` — CLI wiring
2. `packages/opencode/src/agent/agent.ts` — agent config
3. `packages/opencode/src/session/prompt.ts` — main loop
4. `packages/opencode/src/session/processor.ts` — stream processing
5. `packages/opencode/src/tool/registry.ts` — tools
6. `packages/opencode/src/server/server.ts` — API surface

---

## Debugging

From CONTRIBUTING.md:

```bash
# Run server with debugger
bun run --inspect=ws://localhost:6499/ --cwd packages/opencode ./src/index.ts serve --port 4096

# Attach TUI to running server
bun dev attach http://localhost:4096
```

For TUI + server in one process, use:

```bash
bun dev spawn   # spawns server in separate process
```

---

## Tests

Tests live in `packages/opencode`. **Do not run from repo root.**

```bash
cd packages/opencode
bun test
```

---

## Directory Map (opencode package)

```
src/
├── index.ts          # CLI entry
├── agent/            # Agent definitions
├── session/          # Main loop, processor, messages, LLM
├── tool/             # Tool registry and implementations
├── server/           # Hono API, routes
├── provider/         # Model providers
├── plugin/           # Plugin loading
├── permission/       # Permission handling
├── project/          # Worktree, instance
├── cli/              # Commands, TUI
└── ...
```
