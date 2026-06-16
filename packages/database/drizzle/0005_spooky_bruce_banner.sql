CREATE TABLE "pending_approvals" (
	"id" text PRIMARY KEY NOT NULL,
	"tool_name" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"args" jsonb NOT NULL,
	"user_id" text NOT NULL,
	"request_id" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"preview" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"approved_at" timestamp,
	"cancelled_at" timestamp,
	"executed_at" timestamp,
	"expires_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "pending_approvals" ADD CONSTRAINT "pending_approvals_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;