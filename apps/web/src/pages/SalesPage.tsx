/**
 * /sales — раздел продаж. Оболочка: шапка + выбор периода + вкладки «Обзор» | «Список».
 * Период общий для обеих вкладок (по дате продажи). Обзор — аналитика (SalesOverview),
 * Список — реестр продаж (SalesList). Кнопка «Новая продажа» ведёт на /sales/new.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { Link } from 'wouter';
import { BarChart3, List, Plus, ShoppingCart } from 'lucide-react';
import { SalesOverview } from './SalesOverview';
import { SalesList } from './SalesListPage';

type PresetId = 'month' | 'quarter' | 'year' | 'all' | 'custom';
type TabId = 'overview' | 'list';

const PRESETS: Array<{ id: PresetId; label: string }> = [
  { id: 'month', label: 'Месяц' },
  { id: 'quarter', label: 'Квартал' },
  { id: 'year', label: 'Год' },
  { id: 'all', label: 'Всё время' },
];

const MONTHS_FULL = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
];

function isoLocal(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

function computePeriod(
  preset: PresetId,
  customFrom: string,
  customTo: string,
): { from?: string; to?: string } {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  const today = isoLocal(now);
  switch (preset) {
    case 'month':
      return { from: isoLocal(new Date(y, m, 1)), to: today };
    case 'quarter': {
      const q = Math.floor(m / 3);
      return { from: isoLocal(new Date(y, q * 3, 1)), to: today };
    }
    case 'year':
      return { from: isoLocal(new Date(y, 0, 1)), to: today };
    case 'all':
      return {};
    case 'custom':
      return { from: customFrom || undefined, to: customTo || undefined };
  }
}

function periodLabel(preset: PresetId, customFrom: string, customTo: string): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth();
  switch (preset) {
    case 'month':
      return `${MONTHS_FULL[m]} ${y}`;
    case 'quarter':
      return `${Math.floor(m / 3) + 1}-й квартал ${y}`;
    case 'year':
      return `${y} год`;
    case 'all':
      return 'весь период';
    case 'custom':
      return customFrom && customTo ? `${customFrom} — ${customTo}` : 'выбранный период';
  }
}

export function SalesPage() {
  const [tab, setTab] = useState<TabId>('overview');
  const [preset, setPreset] = useState<PresetId>('year');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const period = useMemo(
    () => computePeriod(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );
  const label = periodLabel(preset, customFrom, customTo);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <ShoppingCart className="h-3.5 w-3.5" />
            Продажи
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">
            Продажи запчастей и оборудования
          </h1>
        </div>
        <Link
          href="/sales/new"
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Новая продажа
        </Link>
      </div>

      {/* Период */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="bg-secondary inline-flex rounded-md p-0.5">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              type="button"
              onClick={() => setPreset(p.id)}
              className={
                'rounded px-2.5 py-1 text-sm font-medium transition ' +
                (preset === p.id
                  ? 'bg-background shadow-sm'
                  : 'text-muted-foreground hover:text-foreground')
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1.5">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => {
              setCustomFrom(e.target.value);
              setPreset('custom');
            }}
            className="bg-background focus:ring-primary/40 rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
            title="Начало периода"
          />
          <span className="text-muted-foreground text-xs">—</span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => {
              setCustomTo(e.target.value);
              setPreset('custom');
            }}
            className="bg-background focus:ring-primary/40 rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
            title="Конец периода"
          />
        </div>
      </div>

      {/* Вкладки */}
      <div className="border-b">
        <div className="-mb-px flex gap-1">
          <TabButton
            active={tab === 'overview'}
            onClick={() => setTab('overview')}
            icon={BarChart3}
          >
            Обзор
          </TabButton>
          <TabButton active={tab === 'list'} onClick={() => setTab('list')} icon={List}>
            Список
          </TabButton>
        </div>
      </div>

      {tab === 'overview' ? (
        <SalesOverview period={period} periodLabel={label} />
      ) : (
        <SalesList period={period} />
      )}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  icon: Icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof BarChart3;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ' +
        (active
          ? 'border-primary text-foreground'
          : 'text-muted-foreground hover:text-foreground border-transparent')
      }
    >
      <Icon className="h-4 w-4" />
      {children}
    </button>
  );
}
