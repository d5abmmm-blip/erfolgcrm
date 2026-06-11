/**
 * /kb — база знаний.
 *
 * Сценарии:
 *   - Менеджер заводит статьи про модели техники, типовые операции, прошлые
 *     сложные ремонты. Заголовок + Markdown тело + тэги + модели/asset-id.
 *   - Просмотр и поиск в общем списке (trigram по title+body).
 *
 * Список — DataTable, форма редактирования с MD-textarea и предпросмотром.
 * Архивирование (soft delete), без полного удаления — историю не теряем.
 *
 * MD-предпросмотр упрощён до lightweight-рендера: жирный, заголовки, списки и
 * параграфы. Без зависимостей (react-markdown тащит ~80kb), 11 человек —
 * можно прожить на простой реализации.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  useFieldArray,
  useForm,
  type Resolver,
  type SubmitHandler,
} from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import {
  Archive,
  ArrowLeft,
  BookOpen,
  Plus,
  RotateCcw,
  Search,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ConfirmDialog, DataTable, StatusBadge, type Column } from '../components/ui';
import { renderMarkdown } from '../lib/markdown';

interface KbListItem {
  id: string;
  title: string;
  bodyExcerpt: string;
  tags: string[];
  assetModels: string[];
  attachedAssetIds: string[];
  archivedAt: Date | null;
  updatedAt: Date;
}

const formSchema = z.object({
  title: z.string().trim().min(1, 'Заголовок обязателен').max(200),
  body: z.string().max(100_000),
  tags: z.array(z.object({ value: z.string().trim().max(50) })),
  assetModels: z.array(z.object({ value: z.string().trim().max(200) })),
});
type FormValues = z.infer<typeof formSchema>;

const EMPTY_FORM: FormValues = {
  title: '',
  body: '',
  tags: [],
  assetModels: [],
};

export function KbPage() {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [includeArchived, setIncludeArchived] = useState(false);

  const list = trpc.kbArticles.list.useQuery(
    { query: search.trim() || undefined, includeArchived },
    { staleTime: 5_000 },
  );

  if (editingId !== null) {
    return (
      <KbEditor
        id={editingId === 'new' ? null : editingId}
        onClose={() => setEditingId(null)}
      />
    );
  }

  const items: KbListItem[] = list.data ?? [];

  const columns: Column<KbListItem>[] = [
    {
      key: 'title',
      label: 'Заголовок',
      render: (a) => (
        <div className="font-medium">
          {a.title}
          {a.archivedAt && (
            <StatusBadge variant="muted" compact className="ml-2">
              архив
            </StatusBadge>
          )}
          {a.bodyExcerpt && (
            <div className="text-muted-foreground mt-0.5 line-clamp-2 text-xs font-normal">
              {a.bodyExcerpt}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'models',
      label: 'Модели',
      render: (a) =>
        a.assetModels.length > 0 ? (
          <div className="flex flex-wrap gap-1 text-xs">
            {a.assetModels.slice(0, 3).map((m) => (
              <span
                key={m}
                className="bg-muted text-muted-foreground rounded px-1.5 py-0.5"
              >
                {m}
              </span>
            ))}
            {a.assetModels.length > 3 && (
              <span className="text-muted-foreground">
                +{a.assetModels.length - 3}
              </span>
            )}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'tags',
      label: 'Тэги',
      render: (a) =>
        a.tags.length > 0 ? (
          <div className="flex flex-wrap gap-1 text-xs">
            {a.tags.map((t) => (
              <span
                key={t}
                className="bg-primary/10 text-primary rounded px-1.5 py-0.5"
              >
                #{t}
              </span>
            ))}
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    {
      key: 'updated',
      label: 'Обновлено',
      headerClassName: 'text-right',
      className: 'text-right tabular-nums',
      render: (a) => (
        <span className="text-muted-foreground text-xs">
          {new Date(a.updatedAt).toLocaleDateString('ru-RU', {
            day: '2-digit',
            month: '2-digit',
            year: '2-digit',
          })}
        </span>
      ),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-muted-foreground inline-flex items-center gap-1 text-xs">
            <BookOpen className="h-3.5 w-3.5" />
            Внутренняя «вики» команды
          </div>
          <h1 className="mt-1 text-xl font-semibold md:text-2xl">База знаний</h1>
          <p className="text-muted-foreground mt-0.5 text-sm">
            Записи о моделях техники, типовых операциях и прошлых сложных ремонтах.
            Видны в карточке заявки и асcета как «Похожие случаи».
          </p>
        </div>
        <button
          type="button"
          onClick={() => setEditingId('new')}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-3 py-2 text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          Новая статья
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по заголовку и тексту…"
            className="bg-background w-full rounded-md border pl-8 pr-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
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

      <DataTable<KbListItem>
        data={items}
        columns={columns}
        loading={list.isLoading}
        error={list.error ? { message: list.error.message } : null}
        emptyText={
          search
            ? 'Ничего не нашлось — попробуйте другие слова или короче запрос.'
            : 'Статей пока нет — создайте первую по кнопке выше.'
        }
        rowKey={(r) => r.id}
        onRowClick={(r) => setEditingId(r.id)}
        rowClassName={(r) => (r.archivedAt ? 'opacity-60' : '')}
      />
    </div>
  );
}

function KbEditor({
  id,
  onClose,
}: {
  id: string | null;
  onClose: () => void;
}) {
  const isNew = id === null;
  const utils = trpc.useUtils();
  const detail = trpc.kbArticles.get.useQuery({ id: id ?? '' }, { enabled: !isNew });
  const [archiveAsk, setArchiveAsk] = useState(false);
  const [showPreview, setShowPreview] = useState(true);

  const initial = useMemo<FormValues>(() => {
    if (isNew || !detail.data) return EMPTY_FORM;
    return {
      title: detail.data.title,
      body: detail.data.body,
      tags: detail.data.tags.map((value) => ({ value })),
      assetModels: detail.data.assetModels.map((value) => ({ value })),
    };
  }, [isNew, detail.data]);

  const form = useForm<FormValues>({
    defaultValues: EMPTY_FORM,
    values: initial,
    resolver: zodResolver(formSchema) as unknown as Resolver<FormValues>,
  });
  const tags = useFieldArray({ control: form.control, name: 'tags' });
  const models = useFieldArray({ control: form.control, name: 'assetModels' });

  const create = trpc.kbArticles.create.useMutation({
    onSuccess: async () => {
      await utils.kbArticles.list.invalidate();
      onClose();
    },
  });
  const update = trpc.kbArticles.update.useMutation({
    onSuccess: async () => {
      await utils.kbArticles.list.invalidate();
      if (id) await utils.kbArticles.get.invalidate({ id });
      onClose();
    },
  });
  const archive = trpc.kbArticles.archive.useMutation({
    onSuccess: async () => {
      await utils.kbArticles.list.invalidate();
      onClose();
    },
  });
  const unarchive = trpc.kbArticles.unarchive.useMutation({
    onSuccess: async () => {
      await utils.kbArticles.list.invalidate();
      if (id) await utils.kbArticles.get.invalidate({ id });
    },
  });

  const isPending =
    create.isPending || update.isPending || archive.isPending || unarchive.isPending;
  const archived =
    !isNew && detail.data?.archivedAt !== null && detail.data?.archivedAt !== undefined;

  const onSubmit: SubmitHandler<FormValues> = (v) => {
    const cleanTags = v.tags
      .map((t) => t.value.trim().toLowerCase())
      .filter((t) => t.length > 0);
    const cleanModels = v.assetModels
      .map((m) => m.value.trim())
      .filter((m) => m.length > 0);
    const payload = {
      title: v.title.trim(),
      body: v.body,
      tags: cleanTags,
      assetModels: cleanModels,
      attachedAssetIds: detail.data?.attachedAssetIds ?? [],
    };
    if (isNew) create.mutate(payload);
    else update.mutate({ id: id, patch: payload });
  };

  const bodyValue = form.watch('body');

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <button
        type="button"
        onClick={onClose}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        К списку
      </button>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold md:text-2xl">
          {isNew ? 'Новая статья' : 'Редактирование статьи'}
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
                onClick={() => unarchive.mutate({ id: id })}
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
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        className="bg-card space-y-4 rounded-lg border p-4 md:p-6"
      >
        <div>
          <Label required>Заголовок</Label>
          <input
            type="text"
            {...form.register('title')}
            placeholder="«Калибровка тонометра Omron HEM-7156 — пошагово»"
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          {form.formState.errors.title && (
            <p className="text-destructive mt-1 text-xs">
              {form.formState.errors.title.message}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <ChipsField
            label="Тэги"
            values={tags.fields}
            registerName="tags"
            register={form.register}
            onAdd={() => tags.append({ value: '' })}
            onRemove={(idx) => tags.remove(idx)}
            placeholder="например: калибровка"
            hint="Свободные тэги (через Enter добавится новый)."
          />
          <ChipsField
            label="Модели техники"
            values={models.fields}
            registerName="assetModels"
            register={form.register}
            onAdd={() => models.append({ value: '' })}
            onRemove={(idx) => models.remove(idx)}
            placeholder="например: Omron HEM-7156"
            hint="Точное название модели (как в карточке асcета)."
          />
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between">
            <Label>Тело статьи (Markdown)</Label>
            <button
              type="button"
              onClick={() => setShowPreview((v) => !v)}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
            >
              <Sparkles className="h-3 w-3" />
              {showPreview ? 'Скрыть превью' : 'Показать превью'}
            </button>
          </div>
          <div
            className={
              showPreview
                ? 'grid grid-cols-1 gap-3 md:grid-cols-2'
                : 'grid grid-cols-1 gap-3'
            }
          >
            <textarea
              {...form.register('body')}
              rows={18}
              placeholder={
                '## Шаги\n1. Подключить прибор к стенду…\n2. Прогреть 5 минут…\n\n**Внимание:** не использовать манжету < 22 см.'
              }
              className="bg-background w-full font-mono rounded-md border px-3 py-2 text-xs outline-none focus:ring-2 focus:ring-primary/40"
            />
            {showPreview && (
              <div
                className="bg-muted/30 prose prose-sm max-w-none overflow-auto rounded-md border p-3 text-sm"
                dangerouslySetInnerHTML={{ __html: renderMarkdown(bodyValue) }}
              />
            )}
          </div>
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
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md px-4 py-2 text-sm font-medium"
          >
            {isPending ? 'Сохранение…' : isNew ? 'Создать' : 'Сохранить'}
          </button>
        </div>
      </form>

      <ConfirmDialog
        open={archiveAsk}
        title="Отправить статью в архив?"
        description="Статья перестанет показываться в списке и в блоке «Похожие случаи». Текст останется, его можно будет восстановить."
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

interface ChipsFieldProps {
  label: string;
  values: { id: string }[];
  registerName: 'tags' | 'assetModels';
  register: ReturnType<typeof useForm<FormValues>>['register'];
  onAdd: () => void;
  onRemove: (idx: number) => void;
  placeholder: string;
  hint: string;
}

function ChipsField({
  label,
  values,
  registerName,
  register,
  onAdd,
  onRemove,
  placeholder,
  hint,
}: ChipsFieldProps) {
  return (
    <div>
      <Label>{label}</Label>
      <div className="space-y-1.5">
        {values.length === 0 && (
          <p className="text-muted-foreground rounded-md border border-dashed py-3 text-center text-xs">
            Нет — добавьте хотя бы один.
          </p>
        )}
        {values.map((field, idx) => (
          <div key={field.id} className="flex gap-1.5">
            <input
              type="text"
              {...register(`${registerName}.${idx}.value` as const)}
              placeholder={placeholder}
              className="bg-background flex-1 rounded-md border px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button
              type="button"
              onClick={() => onRemove(idx)}
              aria-label="Удалить"
              className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive grid place-items-center rounded-md border w-7"
            >
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onAdd}
        className="hover:bg-muted mt-1.5 inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
      >
        <Plus className="h-3 w-3" />
        Добавить
      </button>
      <p className="text-muted-foreground mt-1 text-[10px]">{hint}</p>
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

// silence unused imports for Link (used only by kb route from outside) — keep for future
void Link;
