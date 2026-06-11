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
import { Camera, Loader2, Trash2, Upload } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

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
  const utils = trpc.useUtils();

  const list = trpc.attachments.listByReference.useQuery({ referenceType, referenceId });
  const createUrl = trpc.attachments.createUploadUrl.useMutation();
  const confirm = trpc.attachments.confirmUpload.useMutation();
  const remove = trpc.attachments.delete.useMutation({
    onSuccess: () => utils.attachments.listByReference.invalidate({ referenceType, referenceId }),
  });

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
      } catch (err) {
        setError((err as Error).message || 'Ошибка загрузки');
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
                / <button
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
                if (confirm.isPending) return;
                if (window.confirm('Удалить вложение?')) remove.mutate({ id: a.id });
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
