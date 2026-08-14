/**
 * Отметка одного дня в журнале посещений.
 *
 * Время прихода и ухода показываем ТОЛЬКО у явки: у больничного и отпуска его не
 * бывает (сервер такую запись и не примет), а видимые неактивные поля лишь путают.
 * При переключении с явки на другой вид дня время очищаем сразу — иначе кнопка
 * «Сохранить» отдавала бы ошибку из-за поля, которого пользователь уже не видит.
 */
import { useState } from 'react';
import { X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  ATTENDANCE_STATUSES,
  type AttendanceRecord,
  type AttendanceStatus,
} from '../lib/attendance';

interface Props {
  userId: string;
  employeeName: string;
  /** YYYY-MM-DD */
  workDate: string;
  /** Текущая отметка дня либо null — тогда форма заводит новую. */
  record: AttendanceRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

function formatRuDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return d.toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export function AttendanceDayForm({
  userId,
  employeeName,
  workDate,
  record,
  onClose,
  onSaved,
}: Props) {
  const [status, setStatus] = useState<AttendanceStatus>(record?.status ?? 'present');
  const [arrivedAt, setArrivedAt] = useState(record?.arrivedAt ?? '');
  const [leftAt, setLeftAt] = useState(record?.leftAt ?? '');
  const [note, setNote] = useState(record?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const upsert = trpc.attendance.upsert.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });
  const remove = trpc.attendance.remove.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const busy = upsert.isPending || remove.isPending;
  const isPresent = status === 'present';

  const pickStatus = (next: AttendanceStatus) => {
    setStatus(next);
    if (next !== 'present') {
      setArrivedAt('');
      setLeftAt('');
    }
  };

  const save = () => {
    setError(null);
    upsert.mutate({
      userId,
      workDate,
      status,
      arrivedAt: isPresent && arrivedAt ? arrivedAt : null,
      leftAt: isPresent && leftAt ? leftAt : null,
      note: note.trim() ? note.trim() : null,
    });
  };

  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold">{employeeName}</h2>
            <div className="text-muted-foreground text-xs">{formatRuDate(workDate)}</div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground mt-0.5"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-4">
          <div>
            <div className="text-muted-foreground mb-1.5 text-xs font-medium">Вид дня</div>
            <div className="flex flex-wrap gap-1.5">
              {ATTENDANCE_STATUSES.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => pickStatus(s.key)}
                  aria-pressed={status === s.key}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
                    status === s.key
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'hover:bg-muted text-muted-foreground',
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>

          {isPresent && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="arrived" className="text-muted-foreground text-xs font-medium">
                  Пришёл
                </label>
                <input
                  id="arrived"
                  type="time"
                  value={arrivedAt}
                  onChange={(e) => setArrivedAt(e.target.value)}
                  className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                />
              </div>
              <div>
                <label htmlFor="left" className="text-muted-foreground text-xs font-medium">
                  Ушёл
                </label>
                <input
                  id="left"
                  type="time"
                  value={leftAt}
                  onChange={(e) => setLeftAt(e.target.value)}
                  className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                />
              </div>
            </div>
          )}

          <div>
            <label htmlFor="note" className="text-muted-foreground text-xs font-medium">
              Комментарий
            </label>
            <input
              id="note"
              type="text"
              value={note}
              maxLength={500}
              placeholder="Например: опоздание по согласованию"
              onChange={(e) => setNote(e.target.value)}
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>

          {error && <div className="text-destructive text-sm">{error}</div>}

          <div className="flex items-center justify-between gap-2 pt-1">
            {record ? (
              <button
                type="button"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  remove.mutate({ userId, workDate });
                }}
                className="text-destructive hover:bg-destructive/10 rounded-md px-3 py-2 text-sm transition disabled:opacity-50"
              >
                Снять отметку
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="hover:bg-muted rounded-md border px-3 py-2 text-sm transition"
              >
                Отмена
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={save}
                className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50"
              >
                {upsert.isPending ? 'Сохраняем…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
