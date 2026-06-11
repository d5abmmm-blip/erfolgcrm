-- Этап 7-A: Web Push подписки.
--
-- Один пользователь — N подписок (телефон, рабочий браузер). При 410 Gone воркер ставит revoked_at.
-- RLS включается отдельно через 0013_enable_rls_stage7_push.sql (запускается setup-rls.ts).

CREATE TABLE "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "endpoint" varchar(1024) NOT NULL,
  "p256dh" varchar(200) NOT NULL,
  "auth" varchar(200) NOT NULL,
  "user_agent" varchar(500),
  "revoked_at" timestamp with time zone,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "push_subscriptions_endpoint_uniq" UNIQUE ("endpoint")
);--> statement-breakpoint

CREATE INDEX "push_subscriptions_tenant_user_idx"
  ON "push_subscriptions" USING btree ("tenant_id", "user_id")
  WHERE "revoked_at" IS NULL;--> statement-breakpoint

ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE;
