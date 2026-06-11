import { useEffect, useState } from 'react';
import { useLocation, useRoute, Link } from 'wouter';
import {
  useForm,
  type SubmitHandler,
  type UseFormReturn,
  type FieldPath,
} from 'react-hook-form';
import { ChevronLeft, Lock } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

type ClientType = 'legal' | 'individual';

interface FormValues {
  type: ClientType;
  // legal
  displayName: string;
  inn: string;
  kpp: string;
  ogrn: string;
  legalAddress: string;
  phone: string;
  email: string;
  isBudget: boolean;
  treasuryAccount: string;
  eksAccount: string;
  personalAccount: string;
  // individual
  individualFullName: string;
  individualPhone: string;
  individualAddress: string;
  notes: string;
}

const EMPTY: FormValues = {
  type: 'legal',
  displayName: '',
  inn: '',
  kpp: '',
  ogrn: '',
  legalAddress: '',
  phone: '',
  email: '',
  isBudget: false,
  treasuryAccount: '',
  eksAccount: '',
  personalAccount: '',
  individualFullName: '',
  individualPhone: '',
  individualAddress: '',
  notes: '',
};

export function ClientFormPage() {
  const [, navigate] = useLocation();
  const [matchEdit, params] = useRoute<{ id: string }>('/clients/:id/edit');
  const editingId = matchEdit ? params.id : null;
  const isEdit = !!editingId;

  const utils = trpc.useUtils();
  const existing = trpc.clients.get.useQuery(
    { id: editingId ?? '' },
    { enabled: isEdit },
  );

  const form = useForm<FormValues>({ defaultValues: EMPTY });
  const [serverError, setServerError] = useState<string | null>(null);
  const type = form.watch('type');
  const isBudget = form.watch('isBudget');

  useEffect(() => {
    if (!isEdit || !existing.data) return;
    const c = existing.data;
    form.reset({
      type: c.type,
      displayName: c.displayName,
      inn: c.inn ?? '',
      kpp: c.kpp ?? '',
      ogrn: c.ogrn ?? '',
      legalAddress: c.legalAddress ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
      isBudget: c.subtype === 'budget',
      treasuryAccount: c.treasuryAccount ?? '',
      eksAccount: c.eksAccount ?? '',
      personalAccount: c.personalAccount ?? '',
      individualFullName: c.individualFullName ?? '',
      individualPhone: c.individualPhone ?? '',
      individualAddress: c.individualAddress ?? '',
      notes: c.notes ?? '',
    });
  }, [isEdit, existing.data, form]);

  const create = trpc.clients.create.useMutation({
    onSuccess: async (res) => {
      await utils.clients.list.invalidate();
      navigate(`/clients/${res.id}`);
    },
    onError: (e) => setServerError(e.message),
  });
  const update = trpc.clients.update.useMutation({
    onSuccess: async () => {
      if (!editingId) return;
      await Promise.all([
        utils.clients.list.invalidate(),
        utils.clients.get.invalidate({ id: editingId }),
      ]);
      navigate(`/clients/${editingId}`);
    },
    onError: (e) => setServerError(e.message),
  });

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    setServerError(null);
    if (isEdit && editingId) {
      const patch: Record<string, unknown> = {};
      if (v.type === 'legal') {
        patch.displayName = v.displayName;
        patch.subtype = v.isBudget ? 'budget' : null;
        patch.inn = v.inn || null;
        patch.kpp = v.kpp || null;
        patch.ogrn = v.ogrn || null;
        patch.legalAddress = v.legalAddress || null;
        patch.phone = v.phone || null;
        patch.email = v.email || null;
        patch.treasuryAccount = v.isBudget ? v.treasuryAccount || null : null;
        patch.eksAccount = v.isBudget ? v.eksAccount || null : null;
        patch.personalAccount = v.isBudget ? v.personalAccount || null : null;
      } else {
        patch.individualFullName = v.individualFullName;
        patch.individualPhone = v.individualPhone || null;
        patch.individualAddress = v.individualAddress || null;
      }
      patch.notes = v.notes || null;
      update.mutate({ id: editingId, patch });
      return;
    }
    if (v.type === 'legal') {
      create.mutate({
        type: 'legal',
        subtype: v.isBudget ? 'budget' : 'commercial',
        displayName: v.displayName,
        inn: v.inn || null,
        kpp: v.kpp || null,
        ogrn: v.ogrn || null,
        legalAddress: v.legalAddress || null,
        phone: v.phone || null,
        email: v.email || null,
        treasuryAccount: v.isBudget ? v.treasuryAccount || null : null,
        eksAccount: v.isBudget ? v.eksAccount || null : null,
        personalAccount: v.isBudget ? v.personalAccount || null : null,
        notes: v.notes || null,
      });
    } else {
      create.mutate({
        type: 'individual',
        individualFullName: v.individualFullName,
        individualPhone: v.individualPhone || undefined,
        individualAddress: v.individualAddress || undefined,
        notes: v.notes || null,
      });
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Link
        href={isEdit ? `/clients/${editingId}` : '/clients'}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        {isEdit ? 'К карточке клиента' : 'К списку клиентов'}
      </Link>

      <h1 className="text-xl font-semibold md:text-2xl">
        {isEdit ? 'Редактирование клиента' : 'Новый клиент'}
      </h1>

      <form
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        className="bg-card space-y-5 rounded-lg border p-4 md:p-6"
      >
        {!isEdit && (
          <div className="flex gap-1 rounded-md border p-1">
            {(['legal', 'individual'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => form.setValue('type', t)}
                className={cn(
                  'flex-1 rounded-sm px-3 py-1.5 text-sm font-medium transition',
                  type === t
                    ? 'bg-secondary text-secondary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {t === 'legal' ? 'Юр. лицо' : 'Физ. лицо'}
              </button>
            ))}
          </div>
        )}

        {type === 'legal' ? (
          <LegalFields form={form} isBudget={isBudget} />
        ) : (
          <IndividualFields form={form} />
        )}

        <div>
          <Label>Заметки</Label>
          <textarea
            rows={3}
            {...form.register('notes')}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        {serverError && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/30 p-2.5 text-xs">
            {serverError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => navigate(isEdit ? `/clients/${editingId}` : '/clients')}
            className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md px-4 py-2 text-sm font-medium"
          >
            {isPending ? 'Сохранение…' : isEdit ? 'Сохранить' : 'Создать'}
          </button>
        </div>
      </form>
    </div>
  );
}

function LegalFields({
  form,
  isBudget,
}: {
  form: UseFormReturn<FormValues>;
  isBudget: boolean;
}) {
  return (
    <div className="space-y-4">
      <div>
        <Label required>Наименование организации</Label>
        <input
          type="text"
          {...form.register('displayName', { required: true })}
          placeholder="ООО «...» или ГБУ «...»"
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="ИНН" name="inn" form={form} placeholder="10 или 12 цифр" />
        <Field label="КПП" name="kpp" form={form} placeholder="9 цифр" />
        <Field label="ОГРН/ОГРНИП" name="ogrn" form={form} placeholder="13 или 15 цифр" />
      </div>
      <div>
        <Label>Юридический адрес</Label>
        <input
          type="text"
          {...form.register('legalAddress')}
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Телефон" name="phone" form={form} />
        <Field label="Email" name="email" form={form} type="email" />
      </div>

      <label className="text-sm flex items-center gap-2">
        <input
          type="checkbox"
          {...form.register('isBudget')}
          className="h-4 w-4 rounded border-input"
        />
        Бюджетная организация (есть лицевые счета казначейства)
      </label>

      {isBudget && (
        <div className="border-l-2 border-accent/40 space-y-3 pl-4">
          <Field label="Счёт казначейства" name="treasuryAccount" form={form} />
          <Field label="Единый казначейский счёт (ЕКС)" name="eksAccount" form={form} />
          <Field label="Лицевой счёт" name="personalAccount" form={form} />
        </div>
      )}
    </div>
  );
}

function IndividualFields({
  form,
}: {
  form: UseFormReturn<FormValues>;
}) {
  return (
    <div className="space-y-4">
      <div>
        <Label required>
          ФИО полностью
          <PiiBadge />
        </Label>
        <input
          type="text"
          {...form.register('individualFullName', { required: true, minLength: 2 })}
          placeholder="Иванов Иван Иванович"
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
        <p className="text-muted-foreground mt-1 text-xs">
          В списках отобразится как «Иванов И.И.»
        </p>
      </div>
      <div>
        <Label>
          Телефон
          <PiiBadge />
        </Label>
        <input
          type="tel"
          {...form.register('individualPhone')}
          placeholder="+7 ..."
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
      <div>
        <Label>
          Адрес
          <PiiBadge />
        </Label>
        <input
          type="text"
          {...form.register('individualAddress')}
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
    </div>
  );
}

function Field({
  label,
  name,
  form,
  type = 'text',
  placeholder,
}: {
  label: string;
  name: FieldPath<FormValues>;
  form: UseFormReturn<FormValues>;
  type?: string;
  placeholder?: string;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type={type}
        placeholder={placeholder}
        {...form.register(name)}
        className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
      />
    </div>
  );
}

function Label({
  children,
  required = false,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="text-foreground mb-1 flex items-center gap-1 text-xs font-medium">
      {children}
      {required && <span className="text-destructive">*</span>}
    </label>
  );
}

function PiiBadge() {
  return (
    <span
      className="bg-muted text-muted-foreground ml-1 inline-flex items-center gap-0.5 rounded-md px-1.5 py-0.5 text-[10px]"
      title="Хранится в зашифрованном виде (pgcrypto)"
    >
      <Lock className="h-2.5 w-2.5" />
      ПДн
    </span>
  );
}
