/**
 * Разрешённые переходы между статусами заявки — ОДНА таблица на сервер и на экран.
 *
 * ЗАЧЕМ ЗДЕСЬ, А НЕ В API. Таблица жила только на сервере, а интерфейс предлагал
 * переходы наугад, и три экрана обещали то, чего сервер не примет:
 *
 *   • мобильная карточка инженера показывала кнопку «Готов к акту» в статусе
 *     «Диагностика», хотя туда можно только через «В работе». На связи это ошибка,
 *     а БЕЗ связи хуже: правка ложится в офлайн-очередь и всплывает позже как
 *     «не принято» — инженер в этот момент уже уехал с объекта;
 *   • канбан позволял тащить карточку в любую колонку, а сервер принимает
 *     четыре перехода из двенадцати: карточка возвращалась на место без объяснения;
 *   • на карточке заявки кнопки «Закрыть наряд» и «Перевести в „Ожидает акта“»
 *     показывались при любом статусе.
 *
 * Правило простое: кнопки рисуются по этой таблице. Сервер остаётся последним
 * словом — он проверяет её же (tickets/service.ts).
 */
import type { TicketStatus } from './index';

/**
 *   received    → diagnostics | cancelled
 *   diagnostics → in_progress | cancelled
 *   in_progress → act_pending | cancelled
 *   act_pending → closed | in_progress | cancelled   (доделка / отказ клиента)
 *   closed      → ∅                                  (только директор, «Переоткрыть»)
 *   cancelled   → ∅                                  (только директор, «Переоткрыть»)
 *
 * Стадии «Смета» и «Согласование» убраны из потока; значения enum сохранены ради
 * истории, и легаси-заявке из них разрешён выход, чтобы она не застряла.
 */
export const ALLOWED_TICKET_TRANSITIONS: Record<TicketStatus, ReadonlyArray<TicketStatus>> = {
  received: ['diagnostics', 'cancelled'],
  diagnostics: ['in_progress', 'cancelled'],
  estimate: ['in_progress', 'cancelled'],
  approval: ['in_progress', 'cancelled'],
  in_progress: ['act_pending', 'cancelled'],
  act_pending: ['closed', 'in_progress', 'cancelled'],
  closed: [],
  cancelled: [],
};

/** Статусы, которые инженеру разрешено ставить самому. */
export const ENGINEER_ALLOWED_STATUSES: ReadonlyArray<TicketStatus> = [
  'diagnostics',
  'in_progress',
  'act_pending',
];

/**
 * Куда можно перевести заявку из текущего статуса — с учётом роли.
 * Пустой список означает «дальше только через „Переоткрыть“ у директора».
 */
export function allowedNextStatuses(
  from: TicketStatus,
  role?: 'director' | 'dispatcher' | 'engineer',
): ReadonlyArray<TicketStatus> {
  const next = ALLOWED_TICKET_TRANSITIONS[from] ?? [];
  if (role !== 'engineer') return next;
  return next.filter((s) => ENGINEER_ALLOWED_STATUSES.includes(s));
}

/** Примет ли сервер такой переход. `from === to` — не ошибка, а «ничего не менять». */
export function canTransitionTicket(
  from: TicketStatus,
  to: TicketStatus,
  role?: 'director' | 'dispatcher' | 'engineer',
): boolean {
  if (from === to) return true;
  return allowedNextStatuses(from, role).includes(to);
}
