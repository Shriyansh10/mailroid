/**
 * Print the Google consent URL for a tenant, so an account can be (re)connected
 * without the web UI.
 *
 * WHY THIS EXISTS. Rotating GOOGLE_CLIENT_ID invalidates every stored refresh
 * token at once — Google answers `unauthorized_client`, because the token was
 * issued to a different client than the one now presenting it. Recovery is one
 * fresh consent per account per plugin, and the UI is not always a usable route
 * to that (the connect affordance only appears where the app thinks you are
 * disconnected, and a broken refresh is not the same state as never-connected).
 *
 * THE CLI ONLY PRODUCES THE URL. The callback is handled by the running API
 * server at /api/auth/{gmail,calendar}-callback, which is where tokens are
 * exchanged and stored. That split works because `state` is HMAC-signed and
 * round-trips through Google rather than living in a server-side session — so
 * a URL minted in this process is completed by a different one with no shared
 * state beyond the database.
 *
 * Consequently the API server must be running and reachable at BASE_URL (i.e.
 * the tunnel must be up) before you open the link, or Google will redirect to
 * a dead endpoint and the code will be spent for nothing.
 */

import { db, sql } from "@repo/database";
import {
  ensureTenant,
  getGmailOAuthUrl,
  getCalendarOAuthUrl,
  getConnectedPlugins,
} from "@repo/services/tenant/index.js";

import { defineCommand, UsageError } from "../types.ts";
import * as out from "../lib/output.ts";

type Plugin = "gmail" | "calendar";

const ALL: Plugin[] = ["gmail", "calendar"];

/**
 * email → tenant id, across BOTH mapping tables.
 *
 * Deliberately not `lib/resolve-user.ts`, which takes a single table: the
 * account being repaired may have Gmail connected but not Calendar, or the
 * reverse, and this command's whole job is to work when one side is broken.
 * Looking in one table only would refuse to help exactly when help is needed.
 */
async function resolveTenant(arg: string): Promise<string | null> {
  if (!arg.includes("@")) return arg;

  for (const table of ["gmail_tenant_mappings", "calendar_tenant_mappings"]) {
    const rows = await db.execute(
      sql`SELECT tenant_id FROM ${sql.raw(table)} WHERE email_address = ${arg} LIMIT 1`,
    );
    const row =
      (rows as unknown as { rows?: Array<{ tenant_id: string }> }).rows?.[0] ??
      (Array.isArray(rows) ? (rows[0] as { tenant_id?: string }) : undefined);
    if (row?.tenant_id) return row.tenant_id;
  }

  return null;
}

export default defineCommand({
  name: "auth:connect",
  description: "Print the Google consent URL to (re)connect an account",
  usage: "<userId|email> [gmail|calendar]",

  async run(args) {
    const arg = args[0];
    if (!arg) throw new UsageError("Missing <userId|email>.");

    const requested = args[1];
    if (requested && requested !== "gmail" && requested !== "calendar") {
      throw new UsageError(`Unknown plugin "${requested}". Expected gmail or calendar.`);
    }
    const plugins: Plugin[] = requested ? [requested as Plugin] : ALL;

    const tenantId = await resolveTenant(arg);
    if (!tenantId) throw new UsageError(`No user found for "${arg}".`);

    // Idempotent, and the same call the web flow makes before generating a URL
    // (authorizePlugins → ensureTenant). Matters when a tenant row exists but a
    // plugin's account row does not, which is the state a never-connected
    // plugin is in.
    await ensureTenant({ userId: tenantId });

    out.section("Account");
    out.keyValues([
      ["input", arg],
      ["tenant id", tenantId],
    ]);

    // NOT a health check, and must not be labelled as one.
    //
    // `keys.get_access_token()` DECRYPTS the stored access token; it does not
    // refresh (see the note in services/attachments/gmail-fetch.ts:38-40). So a
    // "present" here means only that a decryptable token exists — an unexpired
    // access token survives a client rotation perfectly well, right up until it
    // lapses and the refresh behind it fails with `unauthorized_client`.
    //
    // This was verified the hard way: the API logged `unauthorized_client` for
    // calendar while an earlier version of this command reported "ok" for the
    // same tenant minutes later. Reconnect based on what the server logs say,
    // not on this.
    out.section("Stored tokens");
    try {
      const connected = await getConnectedPlugins(tenantId);
      out.keyValues([
        ["gmail", connected.gmail ? "present" : "absent"],
        ["calendar", connected.googlecalendar ? "present" : "absent"],
      ]);
      out.line(
        out.dim("  Presence only — decrypts the stored token, does not prove refresh works."),
      );
    } catch (err) {
      out.warn(`Could not read tokens: ${err instanceof Error ? err.message : String(err)}`);
    }

    const base = process.env.BASE_URL ?? "http://localhost:8000";

    out.section("Open these in a browser");
    for (const plugin of plugins) {
      const { url } =
        plugin === "gmail"
          ? await getGmailOAuthUrl(tenantId)
          : await getCalendarOAuthUrl(tenantId);

      out.line();
      out.line(`  ${out.emphasis(plugin)}`);
      out.line(`  ${url}`);
    }

    out.line();
    out.warn(
      `The API server must be running and reachable at ${base} — the consent ` +
        `redirect lands on its callback route, and an unreachable endpoint burns ` +
        `the code without storing a token.`,
    );
    out.line(
      out.dim(
        "  Sign in as the account you are repairing. Consenting as a different " +
          "Google account rebinds this tenant to that mailbox.",
      ),
    );
  },
});
