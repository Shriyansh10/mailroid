export { createEmbedding, createEmbeddingsBatch } from "./embeddings/generate.ts";
export { embedSearchQuery } from "./embeddings/search.ts";

export { deepseek, DEEPSEEK_CHAT_MODEL } from "./client.ts";

export {
  ChatMessageSchema,
  ChatRequestSchema,
  ChatResponseSchema,
  ChatStreamChunkSchema,
} from "./chat/types.ts";
export type {
  ChatMessage,
  ChatRequest,
  ChatResponse,
  ChatStreamChunk,
} from "./chat/types.ts";

export { sendChat, streamChat } from "./chat/service.ts";
export { runAgentLoop } from "./chat/agent.ts";
export type { RunAgentLoopOptions } from "./chat/agent.ts";

export type { AgentResponse, ApprovalRequiredResponse } from "./chat/types.ts";

// ── Tool Orchestration ─────────────────────────────────────────────────
export {
  ToolExecutionStatus,
  RiskLevel,
  ToolCallSchema,
  ToolNotFoundError,
  PermissionDeniedError,
  ToolExecutionError,
  makeResult,
  ToolRegistry,
  PermissionService,
  ToolOrchestrator,
  ConsoleAuditLogger,
  SearchEmailsExecutor,
  GetEventsExecutor,
  SendEmailExecutor,
  CreateEventExecutor,
} from "./tools/index.ts";
export type {
  ToolDefinition,
  ToolCall,
  ToolResult,
  ToolExecutionContext,
  AuditEntry,
  AuditLogger,
  ToolExecutor,
  SearchEmailsInput,
  SearchEmailsOutput,
  GetEventsInput,
  GetEventsOutput,
  SendEmailInput,
  SendEmailOutput,
  CreateEventInput,
  CreateEventOutput,
} from "./tools/index.ts";

export { toOpenAiToolDefs } from "./tools/convert.ts";
export type { OpenAiToolDef } from "./tools/convert.ts";

export type { PendingApprovalStore, PendingApproval } from "./tools/approval-store.ts";
export { ApprovalStatus } from "./tools/approval-store.ts";