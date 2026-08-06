/**
 * /settings/notifications — уведомления клиентам по e-mail. Доступ — только директор.
 *
 * Фича B: тумблер «Уведомлять клиента, когда техника готова». ПО УМОЛЧАНИЮ ВКЛЮЧЕНО
 * (как сейчас в проде); директор может отключить. Письмо уходит при переходе
 * заявки в статус «Ожидает акта» (техника готова к выдаче) и только если у клиента есть
 * e-mail. Повторно по одной заявке не дублируется.
 */
import { CheckCircle2, Loader2, Mail } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

export function NotificationsSettingsPage() {
  const q = trpc.settings.getNotifyClientWhenReady.useQuery();
  const utils = trpc.useUtils();

  const setEnabled = trpc.settings.setNotifyClientWhenReady.useMutation({
    onSuccess: async () => {
      await utils.settings.getNotifyClientWhenReady.invalidate();
    },
  });

  // По умолчанию ВКЛЮЧЕНО (DB DEFAULT true) — пока грузится, не маскируем реальное ВКЛ.
  const enabled = q.data ?? true;
  const toggle = () => setEnabled.mutate({ enabled: !enabled });

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Mail className="text-primary h-6 w-6" />
        <h1 className="text-2xl font-semibold">Уведомления клиентам</h1>
      </div>

      <p className="text-muted-foreground text-sm">
        Письма клиентам о ходе заявки. Чтобы рассылка работала, у клиента должен быть указан e-mail
        и должна быть настроена отправка почты.
      </p>

      {q.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        <div className="bg-card flex items-start justify-between gap-4 rounded-lg border p-4">
          <div>
            <div className="font-medium">Уведомлять клиента по эл. почте, когда техника готова</div>
            <div className="text-muted-foreground mt-1 text-xs">
              Письмо «техника готова к выдаче» уйдёт при переводе заявки в статус «Ожидает акта».
              Без e-mail у клиента письмо не отправляется. По одной заявке письмо отправляется один
              раз.
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label="Уведомлять клиента, когда техника готова"
            disabled={setEnabled.isPending}
            onClick={toggle}
            className={cn(
              'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50',
              enabled ? 'bg-primary' : 'bg-muted',
            )}
          >
            <span
              className={cn(
                'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transition-transform',
                enabled ? 'translate-x-5' : 'translate-x-0',
              )}
            />
          </button>
        </div>
      )}

      {setEnabled.isSuccess && (
        <span className="text-success inline-flex items-center gap-1 text-sm">
          <CheckCircle2 className="h-4 w-4" />
          Сохранено
        </span>
      )}
      {setEnabled.error && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border px-4 py-2 text-sm">
          {setEnabled.error.message}
        </div>
      )}
    </div>
  );
}
