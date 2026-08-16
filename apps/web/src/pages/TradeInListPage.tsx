/**
 * Трейд-ин — реестр принятой б/у техники + KPI (вложено/продано/маржа).
 * «Продано» — через PromptDialog с ценой продажи (complete переносит владельца
 * привязанной техники на покупателя, см. server modules/trade-in).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import { BadgeCheck, Plus, Recycle, Search, Trash2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { useDebounce } from '../lib/hooks/useDebounce';
import { formatRub, parseRubToKopecks } from '../lib/money';
import { showToast } from '../lib/toast';
import { DataTable, type Column } from '../components/ui/DataTable';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { PromptDialog } from '../components/ui/PromptDialog';

type TradeInStatus = 'received' | 'assessed' | 'in_stock' | 'sold' | 'scrapped';
type TradeInCondition = 'excellent' | 'good' | 'fair' | 'poor';

const STATUS_META: Record<TradeInStatus, { label: string; variant: StatusBadgeVariant }> = {
  received: { label: 'Принята', variant: 'muted' },
  assessed: { label: 'Оценена', variant: 'info' },
  in_stock: { label: 'На складе', variant: 'warning' },
  sold: { label: 'Продана', variant: 'success' },
  scrapped: { label: 'Утилизация', variant: 'danger' },
};

const CONDITION_LABEL: Record<TradeInCondition, string> = {
  excellent: 'Отличное',
  good: 'Хорошее',
  fair: 'Среднее',
  poor: 'Плохое',
};

const STATUS_OPTIONS: Array<{ value: TradeInStatus | ''; label: string }> = [
  { value: '', label: 'Все статусы' },
  ...(Object.keys(STATUS_META) as TradeInStatus[]).map((s) => ({
    value: s,
    label: STATUS_META[s].label,
  })),
];

interface TradeInRow {
  id: string;
  name: string;
  manufacturer: string | null;
  model: string | null;
  serialNumber: string | null;
  condition: TradeInCondition;
  status: TradeInStatus;
  clientId: string | null;
  clientDisplayName: string | null;
  buyerClientId: string | null;
  buyerDisplayName: string | null;
  purchasePriceKopecks: string;
  assessedPriceKopecks: string;
  salePriceKopecks: string | null;
  marginKopecks: string | null;
  receivedAt: string;
  soldAt: string | null;
}

const PAGE_SIZE = 25;

export function TradeInListPage() {
  const utils = trpc.useUtils();
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [status, setStatus] = useState<TradeInStatus | ''>('');
  const [page, setPage] = useState(1);
  const [completeId, setCompleteId] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const list = trpc.tradeIn.list.useQuery({
    search: debounced || undefined,
    status: status || undefined,
    page,
  });
  const stats = trpc.tradeIn.stats.useQuery();

  const invalidate = () =>
    Promise.all([utils.tradeIn.list.invalidate(), utils.tradeIn.stats.invalidate()]);

  const complete = trpc.tradeIn.complete.useMutation({
    onSuccess: async () => {
      setCompleteId(null);
      setActionError(null);
      await invalidate();
    },
    onError: (e) => {
      setCompleteId(null);
      setActionError(e.message);
    },
  });
  const archive = trpc.tradeIn.archive.useMutation({
    onSuccess: async () => {
      setArchiveId(null);
      await invalidate();
    },
    onError: (e) => {
      setArchiveId(null);
      setActionError(e.message);
    },
  });

  const items = (list.data?.items ?? []) as TradeInRow[];
  const total = list.data?.total ?? 0;

  const columns: Column<TradeInRow>[] = [
    {
      key: 'name',
      label: 'Позиция',
      render: (t) => (
        <div className="min-w-0">
          <Link
            href={`/trade-in/${t.id}/edit`}
            className="text-foreground hover:text-primary font-medium"
          >
            {t.name}
          </Link>
          <div className="text-muted-foreground text-xs">
            {[t.manufacturer, t.model].filter(Boolean).join(' ')}
            {t.serialNumber && <span className="font-mono"> · s/n {t.serialNumber}</span>}
          </div>
        </div>
      ),
    },
    {
      key: 'condition',
      label: 'Состояние',
      className: 'text-xs',
      render: (t) => CONDITION_LABEL[t.condition],
    },
    {
      key: 'parties',
      label: 'Сдал → купил',
      className: 'text-xs',
      render: (t) => (
        <div>
          {t.clientId ? (
            <Link
              href={`/clients/${t.clientId}`}
              className="text-muted-foreground hover:text-primary"
            >
              {t.clientDisplayName}
            </Link>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
          {t.buyerClientId && (
            <div>
              →{' '}
              <Link
                href={`/clients/${t.buyerClientId}`}
                className="text-muted-foreground hover:text-primary"
              >
                {t.buyerDisplayName}
              </Link>
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'money',
      label: 'Зачтено / оценка / продажа',
      className: 'text-xs tabular-nums',
      render: (t) => (
        <div>
          {formatRub(t.purchasePriceKopecks)} / {formatRub(t.assessedPriceKopecks)}
          {t.salePriceKopecks && (
            <div className="font-medium">
              {formatRub(t.salePriceKopecks)}
              {t.marginKopecks && (
                <span
                  className={
                    BigInt(t.marginKopecks) >= 0n ? 'text-success ml-1' : 'text-destructive ml-1'
                  }
                >
                  ({BigInt(t.marginKopecks) >= 0n ? '+' : ''}
                  {formatRub(t.marginKopecks)})
                </span>
              )}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'received',
      label: 'Принята',
      className: 'text-xs tabular-nums',
      render: (t) => formatDate(t.receivedAt),
    },
    {
      key: 'status',
      label: 'Статус',
      render: (t) => {
        const meta = STATUS_META[t.status];
        return <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>;
      },
    },
    {
      key: 'actions',
      label: '',
      className: 'w-24',
      render: (t) => (
        <div className="flex items-center justify-end gap-1">
          {t.status !== 'sold' && t.status !== 'scrapped' && (
            <button
              type="button"
              onClick={() => {
                setActionError(null);
                setCompleteId(t.id);
              }}
              aria-label="Продано"
              title={
                t.buyerClientId
                  ? 'Завершить сделку (продано)'
                  : 'Сначала укажите покупателя в позиции'
              }
              className="text-muted-foreground hover:text-success hover:bg-muted grid h-7 w-7 place-items-center rounded"
            >
              <BadgeCheck className="h-3.5 w-3.5" />
            </button>
          )}
          <button
            type="button"
            onClick={() => setArchiveId(t.id)}
            aria-label="Архивировать"
            title="Архивировать"
            className="text-muted-foreground hover:text-destructive hover:bg-muted grid h-7 w-7 place-items-center rounded"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Recycle className="h-3.5 w-3.5" />
            Трейд-ин
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Б/у техника в зачёт</h1>
          <p className="text-muted-foreground text-sm">
            Приём, оценка и перепродажа техники; продажа переносит владельца в парке
          </p>
        </div>
        <Link
          href="/trade-in/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Принять технику
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Kpi
          label="На складе (шт)"
          value={
            stats.data
              ? String(stats.data.received + stats.data.assessed + stats.data.inStock)
              : '—'
          }
        />
        <Kpi label="Вложено" value={stats.data ? formatRub(stats.data.investedKopecks) : '—'} />
        <Kpi
          label="Продано (выручка)"
          value={stats.data ? formatRub(stats.data.soldRevenueKopecks) : '—'}
        />
        <Kpi
          label="Маржа по проданным"
          value={stats.data ? formatRub(stats.data.soldMarginKopecks) : '—'}
          tone={stats.data && BigInt(stats.data.soldMarginKopecks) < 0n ? 'danger' : undefined}
        />
      </div>

      {actionError && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
          {actionError}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[200px] flex-1">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Поиск по названию, модели, s/n, клиенту"
            className="bg-background focus:ring-primary/40 w-full rounded-md border py-2 pl-8 pr-3 text-sm outline-none focus:ring-2"
          />
        </div>
        <select
          value={status}
          onChange={(e) => {
            setStatus(e.target.value as TradeInStatus | '');
            setPage(1);
          }}
          className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
        >
          {STATUS_OPTIONS.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>

      <DataTable
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Позиций трейд-ина нет"
        rowKey={(t) => t.id}
      />

      <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />

      <PromptDialog
        open={!!completeId}
        title="Завершить сделку?"
        description="Позиция станет «Продана». Если к ней привязана техника из парка — владелец будет перенесён на покупателя."
        label="Цена продажи, ₽ (можно пусто)"
        placeholder="например: 120 000"
        confirmText="Продано"
        loading={complete.isPending}
        onConfirm={(v) => {
          if (!completeId) return;
          const raw = v.trim();
          // Пусто — сделка закрывается без цены, так и задумано.
          if (!raw) {
            complete.mutate({ id: completeId, salePriceKopecks: undefined });
            return;
          }
          const kopecks = parseRubToKopecks(raw);
          // Раньше здесь стоял parseFloat, и «120 000» молча превращалось в 120 ₽.
          // Непонятную цену теперь не сохраняем вовсе — человек поправит ввод.
          if (kopecks === null || kopecks <= 0) {
            showToast('error', 'Цену продажи не понял. Введите число, например: 120 000');
            return;
          }
          complete.mutate({ id: completeId, salePriceKopecks: kopecks });
        }}
        onCancel={() => setCompleteId(null)}
      />
      <ConfirmDialog
        open={!!archiveId}
        title="Архивировать позицию?"
        description="Позиция будет скрыта из реестра (мягкое удаление)."
        confirmText="Архивировать"
        variant="danger"
        loading={archive.isPending}
        onConfirm={() => archiveId && archive.mutate({ id: archiveId })}
        onCancel={() => setArchiveId(null)}
      />
    </div>
  );
}

function Kpi({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="bg-card rounded-lg border p-3">
      <div className="text-muted-foreground text-xs">{label}</div>
      <div
        className={`mt-1 text-lg font-semibold tabular-nums ${tone === 'danger' ? 'text-destructive' : ''}`}
      >
        {value}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}
