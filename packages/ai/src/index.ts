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
export { runAgentLoop, healConversation } from "./chat/agent.ts";
export type { RunAgentLoopOptions, AgentLoopResult, AgentLoopNewMessage } from "./chat/agent.ts";

export type { AgentResponse, ApprovalRequiredResponse } from "./chat/types.ts";

// ── Tool Orchestration ─────────────────────────────────────────────────
export {
  ToolExecutionStatus,
  AuditEventType,
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
  GenerateExecutiveBriefExecutor,
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
  GenerateExecutiveBriefInput,
  GenerateExecutiveBriefOutput,
} from "./tools/index.ts";

export { toOpenAiToolDefs } from "./tools/convert.ts";
export type { OpenAiToolDef } from "./tools/convert.ts";

export type { PendingApprovalStore, PendingApproval } from "./tools/approval-store.ts";
export { ApprovalStatus } from "./tools/approval-store.ts";

// ── Security Firewall ─────────────────────────────────────────────────
export { SecurityFirewall, firewall } from "./security/index.ts";
export { detectSensitive, isSensitive } from "./security/index.ts";
export { sanitizeText, sanitizeToolResult } from "./security/index.ts";
export { detectPromptInjection } from "./security/index.ts";
export { detectPII, hasPII, maskPII, PIICategory } from "./security/index.ts";
export type { PIIMatch, PIIDetectionResult, PIIMaskResult } from "./security/index.ts";
export { SecurityEventType, SensitivityCategory } from "./security/index.ts";
export { WriteGuard, writeGuard, PhishingRisk } from "./security/index.ts";
export { RateLimiter, rateLimiter } from "./security/index.ts";
export type {
  SecurityEvent,
  DetectionResult,
  SanitizationResult,
  WriteGuardResult,
  RateCheckResult,
} from "./security/index.ts";

// ── Prompts ────────────────────────────────────────────────────────────
export { classifyEmailPriority, classifyEmailPriorityBatch } from "./prompts/priority.ts";
export type {
  PriorityClassificationResult,
  PriorityBatchItem,
  PriorityBatchResult,
  MatchedSignal,
} from "./prompts/priority.ts";
export {
  buildUserSummary,
  buildClassificationContext,
  renderContextBlock,
} from "./prompts/user-summary.ts";
export type { ClassificationContext } from "./prompts/user-summary.ts";
export {
  applyProfileOverrides,
  extractSenderDomain,
} from "./prompts/overrides.ts";
export type { ProfileOverrideInput } from "./prompts/overrides.ts";
export { evaluateFeedback } from "./prompts/feedback-evaluator.ts";
export type { FeedbackEvaluationResult } from "./prompts/feedback-evaluator.ts";