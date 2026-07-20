import { useState } from 'react';
import { X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { AssetPicker } from './AssetPicker';

interface Props {
  onClose: () => void;
  onSaved: () => void;
}

export function MaintenanceScheduleForm({ onClose, onSaved }: Props) {
  const [assetId, setAssetId] = useState<string | null>(null);
  const [kind, setKind] = useState<'planned' | 'urgent'>('planned');
  const [intervalDays, setIntervalDays] = useState('180');
  // Дата последнего фактического ТО. Пусто — считаем от сегодня.
  const [lastDone, setLastDone] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = trpc.maintenance.createSchedule.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!assetId) {
      setError('Выберите технику');
      return;
    }
    const days = Math.max(1, Math.round(Number(intervalDays) || 0));
    // Сервер считает срок следующего ТО как startAt + интервал. Раньше форма
    // это поле не слала вовсе, поэтому график всегда начинался «от сегодня»:
    // завести его на аппарат, который обслуживали в марте, было невозможно.
    const startAt = lastDone ? new Date(`${lastDone}T00:00:00`) : undefined;
    if (startAt && Number.isNaN(startAt.getTime())) {
      setError('Проверьте дату последнего ТО');
      return;
    }
    create.mutate({
      assetId,
      kind,
      intervalDays: days,
      startAt,
      notes: notes.trim() || null,
    });
  };

  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Создать график ТО</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={submit} className="space-y-3 p-4">
          <Field label="Техника" required>
            <AssetPicker
              value={assetId}
              onChange={(id) => setAssetId(id || null)}
            />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Тип">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as 'planned' | 'urgent')}
                className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
              >
                <option value="planned">Плановое</option>
                <option value="urgent">Срочное</option>
              </select>
            </Field>
            <Field label="Интервал, дней" required>
              <input
                type="number"
                step="1"
                min="1"
                value={intervalDays}
                onChange={(e) => setIntervalDays(e.target.value)}
                required
                className="bg-background w-full rounded-md border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
              />
            </Field>
          </div>
          <Field label="Дата последнего ТО">
            <input
              type="date"
              value={lastDone}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e) => setLastDone(e.target.value)}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            <span className="text-muted-foreground mt-1 block text-xs">
              {lastDone
                ? `Следующее ТО: ${formatNextDue(lastDone, intervalDays)}`
                : 'Не знаете — оставьте пусто, отсчёт пойдёт от сегодня'}
            </span>
          </Field>
          <Field label="Примечания">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </Field>
          {error && <div className="text-destructive text-sm">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="hover:bg-muted rounded-md border px-3 py-2 text-sm transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={create.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md px-3 py-2 text-sm font-medium transition"
            >
              {create.isPending ? 'Сохраняем…' : 'Создать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

/** Подсказка под полем: когда наступит следующее ТО при таком интервале. */
export function formatNextDue(lastDoneIso: string, intervalDaysRaw: string): string {
  const days = Math.max(1, Math.round(Number(intervalDaysRaw) || 0));
  const start = new Date(`${lastDoneIso}T00:00:00`);
  if (Number.isNaN(start.getTime())) return '—';
  const next = new Date(start.getTime() + days * 24 * 60 * 60 * 1000);
  const label = next.toLocaleDateString('ru-RU');
  return next.getTime() < Date.now() ? `${label} (уже просрочено)` : label;
}

function Field({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-muted-foreground text-xs font-medium">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
