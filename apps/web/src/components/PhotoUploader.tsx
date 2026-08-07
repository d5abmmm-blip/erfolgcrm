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
import { useRef, useState } from 'react';
import { AlertTriangle, Camera, Loader2, RefreshCw, Trash2, Upload, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ConfirmDialog } from './ui';

/**
 * Человеческий текст вместо «Failed to fetch» и «storage PUT 403».
 * Инженер в поле должен понимать, что делать, а не что сломалось.
 */
export function humanUploadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!navigator.onLine || raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
    return 'Нет связи — фото не отправлено';
  }
  if (/storage PUT (401|403)/.test(raw))
    return 'Хранилище отклонило файл — позовите администратора';
  if (/storage PUT 4\d\d/.test(raw)) return 'Файл не принят хранилищем';
  if (/storage PUT 5\d\d/.test(raw)) return 'Хранилище недоступно — повторите';
  return raw || 'Не удалось отправить фото';
}

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
   * Не отправленные фото вместе с самими файлами.
   *
   * ВНИМАНИЕ: это память экрана, а не очередь. Уйдёте со страницы или закроете
   * приложение — файлы пропадут. Настоящая офлайн-очередь для фото требует
   * отдельного хранилища (ссылка на загрузку живёт 15 минут, поэтому повтор
   * назавтра надо начинать с нуля) — это отдельная работа. Здесь задача одна:
   * чтобы фото не исчезало МОЛЧА и его можно было переотправить сразу.
   */
  const [failed, setFailed] = useState<Array<{ id: string; file: File; reason: string }>>([]);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  const utils = trpc.useUtils();

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

  const retryFailed = async (id: string) => {
    const item = failed.find((f) => f.id === id);
    if (!item) return;
    setFailed((prev) => prev.filter((f) => f.id !== id));
    setPending((p) => [...p, id]);
    try {
      await uploadOne(item.file);
    } catch (err) {
      setFailed((prev) => [...prev, { ...item, reason: humanUploadError(err) }]);
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
        // Раньше файл здесь терялся насовсем: он жил только в замыкании, а на
        // экране оставалась одна техническая строка вроде «Failed to fetch».
        // Теперь держим сам File и показываем плитку с кнопкой «Повторить».
        setFailed((prev) => [...prev, { id: tag, file, reason: humanUploadError(err) }]);
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

      {/* Не отправленные фото. Раньше файл пропадал молча — спиннер снимался,
          и экран выглядел так, будто фото и не выбирали. */}
      {failed.length > 0 && (
        <div className="border-destructive/30 bg-destructive/5 space-y-2 rounded-lg border p-3">
          <div className="text-destructive flex items-center gap-1.5 text-sm font-medium">
            <AlertTriangle className="h-4 w-4" />
            Не отправлено: {failed.length}
          </div>
          <div className="text-muted-foreground text-xs">
            Файлы держатся только на этом экране. Отправьте сейчас — если уйти со страницы или
            закрыть приложение, их придётся снимать заново.
          </div>
          <ul className="space-y-1.5">
            {failed.map((f) => (
              <li
                key={f.id}
                className="bg-card flex items-center justify-between gap-2 rounded-md border px-2 py-1.5"
              >
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium">{f.file.name}</div>
                  <div className="text-destructive text-[11px]">{f.reason}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <button
                    type="button"
                    disabled={pending.includes(f.id)}
                    onClick={() => void retryFailed(f.id)}
                    className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs disabled:opacity-50"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Повторить
                  </button>
                  <button
                    type="button"
                    onClick={() => setFailed((prev) => prev.filter((x) => x.id !== f.id))}
                    className="text-muted-foreground hover:text-foreground rounded-md p-1"
                    aria-label="Убрать из списка"
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
