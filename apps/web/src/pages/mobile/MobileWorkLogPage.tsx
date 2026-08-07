import { Link, useRoute } from 'wouter';
import { ChevronLeft, Loader2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { WorkOrderEditor } from '../../components/WorkOrderEditor';

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
    return (
      <div className="m-3">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
          {ticket.error?.message ?? 'Заявка не найдена'}
        </div>
      </div>
    );
  }
  const role = me.data?.user.role;
  const canEdit = role === 'engineer' || role === 'dispatcher' || role === 'director';
  const canEditVat = role === 'dispatcher' || role === 'director';

  return (
    <div className="space-y-3 p-3">
      <Link
        href={`/m/tickets/${id}`}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К заявке {ticket.data.ticketNumber}
      </Link>

      <WorkOrderEditor
        ticketId={id}
        ticketNumber={ticket.data.ticketNumber}
        canEdit={canEdit}
        canEditVat={canEditVat}
      />
    </div>
  );
}
