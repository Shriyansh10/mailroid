import { getMyDeletionRequest, userFacingStatus } from "@repo/services/account-deletion/index";
import type { ToolExecutionContext } from "@repo/ai";

/**
 * Dobbie's view of account deletion: the caller's own request, read-only.
 *
 * Scoped by `ctx.userId` and nothing the model supplies — the tool takes no
 * input at all, so there is no way to ask about someone else's account. It
 * returns the same user-facing sentence the settings page shows, never
 * internal state (fence steps, org context, errors).
 */
export async function accountDeletionStatus(ctx: ToolExecutionContext) {
  const settingsPath = "/settings/account";
  const r = await getMyDeletionRequest(ctx.userId);
  if (!r) {
    return {
      hasRequest: false,
      message:
        "No deletion request. To ask for your account to be deleted, go to Settings → Account. The Mailroid team reviews each request and, if you belong to an organization, confirms with them first.",
      settingsPath,
    };
  }
  return { hasRequest: true, status: r.status, message: userFacingStatus(r.status), settingsPath };
}
