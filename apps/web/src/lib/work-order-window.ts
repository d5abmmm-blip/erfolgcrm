/**
 * Зеркало серверного правила «наряд закрытой заявки правится три дня».
 *
 * Экран не должен предлагать вводить то, что сервер всё равно отклонит:
 * инженер набьёт строку, нажмёт сохранить и получит отказ — с потерянным
 * вводом и без понимания, что произошло. Правило одно, но живёт в двух
 * местах по необходимости: сервер решает, экран объясняет заранее.
 *
 * Источник истины — `apps/api/src/modules/work-orders/edit-window.ts`.
 */
export const CLOSED_WORK_ORDER_EDIT_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TicketClosure {
  status: string;
  closedAt?: Date | string | null;
}

export function daysSinceClosed(ticket: TicketClosure, now: number = Date.now()): number | null {
  if (ticket.status !== 'closed' || !ticket.closedAt) return null;
  const closed = typeof ticket.closedAt === 'string' ? new Date(ticket.closedAt) : ticket.closedAt;
  return Math.floor((now - closed.getTime()) / DAY_MS);
}

export function mayEditWorkOrder(
  role: 'director' | 'dispatcher' | 'engineer' | undefined,
  ticket: TicketClosure | undefined,
  now: number = Date.now(),
): boolean {
  if (!ticket) return false;
  if (role !== 'engineer') return true;
  if (ticket.status !== 'closed') return true;
  // Закрыта без даты закрытия (бывает у импортированных) — не считаем «только что».
  if (!ticket.closedAt) return false;
  const days = daysSinceClosed(ticket, now);
  return days !== null && days <= CLOSED_WORK_ORDER_EDIT_DAYS;
}

/** Текст под кнопками: почему нельзя и что делать. */
export function closedWorkOrderNotice(
  ticket: TicketClosure | undefined,
  now: number = Date.now(),
): string | null {
  const days = ticket ? daysSinceClosed(ticket, now) : null;
  if (ticket?.status === 'closed' && days === null) {
    return 'Заявка закрыта — правку наряда вносит руководитель. Обратитесь к диспетчеру или директору.';
  }
  if (days === null || days <= CLOSED_WORK_ORDER_EDIT_DAYS) return null;
  return (
    `Заявка закрыта ${days} дн. назад — наряд правится только первые ${CLOSED_WORK_ORDER_EDIT_DAYS} дня. ` +
    'Дальше правку вносит руководитель: обратитесь к диспетчеру или директору.'
  );
}
