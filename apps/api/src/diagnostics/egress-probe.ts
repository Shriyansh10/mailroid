import dns from "node:dns";

import { describeError } from "./describe-error.js";

/**
 * Outbound-connectivity probe for the two Google hosts the Gmail webhook path
 * depends on.
 *
 * Why this exists: the production failure surfaces as
 * `[corsair:gmail] Failed to obtain valid access token: fetch failed` and
 * `ConnectTimeoutError ... gmail.googleapis.com:443`. Both are transport
 * failures. Critically, Corsair's token refresh targets *oauth2.googleapis.com*
 * (@corsair-dev/gmail's `Be()` posts to https://oauth2.googleapis.com/token),
 * which is a different host from the gmail.googleapis.com / www.google.com that
 * manual checks covered. This probe hits both, repeatedly, and records the real
 * errno plus the addresses DNS hands back — so an unroutable AAAA or a
 * load-dependent connect timeout becomes visible instead of "fetch failed".
 *
 * Neither function throws. This is diagnostics; it must never affect serving.
 */

/** Corsair's Gmail token-refresh endpoint. Unauthenticated POST => fast 400. */
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
/** The Gmail API host. Unauthenticated GET => fast 401. */
const GMAIL_PROFILE_URL = "https://gmail.googleapis.com/gmail/v1/users/me/profile";

/** Matches undici's default connect timeout, so we observe the same deadline. */
const PROBE_TIMEOUT_MS = 10_000;

type DnsReport = {
  host: string;
  /** Order Node's own resolver returns — i.e. what undici will actually dial. */
  lookup?: Array<{ address: string; family: number }>;
  v4?: string[];
  v6?: string[];
  error?: ReturnType<typeof describeError>;
};

type AttemptReport = {
  attempt: number;
  ok: boolean;
  /** HTTP status, when a response was received at all. */
  status?: number;
  durationMs: number;
  /** Populated only on transport failure — this is the payload we're after. */
  error?: ReturnType<typeof describeError>;
};

type HostReport = {
  url: string;
  expectedStatus: number;
  dns: DnsReport;
  attempts: AttemptReport[];
};

export type EgressReport = {
  startedAt: string;
  nodeVersion: string;
  /** Non-default values here are themselves a finding. */
  runtime: {
    uvThreadpoolSize: string;
    dnsResultOrder: string | undefined;
  };
  hosts: HostReport[];
};

async function reportDns(host: string): Promise<DnsReport> {
  const report: DnsReport = { host };

  // dns.lookup mirrors what undici uses, including family ordering — this is
  // the one that tells us whether an IPv6 address gets dialed first.
  try {
    const results = await dns.promises.lookup(host, { all: true, verbatim: true });
    report.lookup = results.map((r) => ({ address: r.address, family: r.family }));
  } catch (err) {
    report.error = describeError(err);
  }

  // resolve4/resolve6 go through c-ares (not the libuv threadpool) and show what
  // is actually published, independent of lookup ordering.
  try {
    report.v4 = await dns.promises.resolve4(host);
  } catch {
    // A host with no A record, or a resolver hiccup — absence is itself signal.
  }
  try {
    report.v6 = await dns.promises.resolve6(host);
  } catch {
    // No AAAA published (or resolver refused) — also signal.
  }

  return report;
}

async function probeOnce(
  url: string,
  init: RequestInit,
  attempt: number,
): Promise<AttemptReport> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);

  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    // Drain the body so the socket is released back to the pool.
    await response.text().catch(() => undefined);
    return {
      attempt,
      ok: true,
      status: response.status,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      attempt,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: describeError(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

async function probeHost(
  url: string,
  init: RequestInit,
  expectedStatus: number,
  attempts: number,
): Promise<HostReport> {
  const { hostname } = new URL(url);
  const dnsReport = await reportDns(hostname);

  const results: AttemptReport[] = [];
  for (let i = 1; i <= attempts; i++) {
    // Sequential on purpose: concurrent probes would mask the threadpool
    // contention we're trying to detect.
    results.push(await probeOnce(url, init, i));
  }

  return { url, expectedStatus, dns: dnsReport, attempts: results };
}

/**
 * Probes both hosts `attempts` times each. Never throws.
 *
 * Expected healthy result: 400 from the token endpoint (invalid_request — we
 * send no credentials) and 401 from the Gmail profile endpoint. Any transport
 * error, or a duration near PROBE_TIMEOUT_MS, is the failure we're hunting.
 */
export async function probeEgress(attempts = 5): Promise<EgressReport> {
  const report: EgressReport = {
    startedAt: new Date().toISOString(),
    nodeVersion: process.version,
    runtime: {
      // Defaults to 4. Corsair's scrypt KEK->DEK derivation and dns.lookup share
      // this pool, so a small value under webhook bursts can starve DNS.
      uvThreadpoolSize: process.env.UV_THREADPOOL_SIZE ?? "4 (default)",
      dnsResultOrder: dns.getDefaultResultOrder?.(),
    },
    hosts: [],
  };

  try {
    report.hosts.push(
      await probeHost(
        OAUTH_TOKEN_URL,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          // Deliberately empty: we want a 400, not a token. No secrets sent.
          body: new URLSearchParams({ grant_type: "refresh_token" }).toString(),
        },
        400,
        attempts,
      ),
    );
  } catch (err) {
    console.error("[egress-probe] token-endpoint probe crashed:", describeError(err));
  }

  try {
    report.hosts.push(await probeHost(GMAIL_PROFILE_URL, { method: "GET" }, 401, attempts));
  } catch (err) {
    console.error("[egress-probe] gmail-api probe crashed:", describeError(err));
  }

  return report;
}

/**
 * Runs the probe and logs it. Safe to call at startup — swallows everything.
 * Uses console.* rather than the winston logger on purpose: the logger's level
 * defaults to "error" in production, which would hide these lines.
 */
export async function logEgressProbe(attempts = 5): Promise<void> {
  try {
    const report = await probeEgress(attempts);
    const failures = report.hosts.flatMap((h) => h.attempts.filter((a) => !a.ok));

    console.log("[egress-probe] report:", JSON.stringify(report, null, 2));

    if (failures.length > 0) {
      console.error(
        `[egress-probe] ${failures.length} transport failure(s) detected — see codes above`,
      );
    }
  } catch (err) {
    console.error("[egress-probe] probe failed to run:", describeError(err));
  }
}
