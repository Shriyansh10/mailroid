CREATE TYPE "public"."thread_event_status" AS ENUM('ACTIVE', 'CANCELLED', 'DELETED_EXTERNALLY');--> statement-breakpoint
CREATE TABLE "thread_calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"event_id" text NOT NULL,
	"entity_id" text,
	"status" "thread_event_status" DEFAULT 'ACTIVE' NOT NULL,
	"closed_at" timestamp with time zone,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "thread_calendar_events" ADD CONSTRAINT "thread_calendar_events_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_tce_user_thread_status" ON "thread_calendar_events" USING btree ("user_id","thread_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_tce_user_calendar_event" ON "thread_calendar_events" USING btree ("user_id","calendar_id","event_id");