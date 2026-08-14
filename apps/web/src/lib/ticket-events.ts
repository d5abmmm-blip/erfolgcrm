/**
 * Человеческое описание события заявки для мобильной «Истории».
 *
 * Инженер мог писать комментарии, но не видел ни их, ни ответов диспетчера —
 * переписка уходила в пустоту. Формат текстовый и компактный: заголовок +
 * необязательное тело; иконки и вёрстка остаются за экраном.
 */
import type { TicketEventType, TicketStatus, TicketPriority } from '@erfolg/shared';
import { TICKET_STATUS_META, TICKET_PRIORITY_META } from './dictionaries/tickets';

export const DOCUMENT_KIND_LABEL: Record<string, string> = {
  intake_act: 'Акт приёма',
  invoice: 'Счёт',
  work_act: 'Акт работ',
  defect_act: 'Дефектный акт',
  tech_condition_act: 'Акт технического состояния',
};

export interface TicketEventPayload {
  from?: unknown;
  to?: unknown;
  comment?: string;
  documentKind?: string;
  role?: 'engineer' | 'dispatcher';
}

export interface TicketEventLike {
  type: TicketEventType;
  payload: TicketEventPayload;
}

/** payload приходит из БД как unknown — нестроковое значение показываем прочерком. */
function asKey(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/**
 * Подпись статуса в событии. Три случая, и все встречаются на бою:
 *   • свой статус CRM — переводим по словарю;
 *   • статус старой программы («Аппарат готов») — показываем как есть, он осмысленный;
 *   • значения нет вовсе — прочерк. Перенесённая история хранит только «куда», без
 *     «откуда», и десктопная карточка печатала это словом «undefined».
 */
export function eventStatusLabel(v: unknown): string {
  const key = asKey(v);
  return TICKET_STATUS_META[key as TicketStatus]?.label ?? (key || '—');
}

/** То же для приоритета. */
export function eventPriorityLabel(v: unknown): string {
  const key = asKey(v);
  return TICKET_PRIORITY_META[key as TicketPriority]?.label ?? (key || '—');
}

export function describeTicketEvent(e: TicketEventLike): { title: string; body: string | null } {
  const p = e.payload;
  switch (e.type) {
    case 'created':
      return { title: 'Заявка создана', body: null };
    case 'status_change':
      return { title: 'Статус', body: `${eventStatusLabel(p.from)} → ${eventStatusLabel(p.to)}` };
    case 'assignment_change':
      return {
        title: p.role === 'dispatcher' ? 'Назначен диспетчер' : 'Назначен инженер',
        body: `${typeof p.from === 'string' ? p.from : '—'} → ${typeof p.to === 'string' ? p.to : '—'}`,
      };
    case 'priority_change':
      return {
        title: 'Приоритет',
        body: `${eventPriorityLabel(p.from)} → ${eventPriorityLabel(p.to)}`,
      };
    case 'sla_change':
      return { title: 'Изменён SLA / дедлайн', body: null };
    case 'note':
      return { title: 'Комментарий', body: p.comment ?? null };
    case 'document_printed':
      return {
        title: `Документ: ${DOCUMENT_KIND_LABEL[p.documentKind ?? ''] ?? 'напечатан'}`,
        body: null,
      };
    default:
      return { title: 'Событие', body: null };
  }
}
