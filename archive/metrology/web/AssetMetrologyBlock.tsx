/**
 * Stage 10'.G — блок «Метрология» в AssetCardPage.
 *
 * Два состояния:
 *   • requiresMetrology = false → пустая секция с кнопкой «Сделать СИ» (director + dispatcher).
 *   • requiresMetrology = true  → атрибуты + статус + ссылка в реестр + «Снять с учёта СИ».
 *
 * Использует существующие mutations metrology.upsertSiDetails / removeSiDetails,
 * не меняет backend.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { ChevronRight, Gauge, Loader2, ShieldCheck, Trash2, X } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ConfirmDialog } from './ui/ConfirmDialog';

interface Props {
  assetId: string;
  requiresMetrology: boolean;
  canManage: boolean;
}

export function AssetMetrologyBlock({ assetId, requiresMetrology, canManage }: Props) {
  const utils = trpc.useUtils();
  const siQ = trpc.metrology.getSi.useQuery(
    { assetId },
    { enabled: !!assetId && requiresMetrology, retry: false },
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);

  const remove = trpc.metrology.removeSiDetails.useMutation({
    onSuccess: async () => {
      setRemoveConfirmOpen(false);
      await Promise.all([
        utils.assets.get.invalidate({ id: assetId }),
        utils.metrology.getSi.invalidate({ assetId }),
        utils.metrology.listSi.invalidate(),
        utils.metrology.getDashboard.invalidate(),
      ]);
    },
  });

  if (!requiresMetrology) {
    return (
      <section className="bg-card space-y-3 rounded-lg border p-4 md:p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <Gauge className="h-4 w-4" />
          Метрология
        </h2>
        <p className="text-muted-foreground text-xs">
          Эта техника не учитывается в реестре СИ. Заведите атрибуты, чтобы попадало в журнал
          поверок 102-ФЗ.
        </p>
        {canManage && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
          >
            <ShieldCheck className="h-3.5 w-3.5" />
            Сделать СИ
          </button>
        )}
        {createOpen && (
          <CreateSiModal
            assetId={assetId}
            onClose={() => setCreateOpen(false)}
            onSaved={async () => {
              setCreateOpen(false);
              await Promise.all([
                utils.assets.get.invalidate({ id: assetId }),
                utils.metrology.getSi.invalidate({ assetId }),
                utils.metrology.listSi.invalidate(),
                utils.metrology.getDashboard.invalidate(),
              ]);
            }}
          />
        )}
      </section>
    );
  }

  if (siQ.isLoading) {
    return (
      <section className="bg-card rounded-lg border p-4 md:p-6">
        <Loader2 className="text-muted-foreground h-5 w-5 animate-spin" />
      </section>
    );
  }
  const si = siQ.data;
  if (!si) {
    return (
      <section className="bg-card space-y-2 rounded-lg border p-4 md:p-6">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <Gauge className="h-4 w-4" />
          Метрология
        </h2>
        <p className="text-muted-foreground text-xs">Атрибуты СИ не найдены.</p>
      </section>
    );
  }

  return (
    <section className="bg-card space-y-3 rounded-lg border p-4 md:p-6">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <Gauge className="h-4 w-4" />
          Метрология
        </h2>
        <StatusBadge status={si.status} />
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
        <KV label="Тип СИ" value={si.typeName} />
        <KV label="Класс точности" value={si.accuracyClass} />
        <KV label="Диапазон" value={si.measurementRange} />
        <KV label="Госреестр" value={si.patternRegistryNumber} />
        <KV label="Последняя поверка" value={si.lastCalibrationAt ?? '—'} />
        <KV
          label="Следующая поверка"
          value={si.nextCalibrationAt ?? '—'}
          className={cn(
            si.status === 'overdue' && 'text-destructive font-semibold',
            si.status === 'soon' && 'text-warning font-semibold',
          )}
        />
      </div>

      <div className="flex flex-wrap gap-2 pt-2">
        <Link
          href={`/metrology/${assetId}`}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium"
        >
          Открыть в реестре
          <ChevronRight className="h-3.5 w-3.5" />
        </Link>
        {canManage && (
          <button
            type="button"
            disabled={remove.isPending}
            onClick={() => setRemoveConfirmOpen(true)}
            className="hover:bg-destructive/10 text-destructive border-destructive/30 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Снять с учёта СИ
          </button>
        )}
      </div>

      <ConfirmDialog
        open={removeConfirmOpen}
        title="Снять технику с учёта СИ"
        description="Журнал поверок останется, но новые поверки записать будет нельзя."
        confirmText="Снять с учёта"
        variant="danger"
        loading={remove.isPending}
        onConfirm={() => remove.mutate({ assetId })}
        onCancel={() => setRemoveConfirmOpen(false)}
      />
    </section>
  );
}

function StatusBadge({ status }: { status: 'overdue' | 'soon' | 'ok' | 'never' }) {
  const cfg: Record<typeof status, { label: string; cls: string }> = {
    overdue: { label: 'Просрочено', cls: 'bg-destructive/10 text-destructive' },
    soon: { label: 'Скоро поверка', cls: 'bg-warning/15 text-warning' },
    ok: { label: 'В норме', cls: 'bg-success/10 text-success' },
    never: { label: 'Поверок ещё нет', cls: 'bg-muted text-muted-foreground' },
  };
  const c = cfg[status];
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-medium',
        c.cls,
      )}
    >
      {c.label}
    </span>
  );
}

function KV({
  label,
  value,
  className,
}: {
  label: string;
  value: string | null | undefined;
  className?: string;
}) {
  return (
    <div className="bg-muted/30 rounded-md border p-2">
      <div className="text-muted-foreground text-[10px] uppercase tracking-wide">{label}</div>
      <div className={cn('mt-0.5 text-sm', className)}>{value || '—'}</div>
    </div>
  );
}

const createSiSchema = z.object({
  typeName: z.string().trim().min(2, 'Введите тип СИ'),
  patternRegistryNumber: z.string().trim(),
  accuracyClass: z.string().trim(),
  measurementRange: z.string().trim(),
  calibrationIntervalMonths: z
    .number({ invalid_type_error: 'Введите интервал' })
    .int('Должно быть целым')
    .min(1, 'Минимум 1 мес.')
    .max(240, 'Максимум 240 мес.'),
});

type CreateSiValues = z.infer<typeof createSiSchema>;

function CreateSiModal({
  assetId,
  onClose,
  onSaved,
}: {
  assetId: string;
  onClose: () => void;
  onSaved: () => void | Promise<void>;
}) {
  const [error, setError] = useState<string | null>(null);

  const form = useForm<CreateSiValues>({
    resolver: zodResolver(createSiSchema),
    defaultValues: {
      typeName: '',
      patternRegistryNumber: '',
      accuracyClass: '',
      measurementRange: '',
      calibrationIntervalMonths: 12,
    },
  });

  const m = trpc.metrology.upsertSiDetails.useMutation({
    onSuccess: () => void onSaved(),
    onError: (e) => setError(e.message),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onSubmit = (values: CreateSiValues) => {
    setError(null);
    m.mutate({
      assetId,
      input: {
        typeName: values.typeName,
        patternRegistryNumber: values.patternRegistryNumber || null,
        accuracyClass: values.accuracyClass || null,
        measurementRange: values.measurementRange || null,
        calibrationIntervalMonths: values.calibrationIntervalMonths,
      },
    });
  };

  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-base font-semibold">Сделать средством измерений</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-3 p-4">
          <Field label="Тип СИ" required>
            <input
              autoFocus
              type="text"
              {...form.register('typeName')}
              placeholder="Например: Манометр МПЭ-3У"
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            {form.formState.errors.typeName && (
              <div className="text-destructive mt-1 text-xs">
                {form.formState.errors.typeName.message}
              </div>
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="№ Госреестра СИ">
              <input
                type="text"
                {...form.register('patternRegistryNumber')}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </Field>
            <Field label="Класс точности">
              <input
                type="text"
                {...form.register('accuracyClass')}
                className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
              />
            </Field>
          </div>
          <Field label="Диапазон измерений">
            <input
              type="text"
              {...form.register('measurementRange')}
              placeholder="Например: 0…600 мм рт. ст."
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </Field>
          <Field label="Межповерочный интервал, мес." required>
            <input
              type="number"
              min={1}
              max={240}
              {...form.register('calibrationIntervalMonths', { valueAsNumber: true })}
              className="bg-background focus:ring-primary/40 w-32 rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            {form.formState.errors.calibrationIntervalMonths && (
              <div className="text-destructive mt-1 text-xs">
                {form.formState.errors.calibrationIntervalMonths.message}
              </div>
            )}
          </Field>
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
      </div>
    </div>
  );
}

function Field({
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
