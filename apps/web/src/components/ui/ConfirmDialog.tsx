import { useEffect, useRef } from 'react';
import { cn } from '../../lib/utils';

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  onConfirm: () => void;
  onCancel: () => void;
  /** Состояние pending для предотвращения двойных кликов. */
  loading?: boolean;
}

/**
 * Простой headless-стиль ConfirmDialog (без зависимостей вроде @radix-ui).
 *
 * a11y: role="dialog", aria-modal, фокус на cancel при открытии, Escape закрывает.
 *
 * Не используем browser confirm()/alert() — UX в браузере неконтролируем,
 * Safari/Firefox показывают разный текст и блокируют возможность кастомизации.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmText = 'Подтвердить',
  cancelText = 'Отмена',
  variant = 'default',
  onConfirm,
  onCancel,
  loading,
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
        return;
      }
      // Focus trap: Tab не уходит за пределы открытого диалога (WAI-ARIA).
      if (e.key === 'Tab' && rootRef.current) {
        const focusables = rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        if (focusables.length === 0) return;
        const first = focusables[0]!;
        const last = focusables[focusables.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !rootRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !rootRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      {/* Overlay */}
      <button
        type="button"
        aria-label="Закрыть диалог"
        onClick={onCancel}
        className="absolute inset-0 bg-black/40"
      />

      {/* Box */}
      <div className="bg-card relative z-10 w-full max-w-md rounded-lg border p-5 shadow-xl">
        <h3 id="confirm-dialog-title" className="text-base font-semibold">
          {title}
        </h3>
        {description && (
          <p className="text-muted-foreground mt-2 text-sm whitespace-pre-line">
            {description}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={loading}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50',
              variant === 'danger'
                ? 'bg-destructive hover:bg-destructive/90'
                : 'bg-primary hover:bg-primary/90',
            )}
          >
            {loading ? 'Подождите…' : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
