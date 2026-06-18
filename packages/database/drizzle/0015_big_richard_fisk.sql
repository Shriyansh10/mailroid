CREATE TABLE "daily_briefs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"briefing_date" date NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"structured_content" jsonb NOT NULL,
	"raw_response" text NOT NULL,
	"raw_prompt" text NOT NULL
);
