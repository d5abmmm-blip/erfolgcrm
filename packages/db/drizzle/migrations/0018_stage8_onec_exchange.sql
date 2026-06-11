-- Этап 8.F — Обмен с 1С. Журнал двусторонней синхронизации.
--
-- direction: 'export' (счета и акты → 1С) или 'import' (квитанции об оплате ← 1С).
-- kind: 'invoices_export' / 'payments_import' / 'manual' — для расширения в будущем.
-- status: 'pending' (ставится при создании) → 'success' / 'failed' / 'partial' (некоторые элементы упали).
-- payload — что отправили (для export) или что получили (для import). jsonb для удобной выборки.
-- result — что вернулось/что обработали: { processedIds: string[], errors: [{ id, message }] }.
-- onec_token_hash — для аутентификации входящего REST-запроса (приём оплат). hex SHA-256.

CREATE TYPE "public"."onec_exchange_direction" AS ENUM ('export', 'import');--> statement-breakpoint
CREATE TYPE "public"."onec_exchange_status" AS ENUM ('pending', 'success', 'failed', 'partial');--> statement-breakpoint

CREATE TABLE "onec_exchange_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "direction" "onec_exchange_direction" NOT NULL,
  "kind" varchar(50) NOT NULL,
  "status" "onec_exchange_status" NOT NULL DEFAULT 'pending',
  "payload" jsonb,
  "result" jsonb,
  "error_message" text,
  "processed_count" integer NOT NULL DEFAULT 0,
  "error_count" integer NOT NULL DEFAULT 0,
  "started_at" timestamp with time zone NOT NULL DEFAULT now(),
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX "onec_exchange_log_tenant_started_idx"
  ON "onec_exchange_log" USING btree ("tenant_id", "started_at" DESC);--> statement-breakpoint

CREATE INDEX "onec_exchange_log_tenant_status_idx"
  ON "onec_exchange_log" USING btree ("tenant_id", "status")
  WHERE "status" IN ('failed', 'partial');--> statement-breakpoint

-- Per-tenant config для 1С: токен входящего webhook'а (приём платежей) + опции экспорта.
CREATE TABLE "onec_configs" (
  "tenant_id" uuid PRIMARY KEY NOT NULL,
  "enabled" boolean NOT NULL DEFAULT false,
  -- SHA-256 hex от bearer-токена. Сам токен показывается один раз при генерации.
  "incoming_token_hash" varchar(64),
  -- Часовой пояс для cut-off дат «новые счета с момента N». default = tenant.timezone.
  "export_timezone" varchar(50),
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);
