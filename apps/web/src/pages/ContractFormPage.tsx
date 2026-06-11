/**
 * Форма создания/редактирования контракта.
 * Маршруты: /contracts/new и /contracts/:id/edit.
 *
 * Все поля terms.* — необязательные числа; PDF-шаблон сам подставит дефолты.
 */
import { useEffect, useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { Link, useLocation, useRoute } from 'wouter';
import { ChevronLeft } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ClientPicker } from '../components/ClientPicker';

type ContractType = 'service' | 'one_time';
type ContractStatus = 'draft' | 'active' | 'expired' | 'terminated';
type VatRate = '0' | '5' | '10' | '20' | 'without_vat';

interface FormValues {
  clientId: string;
  contractNumber: string;
  contractDate: string;
  type: ContractType;
  status: ContractStatus;
  vatRate: VatRate;
  validFrom: string;
  validUntil: string;
  performanceDays: string;
  warrantyMonths: string;
  prepaymentPercent: string;
  paymentDueDays: string;
  performancePenaltyPercent: string;
  paymentPenaltyDailyPercent: string;
  termsNotes: string;
  notes: string;
}

const EMPTY: FormValues = {
  clientId: '',
  contractNumber: '',
  contractDate: new Date().toISOString().slice(0, 10),
  type: 'service',
  status: 'active',
  vatRate: '5',
  validFrom: '',
  validUntil: '',
  performanceDays: '',
  warrantyMonths: '',
  prepaymentPercent: '',
  paymentDueDays: '',
  performancePenaltyPercent: '',
  paymentPenaltyDailyPercent: '',
  termsNotes: '',
  notes: '',
};

const TYPE_OPTS: Array<{ v: ContractType; label: string }> = [
  { v: 'service', label: 'Сервисный (рамочный)' },
  { v: 'one_time', label: 'Разовый' },
];

const STATUS_OPTS: Array<{ v: ContractStatus; label: string }> = [
  { v: 'draft', label: 'Черновик' },
  { v: 'active', label: 'Действует' },
  { v: 'expired', label: 'Истёк' },
  { v: 'terminated', label: 'Расторгнут' },
];

const VAT_OPTS: Array<{ v: VatRate; label: string }> = [
  { v: '0', label: '0%' },
  { v: '5', label: '5%' },
  { v: '10', label: '10%' },
  { v: '20', label: '20%' },
  { v: 'without_vat', label: 'Без НДС' },
];

export function ContractFormPage() {
  const [, navigate] = useLocation();
  const [isEdit, params] = useRoute('/contracts/:id/edit');
  const editId = isEdit ? params!.id : null;
  const utils = trpc.useUtils();
  const form = useForm<FormValues>({ defaultValues: EMPTY });
  const [serverError, setServerError] = useState<string | null>(null);

  const existing = trpc.contracts.get.useQuery(
    { id: editId ?? '' },
    { enabled: !!editId },
  );

  useEffect(() => {
    if (!existing.data) return;
    const c = existing.data;
    form.reset({
      clientId: c.clientId,
      contractNumber: c.contractNumber,
      contractDate: c.contractDate,
      type: c.type,
      status: c.status,
      vatRate: c.vatRate,
      validFrom: c.validFrom ?? '',
      validUntil: c.validUntil ?? '',
      performanceDays: c.terms.performanceDays?.toString() ?? '',
      warrantyMonths: c.terms.warrantyMonths?.toString() ?? '',
      prepaymentPercent: c.terms.prepaymentPercent?.toString() ?? '',
      paymentDueDays: c.terms.paymentDueDays?.toString() ?? '',
      performancePenaltyPercent: c.terms.performancePenaltyPercent?.toString() ?? '',
      paymentPenaltyDailyPercent: c.terms.paymentPenaltyDailyPercent?.toString() ?? '',
      termsNotes: c.terms.notes ?? '',
      notes: c.notes ?? '',
    });
  }, [existing.data, form]);

  const create = trpc.contracts.create.useMutation({
    onSuccess: async (res) => {
      await utils.contracts.list.invalidate();
      navigate(`/contracts/${res.id}`);
    },
    onError: (e) => setServerError(e.message),
  });

  const update = trpc.contracts.update.useMutation({
    onSuccess: async () => {
      await utils.contracts.list.invalidate();
      if (editId) await utils.contracts.get.invalidate({ id: editId });
      navigate(`/contracts/${editId}`);
    },
    onError: (e) => setServerError(e.message),
  });

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    setServerError(null);
    if (!v.clientId) {
      setServerError('Выберите клиента');
      return;
    }
    if (!v.contractNumber.trim()) {
      setServerError('Укажите номер договора');
      return;
    }
    const terms = {
      performanceDays: parseOptionalInt(v.performanceDays),
      warrantyMonths: parseOptionalInt(v.warrantyMonths),
      prepaymentPercent: parseOptionalNumber(v.prepaymentPercent),
      paymentDueDays: parseOptionalInt(v.paymentDueDays),
      performancePenaltyPercent: parseOptionalNumber(v.performancePenaltyPercent),
      paymentPenaltyDailyPercent: parseOptionalNumber(v.paymentPenaltyDailyPercent),
      notes: v.termsNotes.trim() || undefined,
    };
    const body = {
      contractNumber: v.contractNumber.trim(),
      contractDate: v.contractDate,
      type: v.type,
      status: v.status,
      vatRate: v.vatRate,
      validFrom: v.validFrom || null,
      validUntil: v.validUntil || null,
      terms: stripUndefined(terms),
      notes: v.notes.trim() || null,
    };
    if (editId) {
      update.mutate({ id: editId, patch: body });
    } else {
      create.mutate({ ...body, clientId: v.clientId });
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Link
        href="/contracts"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        К списку договоров
      </Link>
      <h1 className="text-xl font-semibold md:text-2xl">
        {editId ? 'Редактирование договора' : 'Новый договор'}
      </h1>

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="bg-card space-y-5 rounded-lg border p-4 md:p-6"
      >
        <div>
          <Label required>Клиент</Label>
          <ClientPicker
            value={form.watch('clientId') || null}
            onChange={(id) => form.setValue('clientId', id)}
          />
          {editId && (
            <p className="text-muted-foreground mt-1 text-xs">
              Клиент договора не меняется после создания.
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label required>Номер договора</Label>
            <input
              type="text"
              {...form.register('contractNumber', { required: true, maxLength: 50 })}
              placeholder="например: СД-2026-12"
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <div>
            <Label required>Дата договора</Label>
            <input
              type="date"
              {...form.register('contractDate', { required: true })}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label>Тип</Label>
            <Select {...form.register('type')} options={TYPE_OPTS} />
          </div>
          <div>
            <Label>Статус</Label>
            <Select {...form.register('status')} options={STATUS_OPTS} />
          </div>
          <div>
            <Label>НДС</Label>
            <Select {...form.register('vatRate')} options={VAT_OPTS} />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Действует с</Label>
            <input
              type="date"
              {...form.register('validFrom')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <div>
            <Label>Действует по</Label>
            <input
              type="date"
              {...form.register('validUntil')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
            <p className="text-muted-foreground mt-1 text-xs">пусто = бессрочно</p>
          </div>
        </div>

        <fieldset className="border-border space-y-3 rounded-md border p-3">
          <legend className="text-muted-foreground px-1 text-xs font-medium uppercase tracking-wide">
            Условия (попадут в текст PDF)
          </legend>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <NumberField label="Срок выполнения, дней" name="performanceDays" form={form} />
            <NumberField label="Гарантия, мес." name="warrantyMonths" form={form} />
            <NumberField label="Предоплата, %" name="prepaymentPercent" form={form} />
            <NumberField label="Оплата после акта, дн." name="paymentDueDays" form={form} />
            <NumberField
              label="Штраф за просрочку этапа, %"
              name="performancePenaltyPercent"
              form={form}
            />
            <NumberField
              label="Пеня за просрочку оплаты, %/день"
              name="paymentPenaltyDailyPercent"
              form={form}
            />
          </div>
          <div>
            <Label>Дополнительные условия</Label>
            <textarea
              rows={2}
              {...form.register('termsNotes', { maxLength: 2000 })}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </fieldset>

        <div>
          <Label>Внутренние заметки</Label>
          <textarea
            rows={2}
            {...form.register('notes', { maxLength: 5000 })}
            placeholder="Видны только сотрудникам сервиса"
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        {serverError && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
            {serverError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => navigate('/contracts')}
            className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md px-4 py-2 text-sm font-medium"
          >
            {isPending ? 'Сохранение…' : editId ? 'Сохранить' : 'Создать договор'}
          </button>
        </div>
      </form>
    </div>
  );
}

function NumberField({
  label,
  name,
  form,
}: {
  label: string;
  name: keyof FormValues;
  form: ReturnType<typeof useForm<FormValues>>;
}) {
  return (
    <div>
      <Label>{label}</Label>
      <input
        type="number"
        step="any"
        min="0"
        {...form.register(name)}
        className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
      />
    </div>
  );
}

function Select<T extends string>({
  options,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ v: T; label: string }>;
}) {
  return (
    <select
      {...rest}
      className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
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

function parseOptionalInt(v: string): number | undefined {
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const n = Number.parseInt(trimmed, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseOptionalNumber(v: string): number | undefined {
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  const n = Number.parseFloat(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined) out[k] = v;
  }
  return out as T;
}
