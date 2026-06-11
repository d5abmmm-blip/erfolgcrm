-- Этап 9.C — ЗП инженеров.
--
-- engineer_payout_rules: ОДНА запись per tenant (singleton, PK = tenant_id).
-- Содержит правила расчёта ЗП. Сам расчёт ЗП за период считается on-the-fly
-- из work_orders + work_order_lines + users.hourly_cost_rate (см. payroll/repository.ts),
-- историю расчётов не храним (можем добавить engineer_payouts позже если понадобится freeze).
--
-- mode:
--   piecework      — сделка: % от стоимости работ закрытых WO в периоде.
--   salary_bonus   — оклад + бонус: фиксированная база + % от работ.
--
-- Все суммы — bigint в копейках. Проценты — integer 0..100.

CREATE TYPE "payroll_mode" AS ENUM ('piecework', 'salary_bonus');--> statement-breakpoint

CREATE TABLE "engineer_payout_rules" (
  "tenant_id"             uuid PRIMARY KEY,
  "mode"                  payroll_mode NOT NULL DEFAULT 'piecework',
  "piecework_percent"     integer NOT NULL DEFAULT 30,
  "base_salary_kopecks"   bigint NOT NULL DEFAULT 0,
  "bonus_percent"         integer NOT NULL DEFAULT 0,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "engineer_payout_rules_piecework_percent_range" CHECK (piecework_percent BETWEEN 0 AND 100),
  CONSTRAINT "engineer_payout_rules_bonus_percent_range" CHECK (bonus_percent BETWEEN 0 AND 100),
  CONSTRAINT "engineer_payout_rules_base_salary_non_negative" CHECK (base_salary_kopecks >= 0)
);
