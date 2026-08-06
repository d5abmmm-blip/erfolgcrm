import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import {
  Activity,
  Archive,
  Award,
  Building2,
  ChevronLeft,
  History,
  MapPin,
  Pencil,
  Plus,
  Sparkles,
  StickyNote,
  Tag,
  Wrench,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { openPrintWindow } from '../lib/open-print-window';
import { cn } from '../lib/utils';
import { PromptDialog } from '../components/ui';
import { SimilarCasesBlock } from '../components/SimilarCasesBlock';

const STATUS_LABELS: Record<string, { label: string; cls: string }> = {
  in_service: { label: 'В работе', cls: 'bg-success/10 text-success' },
  in_repair: { label: 'В ремонте', cls: 'bg-warning/15 text-warning' },
  awaiting_parts: { label: 'Ждёт запчасти', cls: 'bg-warning/15 text-warning' },
  reserve: { label: 'Резерв', cls: 'bg-muted text-muted-foreground' },
  decommissioned: { label: 'Списана', cls: 'bg-destructive/10 text-destructive' },
};

export function AssetCardPage() {
  const [, params] = useRoute<{ id: string }>('/assets/:id');
  const id = params?.id ?? '';
  const me = trpc.auth.me.useQuery();
  const isDirector = me.data?.user.role === 'director';

  const utils = trpc.useUtils();
  const asset = trpc.assets.get.useQuery({ id }, { enabled: !!id });
  const events = trpc.assets.events.useQuery({ assetId: id }, { enabled: !!id });

  const [statusDraft, setStatusDraft] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [decommissionOpen, setDecommissionOpen] = useState(false);

  const updateStatus = trpc.assets.update.useMutation({
    onSuccess: async () => {
      setStatusDraft(null);
      await Promise.all([
        utils.assets.get.invalidate({ id }),
        utils.assets.events.invalidate({ assetId: id }),
      ]);
    },
  });
  const addNote = trpc.assets.addNote.useMutation({
    onSuccess: async () => {
      setNoteDraft('');
      await utils.assets.events.invalidate({ assetId: id });
    },
  });
  const decommission = trpc.assets.decommission.useMutation({
    onSuccess: async () => {
      setDecommissionOpen(false);
      await Promise.all([
        utils.assets.get.invalidate({ id }),
        utils.assets.events.invalidate({ assetId: id }),
      ]);
    },
  });

  if (asset.isLoading) {
    return <div className="text-muted-foreground p-8 text-sm">Загрузка…</div>;
  }
  if (asset.error || !asset.data) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-4 text-sm">
          {asset.error?.message ?? 'Техника не найдена'}
        </div>
      </div>
    );
  }
  const a = asset.data;
  const statusBadge = STATUS_LABELS[a.lifecycleStatus] ?? {
    label: a.lifecycleStatus,
    cls: 'bg-muted text-muted-foreground',
  };

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        {a.ownerClientId ? (
          <Link
            href={`/clients/${a.ownerClientId}`}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ChevronLeft className="h-4 w-4" />К карточке клиента
          </Link>
        ) : (
          <Link
            href="/assets"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
          >
            <ChevronLeft className="h-4 w-4" />К списку техники
          </Link>
        )}
        <div className="flex items-center gap-2">
          <Link
            href={`/assets/${a.id}/edit`}
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition"
          >
            <Pencil className="h-3.5 w-3.5" />
            Редактировать
          </Link>
          <button
            type="button"
            onClick={() =>
              void (async () => {
                const win = openPrintWindow();
                const [{ printAssetLabel }, { ERFOLG_FALLBACK }] = await Promise.all([
                  import('../lib/pdf'),
                  import('../lib/pdf/branding'),
                ]);
                await printAssetLabel(
                  {
                    asset: {
                      model: a.model,
                      manufacturer: a.manufacturer ?? null,
                      serialNumber: a.serialNumber ?? null,
                      inventoryNumber: a.inventoryNumber ?? null,
                      riskClass: a.riskClass ?? null,
                    },
                    ticket: null,
                    fallbackBarcode: a.id,
                    tenantDisplayName: ERFOLG_FALLBACK.displayName,
                  },
                  win,
                );
              })()
            }
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition"
          >
            <Tag className="h-3.5 w-3.5" />
            Ярлык
          </button>
        </div>
      </div>

      <header className="bg-card rounded-lg border p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex items-start gap-3">
            <div className="bg-primary/10 text-primary flex h-10 w-10 items-center justify-center rounded-md">
              <Wrench className="h-5 w-5" />
            </div>
            <div>
              <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Техника
              </div>
              <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">{a.model}</h1>
              {a.deviceType && <div className="text-muted-foreground text-sm">{a.deviceType}</div>}
              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs">
                <span
                  className={cn(
                    'inline-flex items-center rounded-md px-2 py-0.5 font-medium',
                    statusBadge.cls,
                  )}
                >
                  {statusBadge.label}
                </span>
                {a.serialNumber && (
                  <span className="text-muted-foreground font-mono">s/n {a.serialNumber}</span>
                )}
                {a.requiredAttestationCategory && (
                  <span
                    title={`Требуемая категория аттестации: ${a.requiredAttestationCategory}`}
                    className="bg-warning/15 text-warning inline-flex items-center gap-1 rounded-md px-2 py-0.5"
                  >
                    <Award className="h-3 w-3" />
                    нужна аттестация
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
          <InfoBlock label="Владелец" icon={<Building2 className="h-3.5 w-3.5" />}>
            {a.ownerClientId ? (
              <Link
                href={`/clients/${a.ownerClientId}`}
                className="text-foreground hover:text-primary"
              >
                {a.ownerDisplayName}
              </Link>
            ) : (
              <span className="text-muted-foreground">— без клиента</span>
            )}
          </InfoBlock>
          <InfoBlock label="Производитель">{a.manufacturer ?? '—'}</InfoBlock>
          <InfoBlock label="Тип">{a.deviceType ?? '—'}</InfoBlock>
          <InfoBlock label="Класс риска">{a.riskClass ?? '—'}</InfoBlock>
          <InfoBlock label="Гарантия до">{a.warrantyUntil ?? '—'}</InfoBlock>
          <InfoBlock label="Введена в эксплуатацию">{a.commissionedAt ?? '—'}</InfoBlock>
          <InfoBlock label="Инв. №">{a.inventoryNumber ?? '—'}</InfoBlock>
          <InfoBlock label="Расположение" icon={<MapPin className="h-3.5 w-3.5" />}>
            {a.location ?? '—'}
          </InfoBlock>
          <InfoBlock
            label="Категория аттестации инженеров"
            icon={<Award className="h-3.5 w-3.5" />}
          >
            {a.requiredAttestationCategory ?? '—'}
          </InfoBlock>
        </div>

        {a.notes && (
          <div className="bg-muted/30 mt-4 rounded-md border p-3 text-sm">
            <div className="text-muted-foreground mb-1 text-xs uppercase">Заметки</div>
            {a.notes}
          </div>
        )}
      </header>

      <SimilarCasesBlock assetId={a.id} />

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="bg-card rounded-lg border p-4 md:p-6 lg:col-span-2">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
            <History className="h-4 w-4" />
            Хронология ({events.data?.length ?? 0})
          </h2>
          <ol className="mt-4 space-y-3">
            {events.isLoading ? (
              <li className="text-muted-foreground text-sm">Загрузка…</li>
            ) : (events.data ?? []).length === 0 ? (
              <li className="text-muted-foreground text-sm">Событий пока нет</li>
            ) : (
              (events.data ?? []).map((ev) => <EventRow key={ev.id} event={ev} />)
            )}
          </ol>
        </section>

        <section className="bg-card space-y-4 rounded-lg border p-4 md:p-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
            <Activity className="h-4 w-4" />
            Действия
          </h2>

          <div>
            <div className="text-muted-foreground mb-1 text-xs uppercase">Изменить статус</div>
            <div className="flex gap-2">
              <select
                value={statusDraft ?? a.lifecycleStatus}
                onChange={(e) => setStatusDraft(e.target.value)}
                className="bg-background focus:ring-primary/40 flex-1 rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
              >
                <option value="in_service">В работе</option>
                <option value="in_repair">В ремонте</option>
                <option value="awaiting_parts">Ждёт запчасти</option>
                <option value="reserve">Резерв</option>
                <option value="decommissioned">Списана</option>
              </select>
              <button
                type="button"
                disabled={
                  !statusDraft || statusDraft === a.lifecycleStatus || updateStatus.isPending
                }
                onClick={() =>
                  statusDraft &&
                  updateStatus.mutate({
                    id: a.id,
                    patch: { lifecycleStatus: statusDraft as 'in_service' },
                  })
                }
                className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
              >
                Применить
              </button>
            </div>
          </div>

          <div>
            <div className="text-muted-foreground mb-1 text-xs uppercase">Добавить заметку</div>
            <textarea
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
              rows={3}
              placeholder="Что произошло?"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
            />
            <button
              type="button"
              disabled={!noteDraft.trim() || addNote.isPending}
              onClick={() => addNote.mutate({ assetId: a.id, comment: noteDraft.trim() })}
              className="bg-primary text-primary-foreground hover:bg-primary/90 mt-2 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            >
              <Plus className="h-3.5 w-3.5" />
              Добавить
            </button>
          </div>

          {isDirector && a.lifecycleStatus !== 'decommissioned' && (
            <div className="border-t pt-4">
              <button
                type="button"
                onClick={() => setDecommissionOpen(true)}
                disabled={decommission.isPending}
                className="hover:bg-destructive/10 text-destructive border-destructive/30 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-50"
              >
                <Archive className="h-3.5 w-3.5" />
                Списать
              </button>
              <p className="text-muted-foreground mt-1 text-xs">
                Только для директора, оставляет запись в хронологии
              </p>
              <PromptDialog
                open={decommissionOpen}
                title="Списать технику?"
                description="Техника перейдёт в статус «Списана». Запись останется в хронологии."
                label="Причина списания (необязательна)"
                initialValue="Списание по решению директора"
                variant="danger"
                confirmText="Списать"
                loading={decommission.isPending}
                onConfirm={(reason) =>
                  decommission.mutate({ id: a.id, comment: reason.trim() || undefined })
                }
                onCancel={() => setDecommissionOpen(false)}
              />
            </div>
          )}
        </section>
      </div>
      {/* Sparkles imported for future event icon, suppress unused */}
      <span className="sr-only">
        <Sparkles className="hidden" />
      </span>
    </div>
  );
}

function InfoBlock({
  label,
  icon,
  children,
}: {
  label: string;
  icon?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-muted/30 rounded-md border p-2">
      <div className="text-muted-foreground flex items-center gap-1 text-[10px] uppercase tracking-wide">
        {icon}
        {label}
      </div>
      <div className="mt-0.5 truncate text-sm">{children}</div>
    </div>
  );
}

function EventRow({
  event,
}: {
  event: {
    id: string;
    type: string;
    userId: string | null;
    payload: { from?: unknown; to?: unknown; comment?: string };
    createdAt: Date;
  };
}) {
  const { type, payload, createdAt } = event;
  const ts = new Date(createdAt).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

  let icon = <StickyNote className="text-muted-foreground h-4 w-4" />;
  let title = 'Событие';
  let body: React.ReactNode = null;

  if (type === 'created') {
    icon = <Sparkles className="text-primary h-4 w-4" />;
    title = 'Техника заведена в системе';
  } else if (type === 'status_change') {
    icon = <Activity className="text-primary h-4 w-4" />;
    title = 'Изменение статуса';
    body = (
      <div className="text-muted-foreground text-xs">
        {STATUS_LABELS[String(payload.from)]?.label ?? String(payload.from)} →{' '}
        <span className="text-foreground font-medium">
          {STATUS_LABELS[String(payload.to)]?.label ?? String(payload.to)}
        </span>
      </div>
    );
  } else if (type === 'owner_change') {
    icon = <Building2 className="text-primary h-4 w-4" />;
    title = 'Смена владельца';
  } else if (type === 'location_change') {
    icon = <MapPin className="text-primary h-4 w-4" />;
    title = 'Перемещение';
    body = (
      <div className="text-muted-foreground text-xs">
        {typeof payload.from === 'string' ? payload.from : '—'} →{' '}
        {typeof payload.to === 'string' ? payload.to : '—'}
      </div>
    );
  } else if (type === 'note') {
    icon = <StickyNote className="text-warning h-4 w-4" />;
    title = 'Заметка';
    body = (
      <div className="text-foreground mt-0.5 whitespace-pre-wrap text-sm">{payload.comment}</div>
    );
  }

  return (
    <li className="flex gap-3">
      <div className="bg-muted/40 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full">
        {icon}
      </div>
      <div className="flex-1 border-b pb-3">
        <div className="flex items-baseline justify-between">
          <div className="text-sm font-medium">{title}</div>
          <div className="text-muted-foreground text-xs">{ts}</div>
        </div>
        {body}
      </div>
    </li>
  );
}
