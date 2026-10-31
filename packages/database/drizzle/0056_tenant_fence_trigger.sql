-- Account deletion: the tenant fence (plan Phase 1, decision D-012).
--
-- While a tenant is FENCED (tenant_epoch.state), INSERT and UPDATE on any
-- table holding that tenant's data is rejected. DELETE is always allowed:
-- removing data can never undo a deletion, and the purge is nothing but deletes.
--
-- Exceptions:
--   * UPDATE on the three CREDENTIAL_HELD tables ('allow_update') — the fence
--     steps stop watches and revoke the grant, and a token refresh during that
--     writes corsair_accounts through the Corsair SDK, which can't carry context.
--   * A transaction that sets `mailroid.deletion_capability` to the tenant id
--     (SET LOCAL, inside the deletion service only).
--
-- Cost for everyone else: one probe of the partial index below, which is empty
-- unless some tenant is fenced, before anything per-row is computed.
--
-- The table list must match FENCE_TRIGGER_TABLES in
-- packages/services/account-deletion/inventory.ts (inventory.test.ts checks).

CREATE INDEX IF NOT EXISTS "idx_tenant_epoch_fenced" ON "tenant_epoch" ("tenant_id") WHERE "state" = 'FENCED';
--> statement-breakpoint
ALTER TABLE "account_deletion_event" ADD CONSTRAINT "account_deletion_event_actor_check" CHECK (
  ("actor_type" = 'SYSTEM' AND "actor_user_id" IS NULL)
  OR ("actor_type" IN ('USER', 'DEVELOPER') AND "actor_email" IS NOT NULL)
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION assert_tenant_write() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  tenant text;
  parent_key text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  -- Fast path: nobody is fenced.
  IF NOT EXISTS (SELECT 1 FROM tenant_epoch WHERE state = 'FENCED') THEN
    RETURN NEW;
  END IF;

  -- TG_ARGV: [0] 'block_update' | 'allow_update', [1] 'column' | 'via',
  --          [2] column, [3] parent table, [4] parent key, [5] parent tenant column
  IF TG_ARGV[1] = 'column' THEN
    tenant := to_jsonb(NEW) ->> TG_ARGV[2];
  ELSE
    parent_key := to_jsonb(NEW) ->> TG_ARGV[2];
    EXECUTE format('SELECT %I::text FROM %I WHERE %I::text = $1', TG_ARGV[5], TG_ARGV[3], TG_ARGV[4])
      INTO tenant USING parent_key;
    IF tenant IS NULL THEN
      RAISE EXCEPTION 'TENANT_UNRESOLVED: % on % (parent %)', TG_OP, TG_TABLE_NAME, TG_ARGV[3]
        USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF tenant IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM tenant_epoch WHERE tenant_id = tenant AND state = 'FENCED') THEN
    RETURN NEW;
  END IF;

  IF current_setting('mailroid.deletion_capability', true) = tenant THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE' AND TG_ARGV[0] = 'allow_update' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'TENANT_FENCED: % on % rejected, tenant is fenced for deletion', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$fn$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "account";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "account"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "ai_setup_status";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "ai_setup_status"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "calendar_events";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "calendar_events"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "classification_jobs";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "classification_jobs"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "conversations";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "conversations"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "corsair_connection_emails";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "corsair_connection_emails"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "daily_briefs";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "daily_briefs"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "email_chunks";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "email_chunks"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "emails";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "emails"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "feedbacks";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "feedbacks"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "gmail_sync_failures";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "gmail_sync_failures"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'tenant_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "gmail_sync_status";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "gmail_sync_status"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "mail_template_categories";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "mail_template_categories"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "mail_templates";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "mail_templates"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "message_attachments";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "message_attachments"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "message_metadata";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "message_metadata"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "pending_approvals";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "pending_approvals"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "scheduling_contact_groups";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "scheduling_contact_groups"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "scheduling_contacts";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "scheduling_contacts"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "scheduling_outcomes";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "scheduling_outcomes"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "scheduling_rules";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "scheduling_rules"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "session";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "session"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "subscription";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "subscription"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'subject_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "thread_calendar_events";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "thread_calendar_events"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "thread_meeting_lookups";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "thread_meeting_lookups"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "user";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "user_priority_profile";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "user_priority_profile"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "user_settings";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "user_settings"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "user_usage";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "user_usage"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'column', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "calendar_tenant_mappings";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "calendar_tenant_mappings"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('allow_update', 'column', 'tenant_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "corsair_accounts";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "corsair_accounts"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('allow_update', 'column', 'tenant_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "gmail_tenant_mappings";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "gmail_tenant_mappings"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('allow_update', 'column', 'tenant_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "assistant_messages";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "assistant_messages"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'via', 'conversation_id', 'conversations', 'id', 'user_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "corsair_entities";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "corsair_entities"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'via', 'account_id', 'corsair_accounts', 'id', 'tenant_id');
--> statement-breakpoint
DROP TRIGGER IF EXISTS "trg_tenant_fence" ON "corsair_events";
--> statement-breakpoint
CREATE TRIGGER "trg_tenant_fence" BEFORE INSERT OR UPDATE ON "corsair_events"
  FOR EACH ROW EXECUTE FUNCTION assert_tenant_write('block_update', 'via', 'account_id', 'corsair_accounts', 'id', 'tenant_id');
