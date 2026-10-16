/**
 * Where a response target comes from.
 *
 * Today: every organization gets the Mailroid defaults. When per-organization
 * targets land, they are read here and nothing else in the codebase changes —
 * which is why this takes an `organizationId` it does not yet use. Callers are
 * already shaped for the table that will replace the constant.
 *
 * Validation happens on the way out rather than at the call sites, so that a
 * malformed policy can never reach the SQL layer no matter who added the caller.
 */

import { MAILROID_DEFAULT_SLA_POLICY, assertValidPolicy, type SlaPolicy } from "./sla-policy.ts";

export async function getSlaPolicy(_organizationId: string): Promise<SlaPolicy> {
  const policy = MAILROID_DEFAULT_SLA_POLICY;
  assertValidPolicy(policy);
  return policy;
}
