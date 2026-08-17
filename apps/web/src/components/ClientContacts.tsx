import { useState } from 'react';
import { Mail, Pencil, Phone, Plus, Star, Trash2 } from 'lucide-react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { trpc } from '../lib/trpc';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { contactFormSchema, type ContactFormValues } from './ClientContacts.schemas';

export interface ClientContact {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  position: string | null;
  isPrimary: boolean;
}

/**
 * Контактные лица клиента: список, добавление, правка, удаление.
 *
 * Права повторяют сервер: править может любой из конторы (`updateContact` —
 * staffProcedure), удалять — только директор (`deleteContact` —
 * directorProcedure, действие необратимо). Менеджеру корзинку не показываем
 * вовсе: дразнить кнопкой, которая заведомо кончится отказом, — то же самое,
 * что и с корзинкой на чужом вложении.
 */
export function ClientContacts({
  clientId,
  contacts,
  canDelete,
}: {
  clientId: string;
  contacts: ClientContact[];
  canDelete: boolean;
}) {
  const utils = trpc.useUtils();
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ClientContact | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const refresh = () => utils.clients.get.invalidate({ id: clientId });

  const remove = trpc.clients.deleteContact.useMutation({
    onSuccess: async () => {
      setDeleting(null);
      setDeleteError(null);
      await refresh();
    },
    onError: (e) => setDeleteError(e.message),
  });

  return (
    <section className="bg-card rounded-lg border p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold uppercase tracking-wide">
          Контактные лица ({contacts.length})
        </h2>
      </div>

      <ul className="mt-3 space-y-3">
        {contacts.length === 0 ? (
          <li className="text-muted-foreground text-sm">Нет контактов</li>
        ) : (
          contacts.map((ct) =>
            editingId === ct.id ? (
              <li key={ct.id} className="border-primary/40 border-l-2 pl-3">
                <ContactForm
                  clientId={clientId}
                  contact={ct}
                  onDone={() => setEditingId(null)}
                  onCancel={() => setEditingId(null)}
                />
              </li>
            ) : (
              <li key={ct.id} className="border-border group border-l-2 pl-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-sm font-medium">
                      {ct.fullName ?? '—'}
                      {ct.isPrimary && <Star className="text-warning h-3.5 w-3.5 fill-current" />}
                    </div>
                    {ct.position && (
                      <div className="text-muted-foreground text-xs">{ct.position}</div>
                    )}
                    <div className="mt-1 flex flex-col gap-0.5 text-xs">
                      {ct.phone && (
                        <a
                          href={`tel:${ct.phone}`}
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                          <Phone className="h-3 w-3" />
                          {ct.phone}
                        </a>
                      )}
                      {ct.email && (
                        <a
                          href={`mailto:${ct.email}`}
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
                        >
                          <Mail className="h-3 w-3" />
                          {ct.email}
                        </a>
                      )}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      aria-label={`Изменить контакт ${ct.fullName ?? ''}`.trim()}
                      title="Изменить"
                      onClick={() => {
                        setAdding(false);
                        setEditingId(ct.id);
                      }}
                      className="text-muted-foreground hover:bg-muted hover:text-foreground rounded p-1.5 transition"
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </button>
                    {canDelete && (
                      <button
                        type="button"
                        aria-label={`Удалить контакт ${ct.fullName ?? ''}`.trim()}
                        title="Удалить"
                        onClick={() => {
                          setDeleteError(null);
                          setDeleting(ct);
                        }}
                        className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive rounded p-1.5 transition"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ),
          )
        )}
      </ul>

      {adding ? (
        <div className="mt-3 border-t pt-3">
          <ContactForm
            clientId={clientId}
            contact={null}
            onDone={() => setAdding(false)}
            onCancel={() => setAdding(false)}
          />
        </div>
      ) : (
        <button
          type="button"
          onClick={() => {
            setEditingId(null);
            setAdding(true);
          }}
          className="text-muted-foreground hover:text-foreground mt-3 inline-flex items-center gap-1 text-xs"
        >
          <Plus className="h-3 w-3" />
          Добавить контакт
        </button>
      )}

      <ConfirmDialog
        open={deleting !== null}
        title="Удалить контактное лицо"
        description={
          deleting
            ? `Контакт «${deleting.fullName ?? 'без имени'}» будет удалён без возможности вернуть. Если человек просто больше не работает у клиента, лучше поправить запись, а не удалять её.`
            : undefined
        }
        confirmText="Удалить"
        variant="danger"
        loading={remove.isPending}
        error={deleteError}
        onConfirm={() => deleting && remove.mutate({ id: deleting.id })}
        onCancel={() => {
          setDeleting(null);
          setDeleteError(null);
        }}
      />
    </section>
  );
}

/**
 * Одна форма на два случая. `contact === null` — заводим нового, иначе правим
 * существующего; расходиться этим двум формам нельзя, иначе поля и границы
 * разъедутся, как это уже случилось со сборкой акта в трёх экранах.
 */
function ContactForm({
  clientId,
  contact,
  onDone,
  onCancel,
}: {
  clientId: string;
  contact: ClientContact | null;
  onDone: () => void;
  onCancel: () => void;
}) {
  const utils = trpc.useUtils();
  const [error, setError] = useState<string | null>(null);

  const form = useForm<ContactFormValues>({
    resolver: zodResolver(contactFormSchema),
    defaultValues: {
      fullName: contact?.fullName ?? '',
      phone: contact?.phone ?? '',
      email: contact?.email ?? '',
      position: contact?.position ?? '',
      isPrimary: contact?.isPrimary ?? false,
    },
  });

  const done = async () => {
    await utils.clients.get.invalidate({ id: clientId });
    form.reset();
    setError(null);
    onDone();
  };

  const create = trpc.clients.addContact.useMutation({
    onSuccess: done,
    onError: (e) => setError(e.message),
  });
  const update = trpc.clients.updateContact.useMutation({
    onSuccess: done,
    onError: (e) => setError(e.message),
  });

  const pending = create.isPending || update.isPending;

  const onSubmit = (values: ContactFormValues) => {
    setError(null);
    const fields = {
      fullName: values.fullName,
      phone: values.phone,
      email: values.email || null,
      position: values.position || null,
      isPrimary: values.isPrimary,
    };
    if (contact) update.mutate({ id: contact.id, patch: fields });
    else create.mutate({ clientId, ...fields });
  };

  return (
    <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-2">
      <input
        type="text"
        placeholder="ФИО"
        {...form.register('fullName')}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
      />
      {form.formState.errors.fullName && (
        <div className="text-destructive text-xs">{form.formState.errors.fullName.message}</div>
      )}
      <input
        type="tel"
        placeholder="Телефон"
        {...form.register('phone')}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
      />
      {form.formState.errors.phone && (
        <div className="text-destructive text-xs">{form.formState.errors.phone.message}</div>
      )}
      <input
        type="email"
        placeholder="Email"
        {...form.register('email')}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
      />
      {form.formState.errors.email && (
        <div className="text-destructive text-xs">{form.formState.errors.email.message}</div>
      )}
      <input
        type="text"
        placeholder="Должность"
        {...form.register('position')}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
      />
      {form.formState.errors.position && (
        <div className="text-destructive text-xs">{form.formState.errors.position.message}</div>
      )}
      <label className="flex items-center gap-1 text-xs">
        <input type="checkbox" {...form.register('isPrimary')} />
        Главный контакт
      </label>
      {error && <div className="text-destructive text-xs">{error}</div>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            form.reset();
            setError(null);
            onCancel();
          }}
          className="hover:bg-muted rounded-md border px-2 py-1 text-xs"
        >
          Отмена
        </button>
        <button
          type="submit"
          disabled={pending}
          className="bg-primary text-primary-foreground rounded-md px-2 py-1 text-xs disabled:opacity-50"
        >
          {pending ? 'Сохраняю…' : contact ? 'Сохранить' : 'Добавить'}
        </button>
      </div>
    </form>
  );
}
