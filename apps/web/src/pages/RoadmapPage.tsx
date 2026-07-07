/**
 * Дорожная карта — цели компании по кварталам (директор).
 * Карточки с прогресс-баром target/current, отметка «выполнено», inline-добавление.
 */
import { useMemo, useState } from 'react';
import { CheckCircle2, Circle, Map as MapIcon, Plus, Trash2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

type Quarter = 'Q1' | 'Q2' | 'Q3' | 'Q4';
type Category = 'revenue' | 'clients' | 'processes' | 'team' | 'product';
type Priority = 'high' | 'medium' | 'low';

const CATEGORY_META: Record<Category, { label: string; variant: StatusBadgeVariant }> = {
  revenue: { label: 'Выручка', variant: 'success' },
  clients: { label: 'Клиенты', variant: 'info' },
  processes: { label: 'Процессы', variant: 'muted' },
  team: { label: 'Команда', variant: 'warning' },
  product: { label: 'Продукт', variant: 'info' },
};

const PRIORITY_LABEL: Record<Priority, string> = {
  high: 'Высокий',
  medium: 'Средний',
  low: 'Низкий',
};

const QUARTERS: Quarter[] = ['Q1', 'Q2', 'Q3', 'Q4'];

interface Goal {
  id: string;
  quarter: Quarter;
  year: number;
  title: string;
  description: string | null;
  targetValue: number | null;
  currentValue: number | null;
  unit: string | null;
  category: Category;
  priority: Priority;
  isDone: boolean;
}

export function RoadmapPage() {
  const utils = trpc.useUtils();
  const currentYear = new Date().getFullYear();
  const [year, setYear] = useState(currentYear);
  const [formOpen, setFormOpen] = useState(false);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const list = trpc.roadmap.list.useQuery({ year });
  const invalidate = () => utils.roadmap.list.invalidate();

  const create = trpc.roadmap.create.useMutation({
    onSuccess: async () => {
      setFormOpen(false);
      setError(null);
      await invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const update = trpc.roadmap.update.useMutation({
    onSuccess: invalidate,
    onError: (e) => setError(e.message),
  });
  const archive = trpc.roadmap.archive.useMutation({
    onSuccess: async () => {
      setArchiveId(null);
      await invalidate();
    },
    onError: (e) => {
      setArchiveId(null);
      setError(e.message);
    },
  });

  const goals = (list.data ?? []) as Goal[];
  const byQuarter = useMemo(() => {
    const map = new Map<Quarter, Goal[]>();
    for (const q of QUARTERS) map.set(q, []);
    for (const g of goals) map.get(g.quarter)!.push(g);
    return map;
  }, [goals]);

  const doneCount = goals.filter((g) => g.isDone).length;

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <MapIcon className="h-3.5 w-3.5" />
            Дорожная карта
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Цели компании · {year}</h1>
          <p className="text-muted-foreground text-sm">
            {goals.length > 0
              ? `Выполнено ${doneCount} из ${goals.length}`
              : 'Поставьте цели на кварталы — выручка, клиенты, процессы'}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={year}
            onChange={(e) => setYear(Number(e.target.value))}
            className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          >
            {[currentYear - 1, currentYear, currentYear + 1].map((y) => (
              <option key={y} value={y}>
                {y}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => setFormOpen((v) => !v)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Новая цель
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
          {error}
        </div>
      )}

      {formOpen && (
        <GoalForm
          year={year}
          pending={create.isPending}
          onCancel={() => setFormOpen(false)}
          onSubmit={(values) => create.mutate(values)}
        />
      )}

      {list.isLoading ? (
        <p className="text-muted-foreground text-sm">Загрузка…</p>
      ) : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2 xl:grid-cols-4">
          {QUARTERS.map((q) => {
            const items = byQuarter.get(q)!;
            return (
              <section key={q} className="space-y-2">
                <h2 className="text-muted-foreground text-xs font-semibold uppercase tracking-wide">
                  {q} · {year} <span className="ml-1">({items.length})</span>
                </h2>
                {items.length === 0 ? (
                  <div className="text-muted-foreground rounded-lg border border-dashed p-4 text-center text-xs">
                    Нет целей
                  </div>
                ) : (
                  items.map((g) => (
                    <GoalCard
                      key={g.id}
                      goal={g}
                      onToggleDone={() => update.mutate({ id: g.id, patch: { isDone: !g.isDone } })}
                      onProgress={(v) => update.mutate({ id: g.id, patch: { currentValue: v } })}
                      onArchive={() => setArchiveId(g.id)}
                    />
                  ))
                )}
              </section>
            );
          })}
        </div>
      )}

      <ConfirmDialog
        open={!!archiveId}
        title="Удалить цель?"
        description="Цель будет скрыта (мягкое удаление)."
        confirmText="Удалить"
        variant="danger"
        loading={archive.isPending}
        onConfirm={() => archiveId && archive.mutate({ id: archiveId })}
        onCancel={() => setArchiveId(null)}
      />
    </div>
  );
}

function GoalCard({
  goal,
  onToggleDone,
  onProgress,
  onArchive,
}: {
  goal: Goal;
  onToggleDone: () => void;
  onProgress: (v: number) => void;
  onArchive: () => void;
}) {
  const cat = CATEGORY_META[goal.category];
  const pct =
    goal.targetValue && goal.targetValue > 0
      ? Math.min(100, Math.round(((goal.currentValue ?? 0) / goal.targetValue) * 100))
      : null;
  return (
    <div className={'bg-card rounded-lg border p-3 ' + (goal.isDone ? 'opacity-70' : '')}>
      <div className="flex items-start justify-between gap-2">
        <button
          type="button"
          onClick={onToggleDone}
          className="mt-0.5 shrink-0"
          aria-label={goal.isDone ? 'Снять отметку' : 'Отметить выполненной'}
          title={goal.isDone ? 'Снять отметку' : 'Отметить выполненной'}
        >
          {goal.isDone ? (
            <CheckCircle2 className="text-success h-4.5 w-4.5 h-5 w-5" />
          ) : (
            <Circle className="text-muted-foreground hover:text-foreground h-5 w-5" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <div className={'text-sm font-medium ' + (goal.isDone ? 'line-through' : '')}>
            {goal.title}
          </div>
          {goal.description && (
            <p className="text-muted-foreground mt-0.5 text-xs">{goal.description}</p>
          )}
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <StatusBadge variant={cat.variant} compact>
              {cat.label}
            </StatusBadge>
            {goal.priority === 'high' && (
              <StatusBadge variant="danger" compact>
                {PRIORITY_LABEL[goal.priority]}
              </StatusBadge>
            )}
          </div>
          {pct !== null && (
            <div className="mt-2">
              <div className="text-muted-foreground flex justify-between text-[11px] tabular-nums">
                <span>
                  {formatNum(goal.currentValue ?? 0)} / {formatNum(goal.targetValue!)}
                  {goal.unit ? ` ${goal.unit}` : ''}
                </span>
                <span>{pct}%</span>
              </div>
              <div className="bg-muted mt-1 h-1.5 overflow-hidden rounded-full">
                <div
                  className={'h-full rounded-full ' + (pct >= 100 ? 'bg-success' : 'bg-primary')}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <input
                type="range"
                min={0}
                max={goal.targetValue!}
                value={goal.currentValue ?? 0}
                onChange={(e) => onProgress(Number(e.target.value))}
                className="mt-1 w-full"
                aria-label="Текущий прогресс"
              />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onArchive}
          aria-label="Удалить цель"
          title="Удалить"
          className="text-muted-foreground hover:text-destructive shrink-0"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function GoalForm({
  year,
  pending,
  onCancel,
  onSubmit,
}: {
  year: number;
  pending: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    quarter: Quarter;
    year: number;
    title: string;
    description: string | null;
    targetValue: number | null;
    currentValue: number | null;
    unit: string | null;
    category: Category;
    priority: Priority;
  }) => void;
}) {
  const [quarter, setQuarter] = useState<Quarter>('Q1');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [target, setTarget] = useState('');
  const [unit, setUnit] = useState('');
  const [category, setCategory] = useState<Category>('revenue');
  const [priority, setPriority] = useState<Priority>('medium');

  const inputCls =
    'bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2';

  return (
    <div className="bg-card space-y-3 rounded-lg border p-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Цель, например: Выручка 5 млн"
          className={inputCls + ' sm:col-span-2'}
        />
        <select value={quarter} onChange={(e) => setQuarter(e.target.value as Quarter)} className={inputCls}>
          {QUARTERS.map((q) => (
            <option key={q} value={q}>
              {q} {year}
            </option>
          ))}
        </select>
        <select value={category} onChange={(e) => setCategory(e.target.value as Category)} className={inputCls}>
          {(Object.keys(CATEGORY_META) as Category[]).map((c) => (
            <option key={c} value={c}>
              {CATEGORY_META[c].label}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <input
          type="number"
          min="0"
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder="Целевое значение"
          className={inputCls}
        />
        <input
          value={unit}
          onChange={(e) => setUnit(e.target.value)}
          placeholder="Ед.: ₽, шт, %"
          className={inputCls}
        />
        <select value={priority} onChange={(e) => setPriority(e.target.value as Priority)} className={inputCls}>
          {(Object.keys(PRIORITY_LABEL) as Priority[]).map((p) => (
            <option key={p} value={p}>
              Приоритет: {PRIORITY_LABEL[p]}
            </option>
          ))}
        </select>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Описание (опционально)"
          className={inputCls}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm">
          Отмена
        </button>
        <button
          type="button"
          disabled={pending || !title.trim()}
          onClick={() =>
            onSubmit({
              quarter,
              year,
              title: title.trim(),
              description: description.trim() || null,
              targetValue: target.trim() ? Number.parseInt(target, 10) : null,
              currentValue: target.trim() ? 0 : null,
              unit: unit.trim() || null,
              category,
              priority,
            })
          }
          className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {pending ? 'Создание…' : 'Создать цель'}
        </button>
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  return new Intl.NumberFormat('ru-RU').format(n);
}
