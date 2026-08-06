/**
 * /settings/backup — резервные копии и архив по годам. Только директор.
 *
 * Шаг 1: полная копия всей базы (скачать файл-дамп). Восстановление и архив по годам
 * добавляются следующими шагами.
 */
import { useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  ChevronLeft,
  Database,
  Download,
  FlaskConical,
  Loader2,
  ShieldAlert,
  Upload,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

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

  // ───────── Загрузка (импорт старой базы) ─────────
  const requestImportToken = trpc.backup.requestImportToken.useMutation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [running, setRunning] = useState<null | 'dry' | 'real'>(null);
  const [report, setReport] = useState<string | null>(null);
  const [importErr, setImportErr] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  async function runImport(dryRun: boolean) {
    if (!file) return;
    setRunning(dryRun ? 'dry' : 'real');
    setReport(null);
    setImportErr(null);
    try {
      const tok = await requestImportToken.mutateAsync();
      const params = new URLSearchParams({ t: tok.t, exp: String(tok.exp), sig: tok.sig });
      if (dryRun) params.set('dryRun', '1');
      const resp = await fetch(`${tok.uploadUrl}?${params.toString()}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: file,
        credentials: 'include',
      });
      const data = (await resp.json()) as { ok?: boolean; report?: string; error?: string };
      if (data.report) setReport(data.report);
      if (!resp.ok || data.ok === false) setImportErr(data.error ?? 'Ошибка импорта.');
    } catch (e) {
      setImportErr(e instanceof Error ? e.message : 'Не удалось выполнить импорт.');
    } finally {
      setRunning(null);
    }
  }

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
                Один файл со всеми данными системы. Храните его в надёжном месте — это страховка на
                случай поломки компьютера и способ перенести систему на новый сервер. Файл
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

      {/* ───────── Загрузка из старой базы ───────── */}
      <section className="mt-6">
        <div className="bg-card rounded-lg border p-5">
          <div className="flex items-start gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 shrink-0 place-items-center rounded-md">
              <Upload className="h-5 w-5" />
            </div>
            <div className="min-w-0">
              <h2 className="font-medium">Загрузка из старой базы</h2>
              <p className="text-muted-foreground mt-1 text-sm">
                Перенос данных из прежней программы (файл-экспорт). Загрузка{' '}
                <span className="text-foreground font-medium">безопасна и повторяема</span>: одни и
                те же записи не задвоятся, а сначала можно сделать «сухой прогон» — он ничего не
                пишет, только показывает, что будет загружено.
              </p>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            <input
              ref={fileRef}
              type="file"
              accept=".json,application/json"
              disabled={!isDirector || running !== null}
              onChange={(e) => {
                setFile(e.target.files?.[0] ?? null);
                setReport(null);
                setImportErr(null);
              }}
              className="text-muted-foreground file:bg-secondary file:hover:bg-muted block w-full text-sm file:mr-3 file:cursor-pointer file:rounded-md file:border-0 file:px-3 file:py-1.5 file:text-sm file:font-medium"
            />

            {file && (
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={!isDirector || running !== null}
                  onClick={() => void runImport(true)}
                  className="bg-secondary hover:bg-muted inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {running === 'dry' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <FlaskConical className="h-4 w-4" />
                  )}
                  Проверить (сухой прогон)
                </button>
                <button
                  type="button"
                  disabled={!isDirector || running !== null}
                  onClick={() => setConfirmOpen(true)}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-2 text-sm font-medium disabled:opacity-50"
                >
                  {running === 'real' ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Upload className="h-4 w-4" />
                  )}
                  Импортировать
                </button>
                <span className="text-muted-foreground text-xs">{file.name}</span>
              </div>
            )}

            {importErr && (
              <div className="text-destructive bg-destructive/10 border-destructive/30 rounded-md border p-2.5 text-sm">
                {importErr}
              </div>
            )}
            {report && (
              <pre className="bg-muted/40 text-muted-foreground max-h-80 overflow-auto whitespace-pre-wrap rounded-md border p-3 text-xs">
                {report}
              </pre>
            )}
          </div>
        </div>
      </section>

      <ConfirmDialog
        open={confirmOpen}
        title="Импортировать данные в базу?"
        description="Данные из файла будут загружены в рабочую базу. Повторная загрузка того же файла безопасна (дубликаты не создаются). Рекомендуется сначала сделать «сухой прогон»."
        confirmText="Импортировать"
        loading={running === 'real'}
        onConfirm={() => {
          setConfirmOpen(false);
          void runImport(false);
        }}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
