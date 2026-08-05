/**
 * «Своя» заявка инженера = он ответственный ИЛИ помощник (ticket_engineers).
 *
 * Зеркало серверного assertEngineerOwnsTicket: сервер пускает помощника к
 * documentClient/recordPrint, а мобильный интерфейс проверял только
 * ответственного — помощник не видел кнопок актов и реквизитов клиента
 * (хвост от #84/#87). Директор и диспетчер не ограничены.
 */
export interface TicketAccessInfo {
  assignedEngineerId: string | null;
  helperEngineers?: Array<{ userId: string }> | null;
}

export function engineerOwnsTicket(
  user: { id: string; role: 'director' | 'dispatcher' | 'engineer' } | undefined,
  ticket: TicketAccessInfo | undefined,
): boolean {
  if (!user || !ticket) return false;
  if (user.role !== 'engineer') return true;
  if (ticket.assignedEngineerId === user.id) return true;
  return (ticket.helperEngineers ?? []).some((e) => e.userId === user.id);
}
