/**
 * What the sign-in page says for each `?error=` Better Auth redirects with
 * (`onAPIError.errorURL` in both auth instances).
 *
 * Only ACCOUNT_BEING_DELETED — FENCED_SIGN_IN_CODE in
 * @repo/database/tenant-fence — gets the deletion sentence. Every other code
 * gets a message for what actually went wrong. The text is always ours:
 * `error_description` is never shown, because anyone can put words in a URL.
 */

export const DELETION_SIGN_IN_MESSAGE =
  "This account is being deleted and can no longer be signed in to. Contact support if this is a mistake.";

const RETRY_STALE = "Your sign-in session expired or was started in another tab. Please try again.";
const OUR_SIDE = "Something went wrong on our side while signing you in. Please try again in a moment.";
const NOT_LINKED = "This Google account couldn't be linked to your Mailroid account. Contact support if this keeps happening.";

const MESSAGES: Record<string, string> = {
  ACCOUNT_BEING_DELETED: DELETION_SIGN_IN_MESSAGE,

  // Google: the user pressed Cancel on the consent screen.
  access_denied: "Google sign-in was cancelled. Nothing was changed — continue with Google when you're ready.",

  // The OAuth round trip didn't line up: stale tab, expired state, replayed link.
  state_mismatch: RETRY_STALE,
  state_not_found: RETRY_STALE,
  state_invalid: RETRY_STALE,
  state_security_mismatch: RETRY_STALE,
  please_restart_the_process: RETRY_STALE,
  invalid_callback_request: RETRY_STALE,
  no_code: RETRY_STALE,
  invalid_code: RETRY_STALE,
  no_callback_url: RETRY_STALE,

  email_not_found: "Google didn't share an email address for this account, so Mailroid can't sign you in with it.",

  account_not_linked: NOT_LINKED,
  account_already_linked_to_different_user: "This Google account is already connected to a different Mailroid account.",
  unable_to_link_account: NOT_LINKED,
  "email_doesn't_match": NOT_LINKED,

  signup_disabled: "New sign-ups are closed at the moment.",

  unable_to_create_user: OUR_SIDE,
  unable_to_create_session: OUR_SIDE,
  unable_to_get_user_info: OUR_SIDE,
  internal_server_error: OUR_SIDE,
  oauth_provider_not_found: OUR_SIDE,
  state_generation_error: OUR_SIDE,
};

/** The message for an `?error=` code. Unknown codes are named only if they look like a code. */
export function signInErrorMessage(code: string): string {
  const known = MESSAGES[code];
  if (known) return known;
  return /^[A-Za-z0-9_'-]{1,64}$/.test(code)
    ? `Sign-in didn't complete (${code}). Please try again.`
    : "Sign-in didn't complete. Please try again.";
}
