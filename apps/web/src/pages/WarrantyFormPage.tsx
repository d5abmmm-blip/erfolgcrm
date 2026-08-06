/**
 * Форма создания/редактирования гарантии. Маршруты: /warranties/new и /warranties/:id/edit.
 * Техника выбирается через AssetPicker; на редактировании доступен чекбокс «аннулирована».
 */
import { useEffect, useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { Link, useLocation, useRoute } from 'wouter';
import { ChevronLeft } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { AssetPicker } from '../components/AssetPicker';
import { QueryError } from '../components/QueryError';

type WarrantyType = 'manufacturer' | 'service' | 'extended';

interface FormValues {
  type: WarrantyType;
  startDate: string;
  endDate: string;
  provider: string;
  contractNumber: string;
  coverageDescription: string;
  notes: string;
  voided: boolean;
}

const EMPTY: FormValues = {
  type: 'manufacturer',
  startDate: new Date().toISOString().slice(0, 10),
  endDate: '',
  provider: '',
  contractNumber: '',
  coverageDescription: '',
  notes: '',
  voided: false,
};

const TYPE_OPTS: Array<{ v: WarrantyType; label: string }> = [
  { v: 'manufacturer', label: 'Заводская' },
  { v: 'service', label: 'Сервисная (наш СЦ)' },
  { v: 'extended', label: 'Расширенная' },
];

export function WarrantyFormPage() {
  const [, navigate] = useLocation();
  const [isEdit, params] = useRoute('/warranties/:id/edit');
  const editId = isEdit ? params.id : null;
  const utils = trpc.useUtils();
  const form = useForm<FormValues>({ defaultValues: EMPTY });
  const [assetId, setAssetId] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const existing = trpc.warranties.get.useQuery({ id: editId ?? '' }, { enabled: !!editId });

  useEffect(() => {
    if (!existing.data) return;
    const w = existing.data;
    setAssetId(w.assetId);
    form.reset({
      type: w.type,
      startDate: w.startDate,
      endDate: w.endDate,
      provider: w.provider ?? '',
      contractNumber: w.contractNumber ?? '',
      coverageDescription: w.coverageDescription ?? '',
      notes: w.notes ?? '',
      voided: w.voided,
    });
  }, [existing.data, form]);

  const invalidate = async () => {
    await Promise.all([utils.warranties.list.invalidate(), utils.warranties.stats.invalidate()]);
  };

  const create = trpc.warranties.create.useMutation({
    onSuccess: async () => {
      await invalidate();
      navigate('/warranties');
    },
    onError: (e) => setServerError(e.message),
  });

  const update = trpc.warranties.update.useMutation({
    onSuccess: async () => {
      await invalidate();
      if (editId) await utils.warranties.get.invalidate({ id: editId });
      navigate('/warranties');
    },
    onError: (e) => setServerError(e.message),
  });

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    setServerError(null);
    if (!editId && !assetId) {
      setServerError('Выберите технику');
      return;
    }
    if (!v.endDate) {
      setServerError('Укажите дату окончания гарантии');
      return;
    }
    if (v.endDate < v.startDate) {
      setServerError('Дата окончания не может быть раньше даты начала');
      return;
    }
    const body = {
      type: v.type,
      startDate: v.startDate,
      endDate: v.endDate,
      provider: v.provider.trim() || null,
      contractNumber: v.contractNumber.trim() || null,
      coverageDescription: v.coverageDescription.trim() || null,
      notes: v.notes.trim() || null,
    };
    if (editId) {
      update.mutate({ id: editId, patch: { ...body, voided: v.voided } });
    } else {
      create.mutate({ ...body, assetId: assetId! });
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
          href="/warranties"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" /> К реестру гарантий
        </Link>
        <QueryError
          error={existing.error}
          paused={existing.fetchStatus === 'paused'}
          what="гарантию"
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
        href="/warranties"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К реестру гарантий
      </Link>
      <h1 className="text-xl font-semibold md:text-2xl">
        {editId ? 'Редактирование гарантии' : 'Новая гарантия'}
      </h1>

      <form
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        className="bg-card space-y-5 rounded-lg border p-4 md:p-6"
      >
        <div>
          <Label required>Техника</Label>
          {editId ? (
            existing.data && (
              <div className="bg-muted/50 rounded-md border px-3 py-2 text-sm">
                <div className="font-medium">{existing.data.assetModel}</div>
                {existing.data.assetSerialNumber && (
                  <div className="text-muted-foreground font-mono text-xs">
                    s/n {existing.data.assetSerialNumber}
                  </div>
                )}
                <p className="text-muted-foreground mt-1 text-xs">
                  Техника гарантии не меняется после создания.
                </p>
              </div>
            )
          ) : (
            <AssetPicker value={assetId} onChange={(id) => setAssetId(id || null)} />
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label>Тип гарантии</Label>
            <select
              {...form.register('type')}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            >
              {TYPE_OPTS.map((o) => (
                <option key={o.v} value={o.v}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label required>Начало</Label>
            <input
              type="date"
              {...form.register('startDate', { required: true })}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          <div>
            <Label required>Окончание</Label>
            <input
              type="date"
              {...form.register('endDate', { required: true })}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Поставщик гарантии</Label>
            <input
              type="text"
              {...form.register('provider', { maxLength: 255 })}
              placeholder="завод-изготовитель, дистрибьютор, наш СЦ"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          <div>
            <Label>№ договора / талона</Label>
            <input
              type="text"
              {...form.register('contractNumber', { maxLength: 128 })}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
        </div>

        <div>
          <Label>Что покрывает</Label>
          <textarea
            rows={2}
            {...form.register('coverageDescription', { maxLength: 5000 })}
            placeholder="например: все узлы кроме расходных материалов"
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
        </div>

        <div>
          <Label>Заметки</Label>
          <textarea
            rows={2}
            {...form.register('notes', { maxLength: 5000 })}
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
        </div>

        {editId && (
          <label className="bg-muted/40 flex items-start gap-2 rounded-md border p-3 text-sm">
            <input type="checkbox" {...form.register('voided')} className="mt-0.5" />
            <span>
              <span className="font-medium">Гарантия аннулирована</span>
              <span className="text-muted-foreground block text-xs">
                Например, при нарушении условий эксплуатации. Статус станет «Аннулирована»
                независимо от дат.
              </span>
            </span>
          </label>
        )}

        {serverError && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
            {serverError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => navigate('/warranties')}
            className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
          >
            {isPending ? 'Сохранение…' : editId ? 'Сохранить' : 'Создать гарантию'}
          </button>
        </div>
      </form>
    </div>
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
