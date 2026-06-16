CREATE TABLE "emails" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"gmail_message_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"subject" text,
	"from" text,
	"to" text,
	"snippet" text,
	"body_text" text,
	"raw_payload" jsonb,
	"received_at" timestamp with time zone,
	"embedding" vector(1536),
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "emails_gmail_message_id_unique" UNIQUE("gmail_message_id")
);
