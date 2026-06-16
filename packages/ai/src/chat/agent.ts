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
export async function runAgentLoop(
  options: RunAgentLoopOptions,
): Promise<AgentResponse> {
  console.log("RUN_AGENT_LOOP_STARTED");
  const {
    messages,
    registry,
    execute,
    userId: _userId,
    maxIterations = 5,
  } = options;

  const toolDefs = toOpenAiToolDefs(registry);

  // Convert public ChatMessage[] → internal AgentMessage[]
  const conversation: AgentMessage[] = messages.map((m) => ({
    role: m.role as "system" | "user",
    content: m.content,
  }));

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
      return { role: "assistant", content: msg.content };
    }

    // ── Tool calls: model wants to execute tools ──────────────────────
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      const toolNames = msg.tool_calls.map(
        (tc: { id: string; type: string; function?: { name: string; arguments: string } }) =>
          getFunction(tc).name,
      );
      console.log("[agent:tool-calls]", { iteration, count: msg.tool_calls.length, names: toolNames });

      // Push the assistant message that requested the tools
      conversation.push({
        role: "assistant",
        content: msg.content ?? null,
        tool_calls: msg.tool_calls.map(
          (tc: { id: string; type: string; function?: { name: string; arguments: string } }) => ({
            id: tc.id,
            type: "function" as const,
            function: getFunction(tc),
          }),
        ),
      });

      // Execute each tool call in sequence (order may matter)
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

        // ── Security: sanitize tool output before DeepSeek sees it ──
        const safeResult = {
          ...result,
          data: firewall.sanitizeToolOutput(toolName, result.data),
        };

        // ── Approval required: stop and return to UI ──────────────────
        if (result.status === "approval_required") {
          console.log("[agent:approval-required]", {
            toolName,
            approvalId: result.approvalId,
            toolCallId: tc.id,
          });
          return {
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
        }

        // ── XML framing: separate tool data from conversation ──
        // Prevents email/event content from being interpreted as instructions
        const framedContent =
          safeResult.status === "success"
            ? `<tool_result tool="${toolName}">\n${JSON.stringify(safeResult.data)}\n</tool_result>`
            : `<tool_error tool="${toolName}">\n${JSON.stringify({ error: safeResult.error ?? `Tool execution failed: ${safeResult.status}` })}\n</tool_error>`;

        // Push the framed tool result back into the conversation
        conversation.push({
          role: "tool",
          tool_call_id: tc.id,
          content: framedContent,
        });
      }

      // Loop again — DeepSeek will process the tool results
      continue;
    }

    // ── Degenerate: no content and no tool calls ──────────────────────
    console.warn("[agent:warn]", { iteration, reason: "No content, no tool calls — returning empty" });
    return { role: "assistant", content: msg.content ?? "" };
  }

  // ── Safety limit reached ────────────────────────────────────────────
  console.warn("[agent:max-iterations]", { maxIterations, durationMs: Date.now() - start });
  console.log(
    `[SECURITY] ${AuditEventType.AGENT_STEP_LIMIT_EXCEEDED} | ` +
    `user=${_userId} | ` +
    `iterations=${maxIterations} | ` +
    `maxIterations=${maxIterations}`,
  );
  return {
    role: "assistant",
    content: "I've completed the maximum number of steps (5). Please try a more specific request.",
  };
}

