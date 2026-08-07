/**
 * «Не отправлено» — то, что сервер отказался принять.
 *
 * ЗАЧЕМ. Раньше такая запись удалялась из очереди навсегда, а человек видел
 * одно число: «сервер не принял 3 изменения». Что именно не приняли и какой
 * текст комментария он писал — восстановить было нельзя.
 *
 * Здесь видно название, содержимое и причину, а рядом — три действия:
 * повторить, скопировать текст (чтобы вставить заново руками) и убрать.
 * Показываются и чужие записи: инженер должен понимать, почему в очереди
 * что-то висит, даже если отправить это может только его сменщик.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, RefreshCw, UserRound, X } from 'lucide-react';
import {
  listPending,
  remove,
  retryOutboxItem,
  subscribe,
  type OutboxItem,
} from '../lib/offline/queue';
import { getCurrentUserId } from '../lib/offline/current-user';
import { describeOutboxItem } from '../lib/offline/describe-outbox';
import { humanizeError } from '../lib/error-message';
import { showToast } from '../lib/toast';
import { cn } from '../lib/utils';
import { ConfirmDialog } from './ui';

interface Props {
  /** Обычно `() => void outbox.sync()` — повтор идёт общим проходом очереди. */
  onRetryAll: () => void;
}

export function OutboxRejectedList({ onRetryAll }: Props) {
  const [items, setItems] = useState<OutboxItem[]>([]);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    const refresh = () => {
      void listPending().then((all) =>
        setItems(all.filter((i) => i.failedHard || isForeign(i, getCurrentUserId()))),
      );
    };
    refresh();
    return subscribe(refresh);
  }, []);

  if (items.length === 0) return null;

  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      setTimeout(() => setCopied((c) => (c === id ? null : c)), 2000);
    } catch {
      // Буфер обмена может быть закрыт настройками браузера — не молчим.
      showToast('error', 'Не удалось скопировать — выделите текст вручную');
    }
  };

  return (
    <div className="bg-card space-y-2 rounded-lg border p-4">
      <div className="text-destructive flex items-center gap-1.5 text-sm font-medium">
        <AlertTriangle className="h-4 w-4" />
        Не отправлено: {items.length}
      </div>
      <p className="text-muted-foreground text-xs">
        Эти правки сервер не принял. Они сохранены — ничего не пропало. Повторите, когда причина
        уйдёт, или скопируйте текст и внесите заново.
      </p>
      <ul className="space-y-2">
        {items.map((item) => {
          const d = describeOutboxItem(item);
          const foreign = isForeign(item, getCurrentUserId());
          return (
            <li key={item.id} className="rounded-md border p-2.5">
              <div className="text-sm font-medium">{d.title}</div>
              {d.detail && (
                <div className="text-muted-foreground mt-0.5 whitespace-pre-wrap text-xs">
                  {d.detail}
                </div>
              )}
              <div
                className={cn(
                  'mt-1 inline-flex items-center gap-1 text-[11px]',
                  foreign ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {foreign ? (
                  <>
                    <UserRound className="h-3 w-3" />
                    Сделано другим сотрудником — уйдёт, когда он войдёт на этом телефоне
                  </>
                ) : (
                  <>
                    <AlertTriangle className="h-3 w-3" />
                    {/* Причина сохранена строкой — заворачиваем обратно в Error,
                        чтобы человеку не прилетел SQL или JSON от проверки полей. */}
                    {item.lastError ? humanizeError(new Error(item.lastError)) : 'Сервер не принял'}
                  </>
                )}
              </div>
              {!foreign && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => {
                      void retryOutboxItem(item.id).then(onRetryAll);
                    }}
                    className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Повторить
                  </button>
                  <button
                    type="button"
                    onClick={() => void copy(item.id, d.copyText)}
                    className="hover:bg-muted inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs"
                  >
                    {copied === item.id ? (
                      <>
                        <Check className="h-3 w-3" />
                        Скопировано
                      </>
                    ) : (
                      <>
                        <Copy className="h-3 w-3" />
                        Скопировать
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => setDropTarget(item.id)}
                    className="text-muted-foreground hover:text-destructive inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                  >
                    <X className="h-3 w-3" />
                    Убрать
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>

      <ConfirmDialog
        open={dropTarget !== null}
        title="Убрать запись?"
        description="Она не попала на сервер и будет потеряна. Скопируйте текст, если он ещё нужен."
        variant="danger"
        confirmText="Убрать"
        onConfirm={() => {
          if (dropTarget) void remove(dropTarget);
          setDropTarget(null);
        }}
        onCancel={() => setDropTarget(null)}
      />
    </div>
  );
}

/** Запись другого сотрудника: отправить её от текущего человека нельзя. */
function isForeign(item: OutboxItem, currentUserId: string | null): boolean {
  return !!item.userId && !!currentUserId && item.userId !== currentUserId;
}
