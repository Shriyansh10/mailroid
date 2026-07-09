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

/**
 * Heal any unresponded tool calls in history to comply with OpenAI's strict protocol.
 * If an assistant message requested tool calls but they were never approved/executed,
 * this function inserts inline dummy tool cancellations so the API request does not fail.
 */
export function healConversation<T extends { role: string; tool_calls?: any[]; toolCalls?: any[]; tool_call_id?: string; toolCallId?: string; content?: string | null }>(
  messages: T[]
): T[] {
  const healed: T[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    healed.push(msg);

    if (msg.role === "assistant" && (msg.tool_calls || msg.toolCalls)) {
      const tcList = msg.tool_calls || msg.toolCalls;
      if (Array.isArray(tcList) && tcList.length > 0) {
        const nextToolResponses = new Set<string>();
        let j = i + 1;
        while (j < messages.length && messages[j]?.role === "tool") {
          const toolMsg = messages[j] as any;
          const toolCallId = toolMsg.tool_call_id || toolMsg.toolCallId;
          if (toolCallId) {
            nextToolResponses.add(toolCallId);
          }
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
}

export interface AgentLoopResult {
  response: AgentResponse;
  newMessages: AgentLoopNewMessage[];
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

    const completion = await deepseek.chat.completions.create(params);

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
      return { response: { role: "assistant", content: msg.content }, newMessages };
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
      const resultMessages: { toolCallId: string; content: string }[] = [];
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

        resultMessages.push({ toolCallId: tc.id, content: framedContent });
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
        newMessages.push({ role: "tool", toolCallId: r.toolCallId, content: r.content });
        conversation.push({ role: "tool", tool_call_id: r.toolCallId, content: r.content });
      }

      if (approvalResponse) {
        return { response: approvalResponse, newMessages };
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
  };
}

