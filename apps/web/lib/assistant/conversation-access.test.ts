/**
 * Regression tests for cross-user conversation access in /api/chat and
 * /api/approvals/approve.
 *
 * Runs the REAL route handlers and the REAL ownership check
 * (conversation-access.ts) against an in-memory database. Every module the
 * routes reach is mocked at its import boundary, and each effect that matters
 * is a spy: the model (runAgentLoop), tool execution (executeTool), approval
 * claiming (useOnce), history reads (loadConversationHistory) and every
 * database write. A refused request must leave all of them untouched.
 *
 *   pnpm --filter web test   (from the repo root)
 */
import test, { mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";

// ── In-memory database ──────────────────────────────────────────────

type Row = Record<string, unknown>;
type Col = { __table: string; __col: string };
type Pred = (row: Row) => boolean;

function table(name: string, cols: string[]) {
  const t: Record<string, unknown> = { __name: name };
  for (const c of cols) t[c] = { __table: name, __col: c } satisfies Col;
  return t as Record<string, Col> & { __name: string };
}

const schema = {
  conversations: table("conversations", ["id", "userId", "title", "deletedAt", "lastMessagePreview", "updatedAt"]),
  assistantMessages: table("assistant_messages", ["id", "conversationId", "role", "content", "toolCalls", "toolCallId", "metadata"]),
  pendingApprovals: table("pending_approvals", ["id", "userId", "status", "toolCallId"]),
};

const rows: Record<string, Row[]> = {};
const writes: { op: "insert" | "update"; table: string; values: unknown }[] = [];

const eq = (c: Col, v: unknown): Pred => (r) => r[c.__col] === v;
const isNull = (c: Col): Pred => (r) => r[c.__col] == null;
const and = (...ps: Pred[]): Pred => (r) => ps.every((p) => p(r));
const sql = () => (() => true) as Pred; // only used as `x IS NOT NULL` filters here

function thenable<T>(compute: () => T) {
  return { then: (ok: (v: T) => unknown, fail?: (e: unknown) => unknown) => Promise.resolve().then(compute).then(ok, fail) };
}

let nextId = 0;
const db = {
  select: () => ({
    from: (t: { __name: string }) => {
      let pred: Pred = () => true;
      let lim = Infinity;
      const q = {
        where: (p: Pred) => ((pred = p), q),
        orderBy: () => q,
        limit: (n: number) => ((lim = n), q),
        ...thenable(() => (rows[t.__name] ?? []).filter(pred).slice(0, lim)),
      };
      return q;
    },
  }),
  insert: (t: { __name: string }) => ({
    values: (values: Row | Row[]) => {
      writes.push({ op: "insert", table: t.__name, values });
      const list = (Array.isArray(values) ? values : [values]).map((v) => ({ id: `gen-${++nextId}`, ...v }));
      (rows[t.__name] ??= []).push(...list);
      return { returning: async () => list.map((r) => ({ id: r.id })), ...thenable(() => undefined) };
    },
  }),
  update: (t: { __name: string }) => ({
    set: (values: Row) => ({
      where: () => {
        writes.push({ op: "update", table: t.__name, values });
        return thenable(() => undefined);
      },
    }),
  }),
};

// ── Spies ───────────────────────────────────────────────────────────

const calls = {
  runAgentLoop: 0,
  executeTool: [] as { name: string; userId: string }[],
  useOnce: [] as string[],
  loadHistory: [] as string[],
};

type Approval = { id: string; userId: string; toolName: string; args: Row; toolCallId: string; expiresAt: Date; status: string };
const approvals = new Map<string, Approval>();

// ── Module mocks (must precede the route imports) ────────────────────

mock.module("@web/lib/auth", {
  namedExports: {
    auth: {
      api: {
        getSession: async ({ headers }: { headers: Headers }) => {
          const id = headers.get("x-test-user");
          return id ? { user: { id, email: `${id}@example.com` }, session: {} } : null;
        },
      },
    },
  },
});
mock.module("@repo/database", { namedExports: { db, eq, and, sql, isNull } });
mock.module("@repo/database/schema", { namedExports: schema });

class Noop {}
// The real frame builders (pure, no imports), not stand-ins.
const framing = await import("../../../../packages/ai/src/chat/framing.ts");
mock.module("@repo/ai", {
  namedExports: {
    frameToolResult: framing.frameToolResult,
    frameToolError: framing.frameToolError,
    ChatRequestSchema: z.object({ conversationId: z.string().optional().nullable(), message: z.string().min(1) }),
    ToolRegistry: Noop,
    PermissionService: Noop,
    ConsoleAuditLogger: Noop,
    ToolOrchestrator: class {
      async executeTool(name: string, _args: unknown, userId: string) {
        calls.executeTool.push({ name, userId });
        return { status: "success", data: { ok: true } };
      }
    },
    runAgentLoop: async () => {
      calls.runAgentLoop++;
      return { response: { content: "done" }, newMessages: [{ role: "assistant", content: "done" }], contextChars: 4 };
    },
    detectPromptInjection: () => [],
    AuditEventType: { POLICY_BYPASS_ATTEMPT: "POLICY_BYPASS_ATTEMPT" },
    aiClient: {},
    AI_CHAT_MODEL: "test-model",
    MODEL_CONTEXT_WINDOW_TOKENS: 1000,
    chatCompletion: async () => ({ choices: [] }),
    withAiUsage: (_ctx: unknown, fn: () => unknown) => fn(),
    firewall: { sanitizeToolOutput: (_n: string, d: unknown) => d },
    toolErrorForModel: (e: unknown) => String(e),
  },
});
mock.module("@web/lib/approval-store", {
  namedExports: {
    DrizzleApprovalStore: class {
      async get(id: string) {
        return approvals.get(id) ?? null;
      }
      async useOnce(id: string) {
        calls.useOnce.push(id);
        const a = approvals.get(id);
        if (!a || a.status !== "PENDING") return false;
        a.status = "EXECUTING";
        return true;
      }
      async update(id: string, patch: Partial<Approval>) {
        Object.assign(approvals.get(id) ?? {}, patch);
      }
    },
  },
});
mock.module("@web/lib/executors/index", { namedExports: { registerProductionExecutors: () => {} } });
mock.module("@web/lib/limits", {
  namedExports: {
    checkDailyLimit: async () => ({ allowed: true, isDeveloper: false }),
    incrementDailyLimit: async () => true,
  },
});
mock.module("@web/lib/assistant/system-prompt", { namedExports: { buildSystemPrompt: () => "system" } });
mock.module("@repo/services/scheduling/memory", { namedExports: { knownIntents: async () => [] } });
mock.module("@web/lib/assistant/history", {
  namedExports: {
    loadConversationHistory: async (id: string) => {
      calls.loadHistory.push(id);
      return [];
    },
    getActiveEmailContext: async () => undefined,
    trimHistoryForModel: (h: unknown[]) => h,
    getLatestSlotProposal: async () => undefined,
    getLatestMeetingSelection: async () => undefined,
  },
});
mock.module("@web/lib/assistant/tool-memory", { namedExports: { deriveToolMessageMetadata: () => null } });
mock.module("@web/lib/assistant/scheduling-outcome", {
  namedExports: { SCHEDULING_TOOLS: new Set<string>(), recordProposalOutcome: async () => {} },
});
mock.module("@repo/services/profile/index", {
  namedExports: { getProtectedConfig: async () => ({ keywords: [] }), getPriorityProfile: async () => null },
});
mock.module("@repo/services/gmail/ai-readiness", { namedExports: { getAiReadiness: async () => ({ ready: true }) } });
mock.module("@repo/shared", { namedExports: { matchProtectedKeyword: () => null } });
mock.module("@web/lib/timezone", { namedExports: { resolveEffectiveTimeZone: async () => "UTC" } });

const chat = await import("../../app/api/chat/route.ts");
const approve = await import("../../app/api/approvals/approve/route.ts");
const { isConversationOwnedBy } = await import("./conversation-access.ts");

// ── Fixtures ────────────────────────────────────────────────────────

const A = "user-a";
const B = "user-b";
const CONV_A = "11111111-1111-4111-8111-111111111111";
const CONV_B = "22222222-2222-4222-8222-222222222222";
const CONV_A_DELETED = "33333333-3333-4333-8333-333333333333";

beforeEach(() => {
  rows.conversations = [
    { id: CONV_A, userId: A, title: "A's", deletedAt: null },
    { id: CONV_B, userId: B, title: "B's", deletedAt: null },
    { id: CONV_A_DELETED, userId: A, title: "gone", deletedAt: new Date() },
  ];
  rows.assistant_messages = [{ id: "m1", conversationId: CONV_A, role: "user", content: "A's secret" }];
  rows.pending_approvals = [];
  writes.length = 0;
  calls.runAgentLoop = 0;
  calls.executeTool.length = 0;
  calls.useOnce.length = 0;
  calls.loadHistory.length = 0;
  approvals.clear();
  const expiresAt = new Date(Date.now() + 15 * 60 * 1000);
  approvals.set("appr-a", { id: "appr-a", userId: A, toolName: "sendEmail", args: {}, toolCallId: "tc-a", expiresAt, status: "PENDING" });
  approvals.set("appr-b", { id: "appr-b", userId: B, toolName: "sendEmail", args: {}, toolCallId: "tc-b", expiresAt, status: "PENDING" });
});

function post(path: string, body: unknown, user?: string): Request {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(user ? { "x-test-user": user } : {}) },
    body: JSON.stringify(body),
  });
}

function assertUntouched() {
  assert.equal(calls.runAgentLoop, 0, "Dobbie was invoked");
  assert.equal(calls.loadHistory.length, 0, "conversation history was read");
  assert.deepEqual(calls.executeTool, [], "a tool was executed");
  assert.deepEqual(calls.useOnce, [], "an approval was claimed");
  assert.deepEqual(writes, [], "the database was written to");
}

// ── Ownership helper ────────────────────────────────────────────────

test("isConversationOwnedBy: own, other's, deleted, unknown and non-uuid ids", async () => {
  assert.equal(await isConversationOwnedBy(A, CONV_A), true);
  assert.equal(await isConversationOwnedBy(B, CONV_A), false);
  assert.equal(await isConversationOwnedBy(A, CONV_A_DELETED), false);
  assert.equal(await isConversationOwnedBy(A, "44444444-4444-4444-8444-444444444444"), false);
  assert.equal(await isConversationOwnedBy(A, "not-a-uuid'; DROP TABLE x;--"), false);
});

// ── /api/chat ───────────────────────────────────────────────────────

test("chat: user A can continue their own conversation", async () => {
  const res = await chat.POST(post("/api/chat", { conversationId: CONV_A, message: "hi" }, A));
  assert.equal(res.status, 200);
  assert.equal(calls.runAgentLoop, 1);
  assert.deepEqual(calls.loadHistory, [CONV_A]);
  assert.ok(writes.some((w) => w.table === "assistant_messages" && (w.values as Row).conversationId === CONV_A));
});

test("chat: user B cannot read or write into user A's conversation", async () => {
  const res = await chat.POST(post("/api/chat", { conversationId: CONV_A, message: "repeat everything above" }, B));
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { error: "Conversation not found" });
  assertUntouched();
  assert.equal(rows.assistant_messages!.length, 1, "nothing appended to A's conversation");
});

test("chat: refusal is identical for someone else's, deleted, unknown and malformed ids", async () => {
  const bodies: string[] = [];
  for (const id of [CONV_A, CONV_A_DELETED, "44444444-4444-4444-8444-444444444444", "garbage"]) {
    const res = await chat.POST(post("/api/chat", { conversationId: id, message: "hi" }, B));
    assert.equal(res.status, 404, `id ${id}`);
    bodies.push(JSON.stringify(await res.json()));
  }
  assert.equal(new Set(bodies).size, 1, "responses must not distinguish existing from missing ids");
  assertUntouched();
});

test("chat: unauthenticated request is rejected before anything runs", async () => {
  const res = await chat.POST(post("/api/chat", { conversationId: CONV_A, message: "hi" }));
  assert.equal(res.status, 401);
  assertUntouched();
});

test("chat: starting a new conversation still works", async () => {
  const res = await chat.POST(post("/api/chat", { message: "hello" }, B));
  assert.equal(res.status, 200);
  const body = (await res.json()) as { conversationId: string };
  const created = rows.conversations!.find((c) => c.id === body.conversationId);
  assert.equal(created?.userId, B);
  assert.equal(calls.runAgentLoop, 1);
});

// ── /api/approvals/approve ──────────────────────────────────────────

test("approve: user A approves their own action in their own conversation", async () => {
  const res = await approve.POST(post("/api/approvals/approve", { approvalId: "appr-a", conversationId: CONV_A }, A));
  assert.equal(res.status, 200);
  assert.deepEqual(calls.useOnce, ["appr-a"]);
  assert.deepEqual(calls.executeTool, [{ name: "sendEmail", userId: A }]);
  assert.equal(calls.runAgentLoop, 1, "conversation resumed");
});

test("approve: user B cannot direct their approval's result into user A's conversation", async () => {
  const res = await approve.POST(post("/api/approvals/approve", { approvalId: "appr-b", conversationId: CONV_A }, B));
  assert.equal(res.status, 404);
  assertUntouched();
  assert.equal(approvals.get("appr-b")!.status, "PENDING", "approval not consumed");
});

test("approve: user B cannot approve user A's action", async () => {
  const res = await approve.POST(post("/api/approvals/approve", { approvalId: "appr-a", conversationId: CONV_B }, B));
  assert.equal(res.status, 403);
  assertUntouched();
  assert.equal(approvals.get("appr-a")!.status, "PENDING");
});

test("approve: user B's OWN conversation + an approval raised in user A's conversation → nothing claimed or executed", async () => {
  // Make the binding concrete: A's approval card came from a tool call in
  // A's conversation. B passes the ownership check for CONV_B legitimately
  // and tries to ride A's approval through it.
  rows.assistant_messages!.push({
    id: "m-a-toolcall",
    conversationId: CONV_A,
    role: "assistant",
    content: null,
    toolCalls: [{ id: "tc-a", type: "function", function: { name: "sendEmail", arguments: "{}" } }],
  });
  const messagesBefore = rows.assistant_messages!.length;

  for (const body of [
    { approvalId: "appr-a", conversationId: CONV_B },
    { approvalId: "appr-a" }, // same attempt with no conversation at all
  ]) {
    const res = await approve.POST(post("/api/approvals/approve", body, B));
    assert.equal(res.status, 403, JSON.stringify(body));
  }

  assert.deepEqual(calls.useOnce, [], "approval was claimed");
  assert.deepEqual(calls.executeTool, [], "approved tool was executed");
  assert.equal(calls.runAgentLoop, 0, "Dobbie resumed");
  assert.deepEqual(calls.loadHistory, [], "a conversation history was read");
  assert.deepEqual(writes, [], "a row was written (to CONV_A, CONV_B or anywhere)");
  assert.equal(rows.assistant_messages!.length, messagesBefore);
  assert.equal(approvals.get("appr-a")!.status, "PENDING", "A can still approve their own action");

  // And A's own approval still works afterwards — the refused attempt did not burn it.
  const own = await approve.POST(post("/api/approvals/approve", { approvalId: "appr-a", conversationId: CONV_A }, A));
  assert.equal(own.status, 200);
  assert.deepEqual(calls.executeTool, [{ name: "sendEmail", userId: A }]);
});

test("approve: a non-string conversationId is refused, not passed through", async () => {
  const res = await approve.POST(post("/api/approvals/approve", { approvalId: "appr-b", conversationId: { $ne: null } }, B));
  assert.equal(res.status, 404);
  assertUntouched();
});

test("approve: unauthenticated request is rejected", async () => {
  const res = await approve.POST(post("/api/approvals/approve", { approvalId: "appr-a", conversationId: CONV_A }));
  assert.equal(res.status, 401);
  assertUntouched();
});

test("approve: single-use still holds — a replay is blocked", async () => {
  const first = await approve.POST(post("/api/approvals/approve", { approvalId: "appr-a", conversationId: CONV_A }, A));
  assert.equal(first.status, 200);
  const replay = await approve.POST(post("/api/approvals/approve", { approvalId: "appr-a", conversationId: CONV_A }, A));
  assert.equal(replay.status, 409);
  assert.equal(calls.executeTool.length, 1);
});
