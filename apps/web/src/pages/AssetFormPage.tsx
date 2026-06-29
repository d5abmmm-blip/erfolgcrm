import { useEffect, useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import { useForm, type SubmitHandler } from 'react-hook-form';
import { ChevronLeft } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ClientPicker } from '../components/ClientPicker';
import { AssetModelPicker, type AssetModelLite } from '../components/AssetModelPicker';

interface FormValues {
  ownerClientId: string;
  /** Галочка «без привязки к клиенту» — техника ведётся сама по себе (склад, демо, свой парк). */
  noOwner: boolean;
  /** Ссылка на модель из каталога (asset_models). Пусто ⇒ заведено свободным текстом. */
  assetModelId: string;
  model: string;
  manufacturer: string;
  serialNumber: string;
  inventoryNumber: string;
  location: string;
  lifecycleStatus: 'in_service' | 'in_repair' | 'awaiting_parts' | 'reserve' | 'decommissioned';
  riskClass: '' | '1' | '2a' | '2b' | '3';
  /** Stage 10'.I — пустая строка ⇒ NULL (требование не задано). */
  requiredAttestationCategory: string;
  commissionedAt: string;
  warrantyUntil: string;
  notes: string;
}

const EMPTY: FormValues = {
  ownerClientId: '',
  noOwner: false,
  assetModelId: '',
  model: '',
  manufacturer: '',
  serialNumber: '',
  inventoryNumber: '',
  location: '',
  lifecycleStatus: 'in_service',
  riskClass: '',
  requiredAttestationCategory: '',
  commissionedAt: '',
  warrantyUntil: '',
  notes: '',
};

export function AssetFormPage() {
  const [, navigate] = useLocation();
  const [matchEdit, params] = useRoute<{ id: string }>('/assets/:id/edit');
  const editingId = matchEdit ? params.id : null;
  const isEdit = !!editingId;

  const utils = trpc.useUtils();
  const existing = trpc.assets.get.useQuery({ id: editingId ?? '' }, { enabled: isEdit });
  const manufacturers = trpc.assets.manufacturers.useQuery();

  const form = useForm<FormValues>({ defaultValues: EMPTY });
  const [serverError, setServerError] = useState<string | null>(null);

  // На /assets/new?clientId=xxx — предзаполняем владельца
  useEffect(() => {
    if (isEdit) return;
    const params2 = new URLSearchParams(window.location.search);
    const cid = params2.get('clientId');
    if (cid) form.setValue('ownerClientId', cid);
  }, [isEdit, form]);

  useEffect(() => {
    if (!isEdit || !existing.data) return;
    const a = existing.data;
    form.reset({
      ownerClientId: a.ownerClientId ?? '',
      noOwner: !a.ownerClientId,
      assetModelId: a.assetModelId ?? '',
      model: a.model,
      manufacturer: a.manufacturer ?? '',
      serialNumber: a.serialNumber ?? '',
      inventoryNumber: a.inventoryNumber ?? '',
      location: a.location ?? '',
      lifecycleStatus: a.lifecycleStatus,
      riskClass: (a.riskClass ?? ''),
      requiredAttestationCategory: a.requiredAttestationCategory ?? '',
      commissionedAt: a.commissionedAt ?? '',
      warrantyUntil: a.warrantyUntil ?? '',
      notes: a.notes ?? '',
    });
  }, [isEdit, existing.data, form]);

  const create = trpc.assets.create.useMutation({
    onSuccess: async (res) => {
      await utils.assets.list.invalidate();
      navigate(`/assets/${res.id}`);
    },
    onError: (e) => setServerError(e.message),
  });
  const update = trpc.assets.update.useMutation({
    onSuccess: async () => {
      if (!editingId) return;
      await Promise.all([
        utils.assets.list.invalidate(),
        utils.assets.get.invalidate({ id: editingId }),
        utils.assets.events.invalidate({ assetId: editingId }),
      ]);
      navigate(`/assets/${editingId}`);
    },
    onError: (e) => setServerError(e.message),
  });

  function handlePickModel(id: string, m: AssetModelLite | null) {
    form.setValue('assetModelId', id);
    if (m) {
      form.setValue('model', m.model);
      form.setValue('manufacturer', m.manufacturer ?? '');
      // Подставляем класс риска/аттестацию только если поле ещё пустое — не затираем ручной ввод.
      if (m.riskClass && !form.getValues('riskClass')) {
        form.setValue('riskClass', m.riskClass);
      }
      if (m.requiredAttestationCategory && !form.getValues('requiredAttestationCategory')) {
        form.setValue('requiredAttestationCategory', m.requiredAttestationCategory);
      }
    }
  }

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    setServerError(null);
    if (!v.noOwner && !v.ownerClientId) {
      setServerError('Выберите клиента-владельца или отметьте «без привязки к клиенту»');
      return;
    }
    const payload = {
      ownerClientId: v.noOwner ? null : v.ownerClientId,
      assetModelId: v.assetModelId || null,
      model: v.model,
      manufacturer: v.manufacturer || null,
      serialNumber: v.serialNumber || null,
      inventoryNumber: v.inventoryNumber || null,
      location: v.location || null,
      lifecycleStatus: v.lifecycleStatus,
      riskClass: v.riskClass || null,
      requiredAttestationCategory: v.requiredAttestationCategory || null,
      commissionedAt: v.commissionedAt || null,
      warrantyUntil: v.warrantyUntil || null,
      notes: v.notes || null,
    };
    if (isEdit && editingId) {
      update.mutate({ id: editingId, patch: payload });
    } else {
      create.mutate(payload);
    }
  };

  const isPending = create.isPending || update.isPending;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Link
        href={isEdit ? `/assets/${editingId}` : '/assets'}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        {isEdit ? 'К карточке техники' : 'К списку техники'}
      </Link>
      <h1 className="text-xl font-semibold md:text-2xl">
        {isEdit ? 'Редактирование техники' : 'Новая единица техники'}
      </h1>

      <form
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        className="bg-card space-y-5 rounded-lg border p-4 md:p-6"
      >
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm font-medium">
            <input
              type="checkbox"
              {...form.register('noOwner')}
              className="h-4 w-4 rounded border accent-primary"
            />
            Без привязки к клиенту (веду как своё оборудование)
          </label>
          {form.watch('noOwner') ? (
            <p className="text-muted-foreground text-xs">
              Техника без клиента-владельца — например, собственный парк сервиса, демо-аппарат
              или оборудование на складе до продажи. Клиента можно будет указать позже.
            </p>
          ) : (
            <div>
              <Label required>Клиент-владелец</Label>
              <ClientPicker
                value={form.watch('ownerClientId') || null}
                onChange={(id) => form.setValue('ownerClientId', id)}
              />
            </div>
          )}
        </div>

        <div>
          <Label>Модель из каталога</Label>
          <AssetModelPicker
            value={form.watch('assetModelId') || null}
            onChange={handlePickModel}
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Выберите тип аппарата из справочника — поля «Модель» и «Производитель»
            заполнятся автоматически. Нет нужной модели — добавьте её прямо в поиске.
          </p>
        </div>

        <div>
          <Label required>Модель</Label>
          <input
            type="text"
            {...form.register('model', { required: true })}
            placeholder="Mindray DC-30, Tuttnauer 3870EA…"
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Производитель</Label>
            <input
              type="text"
              list="manufacturers-list"
              {...form.register('manufacturer')}
              placeholder="Philips, Drager, Mindray…"
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
            <datalist id="manufacturers-list">
              {manufacturers.data?.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
          <div>
            <Label>Серийный №</Label>
            <input
              type="text"
              {...form.register('serialNumber')}
              className="bg-background w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Инвентарный №</Label>
            <input
              type="text"
              {...form.register('inventoryNumber')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <div>
            <Label>Расположение</Label>
            <input
              type="text"
              {...form.register('location')}
              placeholder="Кабинет 305, Корпус Б"
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <Label>Статус</Label>
            <select
              {...form.register('lifecycleStatus')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="in_service">В работе</option>
              <option value="in_repair">В ремонте</option>
              <option value="awaiting_parts">Ждёт запчасти</option>
              <option value="reserve">Резерв</option>
              <option value="decommissioned">Списана</option>
            </select>
          </div>
          <div>
            <Label>Класс риска</Label>
            <select
              {...form.register('riskClass')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">не задан</option>
              <option value="1">1</option>
              <option value="2a">2а</option>
              <option value="2b">2б</option>
              <option value="3">3</option>
            </select>
            <p className="text-muted-foreground mt-1 text-xs">по Росздравнадзору</p>
          </div>
        </div>

        <div>
          <Label>Категория аттестации инженеров для обслуживания</Label>
          <RequiredAttestationCategorySelect
            value={form.watch('requiredAttestationCategory')}
            onChange={(v) => form.setValue('requiredAttestationCategory', v)}
          />
          <p className="text-muted-foreground mt-1 text-xs">
            Если задано — диспетчер увидит предупреждение при назначении инженера без
            действующей аттестации по этой категории. Назначение не блокируется.
          </p>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Дата ввода в эксплуатацию</Label>
            <input
              type="date"
              {...form.register('commissionedAt')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
          <div>
            <Label>Гарантия до</Label>
            <input
              type="date"
              {...form.register('warrantyUntil')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>

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
            onClick={() => navigate(isEdit ? `/assets/${editingId}` : '/assets')}
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

/**
 * Селект категорий аттестации (Stage 10'.I). Подгружает справочник из API,
 * добавляет опцию «не требуется». Падение запроса не блокирует — без options.
 */
function RequiredAttestationCategorySelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (v: string) => void;
}) {
  const cats = trpc.attestations.categories.useQuery();
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
    >
      <option value="">не требуется</option>
      {cats.data?.map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
      {/* Если в БД сохранено редкое значение вне справочника — показать его тоже. */}
      {value && !(cats.data as readonly string[] | undefined ?? []).includes(value) && (
        <option value={value}>{value}</option>
      )}
    </select>
  );
}
