import type { TicketStatus, TicketPriority } from '@erfolg/shared';
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

/** Активные статусы — заявки в работе (не closed/cancelled). */
export const ACTIVE_TICKET_STATUSES: readonly TicketStatus[] = [
  'received',
  'diagnostics',
  'estimate',
  'approval',
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
