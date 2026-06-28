import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import {
  ChevronLeft,
  Clock,
  Loader2,
  User,
  Wrench,
  ScanLine,
  PlayCircle,
  Stethoscope,
  ClipboardCheck,
  StickyNote,
  CheckCircle2,
  AlertCircle,
  Tag,
} from 'lucide-react';
import type { TicketStatus } from '@erfolg/shared';
import { trpc, getTenantSubdomain } from '../../lib/trpc';
import { openPrintWindow } from '../../lib/open-print-window';
import { executeOrQueue } from '../../lib/offline/executor';
import { cn } from '../../lib/utils';
import { PhotoUploader } from '../../components/PhotoUploader';

const STATUS_LABEL: Record<TicketStatus, string> = {
  received: 'Принята',
  diagnostics: 'Диагностика',
  estimate: 'Смета',
  approval: 'Согласование',
  in_progress: 'В работе',
  act_pending: 'Ожидает акта',
  closed: 'Закрыта',
  cancelled: 'Отменена',
};

const STATUS_PILL: Record<TicketStatus, string> = {
  received: 'bg-primary/10 text-primary',
  diagnostics: 'bg-primary/10 text-primary',
  estimate: 'bg-primary/10 text-primary',
  approval: 'bg-warning/15 text-warning',
  in_progress: 'bg-warning/15 text-warning',
  act_pending: 'bg-accent/10 text-accent',
  closed: 'bg-success/10 text-success',
  cancelled: 'bg-destructive/10 text-destructive',
};

interface ActionDef {
  /** Кнопка-цель (ставит этот status). */
  target: TicketStatus;
  label: string;
  icon: typeof PlayCircle;
  /** Visible только если текущий статус ∈ from. */
  from: TicketStatus[];
  variant: 'primary' | 'accent' | 'success' | 'ghost';
}

const ACTIONS: ActionDef[] = [
  {
    target: 'diagnostics',
    label: 'Начать диагностику',
    icon: Stethoscope,
    from: ['received'],
    variant: 'primary',
  },
  {
    target: 'in_progress',
    label: 'В работу',
    icon: PlayCircle,
    from: ['diagnostics', 'estimate', 'approval'],
    variant: 'primary',
  },
  {
    target: 'act_pending',
    label: 'Готов к акту',
    icon: ClipboardCheck,
    from: ['in_progress', 'diagnostics'],
    variant: 'accent',
  },
];

export function MobileTicketPage() {
  const [, params] = useRoute<{ id: string }>('/m/tickets/:id');
  const id = params?.id ?? '';

  const ticket = trpc.tickets.get.useQuery({ id }, { enabled: !!id });
  const wo = trpc.workOrders.getByTicket.useQuery({ ticketId: id }, { enabled: !!id });
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const changeStatusM = trpc.tickets.changeStatus.useMutation();
  const addNoteM = trpc.tickets.addNote.useMutation();
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<{ kind: 'ok' | 'queued' | 'error'; text: string } | null>(null);

  if (ticket.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 p-8 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка…
      </div>
    );
  }
  if (ticket.error || !ticket.data) {
    return (
      <div className="m-3">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
          {ticket.error?.message ?? 'Заявка не найдена'}
        </div>
      </div>
    );
  }
  const t = ticket.data;
  const tenantSubdomain = getTenantSubdomain();

  const showToast = (toastData: NonNullable<typeof toast>) => {
    setToast(toastData);
    setTimeout(() => setToast(null), 3000);
  };

  const onAction = async (target: TicketStatus, label: string) => {
    setBusy(target);
    const result = await executeOrQueue(
      'tickets.changeStatus',
      { id: t.id, status: target },
      (p) => changeStatusM.mutateAsync(p),
      tenantSubdomain,
    );
    setBusy(null);
    if (result.status === 'ok') {
      await Promise.all([
        utils.tickets.get.invalidate({ id: t.id }),
        utils.tickets.list.invalidate(),
      ]);
      showToast({ kind: 'ok', text: `Статус изменён: ${label}` });
    } else if (result.status === 'queued') {
      showToast({
        kind: 'queued',
        text: 'Нет связи — изменение сохранено в очередь, отправится автоматически',
      });
    } else {
      showToast({ kind: 'error', text: result.error.message });
    }
  };

  const onSendNote = async () => {
    if (!comment.trim()) return;
    setBusy('note');
    const result = await executeOrQueue(
      'tickets.addNote',
      { ticketId: t.id, comment: comment.trim() },
      (p) => addNoteM.mutateAsync(p),
      tenantSubdomain,
    );
    setBusy(null);
    if (result.status === 'ok') {
      setComment('');
      await utils.tickets.events.invalidate({ ticketId: t.id });
      showToast({ kind: 'ok', text: 'Комментарий добавлен' });
    } else if (result.status === 'queued') {
      setComment('');
      showToast({ kind: 'queued', text: 'Сохранено в очередь' });
    } else {
      showToast({ kind: 'error', text: result.error.message });
    }
  };

  const isEngineer = me.data?.user.role === 'engineer';
  const visibleActions = ACTIONS.filter((a) => a.from.includes(t.status));
  // Инженер ограничен в diagnostics/in_progress/act_pending — отфильтруем заранее (роутер всё равно проверит)
  const allowedActions = isEngineer
    ? visibleActions.filter((a) =>
        (['diagnostics', 'in_progress', 'act_pending'] as TicketStatus[]).includes(a.target),
      )
    : visibleActions;

  return (
    <div className="space-y-3 p-3">
      <Link
        href="/m/queue"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        К очереди
      </Link>

      <div className="bg-card space-y-3 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-mono text-base font-semibold">{t.ticketNumber}</div>
            <div className="text-muted-foreground text-xs">
              принята {fmtDate(t.receivedAt)}
            </div>
          </div>
          <span
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium',
              STATUS_PILL[t.status],
            )}
          >
            {STATUS_LABEL[t.status]}
          </span>
        </div>

        {t.scheduledStartAt && (
          <div className="bg-primary/10 text-primary inline-flex items-center gap-2 rounded-lg px-3 py-2 text-base font-bold">
            <Clock className="h-5 w-5 shrink-0" />
            <span>{fmtScheduleSlot(t.scheduledStartAt, t.scheduledEndAt)}</span>
          </div>
        )}

        <div className="space-y-2 border-t pt-3 text-sm">
          <Row icon={User} label="Клиент">
            {t.clientDisplayName || '—'}
          </Row>
          {t.assetModel && (
            <Row icon={Wrench} label="Техника">
              {t.assetModel}
              {t.assetSerialNumber && (
                <span className="text-muted-foreground"> · S/N {t.assetSerialNumber}</span>
              )}
            </Row>
          )}
          {t.barcode && (
            <Row icon={ScanLine} label="Штрих-код">
              <span className="font-mono text-xs break-all">{t.barcode}</span>
            </Row>
          )}
        </div>
        {t.assetModel && (
          <button
            type="button"
            onClick={() => void (async () => {
              const win = openPrintWindow();
              const [{ printAssetLabel }, { ERFOLG_FALLBACK }] = await Promise.all([
                import('../../lib/pdf'),
                import('../../lib/pdf/branding'),
              ]);
              await printAssetLabel({
                asset: {
                  model: t.assetModel ?? '—',
                  manufacturer: null,
                  serialNumber: t.assetSerialNumber ?? null,
                  inventoryNumber: null,
                  riskClass: null,
                },
                ticket: t.barcode
                  ? { ticketNumber: t.ticketNumber, receivedAt: typeof t.receivedAt === 'string' ? t.receivedAt : t.receivedAt.toISOString(), barcode: t.barcode }
                  : null,
                fallbackBarcode: t.assetId ?? t.id,
                tenantDisplayName: ERFOLG_FALLBACK.displayName,
              }, win);
            })()}
            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium"
          >
            <Tag className="h-4 w-4" />
            Печать ярлыка
          </button>
        )}

        {t.symptom && (
          <div className="bg-muted/40 rounded-md p-3 text-sm">
            <div className="text-muted-foreground mb-1 text-[11px] font-medium uppercase">
              Жалоба клиента
            </div>
            <div className="whitespace-pre-wrap">{t.symptom}</div>
          </div>
        )}
      </div>

      {allowedActions.length > 0 && (
        <div className="space-y-2">
          {allowedActions.map((a) => {
            const Icon = a.icon;
            const isBusy = busy === a.target;
            return (
              <button
                key={a.target}
                type="button"
                disabled={!!busy}
                onClick={() => void onAction(a.target, a.label)}
                className={cn(
                  'flex h-14 w-full items-center justify-center gap-2 rounded-lg text-base font-semibold transition disabled:opacity-60',
                  a.variant === 'primary'
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-accent text-accent-foreground hover:bg-accent/90',
                )}
              >
                {isBusy ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Icon className="h-5 w-5" />
                )}
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      <Link
        href={`/m/tickets/${t.id}/work-log`}
        className="bg-card hover:bg-muted/40 flex h-14 w-full items-center justify-center gap-2 rounded-lg border text-base font-semibold transition"
      >
        <Wrench className="h-5 w-5" />
        Журнал работ {wo.data ? `· ${(Number(wo.data.totalAmountKopecks) / 100).toLocaleString('ru-RU')} ₽` : ''}
      </Link>

      <div className="bg-card space-y-2 rounded-lg border p-3">
        <label className="text-muted-foreground text-[11px] font-medium uppercase">
          Комментарий
        </label>
        <textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Например: «приехал на объект, ожидаю клиента»"
          rows={3}
          className="border-input bg-background w-full resize-none rounded-md border px-3 py-2 text-sm"
        />
        <button
          type="button"
          onClick={() => void onSendNote()}
          disabled={!comment.trim() || busy === 'note'}
          className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium disabled:opacity-50"
        >
          {busy === 'note' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <StickyNote className="h-4 w-4" />
          )}
          Сохранить комментарий
        </button>
      </div>

      <div className="bg-card rounded-2xl border p-4">
        <div className="text-foreground mb-3 text-sm font-semibold">Фото</div>
        <PhotoUploader
          kind="ticket_photo"
          referenceType="ticket"
          referenceId={t.id}
          canUpload={true}
          showCamera={true}
          hint="Фото техники, состояния, повреждений"
        />
      </div>

      {toast && (
        <div
          className={cn(
            'fixed inset-x-3 bottom-24 z-40 rounded-lg p-3 text-sm shadow-lg',
            toast.kind === 'ok' && 'bg-success text-success-foreground',
            toast.kind === 'queued' && 'bg-warning text-warning-foreground',
            toast.kind === 'error' && 'bg-destructive text-destructive-foreground',
          )}
          role="status"
        >
          <div className="flex items-center gap-2">
            {toast.kind === 'ok' && <CheckCircle2 className="h-4 w-4" />}
            {toast.kind === 'queued' && <AlertCircle className="h-4 w-4" />}
            {toast.kind === 'error' && <AlertCircle className="h-4 w-4" />}
            <span>{toast.text}</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof User;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground text-[11px] font-medium uppercase">{label}</div>
        <div className="text-sm">{children}</div>
      </div>
    </div>
  );
}

function fmtDate(d: Date | string): string {
  const date = typeof d === 'string' ? new Date(d) : d;
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Stage 11 — формат окна «5 мая, 14:00 – 15:30» или «5 мая, 14:00» если end не задан.
 */
function fmtScheduleSlot(start: Date | string, end: Date | string | null): string {
  const s = typeof start === 'string' ? new Date(start) : start;
  const dayLabel = s.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
  const startTime = s.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (!end) return `${dayLabel}, ${startTime}`;
  const e = typeof end === 'string' ? new Date(end) : end;
  const endTime = e.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return `${dayLabel}, ${startTime} – ${endTime}`;
}
