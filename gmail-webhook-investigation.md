# Gmail Webhook Installation Investigation

Investigated: 2026-06-17
Corsair SDK: v0.1.76
Gmail Plugin: @corsair-dev/gmail v0.1.4

---

## Source Files Found

| File | Relevance |
|------|-----------|
| `node_modules/.pnpm/corsair@0.1.76/node_modules/corsair/dist/oauth.js` | `processOAuthCallback` — zero matches for watch/webhook/PubSub |
| `node_modules/.pnpm/corsair@0.1.76/node_modules/corsair/dist/setup.js` | `setupCorsair` — zero matches for watch/webhook/PubSub |
| `node_modules/.pnpm/@corsair-dev+gmail@0.1.4_.../dist/index.js` | Gmail plugin — NO `users.watch` or `users.stop` endpoint |
| `node_modules/.pnpm/@corsair-dev+gmail@0.1.4_.../dist/index.d.ts` | Gmail endpoints type — only `usersGetProfile`, no watch/stop |
| `node_modules/.pnpm/@corsair-dev+gmail@0.1.4_.../dist/webhooks/types.d.ts` | `PubSubMessage`, `PubSubNotification`, `decodePubSubMessage` |
| `node_modules/.pnpm/@corsair-dev+gmail@0.1.4_.../dist/webhooks/index.d.ts` | `messageChanged` webhook handler |
| `packages/services/tenant/index.ts` | Your `processOAuthCallbackForPlugin` wrapper |
| `apps/api/src/auth/gmail-oauth.ts` | Your Gmail OAuth callback route |
| `packages/services/gmail/sync-metadata.ts` | Your `syncAllEmails` + `syncMailbox` |

---

## Complete Gmail Endpoint Inventory

The Gmail plugin v0.1.4 exposes exactly **24 endpoints**. There is **no** `users.watch` or `users.stop`:

**Messages (8):** `list`, `get`, `send`, `delete`, `modify`, `batchModify`, `trash`, `untrash`

**Labels (5):** `list`, `get`, `create`, `update`, `delete`

**Drafts (6):** `list`, `get`, `create`, `update`, `delete`, `send`

**Threads (6):** `list`, `get`, `modify`, `delete`, `trash`, `untrash`

**Users (1):** `getProfile`

---

## Key Questions Answered

### 1. Does `processOAuthCallback()` install webhook watches?

**No.** I searched the Corsair SDK's `oauth.js` — zero references to `watch`, `webhook`, `topic`, or `pubsub`. It only exchanges the OAuth code for tokens and stores them encrypted in your database.

### 2. Does the Corsair SDK install watches automatically elsewhere?

**No.** `setup.js` (the CLI setup function) also has zero matches for those terms.

### 3. Is there a separate SDK API to call after OAuth?

**No.** The Corsair SDK does not expose any `watch`, `startWatch`, or `subscribe` functions. The Gmail plugin type definitions confirm there is no `users.watch` endpoint bound.

### 4. Does `pnpm corsair auth-plugin --plugin=gmail-webhook` exist?

**No — that CLI command does not exist in the Corsair SDK v0.1.76.** It produced exit code 254 when you ran it. The SDK's only CLI command is `setupCorsair()`.

### 5. What does the Gmail plugin's `topic_id` field mean?

```ts
readonly integration: readonly ["topic_id"];
```

This is an **integration-level** config field — one per Gmail plugin instance — not per-user. You can set a Google Cloud PubSub topic ARN when initializing the Gmail plugin:

```ts
gmail({
  credentials: {
    topic_id: "projects/my-project/topics/gmail-notifications",
    // ...
  },
})
```

This tells the plugin *which PubSub topic* push notifications will arrive on, so it can verify incoming webhooks. It does **not** call `users.watch` for you.

---

## How Gmail Push Notifications Actually Work

Gmail push notifications (real-time email alerts) require **two separate** steps:

### Step A: Google Cloud Console (one-time, manual)

1. Create a PubSub topic in Google Cloud
2. Grant the Gmail service account `pubsub.publisher` permission on that topic
3. Create a subscription (push or pull) pointing to your webhook endpoint
4. Configure OAuth consent screen

### Step B: Gmail API `users.watch` call (per user, after OAuth)

```http
POST https://gmail.googleapis.com/gmail/v1/users/me/watch
{
  "topicName": "projects/my-project/topics/gmail-notifications",
  "labelIds": ["INBOX"]
}
```

This subscribes the authenticated user to push notifications. It must be called **after** OAuth for each user.

### What the Corsair SDK Provides

The Gmail plugin already has **webhook receiving** wired up — the `messageChanged` webhook handler can parse incoming PubSub push notifications. But it does **not** make the `users.watch` call to register the subscription.

---

## The Webhook Data Flow

```
Gmail (user's inbox changes)
    ↓ sends PubSub message to topic
Google Cloud PubSub
    ↓ pushes to subscription endpoint
Your server (webhook endpoint)
    ↓
Corsair managementHandler
    ↓ routes to plugin
Gmail plugin messageChanged handler
    ↓ decodes PubSub message
decodePubSubMessage(data)  ← provided by plugin
    ↓
Your webhookHooks (optional custom logic)
    ↓
Corsair auto-syncs to database tables
```

---

## Final Conclusions

| Question | Answer |
|----------|--------|
| Is `processOAuthCallback` automatic? | **Yes** — it exchanges OAuth code, stores tokens. That's all. |
| Is webhook installation automatic? | **No** — it's never triggered. |
| Is there an SDK method to call? | **No** — `users.watch` isn't exposed as an endpoint. |
| Does the CLI command exist? | **No** — `corsair auth-plugin` doesn't exist in this SDK version. |
| Is the Gmail plugin webhook handler ready? | **Yes** — `messageChanged` is fully defined. |
| Can you call `users.watch` directly? | **Yes** — via the raw Gmail API (fetch to Google). |

---

## Recommended Implementation for Mailroid

Since the Corsair SDK doesn't expose `users.watch`, you have two options:

### Option A: Call the raw Gmail REST API directly (recommended)

Add to `apps/api/src/auth/gmail-oauth.ts` after OAuth succeeds:

```ts
import { corsair } from "@repo/corsair";

async function startGmailWatch(tenantId: string) {
  const tenant = corsair.withTenant(tenantId);
  const tokens = await tenant.auth.tokens.get("gmail"); // get stored OAuth tokens

  const response = await fetch(
    "https://gmail.googleapis.com/gmail/v1/users/me/watch",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        topicName: "projects/your-project/topics/gmail-notifications",
        labelIds: ["INBOX"],
      }),
    },
  );

  if (!response.ok) {
    const error = await response.text();
    console.error("[gmail-oauth] watch failed:", error);
  } else {
    const data = await response.json();
    console.log("[gmail-oauth] watch started:", data);
  }
}
```

Then call it:
```ts
await storeGmailConnectedEmail(result.tenantId);
await startGmailWatch(result.tenantId); // Add this
syncMailbox(result.tenantId).catch(...);
```

### Option B: Use a periodic polling approach instead

Given that Gmail watches expire every 7 days and require PubSub infrastructure, many apps use periodic polling instead. You already have `syncMailbox()` — you could run it on a cron schedule via Inngest (which you already have):

```ts
// packages/inngest/src/functions/sync-emails.ts
export const syncAllMailboxes = inngest.createFunction(
  { id: "sync-all-mailboxes", cron: "*/15 * * * *" }, // every 15 min
  { event: "cron.sync-mailboxes" },
  async ({ step }) => {
    // iterate all tenants, call syncMailbox(tenantId)
  },
);
```
