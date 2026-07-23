/**
 * /finance/receivables — «Дебиторка»: кто и сколько должен компании.
 *
 * Поверх готового движка счетов (статусы/due_date/авто-письма воркера). Показывает:
 *   • сколько всего должны + сколько из этого просрочено (герой),
 *   • разбивку долга по срокам (aging: срок не наступил / 1–30 / 31–60 / 60+ дней),
 *   • таблицу должников с кнопкой «Напомнить» (шлёт письмо по просроченным счетам сразу).
 *
 * RBAC: staff (директор + диспетчер) — как весь раздел «Финансы».
 * Кнопка «Напомнить» — только у клиентов с просроченными счетами (выбор владельца).
 */
import { useEffect, useState } from 'react';
import {
  Wallet,
  AlertTriangle,
  Mail,
  MailX,
  Check,
  Clock,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { formatRub, formatRubWhole } from '../lib/money';
import { FinanceTabs } from '../components/finance/FinanceTabs';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';

/** BigInt без падения: пустое/кривое значение → 0n, а не краш страницы. */
function safeBig(v: string | number | null | undefined): bigint {
  try {
    return BigInt(v ?? 0);
  } catch {
    return 0n;
  }
}

/** Склонение: 1 день / 2 дня / 5 дней. */
function pluralDays(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'дней';
  if (last > 1 && last < 5) return 'дня';
  if (last === 1) return 'день';
  return 'дней';
}

/** Склонение: 1 раз / 2 раза / 5 раз. */
function pluralTimes(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'раз';
  if (last > 1 && last < 5) return 'раза';
  return 'раз';
}

function daysAgoLabel(iso: string | null): string | null {
  if (!iso) return null;
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) return null;
  const days = Math.floor((Date.now() - then.getTime()) / 86_400_000);
  if (days <= 0) return 'сегодня';
  if (days === 1) return 'вчера';
  return `${days} ${pluralDays(days)} назад`;
}

interface Toast {
  tone: 'success' | 'error';
  msg: string;
}

export function ReceivablesPage() {
  const q = trpc.invoices.receivables.useQuery({});
  const utils = trpc.useUtils();
  const [toast, setToast] = useState<Toast | null>(null);
  const [sendingClientId, setSendingClientId] = useState<string | null>(null);
  // F1: подтверждение перед реальной отправкой письма клиенту (защита от случайного клика).
  const [confirmTarget, setConfirmTarget] = useState<{
    clientId: string;
    clientName: string | null;
    count: number;
  } | null>(null);

  const remind = trpc.invoices.sendReminder.useMutation();

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  const data = q.data;

  async function onRemind(clientId: string, clientName: string | null) {
    setSendingClientId(clientId);
    try {
      const res = await remind.mutateAsync({ clientId });
      const problems =
        res.skippedNoEmail +
        res.skippedBadEmail +
        res.skippedArchived +
        res.notConfigured +
        res.failed;
      if (res.sent > 0 && problems === 0) {
        const cd = res.skippedCooldown > 0 ? `, ${res.skippedCooldown} пропущено (недавно)` : '';
        setToast({
          tone: 'success',
          msg: `Отправлено ${res.sent} ${pluralTimes(res.sent)} — ${clientName ?? 'клиенту'}${cd}`,
        });
      } else if (res.sent > 0) {
        // Часть писем не ушла — не выдаём это за полный успех.
        setToast({ tone: 'error', msg: `Отправлено ${res.sent} из ${res.total} — часть не ушла` });
      } else if (res.skippedCooldown === res.total) {
        // Все счета в cooldown — это нормальный исход, не ошибка (защита от дублей).
        setToast({ tone: 'success', msg: 'Недавно уже напоминали — повтор не отправляли' });
      } else if (res.skippedArchived > 0) {
        // Кнопка по архивным и так погашена — сюда попадаем, только если клиента
        // заархивировали в другой вкладке уже после отрисовки списка. Это не сбой
        // отправки, поэтому текст объясняет причину, а не пугает «попробуйте позже».
        setToast({ tone: 'error', msg: 'Клиент в архиве — письма ему не отправляются' });
      } else if (res.skippedBadEmail > 0) {
        // Отдельно от «не указан email»: адрес вроде бы есть, но это имя или телефон
        // (свободный текст из старой системы). Повторный клик не поможет — текст
        // должен вести человека в карточку клиента, а не в «попробуйте позже».
        setToast({
          tone: 'error',
          msg: 'В карточке клиента вместо почты — не адрес. Исправьте почту в карточке',
        });
      } else if (res.skippedNoEmail > 0) {
        setToast({ tone: 'error', msg: 'У клиента не указан email' });
      } else if (res.notConfigured > 0) {
        setToast({ tone: 'error', msg: 'Почта не настроена' });
      } else {
        setToast({ tone: 'error', msg: 'Не удалось отправить — попробуйте позже' });
      }
      await Promise.all([utils.invoices.receivables.invalidate(), utils.dashboard.navBadges.invalidate()]);
    } catch (err) {
      setToast({
        tone: 'error',
        msg: err instanceof Error ? err.message : 'Не удалось отправить напоминание',
      });
    } finally {
      setSendingClientId(null);
    }
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-5 p-4 md:p-6">
      <FinanceTabs />

      <div>
        <div className="text-muted-foreground flex items-center gap-2 text-xs font-medium uppercase tracking-wide">
          <Wallet className="h-3.5 w-3.5" />
          Финансы
        </div>
        <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">Дебиторка — кто должен компании</h1>
        <p className="text-muted-foreground text-sm">
          Неоплаченные счета клиентов. Авто-письмо о просрочке уходит само раз в неделю — кнопка
          «Напомнить» отправляет сразу.
        </p>
      </div>

      {q.isLoading && (
        <div className="text-muted-foreground bg-card rounded-lg border p-6 text-sm">Загружаем…</div>
      )}
      {q.error && (
        <div className="text-destructive bg-destructive/10 border-destructive/30 rounded-lg border p-4 text-sm">
          Не удалось загрузить: {q.error.message}
        </div>
      )}

      {data && (
        <>
          {/* Герой: всего должны + из них просрочено */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="bg-card rounded-xl border p-4 shadow-sm sm:p-5">
              <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
                Вам должны всего
              </div>
              <div className="mt-1 text-3xl font-semibold tabular-nums tracking-tight md:text-4xl">
                {formatRubWhole(data.summary.totalOutstandingKopecks)}
              </div>
              <div className="text-muted-foreground mt-1 text-sm">
                {data.summary.invoiceCount} неоплаченных {pluralInvoices(data.summary.invoiceCount)} ·{' '}
                {data.summary.debtorCount} {pluralClients(data.summary.debtorCount)}
              </div>
            </div>
            <div
              className={cn(
                'rounded-xl border p-4 shadow-sm sm:p-5',
                safeBig(data.summary.overdueOutstandingKopecks) > 0n
                  ? 'border-destructive/30 bg-destructive/10'
                  : 'bg-card',
              )}
            >
              <div
                className={cn(
                  'flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide',
                  safeBig(data.summary.overdueOutstandingKopecks) > 0n
                    ? 'text-destructive'
                    : 'text-muted-foreground',
                )}
              >
                <AlertTriangle className="h-4 w-4" />
                Из них просрочено
              </div>
              <div
                className={cn(
                  'mt-1 text-3xl font-semibold tabular-nums tracking-tight md:text-4xl',
                  safeBig(data.summary.overdueOutstandingKopecks) > 0n && 'text-destructive',
                )}
              >
                {formatRubWhole(data.summary.overdueOutstandingKopecks)}
              </div>
              <div
                className={cn(
                  'mt-1 text-sm',
                  safeBig(data.summary.overdueOutstandingKopecks) > 0n
                    ? 'text-destructive'
                    : 'text-muted-foreground',
                )}
              >
                {data.summary.overdueInvoiceCount} просроченных{' '}
                {pluralInvoices(data.summary.overdueInvoiceCount)}
              </div>
            </div>
          </div>

          {/* Разбивка по срокам (aging) */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <AgingCard title="Срок не наступил" bucket={data.aging.notDue} tone="neutral" />
            <AgingCard title="1–30 дней" bucket={data.aging.d1_30} tone="warning" />
            <AgingCard title="31–60 дней" bucket={data.aging.d31_60} tone="warning" />
            <AgingCard title="60+ дней" bucket={data.aging.d60plus} tone="danger" />
          </div>

          {/* Таблица должников */}
          <section className="bg-card overflow-hidden rounded-xl border shadow-sm">
            <div className="border-b p-4 text-sm font-semibold">Кто должен</div>
            {data.debtors.length === 0 ? (
              <div className="text-muted-foreground flex flex-col items-center gap-2 p-10 text-center text-sm">
                <Check className="text-success h-6 w-6" />
                Никто не должен — все выставленные счета оплачены.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground border-b text-[11px] uppercase tracking-wide">
                      <th className="p-3 text-left font-medium">Клиент</th>
                      <th className="p-3 text-right font-medium">Всего должен</th>
                      <th className="p-3 text-right font-medium">Просрочено</th>
                      <th className="p-3 text-right font-medium">Напоминание</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {data.debtors.map((d) => {
                      const overdue = safeBig(d.overdueOwedKopecks) > 0n;
                      const hasEmail = Boolean(d.clientEmail);
                      // Архивным письма не уходят (сервер вернёт skipped_archived) —
                      // гасим кнопку заранее, чтобы клик не выглядел как сбой почты.
                      const canRemind = hasEmail && !d.clientArchived;
                      const sending = sendingClientId === d.clientId;
                      const lastReminder = daysAgoLabel(d.lastReminderSentAt);
                      return (
                        <tr key={d.clientId} className="hover:bg-muted/40">
                          <td className="p-3">
                            <div className="flex items-center gap-2 font-medium">
                              {d.clientName ?? 'Без названия'}
                              {d.clientArchived && (
                                <span className="bg-muted text-muted-foreground rounded-full px-2 py-0.5 text-[10px] font-normal">
                                  В архиве
                                </span>
                              )}
                            </div>
                            <div className="text-muted-foreground text-xs">
                              {d.invoiceCount} {pluralInvoices(d.invoiceCount)}
                              {hasEmail ? ` · ${d.clientEmail}` : ''}
                              {!hasEmail && !d.clientArchived && (
                                <span className="text-destructive ml-1 inline-flex items-center gap-1">
                                  <MailX className="h-3 w-3" /> нет email
                                </span>
                              )}
                            </div>
                          </td>
                          <td className="p-3 text-right font-medium tabular-nums">
                            {formatRub(d.totalOwedKopecks)}
                          </td>
                          <td className="p-3 text-right tabular-nums">
                            {overdue ? (
                              <>
                                <div className="text-destructive font-medium">
                                  {formatRub(d.overdueOwedKopecks)}
                                </div>
                                <span className="bg-destructive/10 text-destructive mt-1 inline-block rounded-full px-2 py-0.5 text-[10px]">
                                  {d.maxDaysOverdue} {pluralDays(d.maxDaysOverdue)}
                                </span>
                              </>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </td>
                          <td className="p-3 text-right">
                            {lastReminder && (
                              <div className="text-muted-foreground mb-1 text-xs">
                                {d.reminderCount > 0
                                  ? `${d.reminderCount} ${pluralTimes(d.reminderCount)} · ${lastReminder}`
                                  : lastReminder}
                              </div>
                            )}
                            {overdue ? (
                              <button
                                type="button"
                                disabled={!canRemind || sending}
                                onClick={() =>
                                  setConfirmTarget({
                                    clientId: d.clientId,
                                    clientName: d.clientName,
                                    count: d.overdueInvoiceCount,
                                  })
                                }
                                title={
                                  d.clientArchived
                                    ? 'Клиент в архиве — письма ему не отправляются. Долг виден, но напомнить о нём можно только вручную'
                                    : hasEmail
                                      ? undefined
                                      : 'У клиента не указан email'
                                }
                                className={cn(
                                  'inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition',
                                  canRemind && !sending
                                    ? 'hover:bg-muted'
                                    : 'cursor-not-allowed opacity-50',
                                )}
                              >
                                {sending ? (
                                  <Clock className="h-3.5 w-3.5 animate-spin" />
                                ) : (
                                  <Mail className="h-3.5 w-3.5" />
                                )}
                                Напомнить
                              </button>
                            ) : (
                              <span className="text-muted-foreground text-xs">срок не наступил</span>
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
        </>
      )}

      {toast && (
        <div
          className={cn(
            'fixed bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-lg px-4 py-2.5 text-sm font-medium shadow-lg',
            toast.tone === 'success'
              ? 'bg-success text-success-foreground'
              : 'bg-destructive text-destructive-foreground',
          )}
          role={toast.tone === 'error' ? 'alert' : 'status'}
          aria-live={toast.tone === 'error' ? 'assertive' : 'polite'}
        >
          {toast.msg}
        </div>
      )}

      <ConfirmDialog
        open={confirmTarget !== null}
        title="Отправить напоминание клиенту?"
        description={
          confirmTarget
            ? `${confirmTarget.clientName ?? 'Клиенту'} уйдёт письмо по ${confirmTarget.count} ${pluralInvoices(
                confirmTarget.count,
              )}. Счета, по которым напоминали в последние ~20 часов, будут пропущены (без дублей).`
            : undefined
        }
        confirmText="Отправить"
        cancelText="Отмена"
        loading={sendingClientId !== null}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          if (!confirmTarget) return;
          const { clientId, clientName } = confirmTarget;
          setConfirmTarget(null);
          void onRemind(clientId, clientName);
        }}
      />
    </div>
  );
}

function pluralInvoices(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'счетов';
  if (last > 1 && last < 5) return 'счёта';
  if (last === 1) return 'счёт';
  return 'счетов';
}

function pluralClients(n: number): string {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return 'клиентов';
  if (last > 1 && last < 5) return 'клиента';
  if (last === 1) return 'клиент';
  return 'клиентов';
}

function AgingCard({
  title,
  bucket,
  tone,
}: {
  title: string;
  bucket: { sumKopecks: string; count: number };
  tone: 'neutral' | 'warning' | 'danger';
}) {
  const empty = safeBig(bucket.sumKopecks) <= 0n;
  return (
    <div
      className={cn(
        'rounded-xl border p-3 shadow-sm md:p-4',
        empty && 'bg-card',
        !empty && tone === 'neutral' && 'bg-card',
        !empty && tone === 'warning' && 'border-warning/30 bg-warning/10',
        !empty && tone === 'danger' && 'border-destructive/30 bg-destructive/10',
      )}
    >
      <div
        className={cn(
          'text-xs',
          !empty && tone === 'warning' && 'text-warning',
          !empty && tone === 'danger' && 'text-destructive',
          (empty || tone === 'neutral') && 'text-muted-foreground',
        )}
      >
        {title}
      </div>
      <div
        className={cn(
          'mt-1 text-lg font-semibold tabular-nums md:text-xl',
          !empty && tone === 'danger' && 'text-destructive',
          !empty && tone === 'warning' && 'text-warning',
        )}
      >
        {formatRubWhole(bucket.sumKopecks)}
      </div>
      <div className="text-muted-foreground text-[11px]">
        {bucket.count} {pluralInvoices(bucket.count)}
      </div>
    </div>
  );
}
