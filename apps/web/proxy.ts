import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { auth } from "@web/lib/auth";
import { getAiReadiness } from "@repo/services/gmail/ai-readiness";
import { getAccountsExist } from "@repo/services/tenant/index";
import { getSyncStatus } from "@repo/services/gmail/sync-status";
import { getPriorityProfile } from "@repo/services/profile/index";
import { getGlobalMaintenance } from "@repo/services/gmail/pause";
import { logger } from "@repo/logger";

/**
 * "Proxy" (formerly "middleware") always runs on the Node.js runtime in this
 * Next.js version — unlike the old edge-only middleware.ts — so it's safe to
 * reach Postgres directly here rather than needing an edge-safe indirection.
 * Both guards below exist because a disabled button or a client-side
 * useEffect redirect doesn't stop someone from typing/pasting a URL directly
 * into the address bar; this closes that gap at the routing layer, before
 * the page ever renders.
 */

/**
 * "Fully onboarded" = both Gmail and Calendar connected, AND the initial
 * mailbox sync isn't currently queued/running, AND the personalization profile
 * has been filled. Deliberately the SAME definition app/(protected)/layout.tsx
 * uses client-side (getAccountsExist + useSyncStatus's queued/running check +
 * usePriorityProfile's completedOnboarding) — matching it exactly is what
 * prevents a redirect loop: that layout independently sends a signed-in-but-
 * not-yet-onboarded user TO /onboarding, so this guard must agree on what "not
 * yet onboarded" means or the two would fight each other.
 *
 * The profile clause is what makes the form compulsory rather than advisory.
 * It has to be a routing-layer gate and not just a removed button, because the
 * profile is only useful BEFORE the first classification — emails can't be
 * re-classified — so "I'll do it later from Settings" is a door that quietly
 * costs the user personalized priorities for their whole mailbox.
 *
 * getAccountsExist (not getConnectedPlugins) on purpose — a plain DB read,
 * not a live corsair token round-trip, since this runs on every navigation
 * to a guarded route.
 */
async function isFullyOnboarded(userId: string): Promise<boolean> {
  const [accounts, sync, profile] = await Promise.all([
    getAccountsExist(userId),
    getSyncStatus(userId),
    getPriorityProfile(userId),
  ]);
  const bothConnected = accounts.gmail && accounts.calendar;
  const syncInProgress = sync?.status === "queued" || sync?.status === "running";
  return bothConnected && !syncInProgress && profile?.completedOnboarding === true;
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // ── Whole-app maintenance ────────────────────────────────────────────
  // Checked before anything else, including auth: during maintenance there is
  // nothing behind the gate worth authenticating for.
  //
  // Fails OPEN, matching the two guards below. Locking every user out of a
  // working app because one DB read failed would make this switch strictly
  // more dangerous than the outages it exists to manage.
  if (pathname !== "/maintenance") {
    try {
      const maintenance = await getGlobalMaintenance();
      if (maintenance) {
        const url = request.nextUrl.clone();
        url.pathname = "/maintenance";
        url.search = "";
        return NextResponse.rewrite(url);
      }
    } catch (err) {
      logger.error("[PROXY] maintenance check failed, allowing navigation", {
        pathname, error: String(err),
      });
    }
  }

  const wantsAssistant = pathname === "/assistant";
  const wantsAiSearch = pathname === "/inbox" && request.nextUrl.searchParams.get("mode") === "ai";
  const wantsSignIn = pathname === "/sign-in";
  const wantsOnboarding = pathname === "/onboarding" || pathname === "/onboarding/personalize";

  if (!wantsAssistant && !wantsAiSearch && !wantsSignIn && !wantsOnboarding) {
    return NextResponse.next();
  }

  const session = await auth.api.getSession({ headers: request.headers });
  const userId = session?.user?.id;
  if (!userId) {
    // Unauthenticated — sign-in and onboarding are exactly where an
    // unauthenticated visitor is supposed to land; leave /assistant and
    // /inbox?mode=ai to the existing client-side auth guard
    // (app/(protected)/layout.tsx) rather than duplicating that redirect here.
    return NextResponse.next();
  }

  // ── Dobbie / AI search: gated on the one-time AI-setup latch ─────────
  if (wantsAssistant || wantsAiSearch) {
    let ready: boolean;
    try {
      ready = (await getAiReadiness(userId)).ready;
    } catch (err) {
      // Fail OPEN: a transient DB hiccup here must never lock a user out of
      // their own inbox or assistant page. Worst case is the same "still
      // setting up" message /api/chat already returns once on the page.
      logger.error("[PROXY] aiReadiness check failed, allowing navigation", {
        userId, pathname, error: String(err),
      });
      return NextResponse.next();
    }

    if (ready) return NextResponse.next();

    if (wantsAssistant) {
      const url = request.nextUrl.clone();
      url.pathname = "/inbox";
      url.search = "";
      return NextResponse.redirect(url);
    }

    // wantsAiSearch: drop back to the default Gmail-search mode on /inbox
    // rather than bouncing away from the inbox entirely — everything else
    // on that page (browsing, sender search) is unaffected by the gate.
    const url = request.nextUrl.clone();
    url.searchParams.delete("mode");
    url.searchParams.delete("aiq");
    return NextResponse.redirect(url);
  }

  // ── Sign-in / onboarding: gated on "already fully onboarded" ─────────
  let onboarded: boolean;
  try {
    onboarded = await isFullyOnboarded(userId);
  } catch (err) {
    // Fail OPEN here too — never trap an authenticated user on sign-in or
    // onboarding because of a transient DB error.
    logger.error("[PROXY] onboarding check failed, allowing navigation", {
      userId, pathname, error: String(err),
    });
    return NextResponse.next();
  }

  if (wantsSignIn) {
    // Mirrors sign-in page's own client-side redirect (now enforced before
    // the page ever renders): fully onboarded → inbox, signed in but not
    // yet onboarded → onboarding.
    const url = request.nextUrl.clone();
    url.pathname = onboarded ? "/inbox" : "/onboarding";
    url.search = "";
    return NextResponse.redirect(url);
  }

  // wantsOnboarding: only bounce away once fully onboarded. A signed-in user
  // who isn't onboarded yet is exactly who this page is for — let it render.
  if (onboarded) {
    const url = request.nextUrl.clone();
    url.pathname = "/inbox";
    url.search = "";
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

/**
 * Widened from the original five exact routes so the maintenance gate can cover
 * the whole app. Everything else in `proxy()` still early-returns
 * NextResponse.next() for paths it doesn't recognise, so the extra matches cost
 * one cheap comparison and nothing else.
 *
 * Excluded: Next's own static/image pipelines and the favicon (never worth a DB
 * read), and /maintenance itself — matching it would rewrite the maintenance
 * page to itself forever.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|maintenance).*)"],
};
