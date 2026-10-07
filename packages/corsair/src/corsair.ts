import "dotenv/config";
import { pool } from "@repo/database";
import { createCorsair } from "corsair";
import { gmail } from "@corsair-dev/gmail";
import { googlecalendar } from "@corsair-dev/googlecalendar";

/**
 * The scopes Mailroid asks Google for, frozen here rather than inherited from
 * the plugins. They must match the OAuth consent screen exactly: a scope
 * requested at runtime but absent from the verified list shows every user the
 * "unverified app" warning. A Corsair upgrade changing its defaults therefore
 * must not change what we request — re-check both lists when upgrading.
 *
 * `gmail.compose` is dropped: every drafts.* and messages.send call also
 * accepts `gmail.modify`, and compose is a second restricted scope that would
 * need its own justification in verification for nothing.
 */
const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/gmail.send",
];

/**
 * Deliberately the same single scope `@corsair-dev/googlecalendar` requests
 * today, so pinning it is a no-op at runtime: identical consent URL, every
 * stored token still valid, nobody re-prompted. The point is that a plugin bump
 * can no longer change what we ask for without a visible diff here.
 *
 * Narrowing to `calendar.events` would be a real, user-visible change needing
 * re-consent and a verification update — not something to slip in with a pin.
 */
const CALENDAR_SCOPES = [
  "https://www.googleapis.com/auth/calendar",
];

const gmailPlugin = gmail();
if (!gmailPlugin.oauthConfig) {
  throw new Error("@corsair-dev/gmail no longer exposes oauthConfig — the scope override in corsair.ts needs updating");
}

const calendarPlugin = googlecalendar();
if (!calendarPlugin.oauthConfig) {
  throw new Error("@corsair-dev/googlecalendar no longer exposes oauthConfig — the scope override in corsair.ts needs updating");
}

export const corsair = createCorsair({
  plugins: [
    { ...gmailPlugin, oauthConfig: { ...gmailPlugin.oauthConfig, scopes: GMAIL_SCOPES } },
    { ...calendarPlugin, oauthConfig: { ...calendarPlugin.oauthConfig, scopes: CALENDAR_SCOPES } },
  ],
  database: pool,
  kek: process.env.CORSAIR_KEK!,
  multiTenancy: true,
});