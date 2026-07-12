-- Тип выплаты ЗП: аванс / окончательный расчёт / премия.
--   advance — аванс (промежуточная выплата в счёт расчёта за период)
--   final   — окончательный расчёт (основная выплата ЗП; сюда попадают все прежние выплаты)
--   bonus   — премия (отдельное поощрение, НЕ входит в расчёт за период)
--
-- За период на сотрудника допускается не более одного 'advance' и одного 'final'
-- (защита от случайного дубля расчёта), премий — сколько угодно.
-- Прежние выплаты получают тип 'final' (default) — полная обратная совместимость.
-- RLS у payroll_payouts уже включён (0050) — отдельная RLS-миграция не нужна.

DO $$ BEGIN
  CREATE TYPE "payroll_payout_kind" AS ENUM ('advance', 'final', 'bonus');
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "payroll_payouts"
  ADD COLUMN IF NOT EXISTS "kind" "payroll_payout_kind" NOT NULL DEFAULT 'final';

-- Старый уникальный индекс (одна выплата на период) заменяем на уникальность ПО ТИПУ,
-- исключая премии (их может быть несколько за период).
DROP INDEX IF EXISTS "payroll_payouts_engineer_period_uniq";

CREATE UNIQUE INDEX IF NOT EXISTS "payroll_payouts_engineer_period_kind_uniq"
  ON "payroll_payouts" ("tenant_id", "engineer_id", "period_start", "kind")
  WHERE "deleted_at" IS NULL AND "kind" <> 'bonus';
