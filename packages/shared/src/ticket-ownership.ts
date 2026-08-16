/**
 * «Заявка этого инженера» — одно правило на сервер и на экран.
 *
 * ЗАЧЕМ. Правило жило только на сервере (`engineerMayEditTicket`): своей считается
 * заявка, где инженер назначен ИЛИ записан вторым (помощником). Экран заявки
 * проверял лишь назначенного — и второй инженер, который выезжал на технику вместе
 * с первым, не видел на десктопе ни кнопок актов, ни реквизитов клиента, хотя
 * сервер их ему отдаёт и печать по такой заявке разрешает.
 *
 * Помощников на заявке завели как раз затем, чтобы работали оба.
 */
export interface TicketEngineers {
  assignedEngineerId: string | null;
  /** Вторые инженеры на заявке. Пусто — только назначенный. */
  helperEngineerIds?: readonly string[];
}

export function ticketBelongsToEngineer(
  userId: string | null | undefined,
  ticket: TicketEngineers,
): boolean {
  if (!userId) return false;
  if (ticket.assignedEngineerId === userId) return true;
  return (ticket.helperEngineerIds ?? []).includes(userId);
}
