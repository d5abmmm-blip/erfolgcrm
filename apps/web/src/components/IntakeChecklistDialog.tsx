/**
 * Stage 10'.J — модальный диалог чек-листа приёмки/выдачи техники.
 *
 * Используется на TicketCardPage. Поддерживает два режима:
 *   - mode='create' — создаём новый чек-лист (выбор шаблона, ввод пунктов, фото).
 *   - mode='view' — просмотр уже сохранённого (read-only).
 *
 * Загрузка фото идёт через стандартный attachments-flow (createUploadUrl → PUT → confirmUpload),
 * referenceType='ticket', kind='damage_photo' (для intake) / 'completion_photo' (для handover).
 * После confirm сохраняем attachmentId на конкретный пункт; финальный submit отправляет
 * массив items с photoAttachmentId.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Camera, Loader2, Plus, Trash2, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

export type ChecklistKind = 'intake' | 'handover';
type ItemStatus = 'ok' | 'issue' | 'na';

interface ItemDraft {
  /** Только для UI keying. */
  uid: string;
  label: string;
  status: ItemStatus;
  comment: string;
  photoAttachmentId: string | null;
  /** Для UI: имя файла после загрузки. */
  photoName: string | null;
  uploading: boolean;
}

interface BaseProps {
  open: boolean;
  onClose: () => void;
  ticketId: string;
}

interface CreateProps extends BaseProps {
  mode: 'create';
  kind: ChecklistKind;
  onSaved?: () => void;
}

interface ViewProps extends BaseProps {
  mode: 'view';
  checklistId: string;
}

type Props = CreateProps | ViewProps;

const STATUS_OPTS: ReadonlyArray<{ v: ItemStatus; label: string; cls: string }> = [
  { v: 'ok', label: 'OK', cls: 'bg-success/10 text-success border-success/30' },
  { v: 'issue', label: 'Замечание', cls: 'bg-destructive/10 text-destructive border-destructive/30' },
  { v: 'na', label: 'Н/Д', cls: 'bg-muted text-muted-foreground border-border' },
];

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic'];
const MAX_BYTES = 25 * 1024 * 1024;

function makeUid(): string {
  return Math.random().toString(36).slice(2, 11);
}

export function IntakeChecklistDialog(props: Props) {
  if (!props.open) return null;
  if (props.mode === 'view') {
    return <ViewDialog {...props} />;
  }
  return <CreateDialog {...props} />;
}

function CreateDialog({ open, onClose, ticketId, kind, onSaved }: CreateProps) {
  const templates = trpc.intakeChecklists.getTemplates.useQuery(undefined, { enabled: open });
  const [tplKey, setTplKey] = useState<string>('general');
  const [items, setItems] = useState<ItemDraft[]>([]);
  const [signatureName, setSignatureName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const utils = trpc.useUtils();
  const createUrl = trpc.attachments.createUploadUrl.useMutation();
  const confirmUpload = trpc.attachments.confirmUpload.useMutation();
  const create = trpc.intakeChecklists.create.useMutation({
    onSuccess: async () => {
      await utils.intakeChecklists.listForTicket.invalidate({ ticketId });
      onSaved?.();
      onClose();
    },
    onError: (err) => setError(err.message),
  });

  // Загружаем шаблон при первой загрузке списка шаблонов / смене ключа.
  useEffect(() => {
    if (!templates.data) return;
    const tpl = templates.data.find((t) => t.key === tplKey) ?? templates.data[0];
    if (!tpl) return;
    setItems(
      tpl.items.map((label) => ({
        uid: makeUid(),
        label,
        status: 'ok' as ItemStatus,
        comment: '',
        photoAttachmentId: null,
        photoName: null,
        uploading: false,
      })),
    );
  }, [templates.data, tplKey]);

  const updateItem = (uid: string, patch: Partial<ItemDraft>) => {
    setItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, ...patch } : it)));
  };

  const addCustomItem = () => {
    setItems((prev) => [
      ...prev,
      {
        uid: makeUid(),
        label: '',
        status: 'ok',
        comment: '',
        photoAttachmentId: null,
        photoName: null,
        uploading: false,
      },
    ]);
  };

  const removeItem = (uid: string) => {
    setItems((prev) => prev.filter((it) => it.uid !== uid));
  };

  const uploadPhoto = async (uid: string, file: File) => {
    setError(null);
    if (!ALLOWED_MIME.includes(file.type)) {
      setError(`Тип «${file.type || file.name}» не поддерживается`);
      return;
    }
    if (file.size > MAX_BYTES) {
      setError(`Файл больше ${(MAX_BYTES / 1024 / 1024).toFixed(0)} МБ`);
      return;
    }
    updateItem(uid, { uploading: true });
    try {
      const presigned = await createUrl.mutateAsync({
        kind: kind === 'intake' ? 'damage_photo' : 'completion_photo',
        referenceType: 'ticket',
        referenceId: ticketId,
        fileName: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
      });
      const put = await fetch(presigned.presignedUrl, {
        method: 'PUT',
        body: file,
        headers: { 'content-type': file.type, ...presigned.headers },
      });
      if (!put.ok) throw new Error(`storage PUT ${put.status}`);
      await confirmUpload.mutateAsync({ attachmentId: presigned.attachmentId });
      updateItem(uid, {
        photoAttachmentId: presigned.attachmentId,
        photoName: file.name,
        uploading: false,
      });
    } catch (err) {
      setError((err as Error).message || 'Ошибка загрузки фото');
      updateItem(uid, { uploading: false });
    }
  };

  const submit = () => {
    setError(null);
    const cleanItems = items
      .map((it) => ({ ...it, label: it.label.trim() }))
      .filter((it) => it.label.length > 0);
    if (cleanItems.length === 0) {
      setError('Добавьте хотя бы один пункт');
      return;
    }
    create.mutate({
      ticketId,
      kind,
      items: cleanItems.map((it) => ({
        label: it.label,
        status: it.status,
        comment: it.comment.trim() || null,
        photoAttachmentId: it.photoAttachmentId,
      })),
      clientSignatureName: signatureName.trim() || null,
      notes: notes.trim() || null,
    });
  };

  const title = kind === 'intake' ? 'Чек-лист приёмки техники' : 'Чек-лист выдачи техники';
  const isBusy = create.isPending || items.some((it) => it.uploading);

  return (
    <Modal onClose={onClose} title={title} open={open}>
      {templates.isLoading ? (
        <div className="text-muted-foreground p-6 text-center text-sm">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </div>
      ) : (
        <div className="space-y-4">
          <div>
            <label className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Тип техники (шаблон)
            </label>
            <select
              value={tplKey}
              onChange={(e) => setTplKey(e.target.value)}
              className="bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
            >
              {(templates.data ?? []).map((t) => (
                <option key={t.key} value={t.key}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          <div className="space-y-2">
            {items.map((it) => (
              <ItemRow
                key={it.uid}
                item={it}
                onChange={(patch) => updateItem(it.uid, patch)}
                onRemove={() => removeItem(it.uid)}
                onPhoto={(file) => void uploadPhoto(it.uid, file)}
              />
            ))}
            <button
              type="button"
              onClick={addCustomItem}
              className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-1 text-xs"
            >
              <Plus className="h-3.5 w-3.5" /> Добавить свой пункт
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            <div>
              <label className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                ФИО клиента, принявшего работы
              </label>
              <input
                type="text"
                value={signatureName}
                onChange={(e) => setSignatureName(e.target.value)}
                maxLength={200}
                placeholder="Напр. Иванов И.И."
                className="bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Заметки
              </label>
              <input
                type="text"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                maxLength={500}
                placeholder="Опционально"
                className="bg-background mt-1 w-full rounded-md border px-2 py-1.5 text-sm"
              />
            </div>
          </div>

          {error && <div className="text-destructive text-sm">{error}</div>}

          <div className="flex items-center justify-end gap-2 border-t pt-3">
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm"
            >
              Отмена
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={isBusy}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {create.isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
              Сохранить
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function ItemRow({
  item,
  onChange,
  onRemove,
  onPhoto,
}: {
  item: ItemDraft;
  onChange: (patch: Partial<ItemDraft>) => void;
  onRemove: () => void;
  onPhoto: (file: File) => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  return (
    <div className="bg-card space-y-2 rounded-md border p-2">
      <div className="flex items-start gap-2">
        <input
          type="text"
          value={item.label}
          onChange={(e) => onChange({ label: e.target.value })}
          placeholder="Описание пункта"
          maxLength={300}
          className="bg-background flex-1 rounded-md border px-2 py-1 text-sm"
        />
        <button
          type="button"
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive p-1"
          aria-label="Удалить пункт"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        {STATUS_OPTS.map((opt) => (
          <button
            key={opt.v}
            type="button"
            onClick={() => onChange({ status: opt.v })}
            className={cn(
              'rounded-md border px-2 py-0.5 text-xs transition',
              item.status === opt.v
                ? opt.cls
                : 'border-border text-muted-foreground hover:border-foreground/30',
            )}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-md border border-dashed px-2 py-0.5 text-xs"
          disabled={item.uploading}
        >
          {item.uploading ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Camera className="h-3 w-3" />
          )}
          {item.photoAttachmentId ? 'Заменить фото' : 'Прикрепить фото'}
        </button>
        {item.photoName && (
          <span className="text-muted-foreground truncate text-xs">{item.photoName}</span>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onPhoto(f);
            e.target.value = '';
          }}
        />
      </div>
      {(item.status === 'issue' || item.comment) && (
        <input
          type="text"
          value={item.comment}
          onChange={(e) => onChange({ comment: e.target.value })}
          placeholder={item.status === 'issue' ? 'Что не так?' : 'Комментарий'}
          maxLength={500}
          className="bg-background w-full rounded-md border px-2 py-1 text-xs"
        />
      )}
    </div>
  );
}

function ViewDialog({ open, onClose, checklistId }: ViewProps) {
  const data = trpc.intakeChecklists.get.useQuery({ checklistId }, { enabled: open });
  const c = data.data;
  const title = useMemo(() => {
    if (!c) return 'Чек-лист';
    return c.kind === 'intake' ? 'Чек-лист приёмки' : 'Чек-лист выдачи';
  }, [c]);
  return (
    <Modal onClose={onClose} title={title} open={open}>
      {data.isLoading ? (
        <div className="text-muted-foreground p-6 text-center text-sm">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </div>
      ) : !c ? (
        <div className="text-destructive text-sm">Чек-лист не найден</div>
      ) : (
        <div className="space-y-3">
          <div className="text-muted-foreground text-xs">
            {new Date(c.completedAt).toLocaleString('ru-RU')} · {c.itemsCount} пунктов · замечаний:{' '}
            <span className={cn(c.issuesCount > 0 ? 'text-destructive' : 'text-muted-foreground')}>
              {c.issuesCount}
            </span>
          </div>
          <ul className="space-y-1">
            {c.items.map((it) => {
              const opt = STATUS_OPTS.find((o) => o.v === it.status)!;
              return (
                <li key={it.id} className="bg-card rounded-md border p-2 text-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1">{it.label}</div>
                    <span className={cn('rounded-md border px-1.5 py-0.5 text-xs', opt.cls)}>
                      {opt.label}
                    </span>
                  </div>
                  {it.comment && (
                    <div className="text-muted-foreground mt-1 text-xs">{it.comment}</div>
                  )}
                  {it.photoAttachmentId && (
                    <div className="text-muted-foreground mt-1 text-[11px]">
                      Прикреплено фото
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
          {c.clientSignatureName && (
            <div className="text-xs">
              <span className="text-muted-foreground">Принял:</span> {c.clientSignatureName}
            </div>
          )}
          {c.notes && (
            <div className="text-xs">
              <span className="text-muted-foreground">Заметки:</span> {c.notes}
            </div>
          )}
          <div className="flex items-center justify-end border-t pt-3">
            <button
              type="button"
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm"
            >
              Закрыть
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Modal({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      className="bg-background/70 fixed inset-0 z-50 flex items-start justify-center overflow-y-auto p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="bg-card my-6 w-full max-w-2xl rounded-lg border p-4 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between border-b pb-2">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
