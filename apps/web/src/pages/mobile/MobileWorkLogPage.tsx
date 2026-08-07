import { Link, useRoute } from 'wouter';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { WorkOrderEditor } from '../../components/WorkOrderEditor';
import { QueryError } from '../../components/QueryError';
import { engineerOwnsTicket } from '../../lib/engineer-ticket-access';
import { closedWorkOrderNotice, mayEditWorkOrder } from '../../lib/work-order-window';

/**
 * /m/tickets/:id/work-log — журнал работ для инженера.
 *
 * Намеренно переиспользуем WorkOrderEditor: он уже horizontally scrollable,
 * autosave on blur, и инженерные права уже зашиты в роутер. Делать второй
 * вариант под мобильный = двойная поддержка.
 */
export function MobileWorkLogPage() {
  const [, params] = useRoute<{ id: string }>('/m/tickets/:id/work-log');
  const id = params?.id ?? '';

  const ticket = trpc.tickets.get.useQuery({ id }, { enabled: !!id });
  const me = trpc.auth.me.useQuery();

  if (ticket.isLoading || me.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 p-8 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка…
      </div>
    );
  }
  if (ticket.error || !ticket.data) {
    // Без связи react-query не роняет запрос, а ставит его на паузу: `error`
    // пуст, и раньше экран писал «Заявка не найдена» — то есть врал, что
    // заявки нет. Плюс сырой `error.message` мог быть техническим (SQL, JSON
    // от проверки полей) — теперь текст всегда человеческий.
    return (
      <div className="m-3 space-y-2">
        <QueryError
          error={ticket.error}
          paused={ticket.fetchStatus === 'paused'}
          what="заявку"
          onRetry={() => void ticket.refetch()}
        />
        {!ticket.error && ticket.fetchStatus !== 'paused' && (
          <div className="text-muted-foreground text-sm">Заявка не найдена</div>
        )}
      </div>
    );
  }
  const role = me.data?.user.role;
  // Инженер правит наряд только по СВОЕЙ заявке (ответственный или помощник) —
  // сервер с 2026-08-07 чужие правки не принимает, и экран не должен давать
  // вводить то, что всё равно откажут.
  const isMine = engineerOwnsTicket(
    me.data ? { id: me.data.user.id, role: me.data.user.role } : undefined,
    ticket.data,
  );
  // Плюс окно правки: наряд закрытой заявки инженер правит три дня, дальше
  // это делает руководитель (решение владельца 2026-08-07).
  const inEditWindow = mayEditWorkOrder(role, ticket.data);
  const closedNotice = role === 'engineer' ? closedWorkOrderNotice(ticket.data) : null;
  const canEdit =
    (role === 'engineer' && isMine && inEditWindow) || role === 'dispatcher' || role === 'director';
  const canEditVat = role === 'dispatcher' || role === 'director';

  return (
    <div className="space-y-3 p-3">
      <Link
        href={`/m/tickets/${id}`}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К заявке {ticket.data.ticketNumber}
      </Link>

      {!canEdit && role === 'engineer' && (
        <div className="bg-warning/15 text-warning border-warning/40 rounded-lg border p-3 text-sm">
          {closedNotice ?? 'Это не ваша заявка — наряд можно смотреть, но не менять.'}
        </div>
      )}

      <WorkOrderEditor
        ticketId={id}
        ticketNumber={ticket.data.ticketNumber}
        canEdit={canEdit}
        canEditVat={canEditVat}
      />
    </div>
  );
}
