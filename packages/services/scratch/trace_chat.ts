import { db, desc, eq, asc } from "../../database/index.ts";
import { conversations, assistantMessages } from "../../database/schema.ts";

async function main() {
  console.log("🔍 Finding the most recent conversation...");

  const recentConvs = await db
    .select()
    .from(conversations)
    .orderBy(desc(conversations.updatedAt))
    .limit(5);

  if (recentConvs.length === 0) {
    console.log("No conversations found in the database.");
    process.exit(0);
  }

  for (const conv of recentConvs) {
    console.log(`\n==================================================`);
    console.log(`Conversation ID: ${conv.id}`);
    console.log(`Title: ${conv.title}`);
    console.log(`Updated At: ${conv.updatedAt}`);
    console.log(`Deleted At: ${conv.deletedAt}`);
    console.log(`--------------------------------------------------`);

    const messages = await db
      .select()
      .from(assistantMessages)
      .where(eq(assistantMessages.conversationId, conv.id))
      .orderBy(asc(assistantMessages.createdAt));

    console.log(`Messages count: ${messages.length}`);
    for (const msg of messages) {
      console.log({
        id: msg.id,
        role: msg.role,
        content: msg.content ? msg.content.substring(0, 60) + (msg.content.length > 60 ? "..." : "") : null,
        toolCalls: msg.toolCalls,
        toolCallId: msg.toolCallId,
        createdAt: msg.createdAt,
      });
    }
  }

  process.exit(0);
}

main().catch(console.error);
