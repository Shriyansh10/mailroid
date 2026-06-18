CREATE TABLE "calendar_tenant_mappings" (
	"email_address" text PRIMARY KEY NOT NULL,
	"tenant_id" text NOT NULL,
	"channel_id" text,
	"resource_id" text,
	"watch_expiration" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "calendar_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"event_id" text NOT NULL,
	"title" text NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"description" text,
	"location" text,
	"organizer_email" text,
	"attendees" jsonb,
	"status" text,
	"html_link" text,
	"updated_at_google" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "calendar_events_event_id_unique" UNIQUE("event_id")
);
