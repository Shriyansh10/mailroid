CREATE TYPE "public"."mail_category" AS ENUM('PRIMARY', 'PROMOTIONS', 'SOCIAL', 'UPDATES', 'FORUMS', 'SENT', 'SPAM', 'TRASH', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."priority_level" AS ENUM('HIGH', 'MEDIUM', 'LOW');--> statement-breakpoint
CREATE TABLE "message_metadata" (
	"entity_id" text PRIMARY KEY NOT NULL,
	"gmail_labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"category" "mail_category" DEFAULT 'OTHER',
	"is_unread" boolean DEFAULT true NOT NULL,
	"is_in_inbox" boolean DEFAULT false NOT NULL,
	"is_starred" boolean DEFAULT false NOT NULL,
	"is_important" boolean DEFAULT false NOT NULL,
	"priority" "priority_level" DEFAULT 'MEDIUM',
	"priority_score" real,
	"priority_reason" text,
	"is_action_required" boolean DEFAULT false NOT NULL,
	"is_reply_needed" boolean DEFAULT false NOT NULL,
	"last_classified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_mm_category" ON "message_metadata" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_mm_priority" ON "message_metadata" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_mm_is_unread" ON "message_metadata" USING btree ("is_unread");--> statement-breakpoint
CREATE INDEX "idx_mm_inbox_triage" ON "message_metadata" USING btree ("is_unread","priority","is_in_inbox");
