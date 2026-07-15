/**
 * Панель «Задачи» на экране «Календарь» (менеджеры: директор + диспетчер).
 * Список дел фирмы с необязательной датой и исполнителем + галочка «сделано».
 * Задачи с датой также показываются в сетке месяца (см. CalendarPage).
 */
import { useEffect, useRef, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Circle,
  ListTodo,
  Pencil,
  Plus,
  Trash2,
  User as UserIcon,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

interface Task {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  dueTime: string | null;
  assigneeUserId: string | null;
  assigneeName: string | null;
  isDone: boolean;
  doneAt: Date | null;
  remind: boolean;
  createdByUserId: string | null;
}

type DialogState = { mode: 'create' } | { mode: 'edit'; task: Task } | null;

function fmtDue(dueDate: string | null, dueTime: string | null): string {
  if (!dueDate) return 'без даты';
  const [y, m, d] = dueDate.split('-');
  const base = `${d}.${m}`;
  const label =
    new Date(`${dueDate}T00:00:00`).getFullYear() === new Date().getFullYear()
      ? base
      : `${base}.${y}`;
  return dueTime ? `${label} · ${dueTime}` : label;
}

function isOverdue(t: Task): boolean {
  if (t.isDone || !t.dueDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${t.dueDate}T00:00:00`) < today;
}

export function CalendarTasksPanel() {
  const utils = trpc.useUtils();
  const [showDone, setShowDone] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);

  const tasksQ = trpc.tasks.list.useQuery({ includeDone: showDone });
  const tasks = (tasksQ.data ?? []) as Task[];

  const setDone = trpc.tasks.setDone.useMutation({
    onSuccess: () => utils.tasks.list.invalidate(),
  });
  const remove = trpc.tasks.delete.useMutation({
    onSuccess: () => utils.tasks.list.invalidate(),
  });

  const openCount = tasks.filter((t) => !t.isDone).length;

  return (
    <section className="bg-card rounded-xl border shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b p-4">
        <div className="flex items-center gap-2.5">
          <span className="bg-success/12 text-success grid h-8 w-8 place-items-center rounded-lg">
            <ListTodo className="h-4 w-4" />
          </span>
          <div>
            <h3 className="font-semibold">Задачи</h3>
            <p className="text-muted-foreground text-xs">
              Дела фирмы — с датой или просто в списке. Открытых: {openCount}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className="bg-secondary text-secondary-foreground inline-flex rounded-md p-0.5 text-sm">
            <button
              type="button"
              onClick={() => setShowDone(false)}
              className={cn(
                'rounded px-3 py-1 transition',
                !showDone ? 'bg-background shadow-sm' : 'text-muted-foreground',
              )}
            >
              Открытые
            </button>
            <button
              type="button"
              onClick={() => setShowDone(true)}
              className={cn(
                'rounded px-3 py-1 transition',
                showDone ? 'bg-background shadow-sm' : 'text-muted-foreground',
              )}
            >
              Все
            </button>
          </div>
          <button
            type="button"
            onClick={() => setDialog({ mode: 'create' })}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Новая задача
          </button>
        </div>
      </div>

      {tasksQ.isLoading ? (
        <div className="text-muted-foreground p-4 text-sm">Загрузка…</div>
      ) : tasks.length === 0 ? (
        <div className="text-muted-foreground p-6 text-center text-sm">
          {showDone ? 'Задач пока нет.' : 'Открытых задач нет.'} Нажмите «Новая задача».
        </div>
      ) : (
        <ul className="divide-y">
          {tasks.map((t) => {
            const overdue = isOverdue(t);
            return (
              <li key={t.id} className="flex items-start gap-2.5 p-3">
                <button
                  type="button"
                  onClick={() => setDone.mutate({ id: t.id, isDone: !t.isDone })}
                  disabled={setDone.isPending}
                  className="mt-0.5 shrink-0"
                  aria-label={t.isDone ? 'Снять отметку' : 'Отметить сделанной'}
                  title={t.isDone ? 'Снять отметку' : 'Отметить сделанной'}
                >
                  {t.isDone ? (
                    <CheckCircle2 className="text-success h-5 w-5" />
                  ) : (
                    <Circle className="text-muted-foreground hover:text-foreground h-5 w-5" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <div className={cn('text-sm font-medium', t.isDone && 'text-muted-foreground line-through')}>
                    {t.title}
                  </div>
                  {t.notes && (
                    <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{t.notes}</p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs">
                    <span
                      className={cn(
                        'inline-flex items-center gap-1',
                        overdue ? 'text-destructive font-medium' : 'text-muted-foreground',
                      )}
                    >
                      <CalendarClock className="h-3 w-3" />
                      {fmtDue(t.dueDate, t.dueTime)}
                      {overdue ? ' · просрочено' : ''}
                    </span>
                    {t.assigneeName && (
                      <span className="text-muted-foreground inline-flex items-center gap-1">
                        <UserIcon className="h-3 w-3" />
                        {t.assigneeName}
                      </span>
                    )}
                    {t.remind && (
                      <span className="text-muted-foreground/70">напомним накануне</span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setDialog({ mode: 'edit', task: t })}
                    aria-label="Изменить задачу"
                    title="Изменить"
                    className="text-muted-foreground hover:text-foreground grid h-7 w-7 place-items-center rounded transition"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate({ id: t.id })}
                    disabled={remove.isPending}
                    aria-label="Удалить задачу"
                    title="Удалить"
                    className="text-muted-foreground hover:text-destructive grid h-7 w-7 place-items-center rounded transition"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {dialog && <TaskDialog initial={dialog} onClose={() => setDialog(null)} />}
    </section>
  );
}

/* ───────────── Диалог создания/правки задачи ───────────── */

function TaskDialog({ initial, onClose }: { initial: NonNullable<DialogState>; onClose: () => void }) {
  const utils = trpc.useUtils();
  const isEdit = initial.mode === 'edit';
  const task = isEdit ? initial.task : null;

  const [title, setTitle] = useState(task?.title ?? '');
  const [date, setDate] = useState(task?.dueDate ?? '');
  const [time, setTime] = useState(task?.dueTime ?? '');
  const [assignee, setAssignee] = useState(task?.assigneeUserId ?? '');
  const [notes, setNotes] = useState(task?.notes ?? '');
  const [remind, setRemind] = useState(task?.remind ?? false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const users = trpc.users.list.useQuery({});

  const done = async () => {
    await utils.tasks.list.invalidate();
    onClose();
  };
  const create = trpc.tasks.create.useMutation({ onSuccess: done, onError: (e) => setError(e.message) });
  const update = trpc.tasks.update.useMutation({ onSuccess: done, onError: (e) => setError(e.message) });
  const remove = trpc.tasks.delete.useMutation({ onSuccess: done, onError: (e) => setError(e.message) });
  const pending = create.isPending || update.isPending || remove.isPending;

  useEffect(() => {
    titleRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }
      if (e.key === 'Tab' && rootRef.current) {
        const f = rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        if (f.length === 0) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !rootRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !rootRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = () => {
    setError(null);
    if (!title.trim()) {
      setError('Укажите название задачи');
      return;
    }
    const payload = {
      title: title.trim(),
      date: date || null,
      time: date && time ? time : null,
      assigneeUserId: assignee || null,
      notes: notes.trim() || null,
      remind,
    };
    if (isEdit && task) update.mutate({ id: task.id, ...payload });
    else create.mutate(payload);
  };

  const inputCls =
    'bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40';

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="task-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      <button type="button" aria-label="Закрыть диалог" onClick={onClose} className="absolute inset-0 bg-black/40" />
      <div className="bg-card relative z-10 w-full max-w-md space-y-4 rounded-lg border p-5 shadow-xl">
        <h3 id="task-dialog-title" className="flex items-center gap-2 text-base font-semibold">
          <span className="bg-success/12 text-success grid h-7 w-7 place-items-center rounded-lg">
            <ListTodo className="h-4 w-4" />
          </span>
          {isEdit ? 'Изменить задачу' : 'Новая задача'}
        </h3>

        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs font-medium">Что нужно сделать</span>
          <input
            ref={titleRef}
            type="text"
            value={title}
            maxLength={300}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="Например: заказать бумагу, позвонить в клинику"
            className={inputCls}
          />
        </label>

        <div className="grid grid-cols-2 gap-3">
          <label className="block space-y-1">
            <span className="text-muted-foreground text-xs font-medium">
              Дата <span className="opacity-60">(необязательно)</span>
            </span>
            <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={inputCls} />
          </label>
          <label className="block space-y-1">
            <span className="text-muted-foreground text-xs font-medium">
              Время <span className="opacity-60">(необязательно)</span>
            </span>
            <input
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              disabled={!date}
              className={cn(inputCls, !date && 'opacity-50')}
            />
          </label>
        </div>

        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs font-medium">Исполнитель</span>
          <select value={assignee} onChange={(e) => setAssignee(e.target.value)} className={inputCls}>
            <option value="">— без исполнителя —</option>
            {(users.data ?? []).map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
                {u.role === 'engineer' ? ' · инженер' : u.role === 'dispatcher' ? ' · диспетчер' : ' · директор'}
              </option>
            ))}
          </select>
        </label>

        <label className="block space-y-1">
          <span className="text-muted-foreground text-xs font-medium">
            Заметка <span className="opacity-60">(необязательно)</span>
          </span>
          <textarea
            value={notes}
            rows={2}
            maxLength={2000}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Детали, ссылки…"
            className={inputCls}
          />
        </label>

        <label className={cn('flex cursor-pointer items-start gap-2.5', !date && 'opacity-50')}>
          <input
            type="checkbox"
            checked={remind}
            disabled={!date}
            onChange={(e) => setRemind(e.target.checked)}
            className="accent-primary mt-0.5 h-4 w-4"
          />
          <span className="text-sm leading-tight">
            Напомнить накануне
            <span className="text-muted-foreground block text-xs">
              push-уведомление исполнителю в 09:00 за день до даты{!date ? ' (нужна дата)' : ''}
            </span>
          </span>
        </label>

        {error && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
            {error}
          </div>
        )}

        <div className="flex items-center justify-between gap-2 pt-1">
          {isEdit ? (
            <button
              type="button"
              disabled={pending}
              onClick={() => {
                if (!confirmDelete) {
                  setConfirmDelete(true);
                  return;
                }
                if (task) remove.mutate({ id: task.id });
              }}
              className={cn(
                'rounded-md border px-3 py-1.5 text-sm font-medium transition disabled:opacity-50',
                confirmDelete
                  ? 'bg-destructive text-destructive-foreground border-destructive'
                  : 'text-destructive border-destructive/30 hover:bg-destructive/10',
              )}
            >
              {confirmDelete ? 'Точно удалить?' : 'Удалить'}
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={pending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            >
              {pending ? 'Сохраняю…' : isEdit ? 'Сохранить' : 'Создать'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
