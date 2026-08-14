/**
 * /staff/:id — карточка сотрудника, вкладка «Сейчас».
 *
 * Отвечает на один вопрос: можно ли отдать этому человеку заявку. Поэтому здесь
 * текущие незакрытые заявки (свои, из CRM), отсутствия и техника, с которой он умеет
 * работать. Остальные вкладки («Работа», «Кадры», «Деньги») добавляются следующими
 * шагами — их заглушки честно говорят, что появится и почему пока пусто.
 *
 * Навыки и отсутствия здесь можно ЗАПОЛНИТЬ, а не только посмотреть: на бою они
 * пусты у всех, потому что форма спрятана в настройках, куда никто не заходит.
 */
import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import { ArrowLeft, AlertTriangle, Archive, CalendarOff, Wrench } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { QueryError } from '../components/QueryError';
import {
  AWAY_LABELS,
  ROLE_LABELS_RU,
  formatAwayRange,
  loadLevel,
  openTicketsPhrase,
  ticketStatusRu,
  ticketsWord,
} from '../lib/staff';

type Tab = 'now' | 'work' | 'hr' | 'money';

const TABS: Array<{ key: Tab; label: string; directorOnly?: boolean }> = [
  { key: 'now', label: 'Сейчас' },
  { key: 'work', label: 'Работа' },
  { key: 'hr', label: 'Кадры' },
  { key: 'money', label: 'Деньги', directorOnly: true },
];

export function StaffCardPage() {
  const [, params] = useRoute('/staff/:id');
  const userId = params?.id ?? '';
  const me = trpc.auth.me.useQuery();
  const role = me.data?.user.role;
  const isStaff = role === 'director' || role === 'dispatcher';
  const isDirector = role === 'director';

  const [tab, setTab] = useState<Tab>('now');

  const cardQ = trpc.staff.get.useQuery({ userId }, { enabled: isStaff && Boolean(userId) });

  if (me.isLoading) return <div className="text-muted-foreground p-6 text-sm">Загрузка…</div>;

  if (!isStaff) {
    return (
      <div className="mx-auto max-w-lg p-6">
        <div className="bg-card rounded-lg border p-6 text-center">
          <h1 className="text-base font-semibold">Раздел недоступен</h1>
          <p className="text-muted-foreground mt-2 text-sm">
            Карточки сотрудников ведут менеджер и директор.
          </p>
        </div>
      </div>
    );
  }

  const card = cardQ.data?.card;
  const visibleTabs = TABS.filter((t) => !t.directorOnly || isDirector);

  return (
    <div className="mx-auto max-w-[1200px] space-y-4 p-4 md:p-6">
      <Link
        href="/staff"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-sm transition"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Все сотрудники
      </Link>

      {cardQ.error && <QueryError error={cardQ.error} onRetry={() => void cardQ.refetch()} />}
      {cardQ.isLoading && <div className="text-muted-foreground text-sm">Загрузка карточки…</div>}

      {card && (
        <>
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <h1 className="text-xl font-semibold md:text-2xl">{card.fullName}</h1>
              <div className="text-muted-foreground mt-0.5 text-sm">
                {card.position || ROLE_LABELS_RU[card.role]}
                {!card.isActive && ' · не работает'}
                {card.phone && ` · ${card.phone}`}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <Metric value={String(card.openTickets)} label="в работе" />
              <Metric
                value={String(card.overdueTickets)}
                label="просрочено"
                tone={card.overdueTickets > 0 ? 'bad' : 'normal'}
              />
              <Metric value={loadLevel(card.openTickets)} label="загрузка" />
            </div>
          </div>

          <div className="inline-flex flex-wrap rounded-md border p-0.5">
            {visibleTabs.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={cn(
                  'rounded-sm px-3 py-1.5 text-xs font-medium transition',
                  tab === t.key
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t.label}
              </button>
            ))}
          </div>

          {tab === 'now' && (
            <div className="grid gap-4 lg:grid-cols-3">
              <section className="bg-card rounded-lg border lg:col-span-2">
                <header className="flex items-center justify-between border-b px-4 py-3">
                  <h2 className="text-sm font-semibold">Незакрытые заявки</h2>
                  <span className="text-muted-foreground text-xs">
                    {card.openTickets} {ticketsWord(card.openTickets)}
                  </span>
                </header>

                {card.openTicketList.length === 0 ? (
                  <p className="text-muted-foreground p-4 text-sm">
                    Свободен — незакрытых заявок нет.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {card.openTicketList.map((t) => (
                      <li key={t.id}>
                        <Link
                          href={`/tickets/${t.id}`}
                          className="hover:bg-muted/40 flex items-center gap-3 px-4 py-2.5 transition"
                        >
                          <span className="text-muted-foreground w-28 shrink-0 truncate font-mono text-xs">
                            {t.ticketNumber}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-sm">
                            {t.clientName ?? 'без клиента'}
                          </span>
                          <span className="text-muted-foreground shrink-0 text-xs">
                            {ticketStatusRu(t.status)}
                          </span>
                          {t.isOverdue && (
                            <span className="text-destructive inline-flex shrink-0 items-center gap-1 text-xs font-medium">
                              <AlertTriangle className="h-3 w-3" />
                              просрочено
                            </span>
                          )}
                        </Link>
                      </li>
                    ))}
                  </ul>
                )}

                {card.archiveOpenTickets > 0 && (
                  <div className="text-muted-foreground flex items-start gap-2 border-t px-4 py-3 text-xs">
                    <Archive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                    <span>
                      В архиве прежней системы за этим человеком числится ещё{' '}
                      {openTicketsPhrase(card.archiveOpenTickets)}. В загрузку они не входят: скорее
                      всего их просто не закрыли при переносе.
                    </span>
                  </div>
                )}
              </section>

              <div className="space-y-4">
                <section className="bg-card rounded-lg border">
                  <header className="flex items-center gap-2 border-b px-4 py-3">
                    <Wrench className="text-muted-foreground h-3.5 w-3.5" />
                    <h2 className="text-sm font-semibold">Обслуживает технику</h2>
                  </header>
                  <div className="p-4">
                    {card.skills.length > 0 ? (
                      <div className="flex flex-wrap gap-1.5">
                        {card.skills.map((s) => (
                          <span
                            key={s}
                            className="bg-secondary text-secondary-foreground rounded px-2 py-0.5 text-xs"
                          >
                            {s}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        Не заполнено. Пока техника не указана, подсказка «кому отдать заявку» по
                        этому человеку работать не будет.
                      </p>
                    )}
                    <p className="text-muted-foreground mt-3 text-xs">
                      Заполняется в{' '}
                      <Link href="/users" className="underline underline-offset-2">
                        настройках пользователей
                      </Link>{' '}
                      — там же, где заводят учётную запись.
                    </p>
                  </div>
                </section>

                <section className="bg-card rounded-lg border">
                  <header className="flex items-center gap-2 border-b px-4 py-3">
                    <CalendarOff className="text-muted-foreground h-3.5 w-3.5" />
                    <h2 className="text-sm font-semibold">Отсутствия</h2>
                  </header>
                  <div className="p-4">
                    {card.upcomingAway.length > 0 ? (
                      <ul className="space-y-1.5">
                        {card.upcomingAway.map((a, i) => (
                          <li key={`${a.dateFrom}-${i}`} className="text-sm">
                            <span className="font-medium">{AWAY_LABELS[a.kind]}</span>{' '}
                            <span className="text-muted-foreground">
                              {formatAwayRange(a.dateFrom, a.dateTo)}
                            </span>
                            {a.note && <span className="text-muted-foreground"> · {a.note}</span>}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-muted-foreground text-sm">
                        Отпусков и выходных не отмечено.
                      </p>
                    )}
                  </div>
                </section>
              </div>
            </div>
          )}

          {tab !== 'now' && <ComingSoon tab={tab} />}
        </>
      )}
    </div>
  );
}

function Metric({
  value,
  label,
  tone = 'normal',
}: {
  value: string;
  label: string;
  tone?: 'normal' | 'bad';
}) {
  return (
    <div className="text-right">
      <div
        className={cn(
          'text-lg font-semibold tabular-nums leading-none',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </div>
      <div className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</div>
    </div>
  );
}

/**
 * Заглушки остальных вкладок. Говорим прямо, что появится и почему пока пусто, —
 * это честнее, чем нарисовать блок с прочерками и выдать его за готовый.
 */
function ComingSoon({ tab }: { tab: Tab }) {
  const text: Record<Exclude<Tab, 'now'>, string> = {
    work: 'Здесь будет история работы за период: сколько заявок закрыто, по каким клиентам и какой технике человек ездит чаще всего. Считать будем только по данным CRM — в перенесённом архиве исполнитель не указан.',
    hr: 'Здесь будут аттестации со сроками, отпуска и табель. Сейчас в базе нет ни одной аттестации и ни одной отметки табеля — не потому, что негде хранить, а потому, что их пока не вносили.',
    money:
      'Здесь будут оклад, процент сделки, аванс и выплаты. Вкладка видна только директору. Сейчас в базе одна ведомость и ни одной проведённой выплаты.',
  };
  return (
    <div className="bg-card text-muted-foreground rounded-lg border p-6 text-sm">
      {text[tab as Exclude<Tab, 'now'>]}
    </div>
  );
}
