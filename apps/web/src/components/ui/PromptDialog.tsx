import { useEffect, useRef, useState } from 'react';
import { cn } from '../../lib/utils';

interface PromptDialogProps {
  open: boolean;
  title: string;
  description?: string;
  /** Подпись над полем. */
  label?: string;
  /** Плейсхолдер. */
  placeholder?: string;
  /** Начальное значение. */
  initialValue?: string;
  confirmText?: string;
  cancelText?: string;
  variant?: 'default' | 'danger';
  onConfirm: (value: string) => void;
  onCancel: () => void;
  /** Состояние pending. */
  loading?: boolean;
  /** Если true — поле обязательно непустое. */
  required?: boolean;
  /** Использовать textarea вместо input (для длинных причин). */
  multiline?: boolean;
}

/**
 * Замена window.prompt() — модальный диалог с input/textarea.
 * Используется, например, для ввода причины отмены счёта.
 */
export function PromptDialog({
  open,
  title,
  description,
  label,
  placeholder,
  initialValue = '',
  confirmText = 'Подтвердить',
  cancelText = 'Отмена',
  variant = 'default',
  onConfirm,
  onCancel,
  loading,
  required = false,
  multiline = false,
}: PromptDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Reset state when dialog re-opens.
  useEffect(() => {
    if (open) {
      setValue(initialValue);
    }
  }, [open, initialValue]);

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();

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

  const canConfirm = !required || value.trim().length > 0;

  const handleConfirm = () => {
    if (!canConfirm) return;
    onConfirm(value);
  };

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="prompt-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center"
    >
      <button
        type="button"
        aria-label="Закрыть диалог"
        onClick={onCancel}
        className="absolute inset-0 bg-black/40"
      />

      <div className="bg-card relative z-10 w-full max-w-md rounded-lg border p-5 shadow-xl">
        <h3 id="prompt-dialog-title" className="text-base font-semibold">
          {title}
        </h3>
        {description && (
          <p className="text-muted-foreground mt-2 text-sm whitespace-pre-line">
            {description}
          </p>
        )}
        <div className="mt-3 space-y-1">
          {label && (
            <label className="text-muted-foreground text-xs font-medium">{label}</label>
          )}
          {multiline ? (
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={placeholder}
              rows={3}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type="text"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && canConfirm) {
                  e.preventDefault();
                  handleConfirm();
                }
              }}
              placeholder={placeholder}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm font-medium disabled:opacity-50"
          >
            {cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={loading || !canConfirm}
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
