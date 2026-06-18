import { corsair } from "@repo/corsair";
import { processWebhook } from "corsair";

async function main() {
  console.log("=== Testing Calendar Webhook Processing ===");

  const headers = {
    "x-goog-channel-id": "d39f97bb-1024-489b-ba1b-7678fb5d6db9",
    "x-goog-resource-id": "GN0KwKCzTgL6mGqaYw1xmS0b5xQ",
    "x-goog-resource-state": "exists",
    "x-goog-channel-expiration": "Thu, 24 Jun 2026 21:56:31 GMT",
    "content-type": "application/json"
  };

  const body = {}; // empty body for google calendar push notifications

  try {
    const result = await processWebhook(
      corsair,
      headers,
      body,
      { tenantId: "I18zlIaeuH86k4fZhzGM0B0BPgMaGGMw" }
    );

    console.log("Corsair processWebhook full result:");
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error("processWebhook threw an error:", err);
  }

  process.exit(0);
}

main().catch(console.error);
