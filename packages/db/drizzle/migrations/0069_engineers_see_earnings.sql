-- Тумблер «инженеры видят свой заработок в личном кабинете».
-- Директор управляет им в «Настройки → Правила расчёта ЗП».
-- По умолчанию true — прежнее поведение (инженеры видят заработок) сохраняется.
-- RLS у engineer_payout_rules уже включён — отдельная RLS-миграция не нужна.

ALTER TABLE "engineer_payout_rules"
  ADD COLUMN IF NOT EXISTS "engineers_see_earnings" boolean NOT NULL DEFAULT true;
