import type { TicketStatus, TicketPriority, TicketBlockedReason } from '@erfolg/shared';
import type { StatusBadgeVariant } from '../../components/ui/StatusBadge';

interface MetaEntry {
  label: string;
  variant: StatusBadgeVariant;
}

/**
 * Метаданные статусов заявки: человекочитаемая подпись + цветовой вариант для StatusBadge.
 * Источник истины — `TicketStatus` enum в @erfolg/shared.
 */
export const TICKET_STATUS_META: Record<TicketStatus, MetaEntry> = {
  received: { label: 'Принята', variant: 'info' },
  diagnostics: { label: 'Диагностика', variant: 'info' },
  estimate: { label: 'Смета', variant: 'info' },
  approval: { label: 'Согласование', variant: 'warning' },
  in_progress: { label: 'В работе', variant: 'warning' },
  act_pending: { label: 'Ожидает акта', variant: 'info' },
  closed: { label: 'Закрыта', variant: 'success' },
  cancelled: { label: 'Отменена', variant: 'danger' },
};

/**
 * Активные статусы — заявки в работе (не closed/cancelled). Задают колонки канбана
 * и фильтр списка. Стадии «Смета»/«Согласование» убраны из потока (значения enum
 * сохранены в TICKET_STATUS_META для истории, но в рабочих списках не показываются).
 */
export const ACTIVE_TICKET_STATUSES: readonly TicketStatus[] = [
  'received',
  'diagnostics',
  'in_progress',
  'act_pending',
] as const;

/**
 * Порог «зависшей» заявки в днях. Открытая заявка без активности дольше этого
 * порога подсвечивается бейджем «Висит N дн.». Совпадает с дефолтным порогом
 * AI-инструмента list_aged_tickets, чтобы бейдж и ответ ИИ не расходились.
 */
export const STALE_TICKET_DAYS = 7;

/**
 * Заявка «висит» = открыта (не closed/cancelled) и без активности дольше порога.
 * idleDays приходит из API (max(received_at, последнее ticket_event)).
 */
export function isTicketStale(status: TicketStatus, idleDays: number): boolean {
  if (status === 'closed' || status === 'cancelled') return false;
  return idleDays >= STALE_TICKET_DAYS;
}

/** Метаданные приоритета заявки. */
export const TICKET_PRIORITY_META: Record<TicketPriority, MetaEntry> = {
  low: { label: 'низкий', variant: 'muted' },
  normal: { label: 'обычный', variant: 'muted' },
  high: { label: 'высокий', variant: 'warning' },
  urgent: { label: 'срочный', variant: 'danger' },
};

/** Подписи причин простоя (доска «почему стоит»). Порядок = порядок колонок. */
export const BLOCKED_REASON_META: Record<TicketBlockedReason, { label: string; short: string }> = {
  waiting_part: { label: 'Ждём запчасть', short: 'запчасть' },
  waiting_client_approval: { label: 'Ждём согласование клиента', short: 'согласование' },
  waiting_payment: { label: 'Ждём оплату', short: 'оплата' },
  waiting_management_decision: { label: 'Ждём решение руководства', short: 'решение' },
  no_free_engineer: { label: 'Нет свободного инженера', short: 'нет инженера' },
  waiting_delivery: { label: 'Ждём привоз / самовывоз', short: 'привоз' },
  ready_for_pickup: { label: 'Готово — позвонить', short: 'готово' },
};

/** Порядок колонок в виде «По причине простоя». */
export const BLOCKED_REASON_COLUMNS: readonly TicketBlockedReason[] = [
  'waiting_part',
  'waiting_client_approval',
  'waiting_payment',
  'waiting_management_decision',
  'no_free_engineer',
  'waiting_delivery',
  'ready_for_pickup',
] as const;

/**
 * Причины, которые менеджер ставит вручную. waiting_client_approval и ready_for_pickup
 * выводятся из статуса заявки (смета/согласование, готово к выдаче) — их не задают руками.
 */
export const SETTABLE_BLOCKED_REASONS: readonly TicketBlockedReason[] = [
  'waiting_part',
  'waiting_payment',
  'waiting_management_decision',
  'no_free_engineer',
  'waiting_delivery',
] as const;

/** Цвет светофора карточки → классы фона (для точки-индикатора). */
export const TRAFFIC_LIGHT_DOT: Record<'green' | 'yellow' | 'red', string> = {
  green: 'bg-success',
  yellow: 'bg-warning',
  red: 'bg-destructive',
};
