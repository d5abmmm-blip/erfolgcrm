/**
 * Привязка Telegram-чата сотрудника к tenant-боту (нуджи с кнопками).
 *
 * userId не задан → «моя» привязка (профиль инженера в PWA);
 * userId задан → привязка конкретного сотрудника (карточка в «Сотрудниках», staff).
 */
import { useState } from 'react';
import { Check, Copy, Link2, Loader2, Send, Unlink } from 'lucide-react';
import { trpc } from '../lib/trpc';

interface Props {
  userId?: string;
}

export function TelegramLinkSection({ userId }: Props) {
  const utils = trpc.useUtils();
  const input = userId ? { userId } : undefined;
  const status = trpc.telegram.linkStatus.useQuery(input);
  const createCode = trpc.telegram.createLinkCode.useMutation();
  const unlink = trpc.telegram.unlink.useMutation({
    onSuccess: () => utils.telegram.linkStatus.invalidate(),
  });
  const [copied, setCopied] = useState(false);

  if (status.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" /> Telegram…
      </div>
    );
  }
  if (!status.data) return null;

  if (!status.data.botEnabled) {
    return (
      <p className="text-muted-foreground text-xs">
        Telegram-бот не подключён — напоминания в Telegram работать не будут. Директор может
        подключить бота в «Настройки → Telegram-бот».
      </p>
    );
  }

  if (status.data.linked) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-success inline-flex items-center gap-1.5 text-sm font-medium">
          <Check className="h-4 w-4" /> Telegram привязан — напоминания приходят в чат
        </span>
        <button
          type="button"
          onClick={() => unlink.mutate(input)}
          disabled={unlink.isPending}
          className="text-destructive hover:bg-destructive/10 inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-medium transition disabled:opacity-50"
        >
          <Unlink className="h-3.5 w-3.5" /> Отвязать
        </button>
      </div>
    );
  }

  const link = createCode.data?.deepLink;
  return (
    <div className="space-y-2">
      {!link && (
        <button
          type="button"
          onClick={() => createCode.mutate(input)}
          disabled={createCode.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition disabled:opacity-50"
        >
          {createCode.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
          Привязать Telegram
        </button>
      )}
      {createCode.error && (
        <p className="text-destructive text-xs">{createCode.error.message}</p>
      )}
      {link && (
        <div className="space-y-2">
          <p className="text-muted-foreground text-xs">
            {userId
              ? 'Отправьте сотруднику эту ссылку — пусть откроет её и нажмёт «Start» в Telegram:'
              : 'Откройте ссылку и нажмите «Start» в Telegram:'}
          </p>
          <div className="flex items-center gap-2">
            <a
              href={link}
              target="_blank"
              rel="noreferrer"
              className="bg-primary/10 text-primary inline-flex h-9 min-w-0 flex-1 items-center gap-1.5 truncate rounded-md px-3 text-sm font-medium"
            >
              <Link2 className="h-4 w-4 shrink-0" />
              <span className="truncate">{link}</span>
            </a>
            <button
              type="button"
              onClick={() => {
                void navigator.clipboard.writeText(link).then(() => {
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                });
              }}
              className="text-muted-foreground hover:text-foreground hover:bg-muted grid h-9 w-9 shrink-0 place-items-center rounded-md transition"
              aria-label="Скопировать ссылку"
            >
              {copied ? <Check className="text-success h-4 w-4" /> : <Copy className="h-4 w-4" />}
            </button>
          </div>
          <p className="text-muted-foreground text-xs">
            Ссылка действует {createCode.data?.ttlMinutes ?? 15} минут. После «Start» бот
            подтвердит привязку, статус здесь обновится при следующем открытии.
          </p>
          <button
            type="button"
            onClick={() => void utils.telegram.linkStatus.invalidate()}
            className="text-primary text-xs font-medium underline-offset-2 hover:underline"
          >
            Проверить привязку
          </button>
        </div>
      )}
    </div>
  );
}
