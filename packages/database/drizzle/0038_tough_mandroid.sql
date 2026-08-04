CREATE TYPE "public"."thread_event_role" AS ENUM('ORGANIZER', 'GUEST');--> statement-breakpoint
CREATE TABLE "thread_meeting_lookups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "emails" ADD COLUMN "rfc822_message_id" text;--> statement-breakpoint
ALTER TABLE "message_metadata" ADD COLUMN "rfc822_message_id" text;--> statement-breakpoint
ALTER TABLE "calendar_events" ADD COLUMN "thread_message_id" text;--> statement-breakpoint
ALTER TABLE "thread_calendar_events" ADD COLUMN "role" "thread_event_role" DEFAULT 'ORGANIZER' NOT NULL;--> statement-breakpoint
ALTER TABLE "thread_meeting_lookups" ADD CONSTRAINT "thread_meeting_lookups_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tml_user_thread" ON "thread_meeting_lookups" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_emails_user_thread" ON "emails" USING btree ("user_id","thread_id");--> statement-breakpoint
CREATE INDEX "idx_mm_user_rfc822" ON "message_metadata" USING btree ("user_id","rfc822_message_id");--> statement-breakpoint
CREATE INDEX "idx_calendar_events_user_thread_msg" ON "calendar_events" USING btree ("user_id","thread_message_id");