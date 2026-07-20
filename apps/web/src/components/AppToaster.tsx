/**
 * Единственная точка показа всплывающих сообщений.
 *
 * Раньше ошибка сохранения не показывалась нигде: у мутаций был только onSuccess,
 * а глобального перехватчика не было — правка молча пропадала (наряд инженера,
 * карточка заявки у менеджера). Теперь перехватчик в main.tsx шлёт сюда.
 *
 * Оформление повторяет тост мобильной карточки заявки: зелёный — сделано,
 * жёлтый — легло в очередь и уйдёт само, красный — не сохранено.
 */
import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, CloudOff, X } from 'lucide-react';
import { subscribeToasts, type ToastMessage } from '../lib/toast';
import { cn } from '../lib/utils';

/** Ошибку держим дольше: её нужно успеть прочитать и понять, что делать. */
const TTL_MS: Record<ToastMessage['kind'], number> = {
  ok: 3000,
  queued: 5000,
  error: 8000,
};

const MAX_VISIBLE = 3;

export function AppToaster() {
  const [items, setItems] = useState<ToastMessage[]>([]);

  useEffect(() => {
    return subscribeToasts((msg) => {
      setItems((prev) => [...prev, msg].slice(-MAX_VISIBLE));
      setTimeout(() => {
        setItems((prev) => prev.filter((t) => t.id !== msg.id));
      }, TTL_MS[msg.kind]);
    });
  }, []);

  if (items.length === 0) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 bottom-20 z-[60] flex flex-col items-center gap-2 px-3 md:bottom-4"
      role="status"
      aria-live="polite"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg px-3 py-2 text-sm font-medium shadow-lg',
            t.kind === 'ok' && 'bg-success text-success-foreground',
            t.kind === 'queued' && 'bg-warning text-warning-foreground',
            t.kind === 'error' && 'bg-destructive text-destructive-foreground',
          )}
        >
          <span className="mt-0.5 shrink-0">
            {t.kind === 'ok' && <CheckCircle2 className="h-4 w-4" />}
            {t.kind === 'queued' && <CloudOff className="h-4 w-4" />}
            {t.kind === 'error' && <AlertCircle className="h-4 w-4" />}
          </span>
          <span className="flex-1">{t.text}</span>
          <button
            type="button"
            onClick={() => setItems((prev) => prev.filter((x) => x.id !== t.id))}
            className="shrink-0 opacity-70 transition hover:opacity-100"
            aria-label="Закрыть сообщение"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}
