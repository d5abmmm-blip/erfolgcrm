/**
 * /settings/backup — резервные копии и архив по годам. Только директор.
 *
 * Шаг 1: полная копия всей базы (скачать файл-дамп). Восстановление и архив по годам
 * добавляются следующими шагами.
 */
import { Link } from 'wouter';
import { ChevronLeft, Database, Download, Loader2, ShieldAlert } from 'lucide-react';
import { trpc } from '../lib/trpc';

export function BackupSettingsPage() {
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
  const isDirector = me.data?.user.role === 'director';

  const requestDump = trpc.backup.requestFullDump.useMutation({
    onSuccess: ({ url }) => {
      // Сервер отдаёт файл с Content-Disposition: attachment — браузер скачает его,
      // не уводя пользователя со страницы.
      window.location.href = url;
    },
  });

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link
        href="/settings"
        className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        Настройки
      </Link>

      <h1 className="text-2xl font-semibold">Резервные копии и архив</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Полная копия всей базы для страховки и переноса, а также выгрузка данных по годам.
      </p>

      {!isDirector && (
        <div className="border-warning/40 bg-warning/10 text-warning-foreground mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Резервными копиями управляет только директор.</span>
        </div>
      )}

      {/* ───────── Полная копия ───────── */}
      <section className="mt-6">
        <div className="bg-card rounded-lg border p-5">
          <div className="flex items-start gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 shrink-0 place-items-center rounded-md">
              <Database className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-medium">Полная копия всей базы</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Один файл со всеми данными системы. Храните его в надёжном месте — это страховка
                на случай поломки компьютера и способ перенести систему на новый сервер. Файл
                формируется при нажатии кнопки; для большой базы это может занять минуту.
              </p>
            </div>
          </div>

          <div className="mt-4 flex items-center gap-3">
            <button
              type="button"
              disabled={!isDirector || requestDump.isPending}
              onClick={() => requestDump.mutate()}
              className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {requestDump.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Download className="h-4 w-4" />
              )}
              {requestDump.isPending ? 'Готовлю копию…' : 'Скачать полную копию'}
            </button>
          </div>

          {requestDump.error && (
            <div className="text-destructive mt-3 text-sm">{requestDump.error.message}</div>
          )}
          {requestDump.isSuccess && !requestDump.error && (
            <div className="text-muted-foreground mt-3 text-sm">
              Скачивание началось. Если файл не появился — проверьте загрузки браузера.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
