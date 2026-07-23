import { deepseek, DEEPSEEK_CHAT_MODEL } from "../client.ts";
import type { ChatMessage } from "./types.ts";
import type { AgentResponse } from "./types.ts";
import type { ToolRegistry } from "../tools/registry.ts";
import type { ToolResult } from "../tools/types.ts";
import { AuditEventType } from "../tools/types.ts";
import { toOpenAiToolDefs } from "../tools/convert.ts";
import { firewall } from "../security/policies.ts";
import { detectPromptInjection } from "../security/prompt-injection.ts";
import type OpenAI from "openai";

// ── Internal message type ──────────────────────────────────────────────

/**
 * Extended message type used inside the agent loop.
 *
 * The public `ChatMessage` only has `{ role, content }`. Internally we need
 * to represent assistant messages with `tool_calls` and tool-result messages
 * with `tool_call_id` so DeepSeek can correlate calls to results.
 */
type AgentMessage =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: AgentToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

interface AgentToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

type HealMessage = {
  role: string;
  tool_calls?: any[];
  toolCalls?: any[];
  tool_call_id?: string;
  toolCallId?: string;
  content?: string | null;
};

function toolCallsOf(msg: HealMessage): any[] | undefined {
  const list = msg.tool_calls || msg.toolCalls;
  return Array.isArray(list) && list.length > 0 ? list : undefined;
}

function toolCallIdOf(msg: HealMessage): string | undefined {
  return msg.tool_call_id || msg.toolCallId;
}

/**
 * Normalize a conversation so it complies with OpenAI/DeepSeek's strict tool
 * protocol: every `tool` message must sit immediately after the `assistant`
 * message whose `tool_calls` include its id, and every requested tool call must
 * have a response. Operates on an in-memory copy only — DB rows are never
 * mutated.
 *
 * Two-step heal:
 *   1. Reverse fix (position). A `tool` message can drift out of position —
 *      e.g. the approval flow persists its tool response with a `createdAt`
 *      after an intervening user message, so strict `createdAt` ordering places
 *      it outside the turn that owns it. We relocate each `tool` message to
 *      directly follow its owning assistant tool_calls message (matched by id),
 *      preserving the real result. A `tool` message whose id matches no
 *      assistant tool_calls anywhere is truly orphaned and dropped.
 *   2. Forward fix (completeness). For any assistant tool_calls that still has
 *      no response, insert an inline dummy cancellation so the request doesn't
 *      400.
 */
export function healConversation<T extends { role: string; tool_calls?: any[]; toolCalls?: any[]; tool_call_id?: string; toolCallId?: string; content?: string | null }>(
  messages: T[]
): T[] {
  // ── Step 1: relocate/drop out-of-position tool messages ──────────────
  // Map each declared tool_call id → index of the assistant message that owns it.
  const ownerOf = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const tcList = toolCallsOf(messages[i]!);
    if (messages[i]!.role === "assistant" && tcList) {
      for (const tc of tcList) {
        if (tc?.id) ownerOf.set(tc.id, i);
      }
    }
  }

  // Bucket every tool message under its owning assistant index (preserving
  // relative order). Tool messages with no owner anywhere are dropped.
  const buckets = new Map<number, T[]>();
  for (const msg of messages) {
    if (msg.role !== "tool") continue;
    const id = toolCallIdOf(msg);
    const owner = id !== undefined ? ownerOf.get(id) : undefined;
    if (owner === undefined) {
      console.log(`[agent:heal] dropping orphaned tool message with no matching tool_calls: ${id ?? "<no id>"}`);
      continue;
    }
    const bucket = buckets.get(owner);
    if (bucket) bucket.push(msg);
    else buckets.set(owner, [msg]);
  }

  // Re-emit: keep every non-tool message in its original relative order, and
  // place each assistant's tool responses immediately after it.
  const normalized: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role === "tool") continue; // placed via buckets
    normalized.push(msg);
    if (msg.role === "assistant" && toolCallsOf(msg)) {
      const bucket = buckets.get(i);
      if (bucket) normalized.push(...bucket);
    }
  }

  // ── Step 2: insert dummy responses for still-unresponded tool calls ──
  const healed: T[] = [];
  for (let i = 0; i < normalized.length; i++) {
    const msg = normalized[i]!;
    healed.push(msg);

    const tcList = toolCallsOf(msg);
    if (msg.role === "assistant" && tcList) {
      const nextToolResponses = new Set<string>();
      let j = i + 1;
      while (j < normalized.length && normalized[j]?.role === "tool") {
        const id = toolCallIdOf(normalized[j] as HealMessage);
        if (id) nextToolResponses.add(id);
        j++;
      }

      for (const tc of tcList) {
        if (!nextToolResponses.has(tc.id)) {
          console.log(`[agent:heal] inserting dummy tool response for unresponded toolCallId: ${tc.id}`);
          healed.push({
            role: "tool",
            tool_call_id: tc.id,
            toolCallId: tc.id,
            content: JSON.stringify({ error: "Action cancelled or ignored by user" }),
          } as unknown as T);
        }
      }
    }
  }
  return healed;
}


// ── Options ────────────────────────────────────────────────────────────

export interface RunAgentLoopOptions {
  /** The initial conversation messages (system prompt + history). */
  messages: ChatMessage[];
  /** Tool registry to convert into OpenAI tool definitions. */
  registry: ToolRegistry;
  /**
   * Execution callback — called whenever DeepSeek requests a tool.
   * The route wires this to `ToolOrchestrator.executeTool()`.
   */
  execute: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
  /** The authenticated user's ID (used by the orchestrator for audit/permissions). */
  userId: string;
  /** Safety limit on tool-calling iterations (default: 10). */
  maxIterations?: number;
  /**
   * Optional hook run after each successful tool call, before its result is
   * pushed onto `newMessages`. Lets a caller attach app-specific metadata
   * (e.g. "this tool result names email X") to the persisted tool message
   * without the agent loop knowing anything about specific tools — keeps
   * @repo/ai tool-agnostic while still letting the caller build durable,
   * per-conversation memory (see apps/web/lib/assistant/tool-memory.ts).
   */
  deriveToolMessageMetadata?: (
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
  ) => Record<string, unknown> | undefined;
}

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Extract the `function` property from a tool call.
 *
 * In OpenAI SDK v6, `ChatCompletionMessageToolCall` is a union of
 *   - `ChatCompletionMessageFunctionToolCall`  (has `.function`)
 *   - `ChatCompletionMessageCustomToolCall`    (does NOT have `.function`)
 *
 * We only support function tools, so filter/assert accordingly.
 */
function getFunction(tc: {
  id: string;
  type: string;
  function?: { name: string; arguments: string };
}): { name: string; arguments: string } {
  if (!tc.function) {
    throw new Error(`Tool call "${tc.id}" has no function property (type: ${tc.type})`);
  }
  return tc.function;
}

// ── Agent Loop ─────────────────────────────────────────────────────────

/**
 * Pure tool-calling loop. No dependency on specific tools, services,
 * or routes — only DeepSeek, a tool registry, and an execution callback.
 *
 * Flow:
 *   1. Convert `registry` → OpenAI `tools` definitions
 *   2. Call DeepSeek with messages + tools
 *   3. If DeepSeek returns content (no tool calls) → return it
 *   4. If DeepSeek returns tool_calls → execute each via callback,
 *      feed result back into messages, loop
 *   5. Safety limit prevents infinite loops
 */
export interface AgentLoopNewMessage {
  role: "assistant" | "tool";
  content: string | null;
  toolCalls?: any;
  toolCallId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentLoopResult {
  response: AgentResponse;
  newMessages: AgentLoopNewMessage[];
  /**
   * Approx. character length of the conversation actually sent to DeepSeek
   * on the last iteration — the same rough proxy already logged as
   * `[agent:deepseek:request] approxChars`. Powers the assistant UI's
   * context-window indicator; not an exact token count (~4 chars/token is
   * the standard rough-estimate ratio for English text).
   */
  contextChars: number;
}

export async function runAgentLoop(
  options: RunAgentLoopOptions,
): Promise<AgentLoopResult> {
  console.log("RUN_AGENT_LOOP_STARTED");
  const {
    messages,
    registry,
    execute,
    userId: _userId,
    maxIterations = 5,
    deriveToolMessageMetadata,
  } = options;

  const toolDefs = toOpenAiToolDefs(registry);
  const newMessages: AgentLoopNewMessage[] = [];

  // Convert public ChatMessage[] → internal AgentMessage[]
  const rawConversation: AgentMessage[] = messages.map((m) => {
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls as AgentToolCall[] | undefined,
      };
    }
    if (m.role === "tool") {
      return {
        role: "tool",
        tool_call_id: m.tool_call_id!,
        content: m.content || "",
      };
    }
    return {
      role: m.role as "system" | "user",
      content: m.content || "",
    };
  });

  const conversation = healConversation(rawConversation);

  // ── Security: sanitize user messages before DeepSeek sees them ────
  for (const msg of conversation) {
    if (msg.role === "user") {
      msg.content = firewall.sanitizeMessage(msg.content);
    }
  }

  // ── Jailbreak detection: audit user messages for policy bypass ────
  for (const msg of conversation) {
    if (msg.role === "user") {
      const injectionMatches = detectPromptInjection(msg.content);
      if (injectionMatches.length > 0) {
        console.log(
          `[SECURITY] ${AuditEventType.POLICY_BYPASS_ATTEMPT} | ` +
          `user=${_userId} | ` +
          `matches=${injectionMatches.length} | ` +
          `patterns=${injectionMatches.map((m) => m.pattern.slice(0, 40)).join(", ")}`,
        );
      }
    }
  }

  const start = Date.now();
  // Tracks the size of the last thing actually sent to DeepSeek, so every
  // return path below can report it as contextChars regardless of which
  // branch it returns from.
  let lastApproxChars = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    console.log("[agent:loop]", { iteration, messageCount: conversation.length, toolCount: toolDefs.length });

    // Build request params — use the non-streaming overload explicitly
    // so `completion.choices` is typed as `ChatCompletion` not a union with Stream.
    const params: OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming = {
      model: DEEPSEEK_CHAT_MODEL,
      messages: conversation as unknown as OpenAI.Chat.Completions.ChatCompletionMessageParam[],
      stream: false,
      ...(toolDefs.length > 0
        ? { tools: toolDefs as unknown as OpenAI.Chat.Completions.ChatCompletionTool[] }
        : {}),
    };

    const approxChars = JSON.stringify(conversation).length;
    lastApproxChars = approxChars;
    console.log("[agent:deepseek:request]", { iteration, approxChars });

    let completion;
    try {
      completion = await deepseek.chat.completions.create(params);
    } catch (err) {
      console.error("[agent:deepseek:error]", {
        iteration,
        approxChars,
        status: (err as { status?: number })?.status,
        message: err instanceof Error ? err.message : String(err),
        // DeepSeek's SDK error puts the API's JSON body here — this is where
        // "context length exceeded" / rate-limit reasons actually show up.
        body: (err as { error?: unknown })?.error,
      });
      throw err;
    }

    const choice = completion.choices[0];
    if (!choice) {
      console.error("[agent:error]", { reason: "No choices in response" });
      throw new Error("No choices in DeepSeek response");
    }

    const msg = choice.message;

    // ── Terminal: model returned text content, no tool calls ──────────
    if (msg.content && (!msg.tool_calls || msg.tool_calls.length === 0)) {
      console.log("[agent:done]", { iteration, durationMs: Date.now() - start, contentLength: msg.content.length });
      newMessages.push({ role: "assistant", content: msg.content });
      return { response: { role: "assistant", content: msg.content }, newMessages, contextChars: lastApproxChars };
    }

    // ── Tool calls: model wants to execute tools ──────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolNames = msg.tool_calls.map(
        (tc: { id: string; type: string; function?: { name: string; arguments: string } }) =>
          getFunction(tc).name,
      );
      console.log("[agent:tool-calls]", { iteration, count: msg.tool_calls.length, names: toolNames });

      // Execute tool calls one at a time, stopping at the first one that
      // requires approval. Only calls actually attempted (executed, or the
      // one pending approval) are recorded below — any calls after that
      // point are never attempted and never persisted, so no toolCallId is
      // ever left dangling without a result. The model naturally re-requests
      // any dropped calls on its next turn once the pending one is resolved.
      const attemptedToolCalls: AgentToolCall[] = [];
      const resultMessages: { toolCallId: string; content: string; metadata?: Record<string, unknown> }[] = [];
      let approvalResponse: Extract<AgentResponse, { approvalRequired: unknown }> | null = null;

      for (const tc of msg.tool_calls) {
        const fn = getFunction(tc);
        const toolName = fn.name;
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(fn.arguments);
        } catch {
          args = {};
        }

        // Attach the tool call ID so the orchestrator can store it for approval
        args._toolCallId = tc.id;

        const result = await execute(toolName, args);

        attemptedToolCalls.push({ id: tc.id, type: "function", function: fn });

        // ── Approval required: stop attempting further calls in this batch ──
        if (result.status === "approval_required") {
          console.log("[agent:approval-required]", {
            toolName,
            approvalId: result.approvalId,
            toolCallId: tc.id,
          });
          approvalResponse = {
            role: "assistant",
            content: msg.content ?? `I'd like to ${toolName}. Please approve this action.`,
            approvalRequired: {
              approvalId: result.approvalId!,
              toolName,
              toolCallId: tc.id,
              args,
              preview: result.preview ?? `Run ${toolName}`,
              reasoningContent: (msg as { reasoning_content?: string | null }).reasoning_content ?? null,
            },
          };
          break;
        }

        // ── Security: sanitize tool output before DeepSeek sees it ──
        const safeResult = {
          ...result,
          data: firewall.sanitizeToolOutput(toolName, result.data),
        };

        // ── XML framing: separate tool data from conversation ──
        // Prevents email/event content from being interpreted as instructions
        const framedContent =
          safeResult.status === "success"
            ? `<tool_result tool="${toolName}">\n${JSON.stringify(safeResult.data)}\n</tool_result>`
            : `<tool_error tool="${toolName}">\n${JSON.stringify({ error: safeResult.error ?? `Tool execution failed: ${safeResult.status}` })}\n</tool_error>`;

        const metadata = deriveToolMessageMetadata?.(toolName, args, result);
        resultMessages.push({ toolCallId: tc.id, content: framedContent, metadata });
      }

      // Push the assistant message with ONLY the tool calls actually attempted
      const assistantMsg: AgentLoopNewMessage = {
        role: "assistant",
        content: msg.content ?? null,
        toolCalls: attemptedToolCalls,
      };
      newMessages.push(assistantMsg);
      conversation.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: attemptedToolCalls,
      });

      // Push results for every call that actually completed (in order)
      for (const r of resultMessages) {
        newMessages.push({ role: "tool", toolCallId: r.toolCallId, content: r.content, metadata: r.metadata });
        conversation.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
      }

      if (approvalResponse) {
        return { response: approvalResponse, newMessages, contextChars: lastApproxChars };
      }

      // Loop again — DeepSeek will process the tool results
      continue;
    }

    // ── Degenerate: no content and no tool calls ──────────────────────
    console.warn("[agent:warn]", { iteration, reason: "No content, no tool calls — returning empty" });
    const emptyMsg: AgentLoopNewMessage = {
      role: "assistant",
      content: msg.content ?? "",
    };
    newMessages.push(emptyMsg);
    return {
      response: { role: "assistant", content: msg.content ?? "" },
      newMessages,
      contextChars: lastApproxChars,
    };
  }

  // ── Safety limit reached ────────────────────────────────────────────
  console.warn("[agent:max-iterations]", { maxIterations, durationMs: Date.now() - start });
  console.log(
    `[SECURITY] ${AuditEventType.AGENT_STEP_LIMIT_EXCEEDED} | ` +
    `user=${_userId} | ` +
    `iterations=${maxIterations} | ` +
    `maxIterations=${maxIterations}`,
  );
  const limitMsg: AgentLoopNewMessage = {
    role: "assistant",
    content: "I've completed the maximum number of steps (5). Please try a more specific request.",
  };
  newMessages.push(limitMsg);
  return {
    response: {
      role: "assistant",
      content: "I've completed the maximum number of steps (5). Please try a more specific request.",
    },
    newMessages,
    contextChars: lastApproxChars,
  };
}

