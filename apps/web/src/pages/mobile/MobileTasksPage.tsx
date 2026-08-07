/**
 * /m/tasks — «Мои задачи» инженера: назначенные ему дела с галочкой «сделано».
 * Поллинг 30 сек. Отметка «сделано» оффлайн-безопасна (executeOrQueue → Outbox).
 * Заголовок шапки даёт MobileShell (пункт навигации «Задачи»).
 */
import { useState } from 'react';
import { CalendarClock, CheckCircle2, Circle, ClipboardList, Loader2 } from 'lucide-react';
import { trpc, getTenantSubdomain } from '../../lib/trpc';
import { QUEUED_MUTATION } from '../../lib/query-defaults';
import { cn } from '../../lib/utils';
import { executeOrQueue } from '../../lib/offline/executor';
import { fmtDue } from '../../lib/dates';
import { showToast } from '../../lib/toast';
import { MobileListToolbar } from '../../components/MobileListToolbar';
import { SegmentedTabs } from '../../components/SegmentedTabs';
import { QueryError } from '../../components/QueryError';

interface Task {
  id: string;
  title: string;
  notes: string | null;
  dueDate: string | null;
  dueTime: string | null;
  isDone: boolean;
}

function isOverdue(dueDate: string | null, isDone: boolean): boolean {
  if (isDone || !dueDate) return false;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return new Date(`${dueDate}T00:00:00`) < today;
}

export function MobileTasksPage() {
  const [tab, setTab] = useState<'active' | 'all'>('active');
  const utils = trpc.useUtils();
  const tenantSubdomain = getTenantSubdomain();

  const list = trpc.tasks.myList.useQuery(
    { includeDone: tab === 'all' },
    { refetchInterval: 30_000, refetchOnWindowFocus: true },
  );
  const tasks = (list.data ?? []) as Task[];

  const setDoneM = trpc.tasks.setDone.useMutation(QUEUED_MUTATION);
  const [busy, setBusy] = useState<string | null>(null);
  // Оптимистичная отметка: id → желаемое isDone. Нужна для мгновенной реакции и
  // особенно для офлайна (invalidate без сети не перечитает данные — галочка
  // осталась бы прежней). Снимается на 'ok' (после рефетча) и 'error' (откат);
  // на 'queued' держится до синхронизации.
  const [override, setOverride] = useState<Record<string, boolean>>({});
  const clearOverride = (id: string) =>
    setOverride((o) => {
      const n = { ...o };
      delete n[id];
      return n;
    });

  const onToggle = async (id: string, next: boolean, title?: string) => {
    setBusy(id);
    setOverride((o) => ({ ...o, [id]: next })); // сразу меняем галочку
    const result = await executeOrQueue(
      'tasks.setDone',
      { id, isDone: next },
      (p) => setDoneM.mutateAsync(p),
      tenantSubdomain,
      undefined,
      title,
    );
    setBusy(null);
    if (result.status === 'ok') {
      await utils.tasks.myList.invalidate(); // дождались свежих данных
      clearOverride(id); // сервер — источник правды
      showToast('ok', next ? 'Задача отмечена сделанной' : 'Отметка снята');
    } else if (result.status === 'queued') {
      // Нет связи: держим оптимистичную отметку до синхронизации.
      showToast('queued', 'Нет связи — отметка сохранена и отправится сама');
    } else {
      clearOverride(id); // откат к серверному состоянию
      showToast('error', result.error.message);
    }
  };

  return (
    <div className="flex flex-col">
      <MobileListToolbar onRefresh={() => void list.refetch()} refreshing={list.isFetching}>
        <SegmentedTabs
          options={
            [
              { value: 'active', label: 'Открытые' },
              { value: 'all', label: 'Все' },
            ] as const
          }
          value={tab}
          onChange={setTab}
        />
      </MobileListToolbar>

      {list.isLoading && (
        <div className="text-muted-foreground flex items-center justify-center gap-2 py-12 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка задач…
        </div>
      )}

      {(list.error || (list.fetchStatus === 'paused' && !list.data)) && (
        <div className="m-3">
          <QueryError
            error={list.error}
            paused={list.fetchStatus === 'paused'}
            what="задачи"
            onRetry={() => void list.refetch()}
          />
        </div>
      )}

      {list.data && tasks.length === 0 && (
        <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 py-16 text-center">
          <ClipboardList className="h-10 w-10 opacity-50" />
          <div className="text-sm">
            {tab === 'active' ? 'Открытых задач нет.' : 'Задач нет.'}
            <br />
            Задачи появятся, когда их назначит менеджер.
          </div>
        </div>
      )}

      <ul className="space-y-2 p-3">
        {tasks.map((t) => {
          const done = t.id in override ? override[t.id]! : t.isDone;
          const overdue = isOverdue(t.dueDate, done);
          return (
            <li key={t.id} className="bg-card flex items-start gap-3 rounded-lg border p-3">
              <button
                type="button"
                onClick={() => void onToggle(t.id, !done, t.title)}
                disabled={busy === t.id}
                className="mt-0.5 shrink-0 disabled:opacity-50"
                aria-label={done ? 'Снять отметку' : 'Отметить сделанной'}
              >
                {done ? (
                  <CheckCircle2 className="text-success h-6 w-6" />
                ) : (
                  <Circle className="text-muted-foreground h-6 w-6" />
                )}
              </button>
              <div className="min-w-0 flex-1">
                <div
                  className={cn(
                    'text-sm font-medium',
                    done && 'text-muted-foreground line-through',
                  )}
                >
                  {t.title}
                </div>
                {t.notes && <p className="text-muted-foreground mt-0.5 text-xs">{t.notes}</p>}
                <div
                  className={cn(
                    'mt-1 inline-flex items-center gap-1 text-xs',
                    overdue ? 'text-destructive font-medium' : 'text-muted-foreground',
                  )}
                >
                  <CalendarClock className="h-3 w-3" />
                  {fmtDue(t.dueDate, t.dueTime)}
                  {overdue ? ' · просрочено' : ''}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
