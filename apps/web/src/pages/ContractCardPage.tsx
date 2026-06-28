/**
 * Карточка контракта: реквизиты, условия, привязанные заявки, скан подписанного экземпляра, печать PDF.
 *
 * RBAC:
 *   - Просмотр — engineer+.
 *   - Архивирование / правка — staff (RBAC проверяется на сервере; UI кнопки скрывает по роли).
 */
import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import { Archive, ChevronLeft, FileSignature, Pencil, Printer } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { openPrintWindow } from '../lib/open-print-window';
import { PhotoUploader } from '../components/PhotoUploader';
import { ConfirmDialog } from '../components/ui';
import { cn } from '../lib/utils';

const TYPE_LABEL: Record<string, string> = {
  service: 'Сервисный (рамочный)',
  one_time: 'Разовый',
};

const STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Черновик', cls: 'bg-muted text-muted-foreground' },
  active: { label: 'Действует', cls: 'bg-success/10 text-success' },
  expired: { label: 'Истёк', cls: 'bg-warning/15 text-warning' },
  terminated: { label: 'Расторгнут', cls: 'bg-destructive/10 text-destructive' },
};

const VAT_LABEL: Record<string, string> = {
  '0': '0%',
  '5': '5%',
  '10': '10%',
  '20': '20%',
  without_vat: 'Без НДС',
};

export function ContractCardPage() {
  const [, params] = useRoute('/contracts/:id');
  const id = params?.id ?? '';

  const me = trpc.auth.me.useQuery();
  const role = me.data?.user.role;
  const canEdit = role === 'director' || role === 'dispatcher';

  const detail = trpc.contracts.get.useQuery({ id }, { enabled: !!id });
  const linked = trpc.tickets.list.useQuery(
    { contractId: id, pageSize: 50 },
    { enabled: !!id },
  );

  const utils = trpc.useUtils();
  const [archiveOpen, setArchiveOpen] = useState(false);
  const archive = trpc.contracts.archive.useMutation({
    onSuccess: async () => {
      setArchiveOpen(false);
      await utils.contracts.list.invalidate();
      await utils.contracts.get.invalidate({ id });
    },
  });

  const [printing, setPrinting] = useState(false);

  const handlePrint = async () => {
    if (!detail.data) return;
    setPrinting(true);
    const win = openPrintWindow();
    try {
      const [{ printContract }, { ERFOLG_FALLBACK }] = await Promise.all([
        import('../lib/pdf'),
        import('../lib/pdf/branding'),
      ]);
      const tenantData = { ...ERFOLG_FALLBACK };
      const c = detail.data;
      const clientData = {
        displayName: c.clientDisplayName,
        // Реквизиты клиента не приходят в contract DTO — вытянем минимум через clients.get,
        // но для PDF этого достаточно (легальный адрес опционален).
        inn: null,
        kpp: null,
        ogrn: null,
        legalAddress: null,
        contactName: null,
        contactPosition: null,
      };
      await printContract({
        tenant: tenantData,
        client: clientData,
        contract: {
          contractNumber: c.contractNumber,
          contractDate: c.contractDate,
          type: c.type,
          vatRate: c.vatRate,
          status: c.status,
          validFrom: c.validFrom,
          validUntil: c.validUntil,
          terms: c.terms,
          notes: c.notes,
        },
      }, win);
    } catch {
      win?.close();
    } finally {
      setPrinting(false);
    }
  };

  if (detail.isLoading) {
    return (
      <div className="text-muted-foreground p-8 text-center text-sm">Загрузка…</div>
    );
  }
  if (detail.error || !detail.data) {
    return (
      <div className="mx-auto max-w-5xl p-6">
        <Link
          href="/contracts"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" />К списку
        </Link>
        <div className="text-destructive mt-4">
          {detail.error?.message ?? 'Контракт не найден'}
        </div>
      </div>
    );
  }

  const c = detail.data;
  const badge = STATUS_BADGE[c.status] ?? { label: c.status, cls: 'bg-muted text-muted-foreground' };

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <Link
        href="/contracts"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К списку договоров
      </Link>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
            <FileSignature className="h-3.5 w-3.5" />
            {TYPE_LABEL[c.type] ?? c.type}
          </div>
          <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">
            № {c.contractNumber} от {formatDate(c.contractDate)}
          </h1>
          <p className="text-muted-foreground text-sm">
            <Link href={`/clients/${c.clientId}`} className="hover:text-primary underline-offset-4 hover:underline">
              {c.clientDisplayName}
            </Link>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={cn('inline-flex items-center rounded-md px-2 py-0.5 text-xs', badge.cls)}>
            {badge.label}
          </span>
          <button
            type="button"
            onClick={() => void handlePrint()}
            disabled={printing}
            className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            <Printer className="h-3.5 w-3.5" />
            {printing ? 'Готовлю…' : 'Печать PDF'}
          </button>
          {canEdit && (
            <Link
              href={`/contracts/${c.id}/edit`}
              className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium"
            >
              <Pencil className="h-3.5 w-3.5" />
              Редактировать
            </Link>
          )}
          {canEdit && c.status !== 'terminated' && (
            <>
              <button
                type="button"
                onClick={() => setArchiveOpen(true)}
                disabled={archive.isPending}
                className="hover:bg-destructive/10 hover:text-destructive inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                <Archive className="h-3.5 w-3.5" />
                Архив
              </button>
              <ConfirmDialog
                open={archiveOpen}
                title="Расторгнуть договор?"
                description={`Договор № ${c.contractNumber} будет помечен как расторгнутый и уйдёт в архив.`}
                variant="danger"
                confirmText="Расторгнуть"
                loading={archive.isPending}
                onConfirm={() => archive.mutate({ id: c.id })}
                onCancel={() => setArchiveOpen(false)}
              />
            </>
          )}
        </div>
      </div>

      <section className="bg-card rounded-lg border p-4 md:p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Реквизиты</h2>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm md:grid-cols-2">
          <Row label="НДС" value={VAT_LABEL[c.vatRate] ?? c.vatRate} />
          <Row label="Действует с" value={c.validFrom ? formatDate(c.validFrom) : 'с подписания'} />
          <Row
            label="Действует по"
            value={c.validUntil ? formatDate(c.validUntil) : 'бессрочно'}
          />
          <Row label="Создан" value={c.createdAt.toLocaleString('ru-RU')} />
        </dl>
      </section>

      <section className="bg-card rounded-lg border p-4 md:p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Условия</h2>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-2 text-sm md:grid-cols-2">
          <Row label="Срок выполнения" value={c.terms.performanceDays ? `${c.terms.performanceDays} дн.` : '—'} />
          <Row label="Гарантия" value={c.terms.warrantyMonths ? `${c.terms.warrantyMonths} мес.` : '—'} />
          <Row label="Предоплата" value={c.terms.prepaymentPercent !== undefined ? `${c.terms.prepaymentPercent}%` : '—'} />
          <Row label="Срок оплаты после акта" value={c.terms.paymentDueDays !== undefined ? `${c.terms.paymentDueDays} дн.` : '—'} />
          <Row label="Штраф за просрочку этапа" value={c.terms.performancePenaltyPercent !== undefined ? `${c.terms.performancePenaltyPercent}%` : '—'} />
          <Row label="Пеня за просрочку оплаты" value={c.terms.paymentPenaltyDailyPercent !== undefined ? `${c.terms.paymentPenaltyDailyPercent}% / день` : '—'} />
          {c.terms.notes && (
            <div className="md:col-span-2">
              <dt className="text-muted-foreground text-xs">Дополнительно</dt>
              <dd className="text-sm">{c.terms.notes}</dd>
            </div>
          )}
        </dl>
      </section>

      {c.notes && (
        <section className="bg-card rounded-lg border p-4 md:p-6">
          <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide">Внутренние заметки</h2>
          <p className="text-sm whitespace-pre-line">{c.notes}</p>
        </section>
      )}

      <section className="bg-card rounded-lg border p-4 md:p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">
          Привязанные заявки {linked.data ? `(${linked.data.total})` : ''}
        </h2>
        {linked.isLoading ? (
          <div className="text-muted-foreground text-sm">Загрузка…</div>
        ) : !linked.data || linked.data.items.length === 0 ? (
          <div className="text-muted-foreground text-sm">Заявок нет</div>
        ) : (
          <ul className="divide-y">
            {linked.data.items.map((t) => (
              <li key={t.id} className="flex items-center justify-between py-2 text-sm">
                <Link href={`/tickets/${t.id}`} className="font-mono hover:text-primary">
                  {t.ticketNumber}
                </Link>
                <span className="text-muted-foreground text-xs">
                  {t.status} · {t.priority}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="bg-card rounded-lg border p-4 md:p-6">
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Подписанный скан</h2>
        <PhotoUploader
          kind="contract_signed"
          referenceType="contract"
          referenceId={c.id}
          canUpload={canEdit}
          hint="PDF/JPEG/PNG до 25 МБ. Скан виден всем сотрудникам, имеющим доступ к договору."
        />
      </section>
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="text-sm">{value}</dd>
    </div>
  );
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU');
}
