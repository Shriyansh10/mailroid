CREATE TABLE "corsair_connection_emails" (
	"user_id" text PRIMARY KEY NOT NULL,
	"gmail_email" text,
	"calendar_email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
