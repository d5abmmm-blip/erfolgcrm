-- Индивидуальная зарплата по каждому сотруднику: персональный оклад + бонус %.
-- Оба поля NULL ⇒ для этого сотрудника действует глобальное правило
-- engineer_payout_rules (полная обратная совместимость).
-- RLS у users уже включён — отдельная RLS-миграция не нужна.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payout_base_salary_kopecks" bigint;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "payout_bonus_percent" integer;

ALTER TABLE "users" ADD CONSTRAINT "users_payout_base_salary_non_negative"
  CHECK ("payout_base_salary_kopecks" IS NULL OR "payout_base_salary_kopecks" >= 0);
ALTER TABLE "users" ADD CONSTRAINT "users_payout_bonus_percent_range"
  CHECK ("payout_bonus_percent" IS NULL OR "payout_bonus_percent" BETWEEN 0 AND 100);
