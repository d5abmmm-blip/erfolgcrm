import { Link } from 'wouter';
import { Loader2, Ticket, Receipt, Wrench, Plus } from 'lucide-react';
import { clientTicketStatusLabel, type TicketStatus } from '@erfolg/shared';
import { trpc } from '../../lib/trpc';
import { formatRub } from '../../lib/money';
import { formatDateRu } from '../../lib/format-date';

const INVOICE_STATUS_LABEL: Record<string, string> = {
  draft: 'Черновик',
  issued: 'Выставлен',
  partially_paid: 'Частично оплачен',
  paid: 'Оплачен',
  overdue: 'Просрочен',
  cancelled: 'Отменён',
};

export function ClientDashboardPage() {
  const dash = trpc.clientCabinet.getDashboard.useQuery();

  if (dash.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (dash.error || !dash.data) {
    return <div className="text-destructive p-6 text-sm">Не удалось загрузить данные</div>;
  }
  const d = dash.data;

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-xl font-semibold">Здравствуйте!</h2>
          <p className="text-muted-foreground text-sm">
            {d.clientDisplayName ?? 'Кабинет клиента'}
          </p>
        </div>
        <Link
          href="/client/tickets/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          Создать заявку
        </Link>
      </div>

      <div className="grid gap-3 md:grid-cols-3">
        <CounterCard
          icon={Ticket}
          label="Активных заявок"
          value={d.counters.openTickets}
          href="/client/tickets"
        />
        <CounterCard
          icon={Receipt}
          label="Неоплаченных счетов"
          value={d.counters.unpaidInvoices}
          href="/client/invoices"
        />
        <CounterCard
          icon={Wrench}
          label="Единиц техники"
          value={d.counters.totalAssets}
          href="/client/assets"
        />
      </div>

      <Section title="Последние заявки" linkHref="/client/tickets" linkLabel="Все заявки">
        {d.recentTickets.length === 0 ? (
          <Empty text="Активных заявок нет" />
        ) : (
          <div className="bg-card divide-y rounded-md border">
            {d.recentTickets.map((t) => (
              <Link
                key={t.id}
                href={`/client/tickets/${t.id}`}
                className="hover:bg-muted/50 flex items-center justify-between gap-3 px-4 py-3 text-sm"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-medium">№ {t.ticketNumber}</div>
                  <div className="text-muted-foreground truncate">
                    {t.assetModel ?? 'Без техники'} — {t.symptom ?? 'без описания'}
                  </div>
                </div>
                <span className="bg-primary/10 text-primary rounded px-2 py-0.5 text-xs">
                  {clientTicketStatusLabel(t.status as TicketStatus)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Section>

      <Section title="Неоплаченные счета" linkHref="/client/invoices" linkLabel="Все счета">
        {d.recentInvoices.length === 0 ? (
          <Empty text="Все счета оплачены" />
        ) : (
          <div className="bg-card divide-y rounded-md border">
            {d.recentInvoices.map((i) => (
              <div key={i.id} className="flex items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="font-medium">{i.invoiceNumber}</div>
                  <div className="text-muted-foreground text-xs">
                    Срок оплаты: {formatDateRu(i.dueDate)}
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-medium">{formatRub(i.totalAmountKopecks)}</div>
                  <div className="text-muted-foreground text-xs">
                    {INVOICE_STATUS_LABEL[i.status] ?? i.status}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function CounterCard({
  icon: Icon,
  label,
  value,
  href,
}: {
  icon: typeof Ticket;
  label: string;
  value: number;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="bg-card hover:border-primary/40 flex items-center gap-3 rounded-md border p-4 transition"
    >
      <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <div className="text-2xl font-semibold leading-none">{value}</div>
        <div className="text-muted-foreground mt-1 text-xs">{label}</div>
      </div>
    </Link>
  );
}

function Section({
  title,
  linkHref,
  linkLabel,
  children,
}: {
  title: string;
  linkHref: string;
  linkLabel: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{title}</h3>
        <Link href={linkHref} className="text-primary text-xs hover:underline">
          {linkLabel}
        </Link>
      </div>
      {children}
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <div className="bg-card text-muted-foreground rounded-md border p-6 text-center text-sm">
      {text}
    </div>
  );
}
