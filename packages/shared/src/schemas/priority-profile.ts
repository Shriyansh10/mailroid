import { z } from "zod";
import {
  ROLE,
  CURRENT_SITUATION,
  PRIORITY_MODE,
  GOAL,
  CURRENT_FOCUS,
  SENDER_CATEGORY,
  TOPIC,
  TOPIC_WEIGHT,
  EXPECTED_EMAIL_TYPE,
  SERVICE,
} from "./priority-profile-config.ts";

// Canonical priority-profile schema — the single source of truth used by
// tRPC input validation, the react-hook-form resolver, and the server-side
// parse before every DB write.
//
// Deliberately transform-free (validation only) so the same schema is safe
// for trpc-to-openapi and zodResolver. Normalization (trim / lowercase /
// dedupe / URL-stripping) happens via the exported sanitize* helpers: the
// tag inputs call them as chips are added, and normalizePriorityProfile()
// runs server-side before parsing, so raw user text never reaches the DB.

const values = <T extends Record<string, string>>(obj: T) =>
  Object.values(obj) as [T[keyof T], ...T[keyof T][]];

// ── Field-level pieces ────────────────────────────────────────────────

// Bare domain like "acme.com" or "mail.acme.co.in" — already normalized.
const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

const domainModel = z
  .string()
  .max(253)
  .regex(DOMAIN_RE, "Enter a valid domain like acme.com");

// Keywords/services: letters, numbers, spaces and a few joiners — nothing
// that could read as markup or prompt structure.
const TAG_RE = /^[\p{L}\p{N}][\p{L}\p{N}\s\-_.@#+]{0,49}$/u;

const tagModel = z.string().min(1).max(50).regex(TAG_RE, "Invalid characters");

const uniqueArray = (items: string[]) =>
  new Set(items.map((s) => s.toLowerCase())).size === items.length;

// ── Profile schema ────────────────────────────────────────────────────

export const priorityProfileModel = z.object({
  version: z.literal(1),
  enabledFeatures: z.object({
    personalization: z.boolean(),
    focusMode: z.boolean(),
    behavioralLearning: z.boolean(),
  }),
  profile: z.object({
    role: z.enum(values(ROLE)),
    currentSituation: z.enum(values(CURRENT_SITUATION)),
    // Never exposed in the UI — derived from the Likert answer.
    priorityMode: z.enum(values(PRIORITY_MODE)),
  }),
  interests: z.object({
    activeGoals: z.array(z.enum(values(GOAL))).max(5),
    currentFocus: z.object({
      items: z.array(z.enum(values(CURRENT_FOCUS))).max(5),
      // ISO datetime; stamped now+30d on save. Summary builder ignores the
      // whole focus block once expired.
      expiresAt: z.string().nullable(),
    }),
  }),
  senders: z
    .object({
      categories: z.array(z.enum(values(SENDER_CATEGORY))).max(8),
      importantDomains: z
        .array(domainModel)
        .max(20)
        .refine(uniqueArray, "Duplicate domains"),
      mutedDomains: z
        .array(domainModel)
        .max(20)
        .refine(uniqueArray, "Duplicate domains"),
    })
    .refine(
      (s) =>
        !s.importantDomains.some((d) => s.mutedDomains.includes(d)),
      { message: "A domain can't be both important and muted" },
    ),
  content: z.object({
    importantTopics: z
      .array(
        z.object({
          id: z.enum(values(TOPIC)),
          weight: z.enum(values(TOPIC_WEIGHT)),
          customKeywords: z.array(tagModel).max(10),
        }),
      )
      .max(10)
      .refine((t) => uniqueArray(t.map((x) => x.id)), "Duplicate topics"),
    customKeywords: z
      .array(tagModel)
      .max(20)
      .refine(uniqueArray, "Duplicate keywords"),
  }),
  context: z.object({
    expectedEmailTypes: z.array(z.enum(values(EXPECTED_EMAIL_TYPE))).max(9),
    servicesUsed: z.array(z.enum(values(SERVICE))).max(12),
    customServices: z
      .array(tagModel)
      .max(10)
      .refine(uniqueArray, "Duplicate services"),
  }),
  preferences: z.object({
    securityAlerts: z.boolean(),
    bills: z.boolean(),
    calendarInvites: z.boolean(),
    packageTracking: z.boolean(),
    newsletters: z.boolean(),
    promotions: z.boolean(),
    socialNotifications: z.boolean(),
    githubNotifications: z.boolean(),
  }),
});

export type PriorityProfile = z.infer<typeof priorityProfileModel>;

// What the API returns: null until the user has ever saved (or skipped).
export const priorityProfileRecordModel = z.object({
  data: priorityProfileModel,
  completedOnboarding: z.boolean(),
  updatedAt: z.string().nullable(),
});
export type PriorityProfileRecord = z.infer<typeof priorityProfileRecordModel>;

// ── Defaults (used by the skip path and as RHF initial values) ────────

export const DEFAULT_PRIORITY_PROFILE: PriorityProfile = {
  version: 1,
  enabledFeatures: {
    personalization: true,
    focusMode: false,
    behavioralLearning: false,
  },
  profile: {
    role: ROLE.PROFESSIONAL,
    currentSituation: CURRENT_SITUATION.WORKING_FULL_TIME,
    priorityMode: PRIORITY_MODE.BALANCED,
  },
  interests: {
    activeGoals: [],
    currentFocus: { items: [], expiresAt: null },
  },
  senders: { categories: [], importantDomains: [], mutedDomains: [] },
  content: { importantTopics: [], customKeywords: [] },
  context: { expectedEmailTypes: [], servicesUsed: [], customServices: [] },
  preferences: {
    securityAlerts: true,
    bills: true,
    calendarInvites: true,
    packageTracking: true,
    newsletters: true,
    promotions: false,
    socialNotifications: false,
    githubNotifications: true,
  },
};

// ── Sanitizers (normalization lives here, not in the schema) ──────────

// "https://www.Acme.com/careers" -> "acme.com"; returns null if the result
// isn't a plausible domain.
export function sanitizeDomainInput(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^[a-z+]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#\s]/)[0]!
    .replace(/^.*@/, "") // tolerate pasted addresses: a@b.com -> b.com
    .replace(/\.$/, "");
  return DOMAIN_RE.test(cleaned) && cleaned.length <= 253 ? cleaned : null;
}

// Strips control/special characters from a free-text tag; null if nothing
// valid remains.
export function sanitizeTagInput(raw: string): string | null {
  const cleaned = raw
    .trim()
    .replace(/[^\p{L}\p{N}\s\-_.@#+]/gu, "")
    .replace(/\s+/g, " ")
    .slice(0, 50);
  return TAG_RE.test(cleaned) ? cleaned : null;
}

const dedupe = (items: string[]) => {
  const seen = new Set<string>();
  return items.filter((s) => {
    const k = s.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

// Server-side belt-and-braces: re-sanitizes every free-text field and drops
// anything invalid, so a caller bypassing the form still can't write raw
// text. Run before priorityProfileModel.parse().
export function normalizePriorityProfile(input: PriorityProfile): PriorityProfile {
  const domains = (xs: string[]) =>
    dedupe(
      xs.map(sanitizeDomainInput).filter((d): d is string => d !== null),
    ).slice(0, 20);
  const tags = (xs: string[], cap: number) =>
    dedupe(
      xs.map(sanitizeTagInput).filter((t): t is string => t !== null),
    ).slice(0, cap);

  const importantDomains = domains(input.senders.importantDomains);
  const mutedDomains = domains(input.senders.mutedDomains).filter(
    (d) => !importantDomains.includes(d),
  );

  return {
    ...input,
    senders: {
      categories: dedupe(input.senders.categories) as typeof input.senders.categories,
      importantDomains,
      mutedDomains,
    },
    interests: {
      activeGoals: dedupe(input.interests.activeGoals).slice(0, 5) as typeof input.interests.activeGoals,
      currentFocus: {
        items: dedupe(input.interests.currentFocus.items).slice(0, 5) as typeof input.interests.currentFocus.items,
        expiresAt: input.interests.currentFocus.expiresAt,
      },
    },
    content: {
      importantTopics: input.content.importantTopics
        .filter(
          (t, i, arr) => arr.findIndex((x) => x.id === t.id) === i,
        )
        .slice(0, 10)
        .map((t) => ({ ...t, customKeywords: tags(t.customKeywords, 10) })),
      customKeywords: tags(input.content.customKeywords, 20),
    },
    context: {
      expectedEmailTypes: dedupe(input.context.expectedEmailTypes) as typeof input.context.expectedEmailTypes,
      servicesUsed: dedupe(input.context.servicesUsed) as typeof input.context.servicesUsed,
      customServices: tags(input.context.customServices, 10),
    },
  };
}
