import {
  buildReport,
  organizationsForEmail,
  resolveViewerScope,
  windowForDays,
} from "@repo/services/organization/index";
import { isOrganizationLicensed } from "@repo/services/entitlements";
import { contactHandle } from "@repo/services/scheduling/contacts";
import { maskMailboxTextForModel, matchPeopleByName, metricsPersonForModel } from "@repo/ai";
import type { ToolExecutionContext } from "@repo/ai";

/**
 * The opaque ref a person is shown under. The same keyed hash as a scheduling
 * handle, computed rather than stored: resolution recomputes it over the
 * caller's visible scope, so nothing is written and a ref outside that scope
 * resolves to no one.
 */
const personRef = (userId: string, email: string) => contactHandle(userId, email);

/**
 * Organization metrics, for the assistant.
 *
 * ── Authorization is done here, and nowhere else ──
 *
 * `PermissionService` ignores `userId` entirely — `riskLevel: SAFE` means "this
 * does not write anything", not "anyone may read this". `ToolExecutionContext`
 * carries no organization either. So this executor resolves the caller's
 * licensed organization and their visible scope itself, in the same order as
 * the `orgProcedure` middleware, and fails closed at each step.
 *
 * `person` reaches us from the model, which means it reaches us from
 * whatever the user typed. It is untrusted input, never a resolved identity:
 * asking about a colleague outside the caller's subtree must be REFUSED, not
 * answered with an empty report. An empty report reads as "that person has no
 * mail", which is both wrong and a disclosure that the person exists.
 *
 * ── And no mail content ──
 *
 * Everything returned here is a count, a duration, or a sentence built from
 * them. The organization services cannot read subjects, senders or message
 * text, and this tool must not become the one place that shape leaks.
 */

export interface CommunicationMetricsInput {
  /** A ref from an earlier result, a name, or an address the user typed. */
  person?: string;
  days?: 7 | 30 | 90;
}

export interface CommunicationMetricsOutput {
  found: boolean;
  message?: string;
  window?: { from: string; to: string };
  policy?: Record<string, unknown>;
  totals?: Record<string, unknown>;
  people?: Record<string, unknown>[];
  candidates?: { ref: string; name: string }[];
}

const refuse = (message: string): CommunicationMetricsOutput => ({ found: false, message });

export class OrganizationMetricsExecutor {
  async execute(
    args: CommunicationMetricsInput,
    ctx: ToolExecutionContext,
  ): Promise<CommunicationMetricsOutput> {
    const viewerEmail = ctx.userEmail?.trim().toLowerCase();
    if (!viewerEmail) {
      return refuse("I can't tell which account you're signed in as, so I can't look this up.");
    }

    // Same order as orgProcedure: membership, then licence, then scope.
    const organizations = await organizationsForEmail(viewerEmail);
    const licensed: { organizationId: string; name: string } | null = await firstLicensed(
      organizations,
    );
    if (!licensed) {
      return refuse(
        "You're not part of an organization on Mailroid, so there are no team metrics to show.",
      );
    }

    const scope = await resolveViewerScope(licensed.organizationId, viewerEmail);
    if (!scope) {
      return refuse("You're not a member of this organization.");
    }

    const days = args.days ?? 30;
    const window = windowForDays(days);

    // Who `person` means, resolved inside the visible scope only. The model
    // never sees an address, so it names people by ref or by name; an address
    // is accepted only as something the user typed.
    let subject: string | undefined;
    const asked = args.person?.trim();
    if (asked) {
      const byRef = scope.visibleEmails.find((email) => personRef(ctx.userId, email) === asked);
      if (byRef) {
        subject = byRef;
      } else if (asked.includes("@")) {
        subject = asked.toLowerCase();
        if (!scope.visibleEmails.includes(subject)) {
          // Refusal, not an empty report. The difference matters: one says
          // "you cannot see this", the other says "there is nothing here".
          return refuse(
            "That person isn't someone you can see a report for — they don't report to you, " +
              "directly or through anyone else.",
          );
        }
      } else {
        // A name: matched against the people in scope, never the whole org,
        // so a miss discloses nothing about anyone outside it.
        const everyone = await buildReport({ organizationId: licensed.organizationId, viewerEmail, window });
        const matches = everyone ? matchPeopleByName(everyone.rows, asked) : [];
        if (matches.length === 0) {
          return refuse(
            `No one you can see a report for matches "${maskMailboxTextForModel(asked)}". Ask the user who they mean.`,
          );
        }
        if (matches.length > 1) {
          return {
            found: false,
            message: "Several people you can see match that name. Ask the user which one, then call again with their ref.",
            candidates: matches.map((row) => metricsPersonForModel(row, personRef(ctx.userId, row.email))),
          };
        }
        subject = matches[0]!.email;
      }
    }

    const report = await buildReport({
      organizationId: licensed.organizationId,
      viewerEmail,
      window,
      onlyEmail: subject,
    });
    if (!report) {
      return refuse("I couldn't read a report for that scope.");
    }

    return {
      found: true,
      window: report.window,
      policy: {
        responseTargetSeconds: report.policy.firstResponseTargetSeconds,
        staleAfterSeconds: report.policy.staleAfterSeconds,
        note:
          "Mailroid product defaults, measured in clock time rather than working hours. " +
          "Not a company policy or a compliance requirement.",
      },
      totals: {
        people: report.members,
        connected: report.covered,
        note:
          report.covered < report.members
            ? "Figures cover connected mailboxes only — say so when you report them."
            : undefined,
      },
      people: report.rows.map((row) => ({
        // Only ever someone already in scope — the rows are the scope. Named
        // and referenced, never addressed; see metricsPersonForModel.
        ...metricsPersonForModel(row, personRef(ctx.userId, row.email)),
        connected: row.coverage === "COVERED",
        status: row.status.status,
        statusReason: row.status.reason,
        ...(row.metrics
          ? {
              received: row.metrics.received,
              sent: row.metrics.sent,
              medianReplySeconds: row.metrics.medianResponseSeconds,
              threadsExpectingReply: row.metrics.threadsRespondable,
              threadsAnswered: row.metrics.threadsAnswered,
              threadsAnsweredWithinTarget: row.metrics.threadsAnsweredWithinTarget,
              threadsWaiting: row.metrics.threadsAwaitingReply,
              threadsPastTarget: row.metrics.threadsOverdue,
              threadsStale: row.metrics.threadsStale,
              oldestWaitSeconds: row.metrics.oldestWaitingSeconds,
            }
          : {}),
        // Paired by index, which `recommendationsFor` guarantees — so the
        // assistant can say what to do about each one, not only what is wrong.
        exceptions: row.exceptions.map((flag, i) => ({
          severity: flag.severity,
          reason: flag.reason,
          nextStep: row.recommendations[i]?.text,
        })),
      })),
    };
  }
}

async function firstLicensed(
  organizations: { organizationId: string; name: string }[],
): Promise<{ organizationId: string; name: string } | null> {
  for (const org of organizations) {
    if (await isOrganizationLicensed(org.organizationId)) return org;
  }
  return null;
}
