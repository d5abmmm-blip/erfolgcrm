import { useState } from 'react';
import { X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { AssetPicker } from './AssetPicker';

/** Что нужно знать форме, чтобы открыться на правку существующего графика. */
export interface EditableSchedule {
  id: string;
  assetModel: string | null;
  assetSerial: string | null;
  kind: 'planned' | 'urgent';
  intervalDays: number;
  notes: string | null;
}

interface Props {
  onClose: () => void;
  onSaved: () => void;
  /**
   * Правим существующий график. Не передан — заводим новый.
   *
   * Форма одна на оба случая сознательно: разъехавшиеся «создать» и
   * «изменить» — это разные границы полей и разные подписи у одного и того же,
   * чем уже поплатились три копии сборки акта (#166).
   */
  schedule?: EditableSchedule | null;
}

export function MaintenanceScheduleForm({ onClose, onSaved, schedule }: Props) {
  const editing = schedule != null;
  const [assetId, setAssetId] = useState<string | null>(null);
  const [kind, setKind] = useState<'planned' | 'urgent'>(schedule?.kind ?? 'planned');
  const [intervalDays, setIntervalDays] = useState(String(schedule?.intervalDays ?? 180));
  // Дата последнего фактического ТО. Пусто — считаем от сегодня.
  const [lastDone, setLastDone] = useState('');
  const [notes, setNotes] = useState(schedule?.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const create = trpc.maintenance.createSchedule.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });
  const update = trpc.maintenance.updateSchedule.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });
  const pending = create.isPending || update.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const days = Math.max(1, Math.round(Number(intervalDays) || 0));

    if (editing && schedule) {
      // Аппарат в правке не меняется: сервер такого поля не принимает, а
      // «перевесить» график на другую технику — это завести новый.
      update.mutate({
        id: schedule.id,
        patch: { kind, intervalDays: days, notes: notes.trim() || null },
      });
      return;
    }

    if (!assetId) {
      setError('Выберите технику');
      return;
    }
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
          <h2 className="text-base font-semibold">
            {editing ? 'Изменить график ТО' : 'Создать график ТО'}
          </h2>
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
          <Field label="Техника" required={!editing}>
            {editing ? (
              <div className="bg-muted/40 rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">{schedule?.assetModel ?? '—'}</div>
                {schedule?.assetSerial && (
                  <div className="text-muted-foreground font-mono text-xs">
                    {schedule.assetSerial}
                  </div>
                )}
                <div className="text-muted-foreground mt-1 text-xs">
                  Техника у графика не меняется — на другой аппарат заводят новый график
                </div>
              </div>
            ) : (
              <AssetPicker value={assetId} onChange={(id) => setAssetId(id || null)} />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Тип">
              <select
                value={kind}
                onChange={(e) => setKind(e.target.value as 'planned' | 'urgent')}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
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
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm tabular-nums outline-none focus:ring-2"
              />
            </Field>
          </div>
          {editing ? (
            <p className="text-muted-foreground text-xs">
              Срок следующего ТО пересчитается от последнего выполненного, а если ТО ещё не было —
              от той же точки, с которой график завели.
            </p>
          ) : (
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
          )}
          <Field label="Примечания">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
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
              disabled={pending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {pending ? 'Сохраняем…' : editing ? 'Сохранить' : 'Создать'}
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
