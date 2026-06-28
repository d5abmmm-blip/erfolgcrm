-- Заявки: флаг «Ждём запчасть» + опт-ин уведомления клиента «техника готова».
--
-- Фича A — флаг ожидания запчасти (НЕ новый статус, чтобы не протаскивать его через
--   все переходы / PDF-бланки / отчёты / kanban). Простой из-за ожидания детали —
--   не вина инженера; менеджер видит такие заявки по бейджу.
--     tickets.waiting_for_part       — флаг (по умолчанию выключен)
--     tickets.waiting_for_part_note  — что именно ждём (деталь / поставщик), опционально
--
-- Фича B — уведомление клиента «техника готова к выдаче» (статус act_pending).
--   Это письмо УЖЕ слалось воркером ticket-status-notify (он шлёт на 7 статусов).
--   Здесь добавляем директору тумблер, чтобы его можно было ОТКЛЮЧИТЬ, и защиту от
--   повторной отправки. ПО УМОЛЧАНИЮ ВКЛЮЧЕНО (true) — чтобы поведение прода, где
--   письмо уже отправляется, не изменилось после миграции. Идемпотентность — через
--   ready_notified_at: одно и то же уведомление «готово» по заявке не шлём повторно.
--     tenants.notify_client_when_ready — тумблер (по умолчанию true = как сейчас в проде)
--     tickets.ready_notified_at        — когда уже отправили «готово» (guard)
--
-- ADD COLUMN к существующим таблицам НЕ требует новой RLS-политики — политики tickets
-- (и control-plane tenants без RLS) покрывают новые колонки.

ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "waiting_for_part" boolean DEFAULT false NOT NULL;

ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "waiting_for_part_note" text;

ALTER TABLE "tickets"
  ADD COLUMN IF NOT EXISTS "ready_notified_at" timestamp with time zone;

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "notify_client_when_ready" boolean DEFAULT true NOT NULL;
