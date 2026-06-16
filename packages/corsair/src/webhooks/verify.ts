import crypto from "node:crypto";

// ── Configuration ────────────────────────────────────────────────────

const MAX_TIMESTAMP_AGE_MS = 5 * 60 * 1000; // 5 minutes

const KNOWN_SOURCES = ["gmail", "googlecalendar", "corsair", "corsair-mcp"];

// ── Signature verification ───────────────────────────────────────────

/**
 * Verify a Corsair webhook signature using HMAC-SHA256.
 *
 * Corsair should send a `x-corsair-signature` header containing an
 * HMAC-SHA256 hex digest of the raw request body. The shared secret
 * is configured as CORSAIR_WEBHOOK_SECRET in the environment.
 *
 * Uses timing-safe comparison to prevent timing attacks.
 *
 * @param rawBody - The raw string body of the webhook request
 * @param signatureHeader - The value of the x-corsair-signature header
 * @param secret - The shared webhook secret (from env)
 * @returns true if the signature is valid
 */
export function verifyWebhookSignature(
  rawBody: string,
  signatureHeader: string,
  secret: string,
): boolean {
  if (!rawBody || !signatureHeader || !secret) {
    return false;
  }

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(rawBody, "utf-8");
  const expected = hmac.digest("hex");

  try {
    const sigBuffer = Buffer.from(signatureHeader, "hex");
    const expectedBuffer = Buffer.from(expected, "hex");

    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }

    return crypto.timingSafeEqual(sigBuffer, expectedBuffer);
  } catch {
    // Invalid hex in the signature header
    return false;
  }
}

// ── Payload validation ───────────────────────────────────────────────

/**
 * Validate webhook payload metadata.
 *
 * Checks:
 *   - Timestamp is within 5 minutes of now (prevents replay attacks)
 *   - Source is a known Corsair integration
 *
 * @param payload - Parsed webhook payload with optional timestamp/source
 * @returns Object with valid flag and optional reason
 */
export function validateWebhookPayload(
  payload: { timestamp?: string; source?: string },
): { valid: boolean; reason?: string } {
  // ── Timestamp check ──────────────────────────────────────────────
  if (payload.timestamp) {
    const payloadTime = new Date(payload.timestamp).getTime();
    if (isNaN(payloadTime)) {
      return { valid: false, reason: "Invalid timestamp format" };
    }

    const now = Date.now();
    const drift = Math.abs(now - payloadTime);
    if (drift > MAX_TIMESTAMP_AGE_MS) {
      return {
        valid: false,
        reason: `Timestamp too old (${Math.round(drift / 1000)}s ago, max ${MAX_TIMESTAMP_AGE_MS / 1000}s)`,
      };
    }
  }

  // ── Source check ─────────────────────────────────────────────────
  if (payload.source && !KNOWN_SOURCES.includes(payload.source)) {
    return { valid: false, reason: `Unknown webhook source: "${payload.source}"` };
  }

  return { valid: true };
}
