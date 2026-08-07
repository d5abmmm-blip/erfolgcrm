/**
 * Этап 6 — фото и документы под произвольную сущность.
 *
 * Flow upload:
 *   1. attachments.createUploadUrl → presigned PUT URL + attachmentId.
 *   2. fetch(PUT, body=file, headers) — напрямую в Object Storage / local emulator.
 *   3. attachments.confirmUpload({ attachmentId }) → server проверяет head() и помечает uploaded.
 *   4. invalidate listByReference.
 *
 * Размещается в карточке заявки, склада, ассета. На мобильнике добавляет capture="environment".
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Camera, Clock, Loader2, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { trpc, getTenantSubdomain } from '../lib/trpc';
import { cn } from '../lib/utils';
import { humanUploadError } from '../lib/photo-upload-error';
import { isNetworkError } from '../lib/offline/executor';
import {
  PhotoQueueFullError,
  enqueuePhoto,
  listPendingPhotos,
  photoBlob,
  removePhoto,
  retryPhoto,
  subscribePhotos,
  type PendingPhoto,
} from '../lib/offline/photo-queue';
import { sendPendingPhotos } from '../lib/offline/photo-sender';
import { uploadPendingPhoto } from '../lib/offline/runner';
import { ConfirmDialog } from './ui';

type Kind =
  | 'ticket_photo'
  | 'asset_photo'
  | 'inventory_receipt'
  | 'damage_photo'
  | 'completion_photo'
  | 'contract_signed'
  | 'document';

type RefType = 'ticket' | 'asset' | 'inventory_batch' | 'work_order_line' | 'contract';

interface Props {
  kind: Kind;
  referenceType: RefType;
  referenceId: string;
  /** Можно ли загружать (по роли). Просмотр — всегда. */
  canUpload: boolean;
  /** Можно ли удалять. По умолчанию = canUpload. */
  canDelete?: boolean;
  /** Подсказка под областью загрузки. */
  hint?: string;
  /** Включить кнопку «Камера» (для мобильника). */
  showCamera?: boolean;
  className?: string;
}

const ALLOWED_MIME = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf'];
const MAX_BYTES = 25 * 1024 * 1024;

export function PhotoUploader({
  kind,
  referenceType,
  referenceId,
  canUpload,
  canDelete,
  hint,
  showCamera,
  className,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  /**
   * Не отправленные фото. Лежат в памяти телефона (IndexedDB), а не в
   * состоянии экрана: раньше файл жил ровно пока открыта страница, и инженер,
   * снявший повреждение в подвале и нажавший «назад», терял снимок навсегда —
   * переснять уже нельзя, аппарат собран.
   */
  const [queued, setQueued] = useState<PendingPhoto[]>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const utils = trpc.useUtils();
  const tenantSubdomain = getTenantSubdomain();

  useEffect(() => {
    const refresh = () => {
      void listPendingPhotos({ referenceType, referenceId }).then(setQueued);
    };
    refresh();
    return subscribePhotos(refresh);
  }, [referenceType, referenceId]);

  // Ссылки на превью живут ровно столько, сколько сама плитка: без отзыва
  // браузер держит файлы в памяти до перезагрузки страницы.
  const previews = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of queued) {
      if (p.mimeType.startsWith('image/')) map.set(p.id, URL.createObjectURL(photoBlob(p)));
    }
    return map;
  }, [queued]);
  useEffect(() => {
    return () => {
      for (const url of previews.values()) URL.revokeObjectURL(url);
    };
  }, [previews]);

  const list = trpc.attachments.listByReference.useQuery({ referenceType, referenceId });
  const createUrl = trpc.attachments.createUploadUrl.useMutation();
  const confirm = trpc.attachments.confirmUpload.useMutation();
  const remove = trpc.attachments.delete.useMutation({
    onSuccess: () => {
      setDeleteTarget(null);
      return utils.attachments.listByReference.invalidate({ referenceType, referenceId });
    },
  });

  /**
   * Повторная отправка одного файла. Вынесено, чтобы «Повторить» на плитке
   * упавшего фото шло тем же путём, что и обычная загрузка.
   */
  const uploadOne = async (file: File): Promise<void> => {
    const presigned = await createUrl.mutateAsync({
      kind,
      referenceType,
      referenceId,
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
    await confirm.mutateAsync({ attachmentId: presigned.attachmentId });
  };

  /** Ещё раз отправить конкретное фото из очереди — по кнопке человека. */
  const retryQueued = async (id: string) => {
    setPending((p) => [...p, id]);
    try {
      await retryPhoto(id); // снимаем пометку «не принято»
      await sendPendingPhotos(uploadPendingPhoto);
    } finally {
      setPending((p) => p.filter((x) => x !== id));
      await utils.attachments.listByReference.invalidate({ referenceType, referenceId });
    }
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    const arr = Array.from(files);
    for (const file of arr) {
      // Эти две проверки — не повод класть файл в очередь: он не станет
      // подходящим оттого, что появится связь.
      if (!ALLOWED_MIME.includes(file.type)) {
        setError(`Тип «${file.type || file.name}» не поддерживается`);
        continue;
      }
      if (file.size > MAX_BYTES) {
        setError(`Файл «${file.name}» больше ${(MAX_BYTES / 1024 / 1024).toFixed(0)} МБ`);
        continue;
      }
      const tag = `${file.name}-${file.size}-${Date.now()}`;
      setPending((p) => [...p, tag]);
      try {
        await uploadOne(file);
      } catch (err) {
        // Не ушло — кладём в память телефона, а не теряем. Отказ по существу
        // (хранилище не приняло) тоже сохраняем: снимок единственный, пусть
        // человек решает, а не система за него.
        try {
          await enqueuePhoto({
            kind,
            referenceType,
            referenceId,
            file,
            tenantSubdomain,
            lastError: humanUploadError(err),
            ...(isNetworkError(err) ? {} : { failedHard: true }),
          });
        } catch (queueErr) {
          setError(
            queueErr instanceof PhotoQueueFullError
              ? queueErr.message
              : `Фото «${file.name}» сохранить не удалось: ${humanUploadError(err)}`,
          );
        }
      } finally {
        setPending((p) => p.filter((x) => x !== tag));
        await utils.attachments.listByReference.invalidate({ referenceType, referenceId });
      }
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    if (canUpload) void handleFiles(e.dataTransfer.files);
  };

  const items = list.data ?? [];
  const allowDelete = canDelete ?? canUpload;

  return (
    <div className={cn('space-y-3', className)}>
      {canUpload && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={onDrop}
          className="border-muted-foreground/30 hover:border-primary bg-muted/20 flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 transition"
        >
          <Upload className="text-muted-foreground h-5 w-5" />
          <div className="text-sm">
            Перетащите файлы сюда или
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              className="text-primary mx-1 underline-offset-4 hover:underline"
            >
              выберите
            </button>
            {showCamera && (
              <>
                /{' '}
                <button
                  type="button"
                  onClick={() => cameraRef.current?.click()}
                  className="text-primary inline-flex items-center gap-1 underline-offset-4 hover:underline"
                >
                  <Camera className="h-3.5 w-3.5" /> снять
                </button>
              </>
            )}
          </div>
          <div className="text-muted-foreground text-xs">
            {hint ?? 'JPEG, PNG, WebP, HEIC, PDF · до 25 МБ'}
          </div>
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ALLOWED_MIME.join(',')}
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
          {showCamera && (
            <input
              ref={cameraRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={(e) => void handleFiles(e.target.files)}
            />
          )}
        </div>
      )}

      {error && <div className="text-destructive text-sm">{error}</div>}

      {/* Ждут отправки. Лежат в памяти телефона: уход с экрана и перезапуск
          приложения их не трогают, уйдут сами, когда появится связь. */}
      {queued.length > 0 && (
        <div className="border-warning/40 bg-warning/10 space-y-2 rounded-lg border p-3">
          <div className="text-warning flex items-center gap-1.5 text-sm font-medium">
            <Clock className="h-4 w-4" />
            Ждут отправки: {queued.length}
          </div>
          <div className="text-muted-foreground text-xs">
            Фото сохранены в телефоне и уйдут сами, когда появится связь. Приложение можно закрыть.
          </div>
          <ul className="space-y-1.5">
            {queued.map((p) => (
              <li
                key={p.id}
                className="bg-card flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
              >
                <div className="flex min-w-0 items-center gap-2">
                  {previews.get(p.id) ? (
                    <img
                      src={previews.get(p.id)}
                      alt={p.fileName}
                      className="h-9 w-9 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="bg-muted grid h-9 w-9 shrink-0 place-items-center rounded">
                      <Upload className="text-muted-foreground h-4 w-4" />
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="truncate text-xs font-medium">{p.fileName}</div>
                    <div
                      className={cn(
                        'text-[11px]',
                        p.failedHard ? 'text-destructive' : 'text-muted-foreground',
                      )}
                    >
                      {p.failedHard ? (
                        <span className="inline-flex items-center gap-1">
                          <AlertTriangle className="h-3 w-3" />
                          {p.lastError ?? 'Не принято сервером'}
                        </span>
                      ) : (
                        'ждёт отправки'
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={pending.includes(p.id)}
                    onClick={() => void retryQueued(p.id)}
                    className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Отправить
                  </button>
                  <button
                    type="button"
                    onClick={() => setDropTarget(p.id)}
                    className="text-muted-foreground hover:text-destructive rounded-md p-1"
                    aria-label="Убрать фото из очереди"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {(items.length > 0 || pending.length > 0) && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
          {items.map((a) => (
            <ThumbCard
              key={a.id}
              id={a.id}
              name={a.originalName}
              mime={a.mimeType}
              url={a.presignedGetUrl}
              sizeBytes={a.sizeBytes}
              canDelete={allowDelete}
              onDelete={() => {
                // Было `confirm.isPending` — это мутация ПОДТВЕРЖДЕНИЯ ЗАГРУЗКИ,
                // а не удаления: пока грузилось любое фото, кнопка удаления
                // молча не срабатывала. Смотреть надо на само удаление.
                if (remove.isPending) return;
                setDeleteTarget(a.id);
              }}
            />
          ))}
          {pending.map((tag) => (
            <div
              key={tag}
              className="bg-muted/30 flex aspect-square items-center justify-center rounded-md border"
            >
              <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
            </div>
          ))}
        </div>
      )}

      {items.length === 0 && pending.length === 0 && !canUpload && (
        <div className="text-muted-foreground text-xs">Вложений пока нет.</div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="Удалить вложение?"
        description="Файл будет удалён без возможности восстановления."
        variant="danger"
        confirmText="Удалить"
        loading={remove.isPending}
        onConfirm={() => deleteTarget && remove.mutate({ id: deleteTarget })}
        onCancel={() => setDeleteTarget(null)}
      />

      {/* Спрашиваем, потому что убрать из очереди = потерять снимок:
          на сервер он не попал, а из телефона мы его сотрём. */}
      <ConfirmDialog
        open={dropTarget !== null}
        title="Убрать фото из очереди?"
        description="Оно не отправлено на сервер и будет потеряно. Если аппарат уже собран, снять заново не получится."
        variant="danger"
        confirmText="Убрать"
        onConfirm={() => {
          if (dropTarget) void removePhoto(dropTarget);
          setDropTarget(null);
        }}
        onCancel={() => setDropTarget(null)}
      />
    </div>
  );
}

interface ThumbProps {
  id: string;
  name: string;
  mime: string;
  url: string;
  sizeBytes: string;
  canDelete: boolean;
  onDelete: () => void;
}

function ThumbCard({ name, mime, url, sizeBytes, canDelete, onDelete }: ThumbProps) {
  const isImg = mime.startsWith('image/');
  return (
    <div className="bg-card group relative overflow-hidden rounded-md border">
      <a
        href={url}
        target="_blank"
        rel="noreferrer noopener"
        className="block aspect-square"
        title={name}
      >
        {isImg ? (
          <img src={url} alt={name} className="h-full w-full object-cover" loading="lazy" />
        ) : (
          <div className="text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-xs">
            <Upload className="h-6 w-6" />
            <div className="line-clamp-2 break-words">{name}</div>
          </div>
        )}
      </a>
      <div className="from-background/90 pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t p-1.5 text-[10px]">
        <div className="line-clamp-1 break-all font-medium">{name}</div>
        <div className="text-muted-foreground tabular-nums">{formatSize(sizeBytes)}</div>
      </div>
      {canDelete && (
        <button
          type="button"
          onClick={onDelete}
          className="bg-background/80 hover:bg-destructive/20 absolute right-1 top-1 rounded p-1 opacity-0 transition group-hover:opacity-100"
          aria-label="Удалить"
        >
          <Trash2 className="text-destructive h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}

function formatSize(bytes: string): string {
  const n = Number(bytes);
  if (n < 1024) return `${n} Б`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
  return `${(n / 1024 / 1024).toFixed(1)} МБ`;
}
