/**
 * Модалка «По шаблону» для создания заявки.
 *
 * Показывает список активных шаблонов с описанием, числом строк и дефолтами.
 * При выборе вызывает onPick(templateId, defaults) — родитель применяет
 * defaults к форме создания тикета (priority/repairType), а apply(templateId)
 * выполняется уже после mutate tickets.create.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { Link } from 'wouter';
import type { RepairType, TicketPriority } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: 'низкий',
  normal: 'обычный',
  high: 'высокий',
  urgent: 'срочный',
};
const REPAIR_LABEL: Record<RepairType, string> = {
  paid: 'Платный',
  warranty: 'Гарантия',
  service_contract: 'По договору',
};

export interface TemplateDefaults {
  templateId: string;
  templateName: string;
  defaultPriority: TicketPriority | null;
  defaultRepairType: RepairType | null;
  defaultEstimatedMinutes: number | null;
  linesCount: number;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Вызывается когда пользователь выбрал шаблон. */
  onPick: (defaults: TemplateDefaults) => void;
}

export function TicketTemplatePicker({ open, onClose, onPick }: Props) {
  const list = trpc.ticketTemplates.list.useQuery(
    { includeArchived: false },
    { enabled: open },
  );
  const [search, setSearch] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setSearch('');
    inputRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const items = useMemo(() => {
    const data = list.data ?? [];
    if (!search.trim()) return data;
    const q = search.trim().toLowerCase();
    return data.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description ?? '').toLowerCase().includes(q),
    );
  }, [list.data, search]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="template-picker-title"
      className="fixed inset-0 z-50 flex items-start justify-center p-4 sm:items-center"
    >
      <button
        type="button"
        aria-label="Закрыть"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="bg-card relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-lg border shadow-xl">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 id="template-picker-title" className="text-base font-semibold">
            Выбор шаблона
          </h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b px-4 py-2">
          <input
            ref={inputRef}
            type="text"
            placeholder="Поиск по названию или описанию"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {list.isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Загрузка шаблонов…
            </div>
          ) : list.error ? (
            <div className="text-destructive p-4 text-sm">
              Ошибка: {list.error.message}
            </div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground space-y-2 p-6 text-center text-sm">
              {(list.data ?? []).length === 0 ? (
                <>
                  Шаблонов ещё нет.{' '}
                  <Link
                    href="/templates"
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    Создать первый
                  </Link>
                </>
              ) : (
                'Ничего не найдено по этому запросу.'
              )}
            </div>
          ) : (
            <ul className="space-y-1">
              {items.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() =>
                      onPick({
                        templateId: t.id,
                        templateName: t.name,
                        defaultPriority: t.defaultPriority,
                        defaultRepairType: t.defaultRepairType,
                        defaultEstimatedMinutes: t.defaultEstimatedMinutes,
                        linesCount: t.linesCount,
                      })
                    }
                    className={cn(
                      'hover:bg-muted/40 group flex w-full flex-col gap-1 rounded-md border px-3 py-2 text-left transition',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-medium">{t.name}</span>
                      <span className="text-muted-foreground text-xs">
                        строк: {t.linesCount}
                      </span>
                    </div>
                    {t.description && (
                      <p className="text-muted-foreground line-clamp-2 text-xs">
                        {t.description}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-1 text-[11px]">
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
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="text-muted-foreground border-t px-4 py-2 text-xs">
          После выбора шаблона строки добавятся в наряд автоматически — после создания
          заявки. Цены и количества можно отредактировать.
        </div>
      </div>
    </div>
  );
}
