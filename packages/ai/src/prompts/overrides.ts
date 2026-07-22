import type { PriorityClassificationResult } from "./priority.ts";

// ── Deterministic profile overrides ───────────────────────────────────
//
// Muted senders never depend on the LLM: whatever it said, a sender the
// user explicitly muted is forced LOW here, after the call. This is rule 1
// of the precedence order (muted > explicit preferences > soft profile
// boosts > mode bias) — content can never override an explicit mute.

export interface ProfileOverrideInput {
  mutedDomains: string[];
  preferences: { githubNotifications: boolean };
}

/** "Jane Doe <jane@mail.acme.com>" -> "mail.acme.com"; null if no domain found. */
export function extractSenderDomain(sender: string): string | null {
  const angled = sender.match(/<([^<>\s]+@[^<>\s]+)>/);
  const addr = angled?.[1] ?? sender.trim();
  const at = addr.lastIndexOf("@");
  if (at === -1) return null;
  const domain = addr
    .slice(at + 1)
    .toLowerCase()
    .replace(/[>\s].*$/, "")
    .replace(/\.$/, "");
  return domain.includes(".") ? domain : null;
}

/** Exact match or subdomain: "notifications.github.com" matches muted "github.com". */
function domainMatches(domain: string, muted: string): boolean {
  return domain === muted || domain.endsWith(`.${muted}`);
}

export function applyProfileOverrides(
  sender: string,
  result: PriorityClassificationResult,
  profile: ProfileOverrideInput | undefined,
): PriorityClassificationResult {
  if (!profile) return result;

  const domain = extractSenderDomain(sender);
  if (!domain) return result;

  const muted = [...profile.mutedDomains];
  if (!profile.preferences.githubNotifications) muted.push("github.com");

  const hit = muted.find((m) => domainMatches(domain, m));
  if (!hit) return result;

  return {
    priority: "LOW",
    priorityScore: Math.min(result.priorityScore, 0.1),
    priorityReason: "Muted sender (your settings)",
    isActionRequired: false,
    isReplyNeeded: false,
    matchedSignals: [{ source: "muted_sender", value: hit }],
  };
}
