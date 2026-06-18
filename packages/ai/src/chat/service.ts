import { deepseek, DEEPSEEK_CHAT_MODEL } from "../client.ts";
import type {
  ChatMessage,
  ChatResponse,
  ChatStreamChunk,
} from "./types.ts";

/**
 * Send a non-streaming chat request to DeepSeek.
 *
 * @param messages - Array of chat messages (system, user, assistant)
 * @returns A ChatResponse containing the assistant's reply
 */
export async function sendChat(
  messages: ChatMessage[],
): Promise<ChatResponse> {
  const start = Date.now();

  console.log("[chat:request]", { model: DEEPSEEK_CHAT_MODEL, messageCount: messages.length });

  try {
    const completion = await deepseek.chat.completions.create({
      model: DEEPSEEK_CHAT_MODEL,
      messages: messages.map((m) => {
        if (m.role === "assistant") {
          return {
            role: "assistant" as const,
            content: m.content || null,
            tool_calls: m.tool_calls,
          };
        }
        if (m.role === "tool") {
          return {
            role: "tool" as const,
            tool_call_id: m.tool_call_id!,
            content: m.content || "",
          };
        }
        return {
          role: m.role as "system" | "user",
          content: m.content || "",
        };
      }) as any,
      stream: false,
    });

    const content = completion.choices[0]?.message?.content ?? "";

    console.log("[chat:response]", { model: DEEPSEEK_CHAT_MODEL, durationMs: Date.now() - start, contentLength: content.length });

    return { role: "assistant" as const, content };
  } catch (error) {
    console.error("[chat:error]", { model: DEEPSEEK_CHAT_MODEL, durationMs: Date.now() - start, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

/**
 * Send a streaming chat request to DeepSeek.
 * Returns an async iterable that yields chunks as they arrive.
 *
 * @param messages - Array of chat messages (system, user, assistant)
 * @returns An async iterable of ChatStreamChunk
 */
export async function* streamChat(
  messages: ChatMessage[],
): AsyncIterable<ChatStreamChunk> {
  const start = Date.now();

  console.log("[chat:stream:request]", { model: DEEPSEEK_CHAT_MODEL, messageCount: messages.length });

  try {
    const stream = await deepseek.chat.completions.create({
      model: DEEPSEEK_CHAT_MODEL,
      messages: messages.map((m) => {
        if (m.role === "assistant") {
          return {
            role: "assistant" as const,
            content: m.content || null,
            tool_calls: m.tool_calls,
          };
        }
        if (m.role === "tool") {
          return {
            role: "tool" as const,
            tool_call_id: m.tool_call_id!,
            content: m.content || "",
          };
        }
        return {
          role: m.role as "system" | "user",
          content: m.content || "",
        };
      }) as any,
      stream: true,
    });

    let totalContent = "";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content;
      if (delta) {
        totalContent += delta;
        yield { content: delta, done: false };
      }
    }

    // Signal completion
    yield { content: "", done: true };

    console.log("[chat:stream:complete]", { model: DEEPSEEK_CHAT_MODEL, durationMs: Date.now() - start, totalContentLength: totalContent.length });
  } catch (error) {
    console.error("[chat:stream:error]", { model: DEEPSEEK_CHAT_MODEL, durationMs: Date.now() - start, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
