/**
 * /settings/onec — настройка интеграции с 1С для tenant'а. Доступ — только директор.
 */
import { useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCopy,
  Database,
  Loader2,
  RefreshCw,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { getTenantSubdomain } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ConfirmDialog } from '../components/ui';
import { QueryError } from '../components/QueryError';

const EXCHANGE_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  pending: { label: 'В процессе', cls: 'bg-warning/15 text-warning' },
  success: { label: 'Успешно', cls: 'bg-success/10 text-success' },
  failed: { label: 'Ошибка', cls: 'bg-destructive/10 text-destructive' },
  partial: { label: 'Частично', cls: 'bg-warning/15 text-warning' },
};

function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return '—';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleString('ru-RU');
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };
  return (
    <button
      type="button"
      onClick={copy}
      title="Копировать"
      className="hover:bg-muted ml-1 inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs"
    >
      <ClipboardCopy className="h-3 w-3" />
      {copied ? 'Скопировано' : 'Копировать'}
    </button>
  );
}

export function OnecSettingsPage() {
  const cfg = trpc.onec.getConfig.useQuery();
  const exchanges = trpc.onec.listExchanges.useQuery({ limit: 20 });
  const utils = trpc.useUtils();

  const [shownToken, setShownToken] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [exportResult, setExportResult] = useState<{
    exchangeId: string;
    xml: string;
    processedCount: number;
    errorCount: number;
    totalPending: number;
    remaining: number;
  } | null>(null);

  const invalidateAll = async () => {
    await utils.onec.getConfig.invalidate();
    await utils.onec.listExchanges.invalidate();
  };

  const setConfig = trpc.onec.setConfig.useMutation({
    onSuccess: () => void invalidateAll(),
    onError: (e) => setActionError(e.message),
  });

  const generateToken = trpc.onec.generateToken.useMutation({
    onSuccess: (data) => {
      setShownToken(data.token);
      void invalidateAll();
    },
    onError: (e) => setActionError(e.message),
  });

  const revokeToken = trpc.onec.revokeToken.useMutation({
    onSuccess: () => {
      setShownToken(null);
      void invalidateAll();
    },
    onError: (e) => setActionError(e.message),
  });

  const exportInvoices = trpc.onec.exportInvoices.useMutation({
    onSuccess: (data) => {
      setExportResult(data);
      void invalidateAll();
      // Автоматически скачиваем XML.
      const blob = new Blob([data.xml], { type: 'application/xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `invoices-export-${data.exchangeId}.xml`;
      a.click();
      URL.revokeObjectURL(url);
    },
    onError: (e) => setActionError(e.message),
  });

  const subdomain = getTenantSubdomain() ?? '<subdomain>';
  const paymentsUrl = `https://${subdomain}.erfolgcrm.ru/api/v1/onec/payments/${subdomain}`;

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Database className="text-primary h-6 w-6" />
        <h1 className="text-2xl font-semibold">1С — обмен данными</h1>
      </div>

      <p className="text-muted-foreground text-sm">
        Выгрузка счетов в формате CommerceML/XML для загрузки в 1С:Бухгалтерия. Входящий URL
        позволяет 1С отправлять информацию об оплатах.
      </p>

      {actionError && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border px-4 py-2 text-sm">
          {actionError}
          <button
            type="button"
            onClick={() => setActionError(null)}
            className="ml-2 underline-offset-2 hover:underline"
          >
            Закрыть
          </button>
        </div>
      )}

      {cfg.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : cfg.error ? (
        // Настройки прячем целиком: иначе тумблер выглядел бы выключенным, а токен —
        // не выданным, хотя на сервере они есть.
        <QueryError
          error={cfg.error}
          paused={cfg.fetchStatus === 'paused'}
          what="настройки обмена с 1С"
          onRetry={() => void cfg.refetch()}
        />
      ) : (
        <div className="space-y-4">
          {/* Enable toggle */}
          <div className="bg-card rounded-lg border p-4">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">Включить обмен с 1С</div>
                <div className="text-muted-foreground text-xs">
                  Разрешает выгрузку счетов и приём платежей от 1С
                </div>
              </div>
              <button
                type="button"
                disabled={setConfig.isPending}
                onClick={() => {
                  setActionError(null);
                  setConfig.mutate({ enabled: !(cfg.data?.enabled ?? false) });
                }}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors focus:outline-none disabled:opacity-50',
                  cfg.data?.enabled ? 'bg-primary' : 'bg-muted',
                )}
                role="switch"
                aria-checked={cfg.data?.enabled ?? false}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transition-transform',
                    cfg.data?.enabled ? 'translate-x-5' : 'translate-x-0',
                  )}
                />
              </button>
            </div>
            <div className="mt-3">
              <div className="text-muted-foreground mb-1 text-xs">Часовой пояс экспорта</div>
              <select
                defaultValue={cfg.data?.exportTimezone ?? 'Europe/Moscow'}
                onChange={(e) => {
                  setActionError(null);
                  setConfig.mutate({ exportTimezone: e.target.value });
                }}
                className="bg-background focus:ring-primary/40 rounded-md border px-3 py-1.5 text-sm outline-none focus:ring-2"
              >
                {[
                  'Europe/Moscow',
                  'Europe/Kaliningrad',
                  'Asia/Yekaterinburg',
                  'Asia/Omsk',
                  'Asia/Krasnoyarsk',
                  'Asia/Irkutsk',
                  'Asia/Yakutsk',
                  'Asia/Vladivostok',
                  'Asia/Magadan',
                  'Asia/Kamchatka',
                ].map((tz) => (
                  <option key={tz} value={tz}>
                    {tz}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Token */}
          <div className="bg-card space-y-3 rounded-lg border p-4">
            <div className="font-medium">Входящий токен (для 1С)</div>
            {cfg.data?.hasIncomingToken ? (
              <div className="bg-success/10 border-success/30 flex items-start gap-3 rounded-lg border p-3">
                <CheckCircle2 className="text-success mt-0.5 h-4 w-4 shrink-0" />
                <div className="text-sm">Токен установлен. Для смены — сгенерируйте новый.</div>
              </div>
            ) : (
              <div className="bg-warning/10 border-warning/30 flex items-start gap-3 rounded-lg border p-3">
                <AlertTriangle className="text-warning mt-0.5 h-4 w-4 shrink-0" />
                <div className="text-sm">Токен не установлен.</div>
              </div>
            )}

            {shownToken && (
              <div className="bg-muted rounded-md border p-3">
                <div className="text-destructive mb-1 text-xs font-medium">
                  Сохраните токен. Он больше не будет показан.
                </div>
                <div className="flex items-center gap-2">
                  <code className="bg-background flex-1 overflow-x-auto rounded border px-2 py-1 font-mono text-xs">
                    {shownToken}
                  </code>
                  <CopyButton text={shownToken} />
                </div>
              </div>
            )}

            <div className="flex gap-2">
              <button
                type="button"
                disabled={generateToken.isPending}
                onClick={() => {
                  setActionError(null);
                  if (cfg.data?.hasIncomingToken) {
                    setConfirmRegenerate(true);
                    return;
                  }
                  generateToken.mutate();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                {generateToken.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                Сгенерировать токен
              </button>
              {cfg.data?.hasIncomingToken && (
                <button
                  type="button"
                  disabled={revokeToken.isPending}
                  onClick={() => {
                    setActionError(null);
                    setConfirmRevoke(true);
                  }}
                  className="hover:bg-destructive/10 hover:text-destructive inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-xs font-medium disabled:opacity-50"
                >
                  {revokeToken.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                  Отозвать токен
                </button>
              )}
            </div>

            <ConfirmDialog
              open={confirmRegenerate}
              title="Перевыпустить токен?"
              description="Текущий токен будет аннулирован — 1С перестанет авторизоваться, пока в неё не вставят новый."
              variant="danger"
              confirmText="Перевыпустить"
              loading={generateToken.isPending}
              onConfirm={() => {
                setConfirmRegenerate(false);
                generateToken.mutate();
              }}
              onCancel={() => setConfirmRegenerate(false)}
            />
            <ConfirmDialog
              open={confirmRevoke}
              title="Отозвать токен?"
              description="1С перестанет авторизоваться до выпуска нового токена."
              variant="danger"
              confirmText="Отозвать"
              loading={revokeToken.isPending}
              onConfirm={() => {
                setConfirmRevoke(false);
                revokeToken.mutate();
              }}
              onCancel={() => setConfirmRevoke(false)}
            />
          </div>

          {/* URL for 1C */}
          <div className="bg-card space-y-2 rounded-lg border p-4">
            <div className="font-medium">URL для настройки в 1С</div>
            <div className="text-muted-foreground text-xs">
              Скопируйте адрес и укажите его в настройках обмена 1С
            </div>
            <div className="flex items-center gap-2">
              <code className="bg-muted flex-1 overflow-x-auto rounded border px-2 py-1.5 font-mono text-xs">
                {paymentsUrl}
              </code>
              <CopyButton text={paymentsUrl} />
            </div>
          </div>

          {/* Export — только при включённом обмене.

              Выгрузка необратима: она помечает счета «отдано в 1С», и снять
              отметку нечем. Пока обмен выключен, кнопки быть не должно, иначе
              один клик из любопытства вычёркивает из очереди до 500 боевых
              счетов. Сервер проверяет то же самое (exportInvoicesToOnecCmd). */}
          {cfg.data?.enabled !== true ? (
            <div className="bg-muted/40 text-muted-foreground rounded-lg border p-4 text-xs">
              Экспорт счетов недоступен: обмен с 1С выключен. Включите переключатель выше, если
              ведёте учёт в 1С.
            </div>
          ) : (
            <div className="bg-card space-y-3 rounded-lg border p-4">
              <div className="font-medium">Экспорт счетов</div>
              <div className="text-muted-foreground text-xs">
                Выгружает несинхронизированные счета в XML и скачивает файл. За один раз — не больше
                500 счетов.
              </div>
              {exportResult && (
                <div className="bg-success/10 border-success/30 rounded-lg border p-3 text-sm">
                  Экспортировано: {exportResult.processedCount} из {exportResult.totalPending}{' '}
                  ожидавших
                  {exportResult.errorCount > 0 && (
                    <span className="text-destructive ml-2">
                      (ошибок: {exportResult.errorCount})
                    </span>
                  )}
                  {exportResult.remaining > 0 && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      Осталось {exportResult.remaining} — запустите экспорт ещё раз.
                    </div>
                  )}
                </div>
              )}
              <button
                type="button"
                disabled={exportInvoices.isPending}
                onClick={() => {
                  setActionError(null);
                  setExportResult(null);
                  exportInvoices.mutate();
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                {exportInvoices.isPending ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                {exportInvoices.isPending ? 'Экспорт…' : 'Запустить экспорт сейчас'}
              </button>
            </div>
          )}
        </div>
      )}

      {/* Exchange log */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide">Журнал обменов</h2>
        {exchanges.isLoading ? (
          <div className="text-muted-foreground text-sm">Загрузка…</div>
        ) : !exchanges.data || exchanges.data.length === 0 ? (
          <div className="text-muted-foreground text-sm">Обменов пока не было</div>
        ) : (
          <div className="bg-card overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Дата</th>
                  <th className="px-3 py-2 text-left font-medium">Тип</th>
                  <th className="px-3 py-2 text-left font-medium">Статус</th>
                  <th className="px-3 py-2 text-right font-medium">Обработано</th>
                  <th className="px-3 py-2 text-right font-medium">Ошибок</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {exchanges.data.map((ex) => {
                  const b = EXCHANGE_STATUS_BADGE[ex.status] ?? {
                    label: ex.status,
                    cls: 'bg-muted text-muted-foreground',
                  };
                  return (
                    <tr key={ex.id} className="hover:bg-muted/20 transition">
                      <td className="px-3 py-2 text-xs">{formatDateTime(ex.startedAt)}</td>
                      <td className="px-3 py-2 text-xs capitalize">{ex.direction}</td>
                      <td className="px-3 py-2">
                        <span
                          className={cn(
                            'inline-flex items-center rounded-md px-2 py-0.5 text-xs',
                            b.cls,
                          )}
                        >
                          {b.label}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right text-xs">{ex.processedCount ?? 0}</td>
                      <td className="px-3 py-2 text-right text-xs">
                        {ex.errorCount && ex.errorCount > 0 ? (
                          <span className="text-destructive">{ex.errorCount}</span>
                        ) : (
                          '0'
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
