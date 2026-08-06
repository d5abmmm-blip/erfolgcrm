/**
 * /settings/telegram — настройка бота для tenant'а. Доступ — только директор.
 */
import { useState } from 'react';
import { Bot, CheckCircle2, ExternalLink, Loader2, AlertTriangle } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { QueryError } from '../components/QueryError';

export function TelegramSettingsPage() {
  const cfg = trpc.telegram.getConfig.useQuery();
  const utils = trpc.useUtils();
  const [token, setToken] = useState('');
  const [submitError, setSubmitError] = useState<string | null>(null);

  const setConfig = trpc.telegram.setConfig.useMutation({
    onSuccess: () => {
      void utils.telegram.getConfig.invalidate();
      setToken('');
      setSubmitError(null);
    },
    onError: (e) => setSubmitError(e.message),
  });
  const disable = trpc.telegram.disable.useMutation({
    onSuccess: () => void utils.telegram.getConfig.invalidate(),
  });

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    setConfig.mutate({ botToken: token.trim() });
  };

  return (
    <div className="mx-auto max-w-2xl p-6">
      <div className="flex items-center gap-3">
        <Bot className="text-primary h-6 w-6" />
        <h1 className="text-2xl font-semibold">Telegram-бот</h1>
      </div>

      <p className="text-muted-foreground mt-2 text-sm">
        Клиенты смогут оформлять заявки через Telegram-бота. Заявка попадает диспетчеру, а диспетчер
        получает push-уведомление.
      </p>

      {cfg.isLoading ? (
        <div className="text-muted-foreground mt-8 flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : cfg.error ? (
        // Экран прячем целиком: иначе он уверял бы, что бот не настроен, и звал
        // заводить нового у @BotFather.
        <QueryError
          error={cfg.error}
          paused={cfg.fetchStatus === 'paused'}
          what="настройки Telegram-бота"
          onRetry={() => void cfg.refetch()}
          className="mt-6"
        />
      ) : (
        <div className="mt-6 space-y-6">
          {cfg.data && cfg.data.hasToken ? (
            <div className="bg-success/10 border-success/30 flex items-start gap-3 rounded-lg border p-4">
              <CheckCircle2 className="text-success mt-0.5 h-5 w-5 shrink-0" />
              <div className="flex-1">
                <div className="font-medium">
                  Бот {cfg.data.enabled ? 'включён' : 'выключен'}
                  {cfg.data.botUsername && (
                    <>
                      :{' '}
                      <a
                        href={`https://t.me/${cfg.data.botUsername.replace(/^@/, '')}`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary inline-flex items-center gap-1 hover:underline"
                      >
                        @{cfg.data.botUsername}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </>
                  )}
                </div>
                <div className="text-muted-foreground mt-0.5 text-sm">
                  Токен сохранён в зашифрованном виде. Для смены — введите новый ниже.
                </div>
                {cfg.data.enabled && (
                  <button
                    type="button"
                    onClick={() => disable.mutate()}
                    disabled={disable.isPending}
                    className="text-destructive mt-2 text-sm underline-offset-2 hover:underline"
                  >
                    {disable.isPending ? 'Выключаю…' : 'Выключить бота'}
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="bg-warning/10 border-warning/30 flex items-start gap-3 rounded-lg border p-4">
              <AlertTriangle className="text-warning mt-0.5 h-5 w-5 shrink-0" />
              <div>
                <div className="font-medium">Бот не настроен</div>
                <div className="text-muted-foreground text-sm">
                  Создайте бота через{' '}
                  <a
                    href="https://t.me/BotFather"
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary inline-flex items-center gap-1 hover:underline"
                  >
                    @BotFather
                    <ExternalLink className="h-3 w-3" />
                  </a>{' '}
                  и вставьте полученный токен ниже.
                </div>
              </div>
            </div>
          )}

          <form onSubmit={onSubmit} className="space-y-3">
            <label className="block">
              <span className="mb-1 block text-sm font-medium">Токен бота от @BotFather</span>
              <input
                type="text"
                inputMode="text"
                placeholder="123456:ABCdef-..."
                value={token}
                onChange={(e) => setToken(e.target.value)}
                className="bg-background w-full rounded-md border px-3 py-2 font-mono text-sm focus:outline-none focus-visible:ring-2"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="text-muted-foreground mt-1 block text-xs">
                Формат: <code>число:строка</code>. Пример: <code>123456789:ABCdef-GhI...</code>
              </span>
            </label>
            {submitError && <div className="text-destructive text-sm">{submitError}</div>}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={!token.trim() || setConfig.isPending}
                className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
              >
                {setConfig.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Bot className="h-4 w-4" />
                )}
                {cfg.data?.hasToken ? 'Обновить токен' : 'Сохранить и подключить'}
              </button>
            </div>
          </form>

          <details className="text-sm">
            <summary className="text-muted-foreground hover:text-foreground cursor-pointer">
              Как создать бота в @BotFather (3 минуты)
            </summary>
            <ol className="text-muted-foreground mt-3 list-decimal space-y-1.5 pl-5">
              <li>
                Откройте <code>@BotFather</code> в Telegram, отправьте <code>/newbot</code>.
              </li>
              <li>Введите имя бота (например: «Эрфольг СЦ — заявки»).</li>
              <li>
                Введите username бота (например: <code>erfolg_service_bot</code>).
              </li>
              <li>
                BotFather пришлёт токен вида <code>123456789:ABC...</code>.
              </li>
              <li>Скопируйте токен в поле выше и нажмите «Сохранить».</li>
            </ol>
          </details>
        </div>
      )}
    </div>
  );
}
