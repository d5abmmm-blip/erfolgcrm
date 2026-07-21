/**
 * Форма создания/редактирования лида. Маршруты: /leads/new и /leads/:id/edit.
 *
 * Стадия (status), причина проигрыша и конвертация в клиента — НЕ здесь, а на карточке
 * (/leads/:id), потому что это переходы воронки со своими правилами.
 */
import { useEffect, useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { Link, useLocation, useRoute } from 'wouter';
import { ChevronLeft } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { QueryError } from '../components/QueryError';
import { LEAD_SOURCE_LABEL, type LeadSource } from './leads.shared';

interface FormValues {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  region: string;
  source: LeadSource;
  estimatedValue: string;
  nextAction: string;
  nextActionDate: string;
  notes: string;
}

const EMPTY: FormValues = {
  name: '',
  contactPerson: '',
  phone: '',
  email: '',
  region: '',
  source: 'other',
  estimatedValue: '',
  nextAction: '',
  nextActionDate: '',
  notes: '',
};

const SOURCE_OPTS = (Object.keys(LEAD_SOURCE_LABEL) as LeadSource[]).map((v) => ({
  v,
  label: LEAD_SOURCE_LABEL[v],
}));

export function LeadFormPage() {
  const [, navigate] = useLocation();
  const [isEdit, params] = useRoute('/leads/:id/edit');
  const editId = isEdit ? params.id : null;
  const utils = trpc.useUtils();
  const form = useForm<FormValues>({ defaultValues: EMPTY });
  const [serverError, setServerError] = useState<string | null>(null);

  const existing = trpc.leads.get.useQuery({ id: editId ?? '' }, { enabled: !!editId });

  useEffect(() => {
    if (!existing.data) return;
    const l = existing.data;
    form.reset({
      name: l.name,
      contactPerson: l.contactPerson ?? '',
      phone: l.phone ?? '',
      email: l.email ?? '',
      region: l.region ?? '',
      source: l.source,
      estimatedValue: l.estimatedValue ? String(l.estimatedValue) : '',
      nextAction: l.nextAction ?? '',
      nextActionDate: l.nextActionDate ?? '',
      notes: l.notes ?? '',
    });
  }, [existing.data, form]);

  const create = trpc.leads.create.useMutation({
    onSuccess: async (res) => {
      await utils.leads.list.invalidate();
      await utils.leads.funnelStats.invalidate();
      navigate(`/leads/${res.id}`);
    },
    onError: (e) => setServerError(e.message),
  });

  const update = trpc.leads.update.useMutation({
    onSuccess: async () => {
      await utils.leads.list.invalidate();
      if (editId) await utils.leads.get.invalidate({ id: editId });
      navigate(`/leads/${editId}`);
    },
    onError: (e) => setServerError(e.message),
  });

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    setServerError(null);
    if (!v.name.trim()) {
      setServerError('Укажите название лида');
      return;
    }
    const body = {
      name: v.name.trim(),
      contactPerson: v.contactPerson.trim() || null,
      phone: v.phone.trim() || null,
      email: v.email.trim() || null,
      region: v.region.trim() || null,
      source: v.source,
      estimatedValue: parseMoney(v.estimatedValue),
      nextAction: v.nextAction.trim() || null,
      nextActionDate: v.nextActionDate || null,
      notes: v.notes.trim() || null,
    };
    if (editId) {
      update.mutate({ id: editId, patch: body });
    } else {
      create.mutate(body);
    }
  };

  const isPending = create.isPending || update.isPending;

  // Пока записи НЕТ — форму не показываем. Условие именно «нет данных», а не «есть
  // ошибка»: при потере связи react-query не роняет запрос, а ставит его на паузу,
  // и error остаётся пустым НАВСЕГДА (проверено в браузере: fetchStatus 'paused').
  // Форма в этот момент показывала бы пустые поля с рабочей кнопкой «Сохранить», и
  // патч ушёл бы со ВСЕМИ полями, затерев то, что лежит в базе.
  if (editId && !existing.data) {
    return (
      <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
        <Link
          href={`/leads/${editId}`}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" /> К карточке лида
        </Link>
        <QueryError
          error={existing.error}
          paused={existing.fetchStatus === 'paused'}
          what="карточку лида"
          onRetry={() => void existing.refetch()}
        />
        {/* Пока данные ещё едут — ошибки нет, и QueryError молчит. Без этой строки
            человек видел бы пустую страницу без единого слова. */}
        {!existing.error && existing.fetchStatus !== 'paused' && (
          <div className="text-muted-foreground text-sm">Загрузка…</div>
        )}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Link
        href={editId ? `/leads/${editId}` : '/leads'}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        {editId ? 'К карточке лида' : 'К списку лидов'}
      </Link>
      <h1 className="text-xl font-semibold md:text-2xl">
        {editId ? 'Редактирование лида' : 'Новый лид'}
      </h1>

      <form
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        className="bg-card space-y-5 rounded-lg border p-4 md:p-6"
      >
        <div>
          <Label required>Название / организация</Label>
          <input
            type="text"
            {...form.register('name', { required: true, maxLength: 255 })}
            placeholder="например: ООО «Медтехника-Юг»"
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Контактное лицо</Label>
            <input
              type="text"
              {...form.register('contactPerson', { maxLength: 255 })}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          <div>
            <Label>Телефон</Label>
            <input
              type="tel"
              {...form.register('phone', { maxLength: 64 })}
              placeholder="+7…"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          <div>
            <Label>Email</Label>
            <input
              type="email"
              {...form.register('email', { maxLength: 320 })}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          <div>
            <Label>Регион</Label>
            <input
              type="text"
              {...form.register('region', { maxLength: 128 })}
              placeholder="например: Краснодар"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Источник</Label>
            <Select {...form.register('source')} options={SOURCE_OPTS} />
          </div>
          <div>
            <Label>Сумма сделки, ₽</Label>
            <input
              type="number"
              step="any"
              min="0"
              {...form.register('estimatedValue')}
              placeholder="0"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Следующий шаг</Label>
            <input
              type="text"
              {...form.register('nextAction', { maxLength: 2000 })}
              placeholder="например: отправить КП"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          <div>
            <Label>Дата следующего шага</Label>
            <input
              type="date"
              {...form.register('nextActionDate')}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
        </div>

        <div>
          <Label>Заметки</Label>
          <textarea
            rows={3}
            {...form.register('notes', { maxLength: 5000 })}
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
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
            onClick={() => navigate(editId ? `/leads/${editId}` : '/leads')}
            className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {isPending ? 'Сохранение…' : editId ? 'Сохранить' : 'Создать лид'}
          </button>
        </div>
      </form>
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
      className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
    >
      {options.map((o) => (
        <option key={o.v} value={o.v}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function Label({ children, required = false }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="text-foreground mb-1 flex items-center gap-1 text-xs font-medium">
      {children}
      {required && <span className="text-destructive">*</span>}
    </label>
  );
}

function parseMoney(v: string): number {
  const n = Number.parseFloat(v.trim());
  return Number.isFinite(n) && n > 0 ? n : 0;
}
