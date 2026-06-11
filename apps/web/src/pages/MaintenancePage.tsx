import { useState } from 'react';
import { CalendarCheck, CheckCircle2, Clock, Plus } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { MaintenanceScheduleForm } from '../components/MaintenanceScheduleForm';
import { MaintenanceRecordForm } from '../components/MaintenanceRecordForm';

type Tab = 'overdue' | 'due_soon' | 'all_active' | 'log';

const TABS: Array<{ key: Tab; label: string; icon: typeof Clock }> = [
  { key: 'overdue', label: 'Просрочено', icon: Clock },
  { key: 'due_soon', label: 'На неделю', icon: Clock },
  { key: 'all_active', label: 'Все активные', icon: CalendarCheck },
  { key: 'log', label: 'Журнал', icon: CheckCircle2 },
];

export function MaintenancePage() {
  const [tab, setTab] = useState<Tab>('overdue');
  const [showForm, setShowForm] = useState(false);
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

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-4 md:p-6">
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
        <button
          type="button"
          onClick={() => setShowForm(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition"
        >
          <Plus className="h-4 w-4" />
          Создать график
        </button>
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
          ) : schedules.data && schedules.data.length > 0 ? (
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Техника</th>
                  <th className="px-3 py-2 text-left font-medium">Тип</th>
                  <th className="px-3 py-2 text-right font-medium">Интервал, дн.</th>
                  <th className="px-3 py-2 text-left font-medium">Последнее ТО</th>
                  <th className="px-3 py-2 text-left font-medium">Следующее</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {schedules.data.map((s) => {
                  const overdue = s.nextDueAt.getTime() < Date.now();
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
                        <KindBadge kind={s.kind} />
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{s.intervalDays}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs">
                        {s.lastDoneAt ? s.lastDoneAt.toLocaleDateString('ru-RU') : 'не было'}
                      </td>
                      <td className={cn('px-3 py-2 text-xs', overdue && 'text-destructive font-semibold')}>
                        {s.nextDueAt.toLocaleDateString('ru-RU')}
                      </td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          onClick={() =>
                            setRecordFor({ scheduleId: s.id, assetId: s.assetId })
                          }
                          className="hover:bg-muted rounded-md border px-2 py-1 text-xs transition"
                        >
                          Записать
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <div className="text-muted-foreground p-8 text-center text-sm">
              {tab === 'overdue' ? 'Просроченных ТО нет' : 'Графики не найдены'}
            </div>
          )}
        </section>
      ) : (
        <section className="bg-card overflow-hidden rounded-lg border">
          {log.data && log.data.length > 0 ? (
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
        kind === 'planned'
          ? 'bg-primary/10 text-primary'
          : 'bg-destructive/10 text-destructive',
      )}
    >
      {kind === 'planned' ? 'Плановое' : 'Срочное'}
    </span>
  );
}
