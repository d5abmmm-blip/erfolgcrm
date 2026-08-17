/**
 * Блок «КП (версии)» на карточке заявки (перенос из v1).
 *
 * История коммерческих предложений: v1 отправили → клиент попросил скидку → v2 → approve.
 * Утверждённая версия одна (approve демотирует прочие на сервере), не редактируется
 * и не удаляется. Суммы — копейки (formatRub).
 */
import { useState } from 'react';
import { BadgeCheck, FileText, Plus, Send, Trash2, Undo2, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { formatRub, parseRubToKopecks } from '../lib/money';
import { StatusBadge, type StatusBadgeVariant } from './ui/StatusBadge';
import { ConfirmDialog } from './ui/ConfirmDialog';

type KpStatus = 'draft' | 'sent' | 'approved' | 'rejected' | 'revision';

const STATUS_META: Record<KpStatus, { label: string; variant: StatusBadgeVariant }> = {
  draft: { label: 'Черновик', variant: 'muted' },
  sent: { label: 'Отправлено', variant: 'info' },
  approved: { label: 'Утверждено', variant: 'success' },
  rejected: { label: 'Отклонено', variant: 'danger' },
  revision: { label: 'На доработке', variant: 'warning' },
};

interface Props {
  ticketId: string;
  canManage: boolean;
}

export function TicketKpBlock({ ticketId, canManage }: Props) {
  const utils = trpc.useUtils();
  const list = trpc.ticketKp.listByTicket.useQuery({ ticketId });

  const [formOpen, setFormOpen] = useState(false);
  const [description, setDescription] = useState('');
  const [worksRub, setWorksRub] = useState('');
  const [partsRub, setPartsRub] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [approveId, setApproveId] = useState<string | null>(null);
  const [archiveId, setArchiveId] = useState<string | null>(null);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const invalidate = () => utils.ticketKp.listByTicket.invalidate({ ticketId });

  const create = trpc.ticketKp.create.useMutation({
    onSuccess: async () => {
      setFormOpen(false);
      setDescription('');
      setWorksRub('');
      setPartsRub('');
      setError(null);
      await invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const update = trpc.ticketKp.update.useMutation({
    onSuccess: async () => {
      setRejectId(null);
      setRejectReason('');
      setError(null);
      await invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const approve = trpc.ticketKp.approve.useMutation({
    onSuccess: async () => {
      setApproveId(null);
      await invalidate();
    },
    onError: (e) => {
      setApproveId(null);
      setError(e.message);
    },
  });
  const archive = trpc.ticketKp.archive.useMutation({
    onSuccess: async () => {
      setArchiveId(null);
      await invalidate();
    },
    onError: (e) => {
      setArchiveId(null);
      setError(e.message);
    },
  });

  const items = list.data ?? [];

  const submitCreate = () => {
    setError(null);
    if (!description.trim()) {
      setError('Опишите предложение');
      return;
    }
    const works = rubToKopecks(worksRub);
    const parts = rubToKopecks(partsRub);
    if (works === null || parts === null) {
      setError('Сумму не понял. Введите число, например: 120 000');
      return;
    }
    create.mutate({
      ticketId,
      worksAmountKopecks: works,
      partsAmountKopecks: parts,
      description: description.trim(),
    });
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <FileText className="h-4 w-4" />
          КП — версии ({items.length})
        </h3>
        {canManage && !formOpen && (
          <button
            type="button"
            onClick={() => setFormOpen(true)}
            className="text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            Новая версия
          </button>
        )}
      </div>

      {error && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 mb-2 rounded-md border p-2 text-xs">
          {error}
        </div>
      )}

      {formOpen && (
        <div className="bg-muted/40 mb-3 space-y-2 rounded-md border p-3">
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Что входит в предложение, условия…"
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
          <div className="grid grid-cols-2 gap-2">
            <label className="text-xs">
              <span className="text-muted-foreground mb-1 block">Работы, ₽</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={worksRub}
                onChange={(e) => setWorksRub(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </label>
            <label className="text-xs">
              <span className="text-muted-foreground mb-1 block">Запчасти, ₽</span>
              <input
                type="number"
                min="0"
                step="0.01"
                value={partsRub}
                onChange={(e) => setPartsRub(e.target.value)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </label>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setFormOpen(false)}
              className="hover:bg-muted rounded-md border px-2.5 py-1.5 text-xs"
            >
              Отмена
            </button>
            <button
              type="button"
              disabled={create.isPending}
              onClick={submitCreate}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
            >
              {create.isPending ? 'Создание…' : 'Создать версию'}
            </button>
          </div>
        </div>
      )}

      {list.isLoading ? (
        <p className="text-muted-foreground text-sm">Загрузка…</p>
      ) : items.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          Версий КП пока нет{canManage ? ' — создайте первую' : ''}.
        </p>
      ) : (
        <ol className="space-y-2">
          {items.map((kp) => {
            const meta = STATUS_META[kp.status];
            const isApproved = kp.status === 'approved';
            return (
              <li key={kp.id} className="rounded-md border p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-semibold">v{kp.version}</span>
                    <StatusBadge variant={meta.variant} compact>
                      {meta.label}
                    </StatusBadge>
                    <span className="text-sm font-semibold tabular-nums">
                      {formatRub(kp.totalAmountKopecks)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      (работы {formatRub(kp.worksAmountKopecks)} + запчасти{' '}
                      {formatRub(kp.partsAmountKopecks)})
                    </span>
                  </div>
                  {canManage && (
                    <div className="flex items-center gap-1">
                      {kp.status === 'draft' && (
                        <ActionBtn
                          icon={Send}
                          label="Отправлено клиенту"
                          onClick={() => update.mutate({ id: kp.id, patch: { status: 'sent' } })}
                        />
                      )}
                      {(kp.status === 'sent' || kp.status === 'revision') && (
                        <>
                          <ActionBtn
                            icon={BadgeCheck}
                            label="Утвердить"
                            tone="success"
                            onClick={() => setApproveId(kp.id)}
                          />
                          <ActionBtn
                            icon={X}
                            label="Отклонить"
                            tone="danger"
                            onClick={() => {
                              setRejectId(kp.id);
                              setRejectReason('');
                            }}
                          />
                        </>
                      )}
                      {kp.status === 'sent' && (
                        <ActionBtn
                          icon={Undo2}
                          label="На доработку"
                          onClick={() =>
                            update.mutate({ id: kp.id, patch: { status: 'revision' } })
                          }
                        />
                      )}
                      {!isApproved && (
                        <ActionBtn
                          icon={Trash2}
                          label="Удалить версию"
                          tone="danger"
                          onClick={() => setArchiveId(kp.id)}
                        />
                      )}
                    </div>
                  )}
                </div>
                <p className="text-muted-foreground mt-1 whitespace-pre-line text-xs">
                  {kp.description}
                </p>
                <div className="text-muted-foreground mt-1 flex flex-wrap gap-x-3 text-[11px]">
                  {kp.createdByName && <span>{kp.createdByName}</span>}
                  <span>создано {formatDateTime(kp.createdAt)}</span>
                  {kp.sentAt && <span>отправлено {formatDateTime(kp.sentAt)}</span>}
                  {kp.respondedAt && <span>ответ {formatDateTime(kp.respondedAt)}</span>}
                </div>
                {kp.rejectionReason && (
                  <p className="text-destructive mt-1 text-[11px]">Причина: {kp.rejectionReason}</p>
                )}

                {rejectId === kp.id && (
                  <div className="bg-muted/40 mt-2 space-y-2 rounded-md border p-2">
                    <input
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="Причина отклонения"
                      className="bg-background focus:ring-primary/40 w-full rounded-md border px-2.5 py-1.5 text-xs outline-none focus:ring-2"
                    />
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setRejectId(null)}
                        className="hover:bg-muted rounded-md border px-2 py-1 text-xs"
                      >
                        Отмена
                      </button>
                      <button
                        type="button"
                        disabled={update.isPending}
                        onClick={() =>
                          update.mutate({
                            id: kp.id,
                            patch: {
                              status: 'rejected',
                              rejectionReason: rejectReason.trim() || null,
                            },
                          })
                        }
                        className="bg-destructive hover:bg-destructive/90 rounded-md px-2.5 py-1 text-xs font-medium text-white disabled:opacity-50"
                      >
                        Отклонить
                      </button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}

      <ConfirmDialog
        open={!!approveId}
        title="Утвердить версию КП?"
        description="Версия станет согласованной оценкой. Другие утверждённые версии этой заявки будут автоматически отклонены."
        confirmText="Утвердить"
        loading={approve.isPending}
        onConfirm={() => approveId && approve.mutate({ id: approveId })}
        onCancel={() => setApproveId(null)}
      />
      <ConfirmDialog
        open={!!archiveId}
        title="Удалить версию КП?"
        description="Версия будет скрыта из истории (мягкое удаление)."
        confirmText="Удалить"
        variant="danger"
        loading={archive.isPending}
        onConfirm={() => archiveId && archive.mutate({ id: archiveId })}
        onCancel={() => setArchiveId(null)}
      />
    </div>
  );
}

function ActionBtn({
  icon: Icon,
  label,
  tone,
  onClick,
}: {
  icon: typeof Send;
  label: string;
  tone?: 'success' | 'danger';
  onClick: () => void;
}) {
  const toneCls =
    tone === 'success'
      ? 'hover:text-success'
      : tone === 'danger'
        ? 'hover:text-destructive'
        : 'hover:text-foreground';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`text-muted-foreground hover:bg-muted grid h-7 w-7 place-items-center rounded ${toneCls}`}
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

/**
 * Пусто — ноль (строку не заполнили), непонятный ввод — null, и предложение не
 * отправляется. Раньше здесь стоял parseFloat, и «120 000» молча становилось 120 ₽ —
 * в цифре, которую видит клиент.
 */
function rubToKopecks(v: string): number | null {
  if (!v.trim()) return 0;
  const kopecks = parseRubToKopecks(v);
  if (kopecks === null || kopecks < 0) return null;
  return kopecks;
}

function formatDateTime(d: Date | string): string {
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}
