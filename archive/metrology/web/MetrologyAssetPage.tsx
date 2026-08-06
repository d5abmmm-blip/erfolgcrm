/**
 * /metrology/:assetId — карточка СИ: атрибуты + журнал поверок + новая поверка.
 *
 * Stage 10'.F MVP. Доступно директору и диспетчеру.
 */
import { useEffect, useRef, useState } from 'react';
import { Link, useRoute } from 'wouter';
import { ChevronLeft, FileCheck2, FileText, Loader2, Pencil, Plus, Upload, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

export function MetrologyAssetPage() {
  const [, params] = useRoute<{ assetId: string }>('/metrology/:assetId');
  const assetId = params?.assetId ?? '';
  const me = trpc.auth.me.useQuery();

  const utils = trpc.useUtils();
  const siQ = trpc.metrology.getSi.useQuery({ assetId }, { enabled: !!assetId });
  const calsQ = trpc.metrology.getCalibrations.useQuery({ assetId }, { enabled: !!assetId });
  // Документы (PDF протоколы) прикреплены к ассету kind='document'.
  // Используем для резолва presigned GET по documentAttachmentId.
  const attachmentsQ = trpc.attachments.listByReference.useQuery(
    { referenceType: 'asset' as const, referenceId: assetId },
    { enabled: !!assetId },
  );
  const attachmentById = new Map((attachmentsQ.data ?? []).map((a) => [a.id, a]));

  const [editOpen, setEditOpen] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);

  if (me.data && me.data.user.role !== 'director' && me.data.user.role !== 'dispatcher') {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-lg border p-4 text-sm">
          Раздел доступен только директору и диспетчеру.
        </div>
      </div>
    );
  }

  if (siQ.isLoading) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (siQ.error || !siQ.data) {
    return (
      <div className="mx-auto max-w-2xl space-y-3 p-6">
        <Link href="/metrology" className="text-primary text-xs hover:underline">
          ← Реестр СИ
        </Link>
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-lg border p-4 text-sm">
          СИ не найдено
        </div>
      </div>
    );
  }
  const si = siQ.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <Link
        href="/metrology"
        className="text-primary inline-flex items-center text-sm hover:underline"
      >
        <ChevronLeft className="h-4 w-4" />
        Реестр СИ
      </Link>

      <div className="bg-card space-y-3 rounded-lg border p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-muted-foreground text-xs uppercase tracking-wide">
              {si.typeName}
            </div>
            <h1 className="text-xl font-semibold md:text-2xl">{si.assetModel}</h1>
            {si.assetSerial && (
              <div className="text-muted-foreground font-mono text-xs">сер. № {si.assetSerial}</div>
            )}
            {si.ownerClientName && (
              <div className="text-muted-foreground text-xs">Клиент: {si.ownerClientName}</div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setEditOpen(true)}
            className="bg-secondary hover:bg-muted inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
          >
            <Pencil className="h-3.5 w-3.5" />
            Атрибуты
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">
          <Field label="Класс точности" value={si.accuracyClass} />
          <Field label="Диапазон" value={si.measurementRange} />
          <Field label="Межповерочный интервал" value={`${si.calibrationIntervalMonths} мес.`} />
          <Field label="Госреестр СИ" value={si.patternRegistryNumber} />
          <Field label="Последняя поверка" value={si.lastCalibrationAt ?? '—'} />
          <Field
            label="Следующая поверка"
            value={si.nextCalibrationAt ?? '—'}
            className={cn(
              si.status === 'overdue' && 'text-destructive font-semibold',
              si.status === 'soon' && 'text-warning font-semibold',
            )}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Журнал поверок</h2>
        <button
          type="button"
          onClick={() => setCalibrationOpen(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          Новая поверка
        </button>
      </div>

      <div className="bg-card overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
            <tr>
              <th className="p-3 text-left font-medium">Дата</th>
              <th className="p-3 text-left font-medium">До</th>
              <th className="p-3 text-left font-medium">№ свидетельства</th>
              <th className="p-3 text-left font-medium">Поверитель</th>
              <th className="p-3 text-left font-medium">Результат</th>
              <th className="p-3 text-left font-medium">Протокол</th>
              <th className="p-3 text-left font-medium">Заметка</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {calsQ.isLoading && (
              <tr>
                <td colSpan={7} className="text-muted-foreground p-6 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            )}
            {!calsQ.isLoading && calsQ.data && calsQ.data.length === 0 && (
              <tr>
                <td colSpan={7} className="text-muted-foreground p-6 text-center">
                  Поверок ещё не было
                </td>
              </tr>
            )}
            {calsQ.data?.map((c) => {
              const att = c.documentAttachmentId
                ? attachmentById.get(c.documentAttachmentId)
                : undefined;
              return (
                <tr key={c.id} className="hover:bg-muted/30">
                  <td className="p-3 text-xs tabular-nums">{c.performedAt}</td>
                  <td className="p-3 text-xs tabular-nums">{c.validUntil}</td>
                  <td className="p-3 font-mono text-xs">{c.certificateNumber ?? '—'}</td>
                  <td className="text-muted-foreground p-3 text-xs">{c.calibratorOrg ?? '—'}</td>
                  <td className="p-3">
                    <ResultBadge result={c.result} />
                  </td>
                  <td className="p-3 text-xs">
                    {att ? (
                      <a
                        href={att.presignedGetUrl}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-primary inline-flex items-center gap-1 hover:underline"
                        title={att.originalName}
                      >
                        <FileText className="h-3.5 w-3.5" />
                        PDF
                      </a>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="text-muted-foreground p-3 text-xs">{c.notes ?? '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editOpen && (
        <EditSiModal
          assetId={assetId}
          initial={{
            typeName: si.typeName,
            patternRegistryNumber: si.patternRegistryNumber,
            accuracyClass: si.accuracyClass,
            measurementRange: si.measurementRange,
            calibrationIntervalMonths: si.calibrationIntervalMonths,
          }}
          onClose={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            void utils.metrology.getSi.invalidate({ assetId });
            void utils.metrology.listSi.invalidate();
          }}
        />
      )}
      {calibrationOpen && (
        <CalibrationModal
          assetId={assetId}
          onClose={() => setCalibrationOpen(false)}
          onSaved={() => {
            setCalibrationOpen(false);
            void utils.metrology.getSi.invalidate({ assetId });
            void utils.metrology.getCalibrations.invalidate({ assetId });
            void utils.metrology.listSi.invalidate();
            void utils.metrology.getDashboard.invalidate();
            void utils.attachments.listByReference.invalidate({
              referenceType: 'asset',
              referenceId: assetId,
            });
          }}
        />
      )}
    </div>
  );
}

function Field({
  label,
  value,
  className,
}: {
  label: string;
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <div>
      <div className="text-muted-foreground text-[11px] uppercase tracking-wide">{label}</div>
      <div className={cn('mt-0.5 text-sm', className)}>{value || '—'}</div>
    </div>
  );
}

function ResultBadge({ result }: { result: 'passed' | 'failed' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded px-2 py-0.5 text-[10px] font-medium uppercase',
        result === 'passed' ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive',
      )}
    >
      {result === 'passed' ? (
        <>
          <FileCheck2 className="h-3 w-3" />
          Годна
        </>
      ) : (
        'Брак'
      )}
    </span>
  );
}

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-base font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
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

function FieldLabel({
  label,
  required,
  children,
}: {
  label: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </div>
      <div className="mt-1">{children}</div>
    </label>
  );
}

interface SiInitial {
  typeName: string;
  patternRegistryNumber: string | null;
  accuracyClass: string | null;
  measurementRange: string | null;
  calibrationIntervalMonths: number;
}

function EditSiModal({
  assetId,
  initial,
  onClose,
  onSaved,
}: {
  assetId: string;
  initial: SiInitial;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [typeName, setTypeName] = useState(initial.typeName);
  const [pattern, setPattern] = useState(initial.patternRegistryNumber ?? '');
  const [accuracy, setAccuracy] = useState(initial.accuracyClass ?? '');
  const [range, setRange] = useState(initial.measurementRange ?? '');
  const [interval, setInterval] = useState(initial.calibrationIntervalMonths);
  const [error, setError] = useState<string | null>(null);
  const m = trpc.metrology.upsertSiDetails.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });
  return (
    <ModalShell title="Атрибуты СИ" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          m.mutate({
            assetId,
            input: {
              typeName,
              patternRegistryNumber: pattern || null,
              accuracyClass: accuracy || null,
              measurementRange: range || null,
              calibrationIntervalMonths: interval,
            },
          });
        }}
        className="space-y-3 p-4"
      >
        <FieldLabel label="Тип СИ" required>
          <input
            autoFocus
            type="text"
            value={typeName}
            onChange={(e) => setTypeName(e.target.value)}
            required
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
        </FieldLabel>
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="№ Госреестра СИ">
            <input
              type="text"
              value={pattern}
              onChange={(e) => setPattern(e.target.value)}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </FieldLabel>
          <FieldLabel label="Класс точности">
            <input
              type="text"
              value={accuracy}
              onChange={(e) => setAccuracy(e.target.value)}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </FieldLabel>
        </div>
        <FieldLabel label="Диапазон измерений">
          <input
            type="text"
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
        </FieldLabel>
        <FieldLabel label="Межповерочный интервал, мес." required>
          <input
            type="number"
            min={1}
            max={240}
            value={interval}
            onChange={(e) => setInterval(Number(e.target.value))}
            required
            className="bg-background focus:ring-primary/40 w-32 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
        </FieldLabel>
        {error && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm font-medium"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={m.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Сохранить
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function CalibrationModal({
  assetId,
  onClose,
  onSaved,
}: {
  assetId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [performedAt, setPerformedAt] = useState(today);
  const [validUntil, setValidUntil] = useState(today);
  const [certNo, setCertNo] = useState('');
  const [org, setOrg] = useState('');
  const [result, setResult] = useState<'passed' | 'failed'>('passed');
  const [notes, setNotes] = useState('');
  const [pdfFile, setPdfFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createUrl = trpc.attachments.createUploadUrl.useMutation();
  const confirmUpload = trpc.attachments.confirmUpload.useMutation();
  const m = trpc.metrology.addCalibration.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  /**
   * Шаги: presign → PUT → confirm → addCalibration с documentAttachmentId.
   * Если PDF не выбран — addCalibration без attachment.
   */
  const submit = async () => {
    setError(null);
    setBusy(true);
    let documentAttachmentId: string | null = null;
    try {
      if (pdfFile) {
        const presigned = await createUrl.mutateAsync({
          kind: 'document',
          referenceType: 'asset',
          referenceId: assetId,
          fileName: pdfFile.name,
          mimeType: pdfFile.type || 'application/pdf',
          sizeBytes: pdfFile.size,
        });
        const put = await fetch(presigned.presignedUrl, {
          method: 'PUT',
          body: pdfFile,
          headers: {
            'content-type': pdfFile.type || 'application/pdf',
            ...presigned.headers,
          },
        });
        if (!put.ok) throw new Error(`Загрузка PDF не удалась: ${put.status}`);
        await confirmUpload.mutateAsync({ attachmentId: presigned.attachmentId });
        documentAttachmentId = presigned.attachmentId;
      }
      await m.mutateAsync({
        assetId,
        input: {
          performedAt,
          validUntil,
          certificateNumber: certNo || null,
          calibratorOrg: org || null,
          result,
          notes: notes || null,
          documentAttachmentId,
        },
      });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalShell title="Новая поверка" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="space-y-3 p-4"
      >
        <div className="grid grid-cols-2 gap-3">
          <FieldLabel label="Дата проведения" required>
            <input
              type="date"
              value={performedAt}
              onChange={(e) => setPerformedAt(e.target.value)}
              required
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </FieldLabel>
          <FieldLabel label="Действительна до" required>
            <input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              required
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </FieldLabel>
        </div>
        <FieldLabel label="№ свидетельства">
          <input
            type="text"
            value={certNo}
            onChange={(e) => setCertNo(e.target.value)}
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus:ring-2"
          />
        </FieldLabel>
        <FieldLabel label="Поверитель (организация)">
          <input
            type="text"
            value={org}
            onChange={(e) => setOrg(e.target.value)}
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
        </FieldLabel>
        <FieldLabel label="Результат" required>
          <select
            value={result}
            onChange={(e) => setResult(e.target.value as 'passed' | 'failed')}
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          >
            <option value="passed">Годна</option>
            <option value="failed">Брак / непригодна</option>
          </select>
        </FieldLabel>
        <FieldLabel label="Заметка">
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={3}
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
          />
        </FieldLabel>
        <FieldLabel label="Протокол поверки (PDF)">
          <PdfPicker file={pdfFile} onChange={setPdfFile} />
        </FieldLabel>
        {error && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm font-medium"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={busy}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-60"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            Записать
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

const MAX_PDF_BYTES = 10 * 1024 * 1024;

function PdfPicker({ file, onChange }: { file: File | null; onChange: (f: File | null) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localError, setLocalError] = useState<string | null>(null);

  const handle = (f: File | undefined) => {
    setLocalError(null);
    if (!f) return;
    if (f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      setLocalError('Только PDF');
      return;
    }
    if (f.size > MAX_PDF_BYTES) {
      setLocalError(`Размер до ${(MAX_PDF_BYTES / 1024 / 1024).toFixed(0)} МБ`);
      return;
    }
    onChange(f);
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    handle(e.dataTransfer.files?.[0]);
  };

  if (file) {
    return (
      <div className="bg-muted/30 flex items-center justify-between gap-2 rounded-md border p-2">
        <div className="flex items-center gap-2 truncate text-sm">
          <FileText className="text-primary h-4 w-4 flex-shrink-0" />
          <span className="truncate" title={file.name}>
            {file.name}
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {(file.size / 1024 / 1024).toFixed(1)} МБ
          </span>
        </div>
        <button
          type="button"
          onClick={() => onChange(null)}
          className="text-muted-foreground hover:text-destructive"
          aria-label="Убрать файл"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    );
  }

  return (
    <>
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
        className="border-muted-foreground/30 hover:border-primary bg-muted/20 flex flex-col items-center justify-center gap-1 rounded-md border-2 border-dashed p-3 text-center transition"
      >
        <Upload className="text-muted-foreground h-4 w-4" />
        <div className="text-xs">
          Перетащите PDF или
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            className="text-primary mx-1 underline-offset-4 hover:underline"
          >
            выберите
          </button>
        </div>
        <div className="text-muted-foreground text-[10px]">PDF до 10 МБ</div>
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf"
          className="hidden"
          onChange={(e) => handle(e.target.files?.[0] ?? undefined)}
        />
      </div>
      {localError && <div className="text-destructive mt-1 text-xs">{localError}</div>}
    </>
  );
}
