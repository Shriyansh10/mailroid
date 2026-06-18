CREATE TABLE "feedbacks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"feedback_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"score" real NOT NULL,
	"category" text NOT NULL,
	"approved" boolean NOT NULL,
	"requires_review" boolean DEFAULT false NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_usage" (
	"user_id" text NOT NULL,
	"date" text NOT NULL,
	"action_count" integer DEFAULT 0 NOT NULL,
	"unlocked" boolean DEFAULT false NOT NULL,
	"feedback_unlocks" integer DEFAULT 0 NOT NULL,
	"feedback_rejected" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_usage_user_id_date_pk" PRIMARY KEY("user_id","date")
);
--> statement-breakpoint
ALTER TABLE "feedbacks" ADD CONSTRAINT "feedbacks_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_usage" ADD CONSTRAINT "user_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_feedbacks_user_id" ON "feedbacks" USING btree ("user_id");