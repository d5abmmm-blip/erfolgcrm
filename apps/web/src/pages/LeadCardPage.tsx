/**
 * Карточка лида: данные + воронка (смена стадии) + конвертация в клиента + архив.
 * Маршрут: /leads/:id.
 */
import { useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import {
  Archive,
  ChevronLeft,
  Loader2,
  Pencil,
  Target,
  UserPlus,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import {
  LEAD_LOST_REASON_LABEL,
  LEAD_SOURCE_LABEL,
  LEAD_STATUS_META,
  LEAD_TRANSITIONS,
  formatLeadMoney,
  type LeadLostReason,
  type LeadStatus,
} from './leads.shared';

export function LeadCardPage() {
  const [, navigate] = useLocation();
  const [, params] = useRoute('/leads/:id');
  const id = params?.id ?? '';
  const utils = trpc.useUtils();

  const lead = trpc.leads.get.useQuery({ id }, { enabled: !!id });

  const [lostOpen, setLostOpen] = useState(false);
  const [lostReason, setLostReason] = useState<LeadLostReason>('no_response');
  const [lostComment, setLostComment] = useState('');
  const [convertOpen, setConvertOpen] = useState(false);
  const [clientType, setClientType] = useState<'legal' | 'individual'>('legal');
  const [inn, setInn] = useState('');
  const [kpp, setKpp] = useState('');
  const [archiveOpen, setArchiveOpen] = useState(false);

  const invalidate = async () => {
    await Promise.all([
      utils.leads.get.invalidate({ id }),
      utils.leads.list.invalidate(),
      utils.leads.funnelStats.invalidate(),
    ]);
  };

  const update = trpc.leads.update.useMutation({
    onSuccess: async () => {
      await invalidate();
      setLostOpen(false);
    },
  });
  const convert = trpc.leads.convertToClient.useMutation({
    onSuccess: async (res) => {
      await invalidate();
      navigate(`/clients/${res.clientId}`);
    },
  });
  const archive = trpc.leads.archive.useMutation({
    onSuccess: async () => {
      await invalidate();
      navigate('/leads');
    },
  });

  if (lead.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (lead.error || !lead.data) {
    return (
      <div className="mx-auto max-w-3xl space-y-3 p-6">
        <Link href="/leads" className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm">
          <ChevronLeft className="h-4 w-4" /> К списку лидов
        </Link>
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
          {lead.error?.message ?? 'Лид не найден'}
        </div>
      </div>
    );
  }

  const l = lead.data;
  const meta = LEAD_STATUS_META[l.status];
  const nextStatuses = LEAD_TRANSITIONS[l.status];
  const canConvert = l.status !== 'lost' && !l.convertedClientId;
  const actionError = update.error?.message ?? convert.error?.message ?? null;

  const setStatus = (to: LeadStatus) => {
    if (to === 'lost') {
      setLostOpen(true);
      return;
    }
    update.mutate({ id, patch: { status: to } });
  };

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Link
        href="/leads"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        К списку лидов
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <Target className="h-3.5 w-3.5" />
            Лид
          </div>
          <h1 className="mt-0.5 flex items-center gap-2 text-xl font-semibold md:text-2xl">
            {l.name}
            <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>
            <ScoreBadge score={l.score} />
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href={`/leads/${id}/edit`}
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm"
          >
            <Pencil className="h-4 w-4" />
            Изменить
          </Link>
          <button
            type="button"
            onClick={() => setArchiveOpen(true)}
            className="text-muted-foreground hover:bg-muted hover:text-destructive inline-flex items-center gap-1.5 rounded-md border px-3 py-2 text-sm"
          >
            <Archive className="h-4 w-4" />
            Архив
          </button>
        </div>
      </div>

      {l.convertedClientId && (
        <div className="bg-success/10 text-success border-success/30 rounded-md border p-3 text-sm">
          Лид сконвертирован в клиента.{' '}
          <Link href={`/clients/${l.convertedClientId}`} className="font-medium underline">
            Открыть карточку клиента →
          </Link>
        </div>
      )}

      {/* Воронка: смена стадии */}
      {(nextStatuses.length > 0 || canConvert) && (
        <div className="bg-card space-y-3 rounded-lg border p-4">
          <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
            Действия по воронке
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {nextStatuses.map((s) => {
              const m = LEAD_STATUS_META[s];
              const isLost = s === 'lost';
              return (
                <button
                  key={s}
                  type="button"
                  disabled={update.isPending}
                  onClick={() => setStatus(s)}
                  className={
                    'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-50 ' +
                    (isLost
                      ? 'text-destructive hover:bg-destructive/10'
                      : 'hover:bg-muted')
                  }
                >
                  → {m.label}
                </button>
              );
            })}
            {canConvert && (
              <button
                type="button"
                onClick={() => setConvertOpen((v) => !v)}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
              >
                <UserPlus className="h-4 w-4" />
                Конвертировать в клиента
              </button>
            )}
          </div>

          {actionError && (
            <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2 text-xs">
              {actionError}
            </div>
          )}

          {/* Панель «проигран» */}
          {lostOpen && (
            <div className="bg-muted/40 space-y-2 rounded-md border p-3">
              <div className="text-sm font-medium">Причина проигрыша</div>
              <select
                value={lostReason}
                onChange={(e) => setLostReason(e.target.value as LeadLostReason)}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              >
                {(Object.keys(LEAD_LOST_REASON_LABEL) as LeadLostReason[]).map((r) => (
                  <option key={r} value={r}>
                    {LEAD_LOST_REASON_LABEL[r]}
                  </option>
                ))}
              </select>
              <textarea
                rows={2}
                value={lostComment}
                onChange={(e) => setLostComment(e.target.value)}
                placeholder="Комментарий (необязательно)"
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setLostOpen(false)}
                  className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={update.isPending}
                  onClick={() =>
                    update.mutate({
                      id,
                      patch: {
                        status: 'lost',
                        lostReason,
                        lostComment: lostComment.trim() || null,
                      },
                    })
                  }
                  className="bg-destructive hover:bg-destructive/90 rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
                >
                  Пометить проигранным
                </button>
              </div>
            </div>
          )}

          {/* Панель конвертации */}
          {convertOpen && canConvert && (
            <div className="bg-muted/40 space-y-2 rounded-md border p-3">
              <div className="text-sm font-medium">Создать клиента из лида</div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
                <select
                  value={clientType}
                  onChange={(e) => setClientType(e.target.value as 'legal' | 'individual')}
                  className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                >
                  <option value="legal">Юрлицо</option>
                  <option value="individual">Физлицо</option>
                </select>
                {clientType === 'legal' && (
                  <>
                    <input
                      value={inn}
                      onChange={(e) => setInn(e.target.value)}
                      placeholder="ИНН"
                      className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                    />
                    <input
                      value={kpp}
                      onChange={(e) => setKpp(e.target.value)}
                      placeholder="КПП"
                      className="bg-background focus:ring-primary/40 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
                    />
                  </>
                )}
              </div>
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setConvertOpen(false)}
                  className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm"
                >
                  Отмена
                </button>
                <button
                  type="button"
                  disabled={convert.isPending}
                  onClick={() =>
                    convert.mutate({
                      leadId: id,
                      clientType,
                      inn: clientType === 'legal' ? inn.trim() || null : null,
                      kpp: clientType === 'legal' ? kpp.trim() || null : null,
                    })
                  }
                  className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
                >
                  {convert.isPending ? 'Создаём…' : 'Создать клиента'}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Данные лида */}
      <div className="bg-card grid grid-cols-1 gap-x-6 gap-y-3 rounded-lg border p-4 sm:grid-cols-2">
        <Info label="Контактное лицо" value={l.contactPerson} />
        <Info label="Телефон" value={l.phone} />
        <Info label="Email" value={l.email} />
        <Info label="Регион" value={l.region} />
        <Info label="Источник" value={LEAD_SOURCE_LABEL[l.source]} />
        <Info label="Сумма сделки" value={formatLeadMoney(l.estimatedValue)} />
        <Info label="Ответственный" value={l.assignedUserName} />
        <Info label="Следующий шаг" value={l.nextAction} />
        <Info label="Дата следующего шага" value={formatDate(l.nextActionDate)} />
        {l.status === 'lost' && (
          <Info
            label="Причина проигрыша"
            value={l.lostReason ? LEAD_LOST_REASON_LABEL[l.lostReason] : null}
          />
        )}
        <Info label="Создан" value={formatDate(l.createdAt)} />
      </div>

      {l.notes && (
        <div className="bg-card rounded-lg border p-4">
          <div className="text-muted-foreground mb-1 text-xs font-medium uppercase tracking-wide">
            Заметки
          </div>
          <p className="whitespace-pre-line text-sm">{l.notes}</p>
        </div>
      )}

      <ConfirmDialog
        open={archiveOpen}
        title="Архивировать лид?"
        description="Лид будет скрыт из списка. Данные сохранятся (мягкое удаление)."
        confirmText="Архивировать"
        variant="danger"
        loading={archive.isPending}
        onConfirm={() => archive.mutate({ id })}
        onCancel={() => setArchiveOpen(false)}
      />
    </div>
  );
}

function Info({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <div className="text-muted-foreground text-xs">{label}</div>
      <div className="text-sm">{value || <span className="text-muted-foreground">—</span>}</div>
    </div>
  );
}

function ScoreBadge({ score }: { score: number }) {
  const variant: StatusBadgeVariant = score >= 70 ? 'success' : score >= 40 ? 'warning' : 'muted';
  return (
    <StatusBadge variant={variant} compact>
      скоринг {score}
    </StatusBadge>
  );
}

function formatDate(iso: string | Date | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleDateString('ru-RU');
}
