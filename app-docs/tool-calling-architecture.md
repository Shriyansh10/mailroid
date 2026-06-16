# Tool Calling Architecture Audit

## Current State

```
┌─ apps/web ─────────────────────────────────────┐
│                                                 │
│  assistant/page.tsx                             │
│    │ fetch("/api/chat")                         │
│    ▼                                            │
│  route.ts                                       │
│    │ ChatRequestSchema.safeParse()              │
│    │ sendChat(messages)                         │
│    ▼                                            │
│  @repo/ai  ──────────────────────────────────┐  │
│    sendChat()                                 │  │
│      deepseek.chat.completions.create()       │  │
│      returns { content: "..." }               │  │
│      ❌ No tools                              │  │
│  ────────────────────────────────────────────┘  │
│                                                 │
│  ToolOrchestrator ← UNUSED by chat              │
│  ToolRegistry ← UNUSED by chat                  │
│  searchEmails/getEvents ← ready, no connection  │
└─────────────────────────────────────────────────┘
```

## Analysis

### 1. Where should tool calling be implemented?

The tool-calling loop needs **two things** the route already has access to: DeepSeek responses (via `sendChat`) and tool execution (via `ToolOrchestrator`). Neither `@repo/ai/src/chat/service.ts` nor the tools module knows about the other — by design.

The answer is a **new agent loop** in `@repo/ai` that accepts tool definitions and an execution callback as parameters. This keeps it pure — no dependency on specific tools, services, or routes.

### 2. Should DeepSeek receive tool definitions directly?

Yes. DeepSeek's API (OpenAI-compatible) accepts a `tools` parameter in the chat completion request. When DeepSeek sees `tools`, it may return a `tool_calls` array instead of text content. The agent loop inspects the response, executes the tool, feeds the result back, and repeats until DeepSeek returns a final text response.

### 3. Should `/api/chat` call ToolOrchestrator?

Indirectly. The route should **pass the orchestrator as a callback** into the agent loop, not call it directly. This keeps the route as the composition layer:

```
route: "here are the tools, here's how to execute them" → agent loop
```

### 4. Cleanest architecture:

```
User types "Search my email"
  │
  ▼
assistant/page.tsx
  │  fetch("/api/chat", { messages })
  ▼
app/api/chat/route.ts
  │
  ├─ Build OpenAI-format tool defs from registry
  │    registry.list() → [{ name, description, parameters }]
  │
  ├─ Call runAgentLoop(messages, toolDefs, executeToolCallback)
  │    │
  │    ▼  @repo/ai/src/chat/agent.ts  (NEW — pure function)
  │    │
  │    │  while (true):
  │    │    1. deepseek.chat.completions.create({ messages, tools })
  │    │    2. if response has content → return it (outputSchema)
  │    │    3. if response has tool_calls:
  │    │       a. for each tool_call:
  │    │            result = executeToolCallback(name, args)
  │    │       b. add tool_call + result to messages[]
  │    │       c. continue loop
  │    │
  │    │  executeToolCallback = (name, args) => {
  │    │    return orchestrator.executeTool(name, args, userId, id)
  │    │  }
  │    │
  │    ▼
  │    orchestrator.executeTool("searchEmails", {query}, userId, id)
  │      → permission check → audit → CorsairSearchEmailsExecutor
  │      → { status: "success", data: { emails: [...] } }
  │    ▼
  │    Back to loop: DeepSeek receives result, generates final answer
  │
  └─ Return final response to UI
```

---

## Minimal Implementation Plan (3 files)

| # | File | Location | Purpose |
|---|------|----------|---------|
| 1 | `@repo/ai/src/tools/convert.ts` | **New** | `toOpenAiToolDefs(registry)` — converts `ToolDefinition[]` → OpenAI `tools` array. Lives in tools module because it already knows `ToolDefinition`. |
| 2 | `@repo/ai/src/chat/agent.ts` | **New** | `runAgentLoop(messages, tools, execute)` — the tool-calling loop. Accepts OpenAI `tools`, messages, and an `execute(name, args) → ToolResult` callback. Pure logic, no service/tool deps. |
| 3 | `apps/web/app/api/chat/route.ts` | **Modified** | Wires tool defs + orchestrator into `runAgentLoop()`. Adds `registry` singleton (shared with `tools/execute` route or instantiated separately). |

**Not modified:** `sendChat()`, `ToolOrchestrator`, `ToolRegistry`, `PermissionService`, `AuditLogger`, any executor, any service.

**No new dependencies:** `runAgentLoop()` only needs `deepseek` (already in `@repo/ai`). `toOpenAiToolDefs()` only needs `ToolDefinition` (already in tools module).

## DeepSeek tool format

```json
{
  "type": "function",
  "function": {
    "name": "searchEmails",
    "description": "Search through the user's emails semantically",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "The search query" }
      },
      "required": ["query"]
    }
  }
}
```

Zod schemas in the registry already have all the data needed — `zod-to-json-schema` or manual extraction from `inputSchema` yields the `parameters` object.
