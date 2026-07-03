-- Причина простоя заявки (структурная) + дата начала простоя.
--
-- Единый источник «почему техника стоит» для новой доски. Флаг waiting_for_part
-- ОСТАЁТСЯ; команда setWaitingForPart дополнительно проставляет blocked_reason='waiting_part'
-- (и снимает вместе). Часть причин ВЫВОДИТСЯ из статуса на доске (estimate/approval →
-- «ждём согласование клиента», act_pending → «готово к выдаче») и здесь не хранится, но
-- входит в enum ради единого ключа колонок.
--
-- blocked_since — когда простой начался (для «стоит N дней»); НЕ сбрасывается записью
-- события note (в отличие от idle-days), поэтому счётчик простоя честный.
--
-- ADD COLUMN к существующей таблице tickets НЕ требует новой RLS-политики.

DO $$ BEGIN
  CREATE TYPE "ticket_blocked_reason" AS ENUM (
    'waiting_part',
    'waiting_client_approval',
    'waiting_payment',
    'waiting_management_decision',
    'no_free_engineer',
    'waiting_delivery',
    'ready_for_pickup'
  );
EXCEPTION WHEN duplicate_object THEN null; END $$;

ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "blocked_reason" "ticket_blocked_reason";
ALTER TABLE "tickets" ADD COLUMN IF NOT EXISTS "blocked_since" timestamp with time zone;

-- Бэкофилл: заявки, уже помеченные «ждём запчасть», получают структурную причину.
UPDATE "tickets"
   SET "blocked_reason" = 'waiting_part',
       "blocked_since" = COALESCE("updated_at", now())
 WHERE "waiting_for_part" = true AND "blocked_reason" IS NULL;

CREATE INDEX IF NOT EXISTS "tickets_blocked_idx"
  ON "tickets" ("tenant_id", "blocked_reason")
  WHERE "blocked_reason" IS NOT NULL;
