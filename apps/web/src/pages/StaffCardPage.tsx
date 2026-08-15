/**
 * /staff/:id — карточка сотрудника.
 *
 * «Сейчас» отвечает на один вопрос: можно ли отдать этому человеку заявку. Поэтому
 * здесь текущие незакрытые заявки (свои, из CRM), отсутствия и техника, с которой он
 * умеет работать, — всё только для просмотра.
 *
 * «Кадры» — место ВНЕСЕНИЯ: аттестации, типы техники, отпуска и табель. На бою во всех
 * этих модулях по нулю записей, потому что формы были спрятаны в настройках, куда
 * никто не заходит. «Работа» — история за период, «Деньги» — только директору.
 */
import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import { ArrowLeft, AlertTriangle, Archive, CalendarOff, Phone, Wrench } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { QueryError } from '../components/QueryError';
import { StatusBadge } from '../components/ui/StatusBadge';
import { StaffHrTab } from '../components/StaffHrTab';
import { StaffMoneyTab } from '../components/StaffMoneyTab';
import { StaffWorkTab } from '../components/StaffWorkTab';
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
          {/* Шапка сделана по образцу карточки инженера из прежней CRM владельца:
              крупный инициал, имя и должность, строка контактов, а показатели — полосой
              под чертой, где они читаются одинаково на телефоне и на мониторе. */}
          <section className="bg-card rounded-lg border p-4 md:p-6">
            <div className="flex items-start gap-4">
              <div className="bg-primary/15 text-primary grid size-14 shrink-0 place-items-center rounded-2xl text-xl font-bold md:size-16 md:text-2xl">
                {card.fullName.trim().charAt(0).toUpperCase()}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <h1 className="text-xl font-semibold md:text-2xl">{card.fullName}</h1>
                  {card.awayToday ? (
                    <StatusBadge variant="warning">
                      {AWAY_LABELS[card.awayToday.kind]} ·{' '}
                      {formatAwayRange(card.awayToday.dateFrom, card.awayToday.dateTo)}
                    </StatusBadge>
                  ) : (
                    card.isActive && <StatusBadge variant="success">на месте</StatusBadge>
                  )}
                  {!card.isActive && <StatusBadge variant="muted">не работает</StatusBadge>}
                </div>
                <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                  <span>{card.position || ROLE_LABELS_RU[card.role]}</span>
                  {card.phone && (
                    <span className="inline-flex items-center gap-1">
                      <Phone className="h-3 w-3" />
                      {card.phone}
                    </span>
                  )}
                  {card.skills.length > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <Wrench className="h-3 w-3" />
                      {card.skills.join(', ')}
                    </span>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2.5 border-t pt-4 lg:grid-cols-4">
              <Tile value={String(card.openTickets)} label="в работе" />
              <Tile
                value={String(card.overdueTickets)}
                label="просрочено"
                tone={card.overdueTickets > 0 ? 'bad' : 'normal'}
              />
              <Tile value={loadLevel(card.openTickets)} label="загрузка" />
              <Tile
                value={card.archiveOpenTickets === 0 ? '—' : String(card.archiveOpenTickets)}
                label="из старой системы"
              />
            </div>
          </section>

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
                {t.key === 'now' && card.openTickets > 0 && (
                  <span className="text-muted-foreground ml-1 tabular-nums">
                    ({card.openTickets})
                  </span>
                )}
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
                    <button
                      type="button"
                      onClick={() => setTab('hr')}
                      className="text-muted-foreground hover:text-foreground mt-3 text-xs underline underline-offset-2"
                    >
                      Изменить во вкладке «Кадры»
                    </button>
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
                    <button
                      type="button"
                      onClick={() => setTab('hr')}
                      className="text-muted-foreground hover:text-foreground mt-3 text-xs underline underline-offset-2"
                    >
                      Отметить во вкладке «Кадры»
                    </button>
                  </div>
                </section>
              </div>
            </div>
          )}

          {tab === 'hr' && <StaffHrTab userId={userId} role={card.role} isDirector={isDirector} />}

          {tab === 'work' && <StaffWorkTab userId={userId} />}

          {tab === 'money' && <StaffMoneyTab userId={userId} />}
        </>
      )}
    </div>
  );
}

/** Плитка полосы показателей. Прочерк вместо нуля там, где ноль означает «нет данных». */
function Tile({
  value,
  label,
  tone = 'normal',
}: {
  value: string;
  label: string;
  tone?: 'normal' | 'bad';
}) {
  return (
    <div className="bg-muted/40 rounded-md px-3 py-2">
      <div className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</div>
      <div
        className={cn(
          'mt-0.5 text-lg font-semibold tabular-nums leading-none',
          tone === 'bad' && 'text-destructive',
        )}
      >
        {value}
      </div>
    </div>
  );
}

