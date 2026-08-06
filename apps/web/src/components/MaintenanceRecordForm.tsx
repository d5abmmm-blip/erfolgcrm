import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { X } from 'lucide-react';
import { trpc } from '../lib/trpc';

interface Props {
  assetId: string;
  scheduleId?: string | null;
  ticketId?: string | null;
  onClose: () => void;
  onSaved: () => void;
}

const schema = z.object({
  summary: z.string().trim().min(2, 'Кратко опишите что сделано'),
  notes: z.string().trim(),
});

type FormValues = z.infer<typeof schema>;

export function MaintenanceRecordForm({ assetId, scheduleId, ticketId, onClose, onSaved }: Props) {
  const [error, setError] = useState<string | null>(null);

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { summary: '', notes: '' },
  });

  const record = trpc.maintenance.recordPerformed.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const onSubmit = (values: FormValues) => {
    setError(null);
    record.mutate({
      assetId,
      scheduleId: scheduleId ?? null,
      ticketId: ticketId ?? null,
      summary: values.summary,
      notes: values.notes ? values.notes : null,
    });
  };

  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">Записать выполнение ТО</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <form onSubmit={(e) => void form.handleSubmit(onSubmit)(e)} className="space-y-3 p-4">
          <div>
            <label htmlFor="summary" className="text-muted-foreground text-xs font-medium">
              Что сделано <span className="text-destructive">*</span>
            </label>
            <input
              id="summary"
              type="text"
              autoFocus
              placeholder="Пример: Замена фильтра HEPA, проверка калибровки"
              {...form.register('summary')}
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
            {form.formState.errors.summary && (
              <div className="text-destructive mt-1 text-xs">
                {form.formState.errors.summary.message}
              </div>
            )}
          </div>
          <div>
            <label htmlFor="notes" className="text-muted-foreground text-xs font-medium">
              Подробности
            </label>
            <textarea
              id="notes"
              rows={3}
              {...form.register('notes')}
              className="bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2"
            />
          </div>
          {error && <div className="text-destructive text-sm">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="hover:bg-muted rounded-md border px-3 py-2 text-sm transition"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={record.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {record.isPending ? 'Сохраняем…' : 'Записать'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
