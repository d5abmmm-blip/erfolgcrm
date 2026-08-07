/**
 * Срок, в течение которого наряд закрытой заявки ещё можно править.
 *
 * ЗАЧЕМ. Ни в сервисе нарядов, ни в интерфейсе не было ни одной проверки
 * статуса заявки: строку можно было добавить в закрытую заявку любой давности.
 * А от строк наряда считается зарплата — то есть правка задним числом меняет
 * суммы УЖЕ ВЫПЛАЧЕННОГО периода, и заметить это некому.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (2026-08-07): «закрытую заявку можно редактировать ещё три
 * дня, а дальше нужно, чтобы давал разрешение администратор». Отдельного
 * механизма «разрешить правку кнопкой» владелец не захотел: после трёх дней
 * наряд правят только директор и диспетчер, и сам факт, что правит
 * руководитель, и есть разрешение.
 *
 * Чистая функция без базы — чтобы правило читалось глазами и проверялось
 * тестом, а не пряталось внутри запроса.
 */
import { TRPCError } from '@trpc/server';

export const CLOSED_WORK_ORDER_EDIT_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export type EditorRole = 'director' | 'dispatcher' | 'engineer';

export interface TicketClosure {
  status: string;
  closedAt: Date | string | null;
}

/** Сколько полных дней прошло с закрытия. null — заявка не закрыта или даты нет. */
export function daysSinceClosed(ticket: TicketClosure, now: number = Date.now()): number | null {
  if (ticket.status !== 'closed') return null;
  if (!ticket.closedAt) return null;
  const closed = typeof ticket.closedAt === 'string' ? new Date(ticket.closedAt) : ticket.closedAt;
  return Math.floor((now - closed.getTime()) / DAY_MS);
}

export function mayEditWorkOrder(
  role: EditorRole,
  ticket: TicketClosure,
  now: number = Date.now(),
): boolean {
  if (role !== 'engineer') return true;
  if (ticket.status !== 'closed') return true;
  // Закрыта, но даты закрытия нет (так бывает у импортированных заявок).
  // Считать её «закрытой только что» нельзя — это ровно та дыра, которую
  // мы и закрываем.
  if (!ticket.closedAt) return false;
  const days = daysSinceClosed(ticket, now);
  return days !== null && days <= CLOSED_WORK_ORDER_EDIT_DAYS;
}

export function assertWorkOrderEditable(
  role: EditorRole,
  ticket: TicketClosure,
  now: number = Date.now(),
): void {
  if (mayEditWorkOrder(role, ticket, now)) return;
  const days = daysSinceClosed(ticket, now);
  const when = days === null ? 'уже закрыта' : `закрыта ${days} дн. назад`;
  throw new TRPCError({
    code: 'FORBIDDEN',
    message:
      `Заявка ${when} — наряд правится только первые ${CLOSED_WORK_ORDER_EDIT_DAYS} дня. ` +
      'Дальше правку вносит руководитель: обратитесь к диспетчеру или директору.',
  });
}
