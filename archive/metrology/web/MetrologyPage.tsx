/**
 * /metrology — реестр СИ + дашборд поверок.
 * Доступно только директору и диспетчеру.
 *
 * Stage 10'.F MVP. Карточки overdue / soon / total + таблица СИ
 * с фильтром по статусу и поиском.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Gauge,
  Loader2,
  Search,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

type Status = 'overdue' | 'soon' | 'ok' | 'all';

const STATUS_TABS: Array<{ key: Status; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'overdue', label: 'Просрочено' },
  { key: 'soon', label: 'Скоро поверка' },
  { key: 'ok', label: 'В норме' },
];

export function MetrologyPage() {
  const me = trpc.auth.me.useQuery();
  const [status, setStatus] = useState<Status>('all');
  const [search, setSearch] = useState('');

  const dashQ = trpc.metrology.getDashboard.useQuery();
  const listQ = trpc.metrology.listSi.useQuery({
    status,
    search: search.trim() || undefined,
  });

  if (me.data && me.data.user.role !== 'director' && me.data.user.role !== 'dispatcher') {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-lg border p-4 text-sm">
          Раздел доступен только директору и диспетчеру.
        </div>
      </div>
    );
  }

  const stats = dashQ.data;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
      <div>
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
          <Gauge className="h-3.5 w-3.5" />
          Метрология
        </div>
        <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Поверка СИ</h1>
        <p className="text-muted-foreground text-sm">
          Реестр средств измерений и журнал поверок. Уведомления за 30/14/7 дней.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title="Просрочено"
          value={stats?.overdueCount ?? null}
          icon={AlertTriangle}
          tone="destructive"
        />
        <StatCard
          title="Скоро поверка"
          value={stats?.soonCount ?? null}
          icon={Clock}
          tone="warning"
        />
        <StatCard
          title="Всего СИ"
          value={stats?.totalSiCount ?? null}
          icon={CheckCircle2}
          tone="primary"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex flex-wrap rounded-md border p-0.5">
          {STATUS_TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setStatus(t.key)}
              className={cn(
                'rounded-sm px-3 py-1.5 text-xs font-medium transition',
                status === t.key
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="relative ml-auto">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по модели, серийнику, клиенту…"
            className="bg-background w-72 rounded-md border py-1.5 pl-8 pr-3 text-xs outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>

      <SiTable rows={listQ.data} loading={listQ.isLoading} />
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
  icon: typeof Clock;
  tone: 'destructive' | 'warning' | 'primary';
}) {
  const toneCls = useMemo(() => {
    if (tone === 'destructive') return 'bg-destructive/10 text-destructive';
    if (tone === 'warning') return 'bg-warning/15 text-warning';
    return 'bg-primary/10 text-primary';
  }, [tone]);
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

interface SiRow {
  assetId: string;
  assetModel: string;
  assetSerial: string | null;
  ownerClientName: string | null;
  typeName: string;
  accuracyClass: string | null;
  measurementRange: string | null;
  lastCalibrationAt: string | null;
  nextCalibrationAt: string | null;
  status: 'overdue' | 'soon' | 'ok' | 'never';
}

function SiTable({ rows, loading }: { rows: SiRow[] | undefined; loading: boolean }) {
  return (
    <div className="bg-card overflow-hidden rounded-lg border">
      <table className="w-full text-sm">
        <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
          <tr>
            <th className="p-3 text-left font-medium">Тип / модель</th>
            <th className="p-3 text-left font-medium">Серийник</th>
            <th className="p-3 text-left font-medium">Клиент</th>
            <th className="p-3 text-left font-medium">Класс</th>
            <th className="p-3 text-left font-medium">Диапазон</th>
            <th className="p-3 text-left font-medium">Последняя</th>
            <th className="p-3 text-left font-medium">Следующая</th>
            <th className="p-3 text-left font-medium">Статус</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {loading && (
            <tr>
              <td colSpan={8} className="text-muted-foreground p-6 text-center">
                <Loader2 className="mx-auto h-4 w-4 animate-spin" />
              </td>
            </tr>
          )}
          {!loading && rows && rows.length === 0 && (
            <tr>
              <td colSpan={8} className="text-muted-foreground p-6 text-center">
                СИ не найдены. Откройте карточку техники → раздел «Метрология» → «Сделать СИ».
              </td>
            </tr>
          )}
          {rows?.map((r) => (
            <tr key={r.assetId} className="hover:bg-muted/30">
              <td className="p-3">
                <Link
                  href={`/metrology/${r.assetId}`}
                  className="hover:underline"
                >
                  <div className="font-medium">{r.typeName}</div>
                  <div className="text-muted-foreground text-xs">{r.assetModel}</div>
                </Link>
              </td>
              <td className="text-muted-foreground p-3 font-mono text-xs">
                {r.assetSerial ?? '—'}
              </td>
              <td className="p-3 text-xs">{r.ownerClientName ?? '—'}</td>
              <td className="p-3 text-xs">{r.accuracyClass ?? '—'}</td>
              <td className="text-muted-foreground p-3 text-xs">
                {r.measurementRange ?? '—'}
              </td>
              <td className="text-muted-foreground p-3 text-xs tabular-nums">
                {r.lastCalibrationAt ?? '—'}
              </td>
              <td className="p-3 text-xs tabular-nums">
                {r.nextCalibrationAt ?? '—'}
              </td>
              <td className="p-3">
                <StatusBadge status={r.status} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StatusBadge({ status }: { status: 'overdue' | 'soon' | 'ok' | 'never' }) {
  const cfg = {
    overdue: { label: 'Просрочено', cls: 'bg-destructive/10 text-destructive' },
    soon: { label: 'Скоро', cls: 'bg-warning/15 text-warning' },
    ok: { label: 'В норме', cls: 'bg-success/10 text-success' },
    never: { label: 'Без поверок', cls: 'bg-muted text-muted-foreground' },
  }[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-2 py-0.5 text-[10px] font-medium uppercase',
        cfg.cls,
      )}
    >
      {cfg.label}
    </span>
  );
}
