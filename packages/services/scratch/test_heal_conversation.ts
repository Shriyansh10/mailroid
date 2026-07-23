import { healConversation } from "@repo/ai";

// ── Tiny assertion helpers (no external test runner) ────────────────────
let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail?: unknown) {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    console.log(`  ❌ ${name}`);
    if (detail !== undefined) console.log("     got:", JSON.stringify(detail));
  }
}

type Msg = {
  role: string;
  content?: string | null;
  tool_calls?: any[];
  tool_call_id?: string;
};

const assistantCall = (id: string, content: string | null = null): Msg => ({
  role: "assistant",
  content,
  tool_calls: [{ id, type: "function", function: { name: "replyToEmail", arguments: "{}" } }],
});
const toolResult = (id: string, content = `result-${id}`): Msg => ({ role: "tool", tool_call_id: id, content });
const user = (content: string): Msg => ({ role: "user", content });

/** True if every `tool` message is immediately preceded by an assistant whose tool_calls include its id. */
function isValidPayload(msgs: Msg[]): boolean {
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i]!.role !== "tool") continue;
    const prev = msgs[i - 1];
    if (!prev || prev.role !== "tool") {
      // start of a tool run — the message before the run must be an assistant with a matching id
      const before = msgs[i - 1];
      if (!before || before.role !== "assistant" || !before.tool_calls) return false;
    }
    // the owning assistant is the nearest preceding assistant-with-tool_calls before this run
    let k = i;
    while (k > 0 && msgs[k - 1]!.role === "tool") k--;
    const owner = msgs[k - 1];
    if (!owner || owner.role !== "assistant" || !owner.tool_calls) return false;
    const ids = new Set(owner.tool_calls.map((tc: any) => tc.id));
    if (!ids.has(msgs[i]!.tool_call_id)) return false;
  }
  return true;
}

function main() {
  console.log("=== healConversation regression tests ===\n");

  // 1. The exact reproduction: tool response separated from its request by a user message.
  {
    const input: Msg[] = [assistantCall("X"), user("fetch that email"), toolResult("X")];
    const out = healConversation(input);
    const xIdx = out.findIndex((m) => m.role === "tool" && m.tool_call_id === "X");
    const asstIdx = out.findIndex((m) => m.role === "assistant" && m.tool_calls);
    const userIdx = out.findIndex((m) => m.role === "user");
    console.log("Test 1: relocate orphaned-by-position tool response");
    check("tool(X) sits immediately after its assistant", xIdx === asstIdx + 1, out);
    check("tool(X) is before the user message", xIdx < userIdx, out);
    check("real result preserved (no dummy)", out[xIdx]?.content === "result-X", out[xIdx]);
    check("payload is valid", isValidPayload(out), out);
    check("no dummy inserted", !out.some((m) => m.content?.includes("cancelled")), out);
  }

  // 2. Tool message whose id matches no assistant tool_calls anywhere → dropped.
  {
    const input: Msg[] = [user("hi"), { role: "assistant", content: "hello" }, toolResult("GHOST")];
    const out = healConversation(input);
    console.log("\nTest 2: drop truly orphaned tool message");
    check("ghost tool message removed", !out.some((m) => m.role === "tool"), out);
    check("payload is valid", isValidPayload(out), out);
  }

  // 3. Assistant tool_calls with a genuinely missing response → forward dummy still inserted.
  {
    const input: Msg[] = [assistantCall("Y"), user("never mind")];
    const out = healConversation(input);
    console.log("\nTest 3: forward heal (dummy for unresponded call) intact");
    const yIdx = out.findIndex((m) => m.role === "tool" && m.tool_call_id === "Y");
    check("dummy tool response inserted for Y", yIdx !== -1, out);
    check("dummy sits right after its assistant", yIdx === 1, out);
    check("dummy marks cancellation", out[yIdx]?.content?.includes("cancelled") ?? false, out[yIdx]);
    check("payload is valid", isValidPayload(out), out);
  }

  // 4. Already-correct pairing is unchanged.
  {
    const input: Msg[] = [user("reply please"), assistantCall("Z"), toolResult("Z"), { role: "assistant", content: "done" }];
    const out = healConversation(input);
    console.log("\nTest 4: already-valid conversation is left intact");
    check("same length", out.length === input.length, out);
    check("order preserved", out.map((m) => m.role).join(",") === "user,assistant,tool,assistant", out);
    check("payload is valid", isValidPayload(out), out);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
