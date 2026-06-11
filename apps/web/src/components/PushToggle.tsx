/**
 * Кнопка-переключатель Web Push уведомлений (для /m/queue инженера).
 *
 * Состояния: unsupported / denied / idle (off) / subscribed (on).
 */
import { useEffect, useState } from 'react';
import { Bell, BellOff, Loader2 } from 'lucide-react';
import { disablePush, enablePush, getPushStatus, type PushStatus } from '../lib/push';

const HIDE_KEY = 'erfolg-push-hidden';

export function PushToggle() {
  const [status, setStatus] = useState<PushStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [hidden, setHidden] = useState<boolean>(() =>
    typeof window !== 'undefined' ? localStorage.getItem(HIDE_KEY) === '1' : false,
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getPushStatus().then(setStatus);
  }, []);

  if (!status) return null;
  if (status.state === 'unsupported') return null;
  if (status.state === 'idle' && hidden) return null;

  const onEnable = async () => {
    setBusy(true);
    setError(null);
    const r = await enablePush();
    setBusy(false);
    if (!r.ok) {
      setError(reasonText(r.reason));
      return;
    }
    setStatus({ state: 'subscribed' });
  };

  const onDisable = async () => {
    setBusy(true);
    setError(null);
    await disablePush();
    setBusy(false);
    setStatus({ state: 'idle' });
  };

  const onHide = () => {
    localStorage.setItem(HIDE_KEY, '1');
    setHidden(true);
  };

  if (status.state === 'denied') {
    return (
      <div className="bg-warning/10 text-warning-foreground/90 mx-3 mt-3 flex items-start gap-2 rounded-lg px-3 py-2 text-sm">
        <BellOff className="mt-0.5 h-4 w-4 shrink-0" />
        <div className="flex-1">
          <div className="font-medium">Уведомления заблокированы</div>
          <div className="text-muted-foreground text-xs">
            Разрешите уведомления в настройках браузера, чтобы получать сообщения о новых заявках.
          </div>
        </div>
      </div>
    );
  }

  if (status.state === 'subscribed') {
    return (
      <div className="bg-success/10 text-success-foreground/90 mx-3 mt-3 flex items-center justify-between gap-2 rounded-lg px-3 py-2 text-sm">
        <div className="inline-flex items-center gap-2">
          <Bell className="h-4 w-4" />
          <span>Push включён</span>
        </div>
        <button
          type="button"
          onClick={onDisable}
          disabled={busy}
          className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline"
        >
          {busy ? 'выключаю…' : 'выключить'}
        </button>
      </div>
    );
  }

  return (
    <div className="bg-primary/10 text-primary mx-3 mt-3 rounded-lg px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="inline-flex items-center gap-2">
          <Bell className="h-4 w-4" />
          <span>Получать push о новых заявках?</span>
        </div>
        <button
          type="button"
          onClick={onHide}
          className="text-muted-foreground hover:text-foreground text-xs"
          aria-label="Скрыть"
        >
          ×
        </button>
      </div>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={onEnable}
          disabled={busy}
          className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />}
          Включить
        </button>
        <button
          type="button"
          onClick={onHide}
          className="text-muted-foreground hover:text-foreground rounded-md px-3 py-1.5 text-sm"
        >
          Не сейчас
        </button>
      </div>
      {error && <div className="text-destructive mt-1.5 text-xs">{error}</div>}
    </div>
  );
}

function reasonText(reason: string): string {
  if (reason === 'denied') return 'Разрешение отклонено';
  if (reason === 'no-vapid') return 'Сервер не настроен (VAPID ключи)';
  if (reason === 'no-keys') return 'Не удалось получить ключи подписки';
  if (reason === 'unsupported') return 'Браузер не поддерживает push';
  return reason;
}
