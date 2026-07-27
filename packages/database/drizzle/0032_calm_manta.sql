CREATE TABLE "ai_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"user_id" text,
	"feature" text NOT NULL,
	"operation" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_tokens" integer,
	"cached_prompt_tokens" integer,
	"completion_tokens" integer,
	"total_tokens" integer,
	"input_price_per_mtok" numeric(20, 10),
	"cached_input_price_per_mtok" numeric(20, 10),
	"output_price_per_mtok" numeric(20, 10),
	"cost_usd" numeric(20, 10),
	"pricing_known" boolean NOT NULL,
	"pricing_version" text NOT NULL,
	"duration_ms" integer NOT NULL,
	"request_id" text NOT NULL,
	"provider_request_id" text,
	"status" text NOT NULL,
	"error_code" text,
	"metadata" jsonb
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_usage_created_at_idx" ON "ai_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_user_created_idx" ON "ai_usage" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_feature_created_idx" ON "ai_usage" USING btree ("feature","created_at");--> statement-breakpoint
CREATE INDEX "ai_usage_model_created_idx" ON "ai_usage" USING btree ("model","created_at");