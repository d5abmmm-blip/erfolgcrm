import { useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import {
  Archive,
  ArchiveRestore,
  Building2,
  ChevronLeft,
  Mail,
  MapPin,
  Pencil,
  Plus,
  User,
  Wrench,
} from 'lucide-react';
import { isLegacyId } from '@erfolg/shared';
import { LegacyBadge } from '../components/ui/LegacyBadge';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { StatusBadge } from '../components/ui/StatusBadge';
import { ASSET_STATUS_META } from '../lib/dictionaries';
import { ComposeEmailModal } from '../components/ComposeEmailModal';
import { ClientContacts } from '../components/ClientContacts';
import { ClientInvoices } from '../components/ClientInvoices';

export function ClientCardPage() {
  const [, params] = useRoute<{ id: string }>('/clients/:id');
  const [, navigate] = useLocation();
  const id = params?.id ?? '';
  const me = trpc.auth.me.useQuery();
  const isDirector = me.data?.user.role === 'director';
  const isStaff = isDirector || me.data?.user.role === 'dispatcher';

  const utils = trpc.useUtils();
  const client = trpc.clients.get.useQuery({ id }, { enabled: !!id });
  const assets = trpc.assets.byClient.useQuery({ clientId: id }, { enabled: !!id });

  const [archiveOpen, setArchiveOpen] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  const archive = trpc.clients.archive.useMutation({
    onSuccess: async () => {
      setArchiveOpen(false);
      await utils.clients.list.invalidate();
      navigate('/clients');
    },
  });

  const unarchive = trpc.clients.unarchive.useMutation({
    onSuccess: async () => {
      // Обязательно инвалидируем и саму карточку: без этого статус останется
      // «archived», кнопка не переключится и директор нажмёт ещё раз.
      // С карточки не уходим — человек вернул клиента, чтобы с ним работать.
      await Promise.all([utils.clients.get.invalidate({ id }), utils.clients.list.invalidate()]);
    },
  });

  if (client.isLoading) {
    return <div className="text-muted-foreground p-8 text-sm">Загрузка…</div>;
  }
  if (client.error || !client.data) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-4 text-sm">
          {client.error?.message ?? 'Клиент не найден'}
        </div>
      </div>
    );
  }

  const c = client.data;
  const isLegal = c.type === 'legal';

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <Link
          href="/clients"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" />К списку клиентов
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isStaff && (
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
            >
              <Mail className="h-3.5 w-3.5" />
              Написать письмо
            </button>
          )}
          <Link
            href={`/clients/${c.id}/edit`}
            className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition"
          >
            <Pencil className="h-3.5 w-3.5" />
            Редактировать
          </Link>
          {isDirector && (
            <Link
              href={`/clients/${c.id}/cabinet-users`}
              className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition"
            >
              Доступ в кабинет
            </Link>
          )}
          {isDirector && c.status === 'active' && (
            <button
              type="button"
              onClick={() => setArchiveOpen(true)}
              className="hover:bg-muted text-muted-foreground inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition"
            >
              <Archive className="h-3.5 w-3.5" />
              Архивировать
            </button>
          )}
          {isDirector && c.status === 'archived' && (
            <button
              type="button"
              disabled={unarchive.isPending}
              onClick={() => unarchive.mutate({ id: c.id })}
              className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-50"
            >
              <ArchiveRestore className="h-3.5 w-3.5" />
              {unarchive.isPending ? 'Возвращаем…' : 'Вернуть из архива'}
            </button>
          )}
        </div>
      </div>

      <header className="bg-card flex flex-wrap items-start justify-between gap-3 rounded-lg border p-4 md:p-6">
        <div className="flex items-start gap-3">
          <div
            className={cn(
              'flex h-10 w-10 items-center justify-center rounded-md',
              isLegal ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground',
            )}
          >
            {isLegal ? <Building2 className="h-5 w-5" /> : <User className="h-5 w-5" />}
          </div>
          <div>
            <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              {isLegal
                ? c.subtype === 'budget'
                  ? 'Бюджетная организация'
                  : 'Юридическое лицо'
                : 'Физическое лицо'}
            </div>
            <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">{c.displayName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {c.status === 'archived' && (
                <span className="bg-muted text-muted-foreground inline-flex items-center rounded-md px-2 py-0.5 text-xs">
                  В архиве
                </span>
              )}
              {isLegacyId(c.id) && <LegacyBadge />}
            </div>
          </div>
        </div>
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="bg-card rounded-lg border p-4 md:p-6 lg:col-span-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide">Реквизиты</h2>
          <dl className="mt-3 space-y-2 text-sm">
            {isLegal ? (
              <>
                <Field label="ИНН">{c.inn ?? '—'}</Field>
                <Field label="КПП">{c.kpp ?? '—'}</Field>
                <Field label="ОГРН/ОГРНИП">{c.ogrn ?? '—'}</Field>
                <Field label="Адрес">{c.legalAddress ?? '—'}</Field>
                <Field label="Телефон">{c.phone ?? '—'}</Field>
                <Field label="Email">{c.email ?? '—'}</Field>
                {c.subtype === 'budget' && (
                  <div className="border-accent/40 mt-3 space-y-2 border-l-2 pl-3">
                    <div className="text-muted-foreground text-xs uppercase">
                      Счета казначейства
                    </div>
                    <Field label="Счёт казначейства">{c.treasuryAccount ?? '—'}</Field>
                    <Field label="ЕКС">{c.eksAccount ?? '—'}</Field>
                    <Field label="Лицевой счёт">{c.personalAccount ?? '—'}</Field>
                  </div>
                )}
              </>
            ) : (
              <>
                <Field label="ФИО">{c.individualFullName ?? '—'}</Field>
                <Field label="Телефон">{c.individualPhone ?? '—'}</Field>
                <Field label="Адрес">{c.individualAddress ?? '—'}</Field>
              </>
            )}
            {c.notes && (
              <div className="text-muted-foreground border-t pt-2">
                <div className="text-xs uppercase tracking-wide">Заметки</div>
                <div className="text-foreground mt-1">{c.notes}</div>
              </div>
            )}
          </dl>
        </section>

        <ClientContacts clientId={c.id} contacts={c.contacts} canDelete={isDirector} />
      </div>

      {isStaff && <ClientInvoices clientId={c.id} />}

      <section className="bg-card rounded-lg border">
        <div className="flex items-center justify-between p-4 md:p-6">
          <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
            <Wrench className="h-4 w-4" />
            Техника клиента ({assets.data?.length ?? 0})
          </h2>
          <Link
            href={`/assets/new?clientId=${c.id}`}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
          >
            <Plus className="h-3.5 w-3.5" />
            Добавить технику
          </Link>
        </div>
        {assets.isLoading ? (
          <div className="text-muted-foreground p-8 text-sm">Загрузка…</div>
        ) : !assets.data || assets.data.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            У клиента пока нет техники
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Модель</th>
                <th className="px-3 py-2 text-left font-medium">Серийный №</th>
                <th className="px-3 py-2 text-left font-medium">Производитель</th>
                <th className="px-3 py-2 text-left font-medium">Статус</th>
                <th className="px-3 py-2 text-left font-medium">Класс</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {assets.data.map((a) => {
                const meta = ASSET_STATUS_META[a.lifecycleStatus];
                return (
                  <tr key={a.id} className="hover:bg-muted/20">
                    <td className="px-3 py-2">
                      <Link
                        href={`/assets/${a.id}`}
                        className="text-foreground hover:text-primary font-medium"
                      >
                        {a.model}
                      </Link>
                    </td>
                    <td className="px-3 py-2 font-mono text-xs">{a.serialNumber ?? '—'}</td>
                    <td className="px-3 py-2">{a.manufacturer ?? '—'}</td>
                    <td className="px-3 py-2">
                      {meta ? (
                        <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>
                      ) : (
                        <StatusBadge variant="muted">{a.lifecycleStatus}</StatusBadge>
                      )}
                    </td>
                    <td className="px-3 py-2">{a.riskClass ?? '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <ConfirmDialog
        open={archiveOpen}
        title="Архивировать клиента"
        description={`Клиент «${c.displayName}» будет переведён в архив: его нельзя будет выбрать в новой заявке, счёте или договоре, а вход в личный кабинет закроется. Карточка останется во вкладке «Архив», и клиента можно вернуть обратно.`}
        confirmText="Архивировать"
        variant="danger"
        loading={archive.isPending}
        onConfirm={() => archive.mutate({ id: c.id })}
        onCancel={() => setArchiveOpen(false)}
      />

      <ComposeEmailModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        initialTo={c.email ?? ''}
        relatedClientId={c.id}
        templateVars={{ clientName: c.displayName, company: me.data?.tenant.displayName }}
      />
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      <dt className="text-muted-foreground text-xs uppercase">{label}</dt>
      <dd className="col-span-2">{children}</dd>
    </div>
  );
}

// MapPin импортирован но не используется напрямую — оставляю для будущих локаций
void MapPin;
