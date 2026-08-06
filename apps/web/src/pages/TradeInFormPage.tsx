/**
 * Форма приёма/редактирования позиции трейд-ина.
 * Маршруты: /trade-in/new и /trade-in/:id/edit.
 * Покупатель указывается здесь; сама продажа — кнопкой «Продано» в реестре (complete).
 */
import { useEffect, useState } from 'react';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { Link, useLocation, useRoute } from 'wouter';
import { ChevronLeft } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ClientPicker } from '../components/ClientPicker';
import { AssetPicker } from '../components/AssetPicker';
import { QueryError } from '../components/QueryError';

type TradeInCondition = 'excellent' | 'good' | 'fair' | 'poor';
type TradeInStatus = 'received' | 'assessed' | 'in_stock' | 'sold' | 'scrapped';

interface FormValues {
  name: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  year: string;
  condition: TradeInCondition;
  status: Exclude<TradeInStatus, 'sold'>;
  purchaseRub: string;
  assessedRub: string;
  receivedAt: string;
  notes: string;
}

const EMPTY: FormValues = {
  name: '',
  manufacturer: '',
  model: '',
  serialNumber: '',
  year: '',
  condition: 'good',
  status: 'received',
  purchaseRub: '',
  assessedRub: '',
  receivedAt: new Date().toISOString().slice(0, 10),
  notes: '',
};

const CONDITION_OPTS: Array<{ v: TradeInCondition; label: string }> = [
  { v: 'excellent', label: 'Отличное' },
  { v: 'good', label: 'Хорошее' },
  { v: 'fair', label: 'Среднее' },
  { v: 'poor', label: 'Плохое' },
];

const STATUS_OPTS: Array<{ v: Exclude<TradeInStatus, 'sold'>; label: string }> = [
  { v: 'received', label: 'Принята' },
  { v: 'assessed', label: 'Оценена' },
  { v: 'in_stock', label: 'На складе' },
  { v: 'scrapped', label: 'Утилизация' },
];

export function TradeInFormPage() {
  const [, navigate] = useLocation();
  const [isEdit, params] = useRoute('/trade-in/:id/edit');
  const editId = isEdit ? params.id : null;
  const utils = trpc.useUtils();
  const form = useForm<FormValues>({ defaultValues: EMPTY });
  const [clientId, setClientId] = useState<string | null>(null);
  const [buyerClientId, setBuyerClientId] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [serverError, setServerError] = useState<string | null>(null);

  const existing = trpc.tradeIn.get.useQuery({ id: editId ?? '' }, { enabled: !!editId });
  const isSold = existing.data?.status === 'sold';

  useEffect(() => {
    if (!existing.data) return;
    const t = existing.data;
    setClientId(t.clientId);
    setBuyerClientId(t.buyerClientId);
    setAssetId(t.assetId);
    form.reset({
      name: t.name,
      manufacturer: t.manufacturer ?? '',
      model: t.model ?? '',
      serialNumber: t.serialNumber ?? '',
      year: t.year ? String(t.year) : '',
      condition: t.condition,
      status: t.status === 'sold' ? 'in_stock' : t.status,
      purchaseRub: kopecksToRubStr(t.purchasePriceKopecks),
      assessedRub: kopecksToRubStr(t.assessedPriceKopecks),
      receivedAt: t.receivedAt,
      notes: t.notes ?? '',
    });
  }, [existing.data, form]);

  const invalidate = () =>
    Promise.all([utils.tradeIn.list.invalidate(), utils.tradeIn.stats.invalidate()]);

  const create = trpc.tradeIn.create.useMutation({
    onSuccess: async () => {
      await invalidate();
      navigate('/trade-in');
    },
    onError: (e) => setServerError(e.message),
  });
  const update = trpc.tradeIn.update.useMutation({
    onSuccess: async () => {
      await invalidate();
      if (editId) await utils.tradeIn.get.invalidate({ id: editId });
      navigate('/trade-in');
    },
    onError: (e) => setServerError(e.message),
  });

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    setServerError(null);
    if (!v.name.trim()) {
      setServerError('Укажите название позиции');
      return;
    }
    const base = {
      name: v.name.trim(),
      manufacturer: v.manufacturer.trim() || null,
      model: v.model.trim() || null,
      serialNumber: v.serialNumber.trim() || null,
      year: v.year.trim() ? Number.parseInt(v.year, 10) : null,
      condition: v.condition,
      clientId,
      assetId,
      notes: v.notes.trim() || null,
      receivedAt: v.receivedAt,
    };
    if (editId) {
      update.mutate({
        id: editId,
        patch: {
          ...base,
          status: v.status,
          buyerClientId,
          purchasePriceKopecks: rubToKopecks(v.purchaseRub),
          assessedPriceKopecks: rubToKopecks(v.assessedRub),
        },
      });
    } else {
      create.mutate({
        ...base,
        purchasePriceKopecks: rubToKopecks(v.purchaseRub),
        assessedPriceKopecks: rubToKopecks(v.assessedRub),
      });
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
          href="/trade-in"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" /> К реестру трейд-ина
        </Link>
        <QueryError
          error={existing.error}
          paused={existing.fetchStatus === 'paused'}
          what="позицию трейд-ина"
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
        href="/trade-in"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К реестру трейд-ина
      </Link>
      <h1 className="text-xl font-semibold md:text-2xl">
        {editId ? 'Редактирование позиции' : 'Приём техники в зачёт'}
      </h1>

      {isSold && (
        <div className="bg-success/10 text-success border-success/30 rounded-md border p-3 text-sm">
          Позиция продана — редактирование закрыто.
        </div>
      )}

      <form
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        className="bg-card space-y-5 rounded-lg border p-4 md:p-6"
      >
        <fieldset disabled={isSold} className="space-y-5">
          <div>
            <Label required>Название позиции</Label>
            <input
              type="text"
              {...form.register('name', { required: true, maxLength: 255 })}
              placeholder="например: ИВЛ Hamilton C2, 2019"
              className={inputCls}
            />
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>Производитель</Label>
              <input
                type="text"
                {...form.register('manufacturer', { maxLength: 200 })}
                className={inputCls}
              />
            </div>
            <div>
              <Label>Модель</Label>
              <input
                type="text"
                {...form.register('model', { maxLength: 200 })}
                className={inputCls}
              />
            </div>
            <div>
              <Label>Серийный номер</Label>
              <input
                type="text"
                {...form.register('serialNumber', { maxLength: 100 })}
                className={inputCls}
              />
            </div>
            <div>
              <Label>Год выпуска</Label>
              <input
                type="number"
                min="1950"
                max="2100"
                {...form.register('year')}
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <Label>Состояние</Label>
              <Select {...form.register('condition')} options={CONDITION_OPTS} />
            </div>
            {editId && (
              <div>
                <Label>Статус</Label>
                <Select {...form.register('status')} options={STATUS_OPTS} />
                <p className="text-muted-foreground mt-1 text-xs">«Продана» — кнопкой в реестре</p>
              </div>
            )}
            <div>
              <Label required>Дата приёма</Label>
              <input
                type="date"
                {...form.register('receivedAt', { required: true })}
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>Зачтено клиенту, ₽</Label>
              <input
                type="number"
                min="0"
                step="0.01"
                {...form.register('purchaseRub')}
                className={inputCls}
              />
            </div>
            <div>
              <Label>Оценочная стоимость, ₽</Label>
              <input
                type="number"
                min="0"
                step="0.01"
                {...form.register('assessedRub')}
                className={inputCls}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label>Кто сдал технику</Label>
              <ClientPicker value={clientId} onChange={(id) => setClientId(id || null)} />
            </div>
            {editId && (
              <div>
                <Label>Покупатель</Label>
                <ClientPicker
                  value={buyerClientId}
                  onChange={(id) => setBuyerClientId(id || null)}
                  placeholder="Поиск покупателя…"
                />
                <p className="text-muted-foreground mt-1 text-xs">
                  Обязателен для завершения сделки
                </p>
              </div>
            )}
          </div>

          <div>
            <Label>Единица в парке техники (опционально)</Label>
            <AssetPicker value={assetId} onChange={(id) => setAssetId(id || null)} />
            <p className="text-muted-foreground mt-1 text-xs">
              При продаже владелец этой единицы будет перенесён на покупателя
            </p>
          </div>

          <div>
            <Label>Заметки</Label>
            <textarea
              rows={2}
              {...form.register('notes', { maxLength: 5000 })}
              className={inputCls}
            />
          </div>
        </fieldset>

        {serverError && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
            {serverError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => navigate('/trade-in')}
            className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
          >
            Отмена
          </button>
          {!isSold && (
            <button
              type="submit"
              disabled={isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {isPending ? 'Сохранение…' : editId ? 'Сохранить' : 'Принять технику'}
            </button>
          )}
        </div>
      </form>
    </div>
  );
}

const inputCls =
  'bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2';

function Select<T extends string>({
  options,
  ...rest
}: React.SelectHTMLAttributes<HTMLSelectElement> & {
  options: Array<{ v: T; label: string }>;
}) {
  return (
    <select {...rest} className={inputCls}>
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

function rubToKopecks(v: string): number {
  const n = Number.parseFloat(v.trim().replace(',', '.'));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n * 100);
}

function kopecksToRubStr(kopecks: string): string {
  try {
    const big = BigInt(kopecks);
    if (big === 0n) return '';
    return (Number(big) / 100).toString();
  } catch {
    return '';
  }
}
