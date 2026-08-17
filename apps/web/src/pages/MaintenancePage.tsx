import { useState } from 'react';
import { Link } from 'wouter';
import { CalendarCheck, CheckCircle2, Clock, PauseCircle, Pencil, Plus, Power } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  MaintenanceScheduleForm,
  type EditableSchedule,
} from '../components/MaintenanceScheduleForm';
import { MaintenanceRecordForm } from '../components/MaintenanceRecordForm';
import { QueryError } from '../components/QueryError';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

type Tab = 'overdue' | 'due_soon' | 'all_active' | 'inactive' | 'log';

const TABS: Array<{ key: Tab; label: string; icon: typeof Clock }> = [
  { key: 'overdue', label: 'Просрочено', icon: Clock },
  { key: 'due_soon', label: 'На неделю', icon: Clock },
  { key: 'all_active', label: 'Все активные', icon: CalendarCheck },
  // Вкладка появилась вместе с кнопкой выключения: без неё выключенный график
  // исчезал бы совсем, и включить его обратно было бы нечем.
  { key: 'inactive', label: 'Выключенные', icon: PauseCircle },
  { key: 'log', label: 'Журнал', icon: CheckCircle2 },
];

export function MaintenancePage() {
  const [tab, setTab] = useState<Tab>('overdue');
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<EditableSchedule | null>(null);
  const [switching, setSwitching] = useState<{ id: string; to: boolean; label: string } | null>(
    null,
  );
  const [switchError, setSwitchError] = useState<string | null>(null);
  const [recordFor, setRecordFor] = useState<{
    scheduleId?: string;
    assetId: string;
  } | null>(null);

  const schedules = trpc.maintenance.listSchedules.useQuery(
    { filter: tab === 'log' ? 'all_active' : tab },
    { enabled: tab !== 'log' },
  );
  const log = trpc.maintenance.listLog.useQuery({ limit: 100 }, { enabled: tab === 'log' });

  const utils = trpc.useUtils();

  const toggleActive = trpc.maintenance.updateSchedule.useMutation({
    onSuccess: async () => {
      setSwitching(null);
      setSwitchError(null);
      await utils.maintenance.listSchedules.invalidate();
    },
    onError: (e) => setSwitchError(e.message),
  });
  // Инженер отмечает ТО только по графику, где он ответственный (решение
  // владельца 2026-08-11); графики заводит staff. Кнопки с гарантированным
  // отказом сервера не показываем.
  const me = trpc.auth.me.useQuery();
  const meUser = me.data?.user;
  const isStaff = meUser?.role === 'director' || meUser?.role === 'dispatcher';

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <CalendarCheck className="h-3.5 w-3.5" />
            Журнал ТО
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Техническое обслуживание</h1>
          <p className="text-muted-foreground text-sm">
            Плановое и срочное ТО с автоматическим расчётом next_due_at
          </p>
        </div>
        {isStaff && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
          >
            <Plus className="h-4 w-4" />
            Создать график
          </button>
        )}
      </div>

      <div className="inline-flex flex-wrap rounded-md border p-0.5">
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-medium transition',
                tab === t.key
                  ? 'bg-secondary text-secondary-foreground'
                  : 'text-muted-foreground hover:text-foreground',
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {t.label}
            </button>
          );
        })}
      </div>

      {tab !== 'log' ? (
        <section className="bg-card overflow-hidden rounded-lg border">
          {schedules.isLoading ? (
            <div className="text-muted-foreground p-8 text-center text-sm">Загрузка…</div>
          ) : schedules.error ? (
            <QueryError
              error={schedules.error}
              paused={schedules.fetchStatus === 'paused'}
              what="план ТО"
              onRetry={() => void schedules.refetch()}
              className="m-4"
            />
          ) : schedules.data && schedules.data.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Техника</th>
                  <th className="px-3 py-2 text-left font-medium">Клиент</th>
                  <th className="px-3 py-2 text-left font-medium">Тип</th>
                  <th className="px-3 py-2 text-right font-medium">Интервал, дн.</th>
                  <th className="px-3 py-2 text-left font-medium">Последнее ТО</th>
                  <th className="px-3 py-2 text-left font-medium">Следующее</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {schedules.data.map((s) => {
                  // Просрочку решает сервер по общему правилу — раньше страница
                  // считала её сама по часам браузера, и это было пятым определением.
                  const overdue = s.isOverdue;
                  return (
                    <tr key={s.id} className="hover:bg-muted/20 transition">
                      <td className="px-3 py-2">
                        <div className="font-medium">{s.assetModel ?? '—'}</div>
                        {s.assetSerial && (
                          <div className="text-muted-foreground font-mono text-xs">
                            {s.assetSerial}
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {s.clientId ? (
                          <Link
                            href={`/clients/${s.clientId}`}
                            className="text-foreground hover:text-primary"
                          >
                            {s.clientName ?? '—'}
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        <KindBadge kind={s.kind} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.intervalDays}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        {s.lastDoneAt ? s.lastDoneAt.toLocaleDateString('ru-RU') : 'не было'}
                      </td>
                      <td
                        className={cn(
                          'px-3 py-2 text-xs',
                          overdue && 'text-destructive font-semibold',
                        )}
                      >
                        {s.nextDueAt.toLocaleDateString('ru-RU')}
                      </td>
                      <td className="px-2 py-2">
                        <div className="flex items-center justify-end gap-1">
                          {tab !== 'inactive' &&
                            (isStaff || s.responsibleUserId === meUser?.id) && (
                              <button
                                type="button"
                                onClick={() =>
                                  setRecordFor({ scheduleId: s.id, assetId: s.assetId })
                                }
                                className="hover:bg-muted rounded-md border px-2 py-1 text-xs transition"
                              >
                                Записать
                              </button>
                            )}
                          {isStaff && (
                            <>
                              <button
                                type="button"
                                aria-label={`Изменить график ${s.assetModel ?? ''}`.trim()}
                                title="Изменить график"
                                onClick={() =>
                                  setEditing({
                                    id: s.id,
                                    assetModel: s.assetModel,
                                    assetSerial: s.assetSerial,
                                    kind: s.kind,
                                    intervalDays: s.intervalDays,
                                    notes: s.notes,
                                  })
                                }
                                className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-1.5 transition"
                              >
                                <Pencil className="h-3.5 w-3.5" />
                              </button>
                              <button
                                type="button"
                                aria-label={`${s.isActive ? 'Выключить' : 'Включить'} график ${s.assetModel ?? ''}`.trim()}
                                title={s.isActive ? 'Выключить график' : 'Включить график'}
                                onClick={() => {
                                  setSwitchError(null);
                                  setSwitching({
                                    id: s.id,
                                    to: !s.isActive,
                                    label: s.assetModel ?? 'без модели',
                                  });
                                }}
                                className={cn(
                                  'rounded p-1.5 transition',
                                  s.isActive
                                    ? 'text-muted-foreground hover:bg-destructive/10 hover:text-destructive'
                                    : 'text-muted-foreground hover:bg-success/10 hover:text-success',
                                )}
                              >
                                <Power className="h-3.5 w-3.5" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="text-muted-foreground p-8 text-center text-sm">
              {tab === 'overdue'
                ? 'Просроченных ТО нет'
                : tab === 'inactive'
                  ? 'Выключенных графиков нет'
                  : 'Графики не найдены'}
            </div>
          )}
        </section>
      ) : (
        <section className="bg-card overflow-hidden rounded-lg border">
          {log.error ? (
            <QueryError
              error={log.error}
              paused={log.fetchStatus === 'paused'}
              what="журнал ТО"
              onRetry={() => void log.refetch()}
              className="m-4"
            />
          ) : log.data && log.data.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Дата</th>
                  <th className="px-3 py-2 text-left font-medium">Что сделано</th>
                  <th className="px-3 py-2 text-left font-medium">Привязка</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {log.data.map((l) => (
                  <tr key={l.id} className="hover:bg-muted/20 transition">
                    <td className="text-muted-foreground px-3 py-2 text-xs tabular-nums">
                      {l.performedAt.toLocaleString('ru-RU')}
                    </td>
                    <td className="px-3 py-2">{l.summary}</td>
                    <td className="text-muted-foreground px-3 py-2 text-xs">
                      {l.scheduleId ? 'график' : l.ticketId ? 'заявка' : 'разовое'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="text-muted-foreground p-8 text-center text-sm">Записей пока нет</div>
          )}
        </section>
      )}

      {showForm && (
        <MaintenanceScheduleForm
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            void utils.maintenance.listSchedules.invalidate();
          }}
        />
      )}

      {editing && (
        <MaintenanceScheduleForm
          schedule={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void utils.maintenance.listSchedules.invalidate();
          }}
        />
      )}

      <ConfirmDialog
        open={switching !== null}
        title={switching?.to ? 'Включить график ТО' : 'Выключить график ТО'}
        description={
          switching?.to
            ? `График по «${switching.label}» вернётся в план: аппарат снова начнёт попадать в «Просрочено» и в счётчик меню.`
            : switching
              ? `График по «${switching.label}» перестанет напоминать о себе: он уйдёт из «Просрочено», из счётчика меню и из календаря. История выполненных ТО сохранится, а сам график останется во вкладке «Выключенные» — включить обратно можно в любой момент.`
              : undefined
        }
        confirmText={switching?.to ? 'Включить' : 'Выключить'}
        variant={switching?.to ? 'default' : 'danger'}
        loading={toggleActive.isPending}
        error={switchError}
        onConfirm={() =>
          switching && toggleActive.mutate({ id: switching.id, patch: { isActive: switching.to } })
        }
        onCancel={() => {
          setSwitching(null);
          setSwitchError(null);
        }}
      />

      {recordFor && (
        <MaintenanceRecordForm
          assetId={recordFor.assetId}
          scheduleId={recordFor.scheduleId}
          onClose={() => setRecordFor(null)}
          onSaved={() => {
            setRecordFor(null);
            void utils.maintenance.listSchedules.invalidate();
            void utils.maintenance.listLog.invalidate();
          }}
        />
      )}
    </div>
  );
}

function KindBadge({ kind }: { kind: 'planned' | 'urgent' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        kind === 'planned' ? 'bg-primary/10 text-primary' : 'bg-destructive/10 text-destructive',
      )}
    >
      {kind === 'planned' ? 'Плановое' : 'Срочное'}
    </span>
  );
}
