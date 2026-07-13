-- Ручная ведомость выплат по сотрудникам (payroll_sheets).
-- Перенос из старой CRM: директор вручную вбивает оклад/аванс/премию по месяцам.
-- Это ОТДЕЛЬНЫЙ учётный журнал — кассу (ДДС) НЕ трогает (в отличие от payroll_payouts).
-- entries — jsonb-массив строк {employeeId, employeeName, salaryKopecks, advanceKopecks, bonusKopecks};
-- суммы — целые копейки (number в jsonb). Soft-delete через deleted_at.
--
-- RLS включается отдельно через 0073_enable_rls_payroll_sheets.sql (setup-rls.ts).

CREATE TABLE IF NOT EXISTS "payroll_sheets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "month" varchar(7) NOT NULL,
  "entries" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "payroll_sheets_month_format" CHECK (month ~ '^[0-9]{4}-[0-9]{2}$')
);--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_sheets_tenant_month_uniq"
  ON "payroll_sheets" USING btree ("tenant_id", "month")
  WHERE deleted_at IS NULL;
