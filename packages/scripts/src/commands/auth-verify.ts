/**
 * Prove that an OAuth credential rotation actually landed everywhere.
 *
 * WHY A COMMAND AND NOT A GLANCE. "The app works" is not evidence. An access
 * token stays valid for about an hour after it is issued, and
 * `keys.get_access_token()` decrypts the stored one rather than refreshing it —
 * so a mailbox can look perfectly healthy while the refresh token behind it
 * belongs to a client that no longer exists. The failure appears an hour later,
 * as `unauthorized_client`, usually while you are doing something unrelated.
 *
 * There are three places a client id lives, and a rotation is only complete
 * when all three agree:
 *
 *   1. the root .env                  — what `corsair:setup` will write NEXT time
 *   2. corsair_integrations.config    — what Corsair actually authenticates with
 *   3. every corsair_accounts row     — which client each stored token belongs to
 *
 * (1) and (2) drift apart whenever .env is edited without re-running
 * `corsair:setup`. (2) and (3) drift apart the moment credentials are rotated,
 * and stay that way until each account re-consents — which is the state this
 * command exists to make visible.
 *
 * (2) is read indirectly, by generating a real consent URL and reading the
 * client_id back out of it: the stored value is encrypted at rest, so the URL
 * Corsair builds is the only honest view of what it will present to Google.
 *
 * (3) is inferred from timestamps rather than by decrypting tokens: a token row
 * written AFTER the integration row was last updated must have been issued by
 * the current client, because the consent that produced it ran against it.
 *
 * Read-only, and spends no Gmail quota unless --probe is passed.
 */

import { db, sql } from "@repo/database";
import { getGmailOAuthUrl } from "@repo/services/tenant/index.js";
import { corsair } from "@repo/corsair";

import { defineCommand } from "../types.ts";
import * as out from "../lib/output.ts";

interface AccountRow {
  tenant_id: string;
  email_address: string | null;
  integration: string;
  token_written: Date;
}

/** "835342000528-abc.apps.googleusercontent.com" → "835342000528". */
function clientPrefix(id: string | null | undefined): string {
  return (id ?? "").split("-")[0] ?? "";
}

export default defineCommand({
  name: "auth:verify",
  description: "Check that a credential rotation landed in env, Corsair and every token",
  usage: "[--probe] [--force]",

  async run(args) {
    const probe = args.includes("--probe");

    // ── 1. env vs what Corsair will actually send ────────────────────
    const envClientId = process.env.GOOGLE_CLIENT_ID ?? "";
    const envPrefix = clientPrefix(envClientId);

    const [anyTenant] = (
      await db.execute(sql`SELECT tenant_id FROM gmail_tenant_mappings LIMIT 1`)
    ).rows as Array<{ tenant_id: string }>;

    let livePrefix = "";
    if (anyTenant?.tenant_id) {
      const { url } = await getGmailOAuthUrl(anyTenant.tenant_id);
      livePrefix = clientPrefix(new URL(url).searchParams.get("client_id"));
    }

    out.section("Client id");
    out.keyValues([
      ["root .env", envPrefix || "(unset)"],
      ["Corsair sends", livePrefix || "(could not determine)"],
    ]);

    const clientsAgree = Boolean(envPrefix) && envPrefix === livePrefix;
    if (clientsAgree) {
      out.success("env and Corsair agree — corsair:setup is up to date.");
    } else {
      out.error(
        "MISMATCH. Corsair is authenticating with a different client than .env " +
          "names. Run: cd packages/corsair && pnpm corsair:setup",
      );
    }

    // ── 2. Pub/Sub topic ─────────────────────────────────────────────
    const topic = process.env.GMAIL_PUBSUB_TOPIC ?? "";
    const topicProject = topic.match(/^projects\/([^/]+)\/topics\//)?.[1] ?? null;
    out.section("Pub/Sub");
    out.keyValues([
      ["topic", topic || "(unset)"],
      ["project", topicProject ?? "(unparseable)"],
    ]);
    out.line(
      out.dim(
        "  A client id does not encode its project, so this is the only place the " +
          "project name is visible. Confirm it is the project the OAuth client lives in.",
      ),
    );

    // ── 3. Per-token freshness ───────────────────────────────────────
    const rotatedAt = (
      (
        await db.execute(
          sql`SELECT MAX(updated_at) AS at FROM corsair_integrations`,
        )
      ).rows as Array<{ at: Date | null }>
    )[0]?.at;

    const accounts = (
      await db.execute(sql`
        SELECT ca.tenant_id,
               gtm.email_address,
               ci.name AS integration,
               ca.updated_at AS token_written
        FROM corsair_accounts ca
        JOIN corsair_integrations ci ON ci.id = ca.integration_id
        LEFT JOIN gmail_tenant_mappings gtm ON gtm.tenant_id = ca.tenant_id
        ORDER BY gtm.email_address NULLS LAST, ci.name
      `)
    ).rows as unknown as AccountRow[];

    out.section("Stored tokens vs rotation");
    out.keyValues([["credentials rotated at", rotatedAt ?? "(never)"]]);
    out.line();

    let stale = 0;
    for (const row of accounts) {
      const written = new Date(row.token_written);
      const fresh = rotatedAt ? written.getTime() >= new Date(rotatedAt).getTime() : true;
      if (!fresh) stale++;
      const label = `${(row.email_address ?? row.tenant_id).padEnd(34)} ${row.integration.padEnd(15)}`;
      out.line(
        `  ${label} ${written.toISOString()}  ${fresh ? out.dim("post-rotation") : "STALE — needs re-consent"}`,
      );
    }

    out.line();
    if (stale === 0 && clientsAgree) {
      out.success(
        `All ${accounts.length} tokens were issued after the rotation. Credentials are consistent.`,
      );
    } else if (stale > 0) {
      out.error(
        `${stale} token(s) predate the rotation and will fail on their next refresh. ` +
          `Re-consent with: pnpm admin auth:connect <email>`,
      );
    }

    // ── 4. Optional live proof ───────────────────────────────────────
    //
    // Opt-in, because it is the only part that touches Gmail. One quota unit per
    // account — but on a mailbox under an active penalty every call also pushes
    // Google's retry instant further out, so this must never be the default.
    if (!probe) {
      out.line();
      out.line(out.dim("  Pass --probe to additionally call Gmail once per account (1 unit each)."));
      return;
    }

    // A mailbox under an active quota cooldown is SKIPPED, not probed.
    //
    // Gmail's 429 carries an absolute retry instant, and every request made
    // before it arrives pushes that instant further out — so a diagnostic that
    // probed a cooling-down mailbox would extend the outage it is reporting on.
    // Reading the stored cooldown here mirrors what assertNotCoolingDown does on
    // the real call path; --force exists for when you deliberately want to know
    // whether Google has relented, and accepts that cost.
    const force = args.includes("--force");
    const cooldowns = new Map(
      (
        (
          await db.execute(sql`
            SELECT tenant_id, quota_cooldown_until
            FROM gmail_tenant_mappings
            WHERE quota_cooldown_until IS NOT NULL
          `)
        ).rows as Array<{ tenant_id: string; quota_cooldown_until: Date }>
      ).map((r) => [r.tenant_id, new Date(r.quota_cooldown_until)] as const),
    );

    out.section("Live probe (users.getProfile)");
    for (const row of accounts.filter((r) => r.integration === "gmail")) {
      const who = row.email_address ?? row.tenant_id;

      const until = cooldowns.get(row.tenant_id);
      if (until && until.getTime() > Date.now() && !force) {
        const mins = Math.ceil((until.getTime() - Date.now()) / 60000);
        out.line(
          `  ${who.padEnd(34)} ${out.dim(`skipped — cooling down ${mins}m (probing would extend it; --force to override)`)}`,
        );
        continue;
      }

      try {
        const token = await corsair.withTenant(row.tenant_id).gmail.keys.get_access_token();
        if (!token) {
          out.line(`  ${who.padEnd(34)} ${out.dim("no token")}`);
          continue;
        }
        const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
          headers: { Authorization: `Bearer ${token}` },
        });
        const body = res.ok ? "" : (await res.text()).replace(/\s+/g, " ").slice(0, 120);
        out.line(`  ${who.padEnd(34)} HTTP ${res.status} ${body}`);
      } catch (err) {
        out.line(
          `  ${who.padEnd(34)} ${out.dim(err instanceof Error ? err.message.slice(0, 120) : String(err))}`,
        );
      }
    }
  },
});
