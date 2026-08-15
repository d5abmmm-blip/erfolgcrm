/**
 * /staff — список сотрудников с текущей загрузкой.
 *
 * Главный вопрос экрана: кому отдать заявку прямо сейчас. Поэтому на виду — сколько
 * у человека незакрытых заявок, сколько из них просрочено, отсутствует ли он сегодня
 * и с какой техникой умеет работать.
 *
 * Подача — СТРОКАМИ, не карточками (просьба владельца 2026-08-15): на 21 человеке
 * строки читаются сверху вниз как таблица и сравниваются глазами по колонкам.
 * Вся строка — ссылка на карточку человека. На узком экране список прокручивается
 * вбок внутри своего контейнера, страница горизонтально не ездит.
 *
 * Загрузка считается только по заявкам, заведённым в CRM. Хвост переноса из прежней
 * системы (незакрытые заявки 2015–2023 годов, большей частью на служебной учётке)
 * показываем отдельной пометкой — он не работа, но и молчать о нём нечестно.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import { Users, AlertTriangle, Search, Archive } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { QueryError } from '../components/QueryError';
import { AWAY_LABELS, ROLE_LABELS_RU, awayText, openTicketsPhrase } from '../lib/staff';

/** Одна сетка колонок на шапку и строки — разъедутся, если задавать порознь. */
const GRID_COLS =
  'grid grid-cols-[minmax(200px,1.3fr)_150px_80px_110px_80px_minmax(170px,1fr)] items-center gap-3';

export function StaffListPage() {
  const me = trpc.auth.me.useQuery();
  const isStaff = me.data?.user.role === 'director' || me.data?.user.role === 'dispatcher';

  const [query, setQuery] = useState('');
  const [includeBlocked, setIncludeBlocked] = useState(false);

  const listQ = trpc.staff.list.useQuery({ includeBlocked }, { enabled: isStaff });

  const rows = useMemo(() => {
    const all = listQ.data?.rows ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter(
      (r) =>
        r.fullName.toLowerCase().includes(q) ||
        (r.position ?? '').toLowerCase().includes(q) ||
        r.skills.some((s) => s.toLowerCase().includes(q)),
    );
  }, [listQ.data?.rows, query]);

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

  const archiveTotal = (listQ.data?.rows ?? []).reduce((s, r) => s + r.archiveOpenTickets, 0);

  return (
    <div className="mx-auto max-w-[1400px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Users className="h-3.5 w-3.5" />
            Команда
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Сотрудники</h1>
          <p className="text-muted-foreground text-sm">
            Кто чем занят сейчас. Загрузка считается по заявкам{' '}
            {listQ.data?.statsSinceLabel ?? 'с запуска CRM'}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Имя, должность, техника"
              className="bg-background focus:ring-primary/40 w-64 rounded-md border py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-2"
            />
          </div>
          <label className="text-muted-foreground flex cursor-pointer items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={includeBlocked}
              onChange={(e) => setIncludeBlocked(e.target.checked)}
              className="h-3.5 w-3.5"
            />
            Показывать уволенных
          </label>
        </div>
      </div>

      {listQ.error && <QueryError error={listQ.error} onRetry={() => void listQ.refetch()} />}
      {listQ.isLoading && <div className="text-muted-foreground text-sm">Загрузка списка…</div>}

      {archiveTotal > 0 && (
        <div className="bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-lg border p-3 text-xs">
          <Archive className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            В архиве прежней системы {openTicketsPhrase(archiveTotal)}. В загрузку они не идут: там
            нет сведений об исполнителе, а часть числится за служебной учётной записью. Скорее всего
            их просто не закрыли при переносе.
          </span>
        </div>
      )}

      {listQ.data && rows.length === 0 && (
        <div className="text-muted-foreground bg-card rounded-lg border p-6 text-sm">
          {query ? 'По запросу никого не нашлось.' : 'Сотрудников нет.'}
        </div>
      )}

      {rows.length > 0 && (
        <div className="bg-card overflow-x-auto rounded-lg border">
          <div className="min-w-[820px]">
            <div
              className={cn(
                GRID_COLS,
                'text-muted-foreground border-b px-4 py-2 text-[11px] font-medium uppercase tracking-wide',
              )}
            >
              <span>Сотрудник</span>
              <span>Статус</span>
              <span className="text-right">В работе</span>
              <span className="text-right">Просрочено</span>
              <span className="text-right">Архив</span>
              <span>Техника</span>
            </div>
            <ul className="divide-y">
              {rows.map((r) => (
                <li key={r.userId}>
                  <Link
                    href={`/staff/${r.userId}`}
                    className={cn(GRID_COLS, 'hover:bg-muted/40 px-4 py-2.5 transition')}
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-medium" title={r.fullName}>
                        {r.fullName}
                      </span>
                      <span className="text-muted-foreground block truncate text-xs">
                        {r.position || ROLE_LABELS_RU[r.role]}
                      </span>
                    </span>

                    <span className="text-xs">
                      {!r.isActive ? (
                        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 font-medium">
                          не работает
                        </span>
                      ) : r.awayToday ? (
                        <span className="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 font-medium">
                          {AWAY_LABELS[r.awayToday.kind]} до{' '}
                          {new Date(`${r.awayToday.dateTo}T00:00:00Z`).toLocaleDateString('ru-RU', {
                            day: 'numeric',
                            month: 'short',
                            timeZone: 'UTC',
                          })}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">на месте</span>
                      )}
                    </span>

                    <span className="text-right font-semibold tabular-nums">{r.openTickets}</span>

                    <span className="text-right">
                      {r.overdueTickets > 0 ? (
                        <span className="text-destructive inline-flex items-center gap-1 text-sm font-medium tabular-nums">
                          <AlertTriangle className="h-3.5 w-3.5" />
                          {r.overdueTickets}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </span>

                    <span
                      className="text-muted-foreground text-right text-sm tabular-nums"
                      title="Незакрытые заявки из прежней системы. В загрузку не входят."
                    >
                      {r.archiveOpenTickets > 0 ? r.archiveOpenTickets : '—'}
                    </span>

                    <span className="text-muted-foreground min-w-0 truncate text-xs">
                      {r.skills.length > 0 ? (
                        r.skills.join(', ')
                      ) : (
                        <span
                          className={cn(
                            r.role === 'engineer' && 'text-amber-600 dark:text-amber-500',
                          )}
                        >
                          {r.role === 'engineer' ? 'техника не указана' : '—'}
                        </span>
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <p className="text-muted-foreground text-xs">
          {awayText(rows.filter((r) => r.awayToday).length)}
        </p>
      )}
    </div>
  );
}
