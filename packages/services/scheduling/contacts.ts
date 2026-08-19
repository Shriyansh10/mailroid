import crypto from "node:crypto";
import { db, eq, and, or, desc, sql, inArray } from "@repo/database";
// @ts-ignore — re-exported via schema.ts
import { emails, messageMetadata, schedulingContacts, schedulingContactGroups } from "@repo/database/schema";

/**
 * Recipient resolution — turning "schedule lunch with Alex" into someone the
 * calendar can actually invite, without ever showing the model an address.
 *
 * Resolution order (fixed, and deliberately not a search relevance score):
 *   1. participants on the thread in context
 *   2. recent mailbox contacts
 *   3. an explicit address the user typed themselves
 *   4. ask
 *
 * Step 4 is not a failure mode, it is the design. `CLAUDE.md`: ambiguity is
 * asked, never guessed — two Alexes must produce a question, and a name that
 * resolves to nobody must be surfaced rather than silently dropped from the
 * invite.
 */

// ── Handles ──────────────────────────────────────────────────────────

const HANDLE_PREFIX = "c_";

/**
 * Keyed so a database dump does not yield addresses by brute force: email
 * addresses are low-entropy enough that a plain hash would be reversible with
 * a wordlist. Falls back to a fixed dev key with a warning rather than
 * throwing, so local work without a full env still runs — but the fallback is
 * constant, so handles stay stable rather than dying on every restart.
 */
function handleKey(): string {
  const secret = process.env.BETTER_AUTH_SECRET;
  if (secret) return secret;
  console.warn("[scheduling:contacts] BETTER_AUTH_SECRET unset; using dev handle key");
  return "mailroid-dev-handle-key";
}

/** Stable, opaque handle for (user, address). Same input always gives the same handle. */
export function contactHandle(userId: string, email: string): string {
  const normalized = normalizeEmail(email);
  const mac = crypto
    .createHmac("sha256", handleKey())
    .update(`${userId}:${normalized}`)
    .digest("hex");
  return `${HANDLE_PREFIX}${mac.slice(0, 16)}`;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

// ── Parsing mailbox address fields ───────────────────────────────────

const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

export interface ParsedAddress {
  email: string;
  displayName?: string;
}

/**
 * Pull addresses out of an RFC-ish header value: `A <a@x.com>, b@y.com`.
 * Deliberately lenient — these strings come from real mail, which is messier
 * than the spec, and a header we cannot parse should yield nothing rather
 * than throw mid-turn.
 */
export function parseAddressList(value: string | null | undefined): ParsedAddress[] {
  if (!value) return [];

  return value
    .split(",")
    .flatMap((part) => {
      const matches = part.match(EMAIL_RE);
      if (!matches?.length) return [];
      const email = normalizeEmail(matches[0]!);

      // "Alex Mehta <alex@x.com>" → "Alex Mehta"
      const namePart = part.slice(0, part.indexOf(matches[0]!)).trim();
      const displayName = namePart
        .replace(/[<>"']/g, "")
        .replace(/\s+/g, " ")
        .trim();

      return [{ email, displayName: displayName || undefined }];
    })
    .filter((a) => a.email.includes("@"));
}

/** Fallback display name when mail carried none: `alex.mehta@x` → `Alex Mehta`. */
function nameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * The display name to keep when the query was a literal address — or
 * `undefined` to let `nameFromEmail` derive one.
 *
 * Exists because `persistAndProject` OVERWRITES `display_name` on conflict,
 * and `parseAddressList` treats everything before the address as a name. The
 * assistant is now told to pass a user-typed address straight through, and it
 * will sometimes pass the surrounding phrase with it — "schedule a call with
 * sam@acme.com". Trusting that would permanently rename a real contact to
 * "schedule a call with".
 *
 * So a name survives only from a genuine address form:
 *
 *   "alex@x.com"                 → undefined      (derive from the address)
 *   "Alex Mehta <alex@x.com>"    → "Alex Mehta"   (a real name, keep it)
 *   "call with alex@x.com"       → undefined      (prose, not a name)
 *
 * The address itself resolves in every case; only the name is discarded.
 */
export function explicitDisplayName(
  query: string,
  parsedDisplayName: string | undefined,
): string | undefined {
  return /^[^<>]*<[^<>]+>$/.test(query.trim()) ? parsedDisplayName : undefined;
}

// ── Candidates ───────────────────────────────────────────────────────

export type ContactSource = "THREAD" | "MAILBOX" | "EXPLICIT";

/**
 * What the model is allowed to see about a person. Note the absence of an
 * `email` field — that is the entire point, and it is enforced by this type
 * rather than by remembering not to log one.
 */
export interface ContactCandidate {
  handle: string;
  displayName: string;
  /** Human context for disambiguation ("on this thread", "emailed Tuesday"). */
  hint: string;
  source: ContactSource;
  lastSeenAt?: string;
}

interface RawContact {
  email: string;
  displayName?: string;
  lastSeenAt?: Date;
  source: ContactSource;
}

// ── Persistence ──────────────────────────────────────────────────────

/**
 * Record contacts so their handles can be resolved back later, and return the
 * candidates the model may see.
 *
 * Upsert rather than insert: the same person shows up on many messages, and
 * the newest sighting should win for both display name and recency.
 */
async function persistAndProject(
  userId: string,
  raws: RawContact[],
): Promise<ContactCandidate[]> {
  if (raws.length === 0) return [];

  const rows = raws.map((r) => ({
    userId,
    handle: contactHandle(userId, r.email),
    email: normalizeEmail(r.email),
    displayName: r.displayName || nameFromEmail(r.email),
    lastSeenAt: r.lastSeenAt ?? null,
  }));

  await db
    .insert(schedulingContacts)
    .values(rows)
    .onConflictDoUpdate({
      target: [schedulingContacts.userId, schedulingContacts.email],
      set: {
        displayName: sql`excluded.display_name`,
        lastSeenAt: sql`greatest(coalesce(${schedulingContacts.lastSeenAt}, 'epoch'), coalesce(excluded.last_seen_at, 'epoch'))`,
        updatedAt: new Date(),
      },
    });

  return rows.map((r, i) => ({
    handle: r.handle,
    displayName: r.displayName,
    hint: hintFor(raws[i]!),
    source: raws[i]!.source,
    lastSeenAt: r.lastSeenAt?.toISOString(),
  }));
}

function hintFor(raw: RawContact): string {
  if (raw.source === "THREAD") return "on this thread";
  if (raw.source === "EXPLICIT") return "address you gave";
  if (raw.lastSeenAt) {
    const days = Math.floor((Date.now() - raw.lastSeenAt.getTime()) / 86_400_000);
    if (days <= 0) return "emailed today";
    if (days === 1) return "emailed yesterday";
    if (days < 30) return `emailed ${days} days ago`;
    if (days < 365) return `emailed ${Math.floor(days / 30)} months ago`;
  }
  return "in your mailbox";
}

// ── Tier 1: thread participants ──────────────────────────────────────

async function fromThread(
  userId: string,
  threadId: string,
  selfEmail: string,
): Promise<RawContact[]> {
  const rows = await db
    .select({
      from: emails.from,
      to: emails.to,
      receivedAt: emails.receivedAt,
    })
    .from(emails)
    .where(and(eq(emails.userId, userId), eq(emails.threadId, threadId)))
    .orderBy(desc(emails.receivedAt))
    .limit(50);

  const byEmail = new Map<string, RawContact>();
  for (const row of rows) {
    for (const addr of [...parseAddressList(row.from), ...parseAddressList(row.to)]) {
      if (addr.email === normalizeEmail(selfEmail)) continue;
      const existing = byEmail.get(addr.email);
      if (!existing) {
        byEmail.set(addr.email, {
          email: addr.email,
          displayName: addr.displayName,
          lastSeenAt: row.receivedAt ?? undefined,
          source: "THREAD",
        });
      } else if (!existing.displayName && addr.displayName) {
        existing.displayName = addr.displayName;
      }
    }
  }
  return [...byEmail.values()];
}

// ── Tier 2: recent mailbox contacts ──────────────────────────────────

/**
 * Two sources, because neither is complete on its own:
 *
 *   - `emails.from` / `emails.to` covers BOTH directions, but only inside the
 *     AI window (that table is the hydrated one).
 *   - `message_metadata.sender` covers everything ever synced, but has no
 *     recipient column — so it only ever knows people who wrote TO the user.
 *
 * People the user has *written to* outside the AI window are therefore not
 * discoverable. That is a real limit of the current schema, stated here rather
 * than papered over, and it is why an unresolved name asks instead of guessing.
 */
async function fromMailbox(
  userId: string,
  query: string,
  selfEmail: string,
): Promise<RawContact[]> {
  const like = `%${query.toLowerCase()}%`;

  const hydrated = await db
    .select({ from: emails.from, to: emails.to, receivedAt: emails.receivedAt })
    .from(emails)
    .where(
      and(
        eq(emails.userId, userId),
        or(sql`lower(${emails.from}) like ${like}`, sql`lower(${emails.to}) like ${like}`),
      ),
    )
    .orderBy(desc(emails.receivedAt))
    .limit(200);

  const metadata = await db
    .select({ sender: messageMetadata.sender, receivedAt: messageMetadata.receivedAt })
    .from(messageMetadata)
    .where(
      and(
        eq(messageMetadata.userId, userId),
        sql`lower(${messageMetadata.sender}) like ${like}`,
      ),
    )
    .orderBy(desc(messageMetadata.receivedAt))
    .limit(200);

  const byEmail = new Map<string, RawContact & { hits: number }>();
  const add = (addr: ParsedAddress, seenAt?: Date | null) => {
    if (addr.email === normalizeEmail(selfEmail)) return;
    const existing = byEmail.get(addr.email);
    if (existing) {
      existing.hits++;
      if (seenAt && (!existing.lastSeenAt || seenAt > existing.lastSeenAt)) {
        existing.lastSeenAt = seenAt;
      }
      if (!existing.displayName && addr.displayName) existing.displayName = addr.displayName;
      return;
    }
    byEmail.set(addr.email, {
      email: addr.email,
      displayName: addr.displayName,
      lastSeenAt: seenAt ?? undefined,
      source: "MAILBOX",
      hits: 1,
    });
  };

  for (const row of hydrated) {
    for (const a of [...parseAddressList(row.from), ...parseAddressList(row.to)]) {
      add(a, row.receivedAt);
    }
  }
  for (const row of metadata) {
    for (const a of parseAddressList(row.sender)) add(a, row.receivedAt);
  }

  // Only keep contacts the query actually names — the SQL LIKE matched the
  // whole header, so a match on one address pulls in its co-recipients too.
  const q = query.toLowerCase();
  const matching = [...byEmail.values()].filter(
    (c) => c.email.includes(q) || (c.displayName ?? "").toLowerCase().includes(q),
  );

  // Recency first, then frequency: who you spoke to last is a better guess
  // than who you have spoken to most, and neither is allowed to auto-resolve
  // an ambiguity on its own.
  matching.sort((a, b) => {
    const at = a.lastSeenAt?.getTime() ?? 0;
    const bt = b.lastSeenAt?.getTime() ?? 0;
    return bt - at || b.hits - a.hits;
  });

  return matching.slice(0, 10);
}

// ── Public API ───────────────────────────────────────────────────────

export interface ResolveRecipientOptions {
  userId: string;
  /** The name or address the user said. */
  query: string;
  /** Thread in context, when there is one — tier 1. */
  threadId?: string;
  /** The authenticated account, always excluded from results. */
  selfEmail: string;
}

export interface ResolveRecipientResult {
  candidates: ContactCandidate[];
  /** True when the caller must ask the user which person is meant. */
  ambiguous: boolean;
  /** True when nothing matched at all. */
  notFound: boolean;
}

export async function resolveRecipient(
  opts: ResolveRecipientOptions,
): Promise<ResolveRecipientResult> {
  const { userId, query, threadId, selfEmail } = opts;
  const trimmed = query.trim();

  if (!trimmed) return { candidates: [], ambiguous: false, notFound: true };

  // Tier 3 first when the user typed a literal address — it is unambiguous by
  // construction, so there is nothing to search for or disambiguate.
  const literal = parseAddressList(trimmed);
  if (literal.length === 1 && trimmed.includes("@")) {
    const candidates = await persistAndProject(userId, [
      {
        email: literal[0]!.email,
        displayName: explicitDisplayName(trimmed, literal[0]!.displayName),
        source: "EXPLICIT",
      },
    ]);
    return { candidates, ambiguous: false, notFound: false };
  }

  // Tier 1 — the thread in context.
  if (threadId) {
    const participants = await fromThread(userId, threadId, selfEmail);
    const named = participants.filter(
      (c) =>
        c.email.includes(trimmed.toLowerCase()) ||
        (c.displayName ?? "").toLowerCase().includes(trimmed.toLowerCase()),
    );

    // A single thread participant matching the name needs no mailbox search:
    // "schedule with Alex" inside a thread Alex is on means that Alex.
    if (named.length === 1) {
      return {
        candidates: await persistAndProject(userId, named),
        ambiguous: false,
        notFound: false,
      };
    }
    if (named.length > 1) {
      return {
        candidates: await persistAndProject(userId, named),
        ambiguous: true,
        notFound: false,
      };
    }
  }

  // Tier 2 — the wider mailbox.
  const mailbox = await fromMailbox(userId, trimmed, selfEmail);
  if (mailbox.length === 0) {
    return { candidates: [], ambiguous: false, notFound: true };
  }

  const candidates = await persistAndProject(userId, mailbox);
  return {
    candidates,
    ambiguous: candidates.length > 1,
    notFound: false,
  };
}

/**
 * Handles → addresses. The only place a handle becomes an address, and it is
 * called exclusively from executors, never from anything the model can reach.
 *
 * Unknown handles are reported rather than skipped: silently dropping one
 * would send an invite to fewer people than the user agreed to, which is
 * exactly the kind of quiet degradation `CLAUDE.md` forbids on an
 * outward-facing action.
 */
export async function resolveAttendeeRefs(
  userId: string,
  handles: string[],
): Promise<{ emails: string[]; unknown: string[] }> {
  const unique = [...new Set(handles.filter(Boolean))];
  if (unique.length === 0) return { emails: [], unknown: [] };

  const rows = await db
    .select({ handle: schedulingContacts.handle, email: schedulingContacts.email })
    .from(schedulingContacts)
    .where(
      and(
        eq(schedulingContacts.userId, userId),
        inArray(schedulingContacts.handle, unique),
      ),
    );

  const found = new Map(rows.map((r) => [r.handle, r.email]));
  return {
    emails: unique.map((h) => found.get(h)).filter((e): e is string => Boolean(e)),
    unknown: unique.filter((h) => !found.has(h)),
  };
}

// ── Groups ───────────────────────────────────────────────────────────

/** Every group name the given handles belong to — the join rule scopes use. */
export async function groupsForHandles(
  userId: string,
  handles: string[],
): Promise<string[]> {
  if (handles.length === 0) return [];

  const rows = await db
    .select({ name: schedulingContactGroups.name, handles: schedulingContactGroups.handles })
    .from(schedulingContactGroups)
    .where(eq(schedulingContactGroups.userId, userId));

  const wanted = new Set(handles);
  return rows
    .filter((g) => ((g.handles ?? []) as string[]).some((h) => wanted.has(h)))
    .map((g) => g.name);
}

export async function listContactGroups(userId: string) {
  return db
    .select()
    .from(schedulingContactGroups)
    .where(eq(schedulingContactGroups.userId, userId));
}

export async function upsertContactGroup(
  userId: string,
  name: string,
  handles: string[],
): Promise<void> {
  const normalized = name.trim().toLowerCase();
  await db
    .insert(schedulingContactGroups)
    .values({ userId, name: normalized, handles })
    .onConflictDoUpdate({
      target: [schedulingContactGroups.userId, schedulingContactGroups.name],
      set: { handles, updatedAt: new Date() },
    });
}
