-- Выплаты ЗП инженерам (payroll_payouts).
-- Расчёт ЗП остаётся on-the-fly; здесь хранится ФАКТ выплаты за период
-- (с возможностью ручной правки суммы) + ссылка на расход в кассе.
-- Суммы — копейки (bigint). Soft-delete через deleted_at.
--
-- RLS включается отдельно через 0050_enable_rls_payroll_payouts.sql (setup-rls.ts).

CREATE TABLE IF NOT EXISTS "payroll_payouts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "engineer_id" uuid NOT NULL,
  "period_start" date NOT NULL,
  "period_end" date NOT NULL,
  "period_label" varchar(40) NOT NULL,
  "computed_kopecks" bigint NOT NULL,
  "amount_kopecks" bigint NOT NULL,
  "paid_on" date NOT NULL,
  "account_id" uuid NOT NULL,
  "cash_transaction_id" uuid,
  "comment" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "payroll_payouts_amount_pos" CHECK (amount_kopecks > 0),
  CONSTRAINT "payroll_payouts_computed_non_negative" CHECK (computed_kopecks >= 0)
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_payouts_engineer_period_uniq"
  ON "payroll_payouts" USING btree ("tenant_id", "engineer_id", "period_start")
  WHERE deleted_at IS NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "payroll_payouts_tenant_period_idx"
  ON "payroll_payouts" USING btree ("tenant_id", "period_start") WHERE deleted_at IS NULL;
