/**
 * /settings/audit — журнал действий пользователей.
 *
 * 152-ФЗ требует, чтобы директор мог просмотреть кто и когда что изменил.
 * События уже пишутся через writeAudit во всех мутациях. Этот UI — только чтение,
 * с фильтрами и keyset-пагинацией (по убыванию ts).
 */
import { Fragment, useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  Activity,
  ChevronDown,
  ChevronRight,
  History,
  Loader2,
  Search,
  ShieldAlert,
  Users,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { QueryErrorRow } from '../components/QueryError';

type Action =
  | 'create'
  | 'update'
  | 'delete'
  | 'restore'
  | 'login'
  | 'logout'
  | 'login_failed'
  | 'password_changed'
  | 'role_changed'
  | 'export'
  | 'consent_given'
  | 'consent_revoked';

const ACTION_LABEL: Record<Action, string> = {
  create: 'Создание',
  update: 'Изменение',
  delete: 'Удаление',
  restore: 'Восстановление',
  login: 'Вход',
  logout: 'Выход',
  login_failed: 'Ошибка входа',
  password_changed: 'Смена пароля',
  role_changed: 'Смена роли',
  export: 'Экспорт',
  consent_given: 'Согласие дано',
  consent_revoked: 'Согласие отозвано',
};

const ACTION_TONE: Record<Action, string> = {
  create: 'bg-success/10 text-success',
  update: 'bg-primary/10 text-primary',
  delete: 'bg-destructive/10 text-destructive',
  restore: 'bg-secondary text-secondary-foreground',
  login: 'bg-muted text-muted-foreground',
  logout: 'bg-muted text-muted-foreground',
  login_failed: 'bg-destructive/10 text-destructive',
  password_changed: 'bg-warning/15 text-warning',
  role_changed: 'bg-warning/15 text-warning',
  export: 'bg-secondary text-secondary-foreground',
  consent_given: 'bg-success/10 text-success',
  consent_revoked: 'bg-destructive/10 text-destructive',
};

const ENTITY_LABEL: Record<string, string> = {
  user: 'Пользователь',
  client: 'Клиент',
  asset: 'Техника',
  ticket: 'Заявка',
  work_order: 'Наряд',
  inventory_item: 'Номенклатура',
  inventory_batch: 'Партия',
  contract: 'Договор',
  invoice: 'Счёт',
  payment: 'Оплата',
  attachment: 'Файл',
  payroll_period: 'Период ЗП',
  payroll_rule: 'Правило ЗП',
  telegram_config: 'Telegram',
  onec_config: '1С обмен',
  session: 'Сессия',
  ticket_template: 'Шаблон заявки',
  ticket_template_apply: 'Применение шаблона',
  kb_article: 'Статья базы знаний',
};

const PAGE_SIZE = 50;

interface FiltersState {
  actions: Action[];
  entityTypes: string[];
  userId: string | null;
  dateFrom: string;
  dateTo: string;
  search: string;
}

const EMPTY_FILTERS: FiltersState = {
  actions: [],
  entityTypes: [],
  userId: null,
  dateFrom: '',
  dateTo: '',
  search: '',
};

export function AuditLogPage() {
  const me = trpc.auth.me.useQuery();
  const [filters, setFilters] = useState<FiltersState>(EMPTY_FILTERS);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const statsQ = trpc.audit.stats.useQuery(undefined, { enabled: me.data?.user.role === 'director' });
  const entityTypesQ = trpc.audit.entityTypes.useQuery(undefined, {
    enabled: me.data?.user.role === 'director',
  });
  const usersQ = trpc.users.list.useQuery({ includeBlocked: true }, {
    enabled: me.data?.user.role === 'director',
  });

  const queryInput = useMemo(
    () => ({
      actions: filters.actions.length > 0 ? filters.actions : undefined,
      entityTypes: filters.entityTypes.length > 0 ? filters.entityTypes : undefined,
      userId: filters.userId ?? undefined,
      dateFrom: filters.dateFrom || undefined,
      dateTo: filters.dateTo || undefined,
      search: filters.search.trim() || undefined,
      limit: PAGE_SIZE,
    }),
    [filters],
  );

  const listQ = trpc.audit.list.useQuery(queryInput, {
    enabled: me.data?.user.role === 'director',
  });

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (me.data?.user.role !== 'director') {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-lg border p-4 text-sm">
          Раздел доступен только директору.
        </div>
      </div>
    );
  }

  const stats = statsQ.data;
  const rows = listQ.data?.rows ?? [];
  const hasMore = listQ.data?.nextCursor != null;

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const reset = () => setFilters(EMPTY_FILTERS);
  const hasFilters =
    filters.actions.length > 0 ||
    filters.entityTypes.length > 0 ||
    filters.userId !== null ||
    filters.dateFrom !== '' ||
    filters.dateTo !== '' ||
    filters.search.trim() !== '';

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div>
        <Link href="/settings" className="text-primary text-sm hover:underline">
          ← Настройки
        </Link>
        <div className="mt-2">
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <History className="h-3.5 w-3.5" />
            Журнал действий
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Аудит</h1>
          <p className="text-muted-foreground text-sm">
            Полный журнал изменений в системе. Хранится 5 лет (152-ФЗ).
            Записи нельзя редактировать или удалять.
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title="Событий за 24 часа"
          value={stats?.last24hCount ?? null}
          icon={Activity}
          tone="primary"
        />
        <StatCard
          title="За 7 дней"
          value={stats?.last7dCount ?? null}
          icon={Users}
          tone="secondary"
        />
        <StatCard
          title="Неуспешных входов (24ч)"
          value={stats?.failedLoginsLast24h ?? null}
          icon={ShieldAlert}
          tone={stats && stats.failedLoginsLast24h > 0 ? 'destructive' : 'muted'}
        />
      </div>

      <div className="bg-card space-y-3 rounded-lg border p-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-4">
          <div>
            <label className="text-muted-foreground mb-1 block text-xs">Действие</label>
            <select
              value={filters.actions[0] ?? ''}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  actions: e.target.value ? [e.target.value as Action] : [],
                }))
              }
              className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
            >
              <option value="">Любое</option>
              {(Object.keys(ACTION_LABEL) as Action[]).map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABEL[a]}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-muted-foreground mb-1 block text-xs">Объект</label>
            <select
              value={filters.entityTypes[0] ?? ''}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  entityTypes: e.target.value ? [e.target.value] : [],
                }))
              }
              className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
            >
              <option value="">Любой</option>
              {(entityTypesQ.data ?? []).map((t) => (
                <option key={t} value={t}>
                  {ENTITY_LABEL[t] ?? t}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-muted-foreground mb-1 block text-xs">Пользователь</label>
            <select
              value={filters.userId ?? ''}
              onChange={(e) =>
                setFilters((f) => ({ ...f, userId: e.target.value || null }))
              }
              className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
            >
              <option value="">Все</option>
              {(usersQ.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName} ({u.username})
                </option>
              ))}
            </select>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">С</label>
              <input
                type="date"
                value={filters.dateFrom}
                onChange={(e) => setFilters((f) => ({ ...f, dateFrom: e.target.value }))}
                className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-muted-foreground mb-1 block text-xs">По</label>
              <input
                type="date"
                value={filters.dateTo}
                onChange={(e) => setFilters((f) => ({ ...f, dateTo: e.target.value }))}
                className="bg-background w-full rounded-md border px-2 py-1.5 text-sm"
              />
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
            <input
              type="search"
              value={filters.search}
              onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
              placeholder="Поиск по ID объекта, IP или User-Agent…"
              className="bg-background w-full rounded-md border py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          {hasFilters && (
            <button
              type="button"
              onClick={reset}
              className="text-muted-foreground hover:text-foreground text-xs underline-offset-4 hover:underline"
            >
              Сбросить
            </button>
          )}
        </div>
      </div>

      <div className="bg-card overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
            <tr>
              <th className="w-8 p-2"></th>
              <th className="p-3 text-left font-medium">Когда</th>
              <th className="p-3 text-left font-medium">Кто</th>
              <th className="p-3 text-left font-medium">Действие</th>
              <th className="p-3 text-left font-medium">Объект</th>
              <th className="p-3 text-left font-medium">ID объекта</th>
              <th className="p-3 text-left font-medium">IP</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {listQ.isLoading && (
              <tr>
                <td colSpan={7} className="text-muted-foreground p-6 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            )}
            {/* Без этой строки сбой загрузки выглядел как «Событий нет» — то есть
                журнал нарушений сам себе выдавал справку, что нарушений не было. */}
            <QueryErrorRow
              error={listQ.error}
              paused={listQ.fetchStatus === 'paused'}
              what="журнал действий"
              colSpan={7}
              onRetry={() => void listQ.refetch()}
            />
            {!listQ.isLoading && !listQ.error && listQ.fetchStatus !== 'paused' && rows.length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted-foreground p-6 text-center">
                  Событий нет.
                </td>
              </tr>
            )}
            {rows.map((r) => {
              const isOpen = expanded.has(r.id);
              const tone = ACTION_TONE[r.action] ?? 'bg-muted text-muted-foreground';
              return (
                <Fragment key={r.id}>
                  <tr
                    className="hover:bg-muted/30 cursor-pointer"
                    onClick={() => toggleExpand(r.id)}
                  >
                    <td className="p-2 text-muted-foreground">
                      {isOpen ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                    </td>
                    <td className="p-3 text-xs tabular-nums">
                      {formatTs(r.ts)}
                    </td>
                    <td className="p-3 text-xs">
                      {r.userName ? (
                        <>
                          <div className="font-medium">{r.userName}</div>
                          {r.userRole && (
                            <div className="text-muted-foreground">{r.userRole}</div>
                          )}
                        </>
                      ) : (
                        <span className="text-muted-foreground italic">система</span>
                      )}
                    </td>
                    <td className="p-3">
                      <span
                        className={cn(
                          'inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium uppercase',
                          tone,
                        )}
                      >
                        {ACTION_LABEL[r.action] ?? r.action}
                      </span>
                    </td>
                    <td className="p-3 text-xs">
                      {ENTITY_LABEL[r.entityType] ?? r.entityType}
                    </td>
                    <td className="text-muted-foreground p-3 font-mono text-[11px]">
                      {r.entityId ? r.entityId.slice(0, 8) + '…' : '—'}
                    </td>
                    <td className="text-muted-foreground p-3 font-mono text-[11px]">
                      {r.ip ?? '—'}
                    </td>
                  </tr>
                  {isOpen && (
                    <tr className="bg-muted/20">
                      <td colSpan={7} className="p-4">
                        <DetailView row={r} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>

        {hasMore && (
          <div className="border-t p-3 text-center">
            <p className="text-muted-foreground text-xs">
              Показано первые {PAGE_SIZE} событий. Уточните фильтр для более точной выборки.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function formatTs(ts: Date | string): string {
  const d = typeof ts === 'string' ? new Date(ts) : ts;
  return new Intl.DateTimeFormat('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

interface DetailRow {
  id: string;
  before: unknown;
  after: unknown;
  context: unknown;
  userAgent: string | null;
  entityId: string | null;
  ip: string | null;
}

function DetailView({ row }: { row: DetailRow }) {
  return (
    <div className="grid grid-cols-1 gap-4 text-xs md:grid-cols-2">
      {row.entityId && (
        <div className="md:col-span-2">
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
            ID объекта (полный)
          </div>
          <div className="font-mono break-all">{row.entityId}</div>
        </div>
      )}
      {row.before != null && (
        <div>
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
            До
          </div>
          <pre className="bg-background overflow-x-auto rounded border p-2 text-[11px]">
            {JSON.stringify(row.before, null, 2)}
          </pre>
        </div>
      )}
      {row.after != null && (
        <div>
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
            После
          </div>
          <pre className="bg-background overflow-x-auto rounded border p-2 text-[11px]">
            {JSON.stringify(row.after, null, 2)}
          </pre>
        </div>
      )}
      {row.context != null && (
        <div className="md:col-span-2">
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
            Контекст
          </div>
          <pre className="bg-background overflow-x-auto rounded border p-2 text-[11px]">
            {JSON.stringify(row.context, null, 2)}
          </pre>
        </div>
      )}
      {row.userAgent && (
        <div className="md:col-span-2">
          <div className="text-muted-foreground mb-1 text-[10px] uppercase tracking-wide">
            User-Agent
          </div>
          <div className="break-all">{row.userAgent}</div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
  tone,
}: {
  title: string;
  value: number | null;
  icon: typeof Activity;
  tone: 'primary' | 'secondary' | 'destructive' | 'muted';
}) {
  const toneCls =
    tone === 'destructive'
      ? 'bg-destructive/10 text-destructive'
      : tone === 'primary'
        ? 'bg-primary/10 text-primary'
        : tone === 'secondary'
          ? 'bg-secondary text-secondary-foreground'
          : 'bg-muted text-muted-foreground';
  return (
    <div className="bg-card flex items-center gap-3 rounded-lg border p-4">
      <div className={cn('grid h-10 w-10 place-items-center rounded-md', toneCls)}>
        <Icon className="h-5 w-5" />
      </div>
      <div>
        <div className="text-muted-foreground text-xs uppercase tracking-wide">{title}</div>
        <div className="text-2xl font-semibold tabular-nums">
          {value === null ? <Loader2 className="h-5 w-5 animate-spin" /> : value}
        </div>
      </div>
    </div>
  );
}
