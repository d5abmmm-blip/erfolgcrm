/**
 * /staff — список сотрудников с текущей загрузкой.
 *
 * Главный вопрос экрана: кому отдать заявку прямо сейчас. Поэтому на виду — сколько
 * у человека незакрытых заявок, сколько из них просрочено, отсутствует ли он сегодня
 * и с какой техникой умеет работать.
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
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((r) => (
            <Link
              key={r.userId}
              href={`/staff/${r.userId}`}
              className="bg-card hover:border-primary/50 block rounded-lg border p-4 transition hover:shadow-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate font-medium" title={r.fullName}>
                    {r.fullName}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {r.position || ROLE_LABELS_RU[r.role]}
                    {!r.isActive && ' · не работает'}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-lg font-semibold tabular-nums leading-none">
                    {r.openTickets}
                  </div>
                  <div className="text-muted-foreground text-[10px] uppercase tracking-wide">
                    в работе
                  </div>
                </div>
              </div>

              <div className="mt-3 flex flex-wrap items-center gap-1.5">
                {r.overdueTickets > 0 && (
                  <span className="text-destructive bg-destructive/10 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium">
                    <AlertTriangle className="h-3 w-3" />
                    просрочено {r.overdueTickets}
                  </span>
                )}
                {r.awayToday && (
                  <span className="bg-secondary text-secondary-foreground rounded px-1.5 py-0.5 text-[11px] font-medium">
                    {AWAY_LABELS[r.awayToday.kind]} до{' '}
                    {new Date(`${r.awayToday.dateTo}T00:00:00Z`).toLocaleDateString('ru-RU', {
                      day: 'numeric',
                      month: 'short',
                      timeZone: 'UTC',
                    })}
                  </span>
                )}
                {r.archiveOpenTickets > 0 && (
                  <span
                    className="text-muted-foreground rounded border px-1.5 py-0.5 text-[11px]"
                    title="Незакрытые заявки из прежней системы. В загрузку не входят."
                  >
                    архив {r.archiveOpenTickets}
                  </span>
                )}
              </div>

              <div className="text-muted-foreground mt-2 truncate text-xs">
                {r.skills.length > 0 ? (
                  r.skills.join(', ')
                ) : (
                  <span
                    className={cn(r.role === 'engineer' && 'text-amber-600 dark:text-amber-500')}
                  >
                    {r.role === 'engineer' ? 'техника не указана' : '—'}
                  </span>
                )}
              </div>
            </Link>
          ))}
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
