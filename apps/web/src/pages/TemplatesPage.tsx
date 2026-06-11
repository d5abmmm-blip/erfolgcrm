/**
 * /templates — справочник шаблонов заявок.
 *
 * Сценарий: директор/диспетчер заводит типовые операции
 * («Замена термопасты», «Калибровка тонометра», «ТО монитора пациента»),
 * чтобы при создании тикета менеджер мог нажать «По шаблону» и получить
 * предзаполненные работы / запчасти / оценку времени.
 *
 * Реализация:
 *   - Список — DataTable, по клику открывается форма редактирования (handle через состояние).
 *   - Форма с react-hook-form + useFieldArray для строк наряда.
 *   - Архивирование (soft delete) и восстановление — без полного удаления, чтобы
 *     не терять историю применений.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  useFieldArray,
  useForm,
  type SubmitHandler,
  type Resolver,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { Archive, ArrowLeft, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ConfirmDialog, DataTable, StatusBadge, type Column } from '../components/ui';
import { cn } from '../lib/utils';

const QUANTITY_REGEX = /^\d+(\.\d{1,3})?$/;

const lineSchema = z.object({
  lineType: z.enum(['work', 'part', 'expense']),
  name: z.string().trim().min(1, 'Название обязательно').max(500),
  unit: z.string().trim().min(1, 'Единица измерения').max(20),
  quantity: z
    .string()
    .regex(QUANTITY_REGEX, 'Количество — целое или дробное (до 3-х знаков): 1, 0.5, 12.345'),
  unitPriceRubInput: z.string().trim(),
});

const formSchema = z.object({
  name: z.string().trim().min(1, 'Название обязательно').max(200),
  description: z.string().trim().max(5000),
  defaultRepairType: z.enum(['', 'paid', 'warranty', 'service_contract']),
  defaultPriority: z.enum(['', 'low', 'normal', 'high', 'urgent']),
  defaultEstimatedMinutes: z.string().trim(),
  lines: z.array(lineSchema),
});

type FormValues = z.infer<typeof formSchema>;

const EMPTY_FORM: FormValues = {
  name: '',
  description: '',
  defaultRepairType: '',
  defaultPriority: '',
  defaultEstimatedMinutes: '',
  lines: [],
};

const LINE_TYPE_LABEL: Record<'work' | 'part' | 'expense', string> = {
  work: 'Работа',
  part: 'Запчасть',
  expense: 'Расход',
};

const REPAIR_LABEL: Record<'paid' | 'warranty' | 'service_contract', string> = {
  paid: 'Платный',
  warranty: 'Гарантия',
  service_contract: 'По договору',
};

const PRIORITY_LABEL: Record<'low' | 'normal' | 'high' | 'urgent', string> = {
  low: 'низкий',
  normal: 'обычный',
  high: 'высокий',
  urgent: 'срочный',
};

interface TemplateListItem {
  id: string;
  name: string;
  description: string | null;
  archivedAt: Date | null;
  linesCount: number;
  defaultRepairType: 'paid' | 'warranty' | 'service_contract' | null;
  defaultPriority: 'low' | 'normal' | 'high' | 'urgent' | null;
  defaultEstimatedMinutes: number | null;
}

export function TemplatesPage() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editingId, setEditingId] = useState<string | 'new' | null>(null);
  const list = trpc.ticketTemplates.list.useQuery({ includeArchived });

  if (editingId !== null) {
    return (
      <TemplateEditor
        id={editingId === 'new' ? null : editingId}
        onClose={() => setEditingId(null)}
      />
    );
  }

  const items: TemplateListItem[] = list.data ?? [];

  const columns: Column<TemplateListItem>[] = [
    {
      key: 'name',
      label: 'Название',
      render: (t) => (
        <div className="font-medium">
          {t.name}
          {t.archivedAt && (
            <StatusBadge variant="muted" compact className="ml-2">
              архив
            </StatusBadge>
          )}
        </div>
      ),
    },
    {
      key: 'description',
      label: 'Описание',
      render: (t) =>
        t.description ? (
          <span className="text-muted-foreground line-clamp-2">{t.description}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'lines',
      label: 'Строк',
      className: 'text-right tabular-nums',
      headerClassName: 'text-right',
      render: (t) => <span className="tabular-nums">{t.linesCount}</span>,
    },
    {
      key: 'defaults',
      label: 'Дефолты',
      render: (t) => (
        <div className="flex flex-wrap gap-1 text-xs">
          {t.defaultPriority && (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5">
              {PRIORITY_LABEL[t.defaultPriority]}
            </span>
          )}
          {t.defaultRepairType && (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5">
              {REPAIR_LABEL[t.defaultRepairType]}
            </span>
          )}
          {t.defaultEstimatedMinutes !== null && (
            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5">
              {t.defaultEstimatedMinutes} мин
            </span>
          )}
          {!t.defaultPriority &&
            !t.defaultRepairType &&
            t.defaultEstimatedMinutes === null && (
              <span className="text-muted-foreground">—</span>
            )}
        </div>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <Link
            href="/settings"
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            К настройкам
          </Link>
          <h1 className="mt-1 text-xl font-semibold md:text-2xl">Шаблоны заявок</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Типовые операции (например «Замена термопасты»). При создании заявки менеджер
            нажмёт «По шаблону» — и в наряд автоматически добавятся строки.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditingId('new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          Новый шаблон
        </button>
      </div>

      <div className="flex items-center gap-3">
        <label className="text-muted-foreground inline-flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="h-3.5 w-3.5"
          />
          Показывать архивные
        </label>
      </div>

      <DataTable<TemplateListItem>
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText="Шаблонов пока нет — создайте первый по кнопке выше."
        rowKey={(r) => r.id}
        onRowClick={(r) => setEditingId(r.id)}
        rowClassName={(r) => (r.archivedAt ? 'opacity-60' : '')}
      />
    </div>
  );
}

function TemplateEditor({ id, onClose }: { id: string | null; onClose: () => void }) {
  const isNew = id === null;
  const utils = trpc.useUtils();
  const detail = trpc.ticketTemplates.get.useQuery(
    { id: id ?? '' },
    { enabled: !isNew },
  );
  const [archiveAsk, setArchiveAsk] = useState(false);

  const initial = useMemo<FormValues>(() => {
    if (isNew || !detail.data) return EMPTY_FORM;
    const t = detail.data;
    return {
      name: t.name,
      description: t.description ?? '',
      defaultRepairType: t.defaultRepairType ?? '',
      defaultPriority: t.defaultPriority ?? '',
      defaultEstimatedMinutes:
        t.defaultEstimatedMinutes !== null ? String(t.defaultEstimatedMinutes) : '',
      lines: t.lines.map((l) => ({
        lineType: l.lineType,
        name: l.name,
        unit: l.unit,
        quantity: l.quantity,
        unitPriceRubInput: l.unitPriceRub !== null ? String(l.unitPriceRub) : '',
      })),
    };
  }, [isNew, detail.data]);

  const form = useForm<FormValues>({
    defaultValues: EMPTY_FORM,
    values: initial,
    resolver: zodResolver(formSchema) as unknown as Resolver<FormValues>,
  });

  const lines = useFieldArray({ control: form.control, name: 'lines' });

  const create = trpc.ticketTemplates.create.useMutation({
    onSuccess: async () => {
      await utils.ticketTemplates.list.invalidate();
      onClose();
    },
  });
  const update = trpc.ticketTemplates.update.useMutation({
    onSuccess: async () => {
      await utils.ticketTemplates.list.invalidate();
      if (id) await utils.ticketTemplates.get.invalidate({ id });
      onClose();
    },
  });
  const archive = trpc.ticketTemplates.archive.useMutation({
    onSuccess: async () => {
      await utils.ticketTemplates.list.invalidate();
      onClose();
    },
  });
  const unarchive = trpc.ticketTemplates.unarchive.useMutation({
    onSuccess: async () => {
      await utils.ticketTemplates.list.invalidate();
      if (id) await utils.ticketTemplates.get.invalidate({ id });
    },
  });

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    const minutesNum = v.defaultEstimatedMinutes
      ? Number.parseInt(v.defaultEstimatedMinutes, 10)
      : null;
    if (
      v.defaultEstimatedMinutes &&
      (Number.isNaN(minutesNum) || minutesNum! < 1 || minutesNum! > 720)
    ) {
      form.setError('defaultEstimatedMinutes', {
        message: 'Минуты от 1 до 720',
      });
      return;
    }
    const linesPayload = v.lines.map((l) => ({
      lineType: l.lineType,
      name: l.name,
      unit: l.unit,
      quantity: l.quantity,
      unitPriceRub:
        l.unitPriceRubInput && l.unitPriceRubInput.trim().length > 0
          ? Number.parseInt(l.unitPriceRubInput, 10)
          : null,
      inventoryItemId: null,
    }));
    if (linesPayload.some((l) => l.unitPriceRub !== null && Number.isNaN(l.unitPriceRub))) {
      form.setError('lines', { message: 'Цена — целое число рублей' });
      return;
    }

    const common = {
      name: v.name.trim(),
      description: v.description.trim() ? v.description.trim() : null,
      defaultRepairType: v.defaultRepairType ? v.defaultRepairType : null,
      defaultPriority: v.defaultPriority ? v.defaultPriority : null,
      defaultEstimatedMinutes: minutesNum,
      lines: linesPayload,
    };

    if (isNew) {
      create.mutate(common);
    } else {
      update.mutate({ id: id!, patch: common });
    }
  };

  const isPending =
    create.isPending || update.isPending || archive.isPending || unarchive.isPending;
  const archived = !isNew && detail.data?.archivedAt !== null && detail.data?.archivedAt !== undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <button
        type="button"
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        К списку шаблонов
      </button>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">
          {isNew ? 'Новый шаблон' : 'Редактирование шаблона'}
          {archived && (
            <StatusBadge variant="muted" compact className="ml-2 align-middle">
              в архиве
            </StatusBadge>
          )}
        </h1>
        {!isNew && (
          <div className="flex gap-2">
            {archived ? (
              <button
                type="button"
                onClick={() => unarchive.mutate({ id: id! })}
                disabled={isPending}
                className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
              >
                <RotateCcw className="h-3.5 w-3.5" />
                Восстановить
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setArchiveAsk(true)}
                disabled={isPending}
                className="text-destructive hover:bg-destructive/10 inline-flex items-center gap-1 rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
              >
                <Archive className="h-3.5 w-3.5" />
                В архив
              </button>
            )}
          </div>
        )}
      </div>

      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="bg-card space-y-4 rounded-lg border p-4 md:p-6"
      >
        <div>
          <Label required>Название</Label>
          <input
            type="text"
            {...form.register('name')}
            placeholder="«Замена термопасты на CPU/GPU»"
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          {form.formState.errors.name && (
            <p className="text-destructive mt-1 text-xs">
              {form.formState.errors.name.message}
            </p>
          )}
        </div>

        <div>
          <Label>Описание</Label>
          <textarea
            rows={2}
            {...form.register('description')}
            placeholder="Когда применяется, что входит, что не входит"
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <div>
            <Label>Тип ремонта по умолчанию</Label>
            <select
              {...form.register('defaultRepairType')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">— не менять —</option>
              <option value="paid">Платный</option>
              <option value="warranty">Гарантия</option>
              <option value="service_contract">По договору</option>
            </select>
          </div>
          <div>
            <Label>Приоритет по умолчанию</Label>
            <select
              {...form.register('defaultPriority')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">— не менять —</option>
              <option value="low">низкий</option>
              <option value="normal">обычный</option>
              <option value="high">высокий</option>
              <option value="urgent">срочный</option>
            </select>
          </div>
          <div>
            <Label>Оценка трудозатрат, мин</Label>
            <input
              type="text"
              inputMode="numeric"
              {...form.register('defaultEstimatedMinutes')}
              placeholder="например 60"
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
            {form.formState.errors.defaultEstimatedMinutes && (
              <p className="text-destructive mt-1 text-xs">
                {form.formState.errors.defaultEstimatedMinutes.message}
              </p>
            )}
          </div>
        </div>

        <div className="border-t pt-4">
          <div className="mb-2 flex items-center justify-between">
            <Label>Строки наряда</Label>
            <button
              type="button"
              onClick={() =>
                lines.append({
                  lineType: 'work',
                  name: '',
                  unit: 'шт',
                  quantity: '1',
                  unitPriceRubInput: '',
                })
              }
              className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
            >
              <Plus className="h-3 w-3" />
              Добавить
            </button>
          </div>
          {lines.fields.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed py-6 text-center text-xs">
              Строк нет. Добавьте работы, запчасти или расходы.
            </p>
          ) : (
            <div className="space-y-2">
              {lines.fields.map((field, idx) => {
                const lineErrors = form.formState.errors.lines?.[idx];
                return (
                  <div
                    key={field.id}
                    className="bg-background grid grid-cols-12 gap-2 rounded-md border p-2"
                  >
                    <select
                      {...form.register(`lines.${idx}.lineType` as const)}
                      className="bg-background col-span-2 rounded-md border px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-primary/40"
                    >
                      <option value="work">Работа</option>
                      <option value="part">Запчасть</option>
                      <option value="expense">Расход</option>
                    </select>
                    <input
                      type="text"
                      placeholder="Название"
                      {...form.register(`lines.${idx}.name` as const)}
                      className="bg-background col-span-5 rounded-md border px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <input
                      type="text"
                      placeholder="ед."
                      {...form.register(`lines.${idx}.unit` as const)}
                      className="bg-background col-span-1 rounded-md border px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <input
                      type="text"
                      inputMode="decimal"
                      placeholder="кол-во"
                      {...form.register(`lines.${idx}.quantity` as const)}
                      className="bg-background col-span-1 rounded-md border px-2 py-1 text-right text-xs tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <input
                      type="text"
                      inputMode="numeric"
                      placeholder="цена ₽"
                      {...form.register(`lines.${idx}.unitPriceRubInput` as const)}
                      className="bg-background col-span-2 rounded-md border px-2 py-1 text-right text-xs tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <button
                      type="button"
                      onClick={() => lines.remove(idx)}
                      aria-label="Удалить строку"
                      className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive col-span-1 grid place-items-center rounded-md border"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                    {lineErrors && (
                      <p className="text-destructive col-span-12 text-xs">
                        {lineErrors.name?.message ??
                          lineErrors.quantity?.message ??
                          lineErrors.unit?.message ??
                          'Ошибка в строке'}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {typeof form.formState.errors.lines?.message === 'string' && (
            <p className="text-destructive mt-1 text-xs">
              {form.formState.errors.lines.message}
            </p>
          )}
        </div>

        {(create.error || update.error) && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
            {create.error?.message ?? update.error?.message}
          </div>
        )}

        <div className="flex items-center justify-end gap-2 border-t pt-4">
          <button
            type="button"
            onClick={onClose}
            className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={isPending}
            className={cn(
              'bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50',
            )}
          >
            {isPending ? 'Сохранение…' : isNew ? 'Создать шаблон' : 'Сохранить'}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={archiveAsk}
        title="Отправить шаблон в архив?"
        description="Шаблон перестанет показываться при создании заявки. Уже применённые ранее строки нарядов останутся как есть."
        confirmText="В архив"
        variant="danger"
        onConfirm={() => {
          setArchiveAsk(false);
          archive.mutate({ id: id! });
        }}
        onCancel={() => setArchiveAsk(false)}
        loading={archive.isPending}
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

// Подсказка по типу строки — оставлена в комментариях чтобы не загромождать UI;
// в реальной выборке достаточно select с тремя опциями (работа/запчасть/расход).
void LINE_TYPE_LABEL;
