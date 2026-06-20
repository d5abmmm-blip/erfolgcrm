/**
 * /settings/email — реквизиты общего почтового ящика компании. Доступ — только директор.
 *
 * SMTP — для отправки (Этап A). IMAP — для входящих (Этап B), поля можно заполнить заранее.
 * Пароли write-only: с сервера приходит лишь флаг «задан», пустое поле = не менять.
 * В dev можно оставить SMTP пустым — письма уйдут в MailHog (http://localhost:8025).
 */
import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, Mail, Send } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

function numOrNull(v: string): number | null {
  const n = Number(v);
  return v.trim() && Number.isFinite(n) ? n : null;
}

export function MailSettingsPage() {
  const cfg = trpc.email.getConfig.useQuery();
  const utils = trpc.useUtils();

  const [enabled, setEnabled] = useState(false);
  const [fromName, setFromName] = useState('');
  const [fromEmail, setFromEmail] = useState('');
  const [smtpHost, setSmtpHost] = useState('');
  const [smtpPort, setSmtpPort] = useState('');
  const [smtpSecure, setSmtpSecure] = useState(true);
  const [smtpUser, setSmtpUser] = useState('');
  const [smtpPassword, setSmtpPassword] = useState('');
  const [imapHost, setImapHost] = useState('');
  const [imapPort, setImapPort] = useState('');
  const [imapSecure, setImapSecure] = useState(true);
  const [imapUser, setImapUser] = useState('');
  const [imapPassword, setImapPassword] = useState('');
  const [signature, setSignature] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  // Префилл из конфига при загрузке.
  useEffect(() => {
    const c = cfg.data;
    if (!c) return;
    setEnabled(c.enabled);
    setFromName(c.fromName ?? '');
    setFromEmail(c.fromEmail ?? '');
    setSmtpHost(c.smtpHost ?? '');
    setSmtpPort(c.smtpPort != null ? String(c.smtpPort) : '');
    setSmtpSecure(c.smtpSecure);
    setSmtpUser(c.smtpUser ?? '');
    setImapHost(c.imapHost ?? '');
    setImapPort(c.imapPort != null ? String(c.imapPort) : '');
    setImapSecure(c.imapSecure);
    setImapUser(c.imapUser ?? '');
    setSignature(c.signature ?? '');
  }, [cfg.data]);

  const setConfig = trpc.email.setConfig.useMutation({
    onSuccess: async () => {
      setSaved(true);
      setSmtpPassword('');
      setImapPassword('');
      setTimeout(() => setSaved(false), 2500);
      await utils.email.getConfig.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const sendTest = trpc.email.sendTest.useMutation({
    onSuccess: (r) => setTestMsg(r.status === 'sent' ? 'Тестовое письмо отправлено.' : 'Отправка пропущена (проверьте реквизиты SMTP).'),
    onError: (e) => setTestMsg(`Ошибка: ${e.message}`),
  });

  const save = () => {
    setError(null);
    setConfig.mutate({
      enabled,
      fromName: fromName.trim() || null,
      fromEmail: fromEmail.trim() || null,
      smtpHost: smtpHost.trim() || null,
      smtpPort: numOrNull(smtpPort),
      smtpSecure,
      smtpUser: smtpUser.trim() || null,
      smtpPassword: smtpPassword || undefined,
      imapHost: imapHost.trim() || null,
      imapPort: numOrNull(imapPort),
      imapSecure,
      imapUser: imapUser.trim() || null,
      imapPassword: imapPassword || undefined,
      signature: signature.trim() || null,
    });
  };

  const inputCls =
    'bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2';

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Mail className="text-primary h-6 w-6" />
        <h1 className="text-2xl font-semibold">Почта — настройки ящика</h1>
      </div>

      <p className="text-muted-foreground text-sm">
        Реквизиты общего почтового ящика компании (например, на reg.ru). SMTP — для отправки писем
        клиентам. IMAP понадобится для входящих на следующем этапе. В режиме разработки можно
        оставить SMTP пустым — письма перехватит MailHog.
      </p>

      {error && (
        <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/30 px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {cfg.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        <div className="space-y-4">
          {/* Enable toggle */}
          <div className="bg-card flex items-center justify-between rounded-lg border p-4">
            <div>
              <div className="font-medium">Отправлять через этот ящик</div>
              <div className="text-muted-foreground text-xs">
                Если выключено — письма уходят через резервный транспорт (в dev — MailHog)
              </div>
            </div>
            <button
              type="button"
              onClick={() => setEnabled((v) => !v)}
              className={cn(
                'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors',
                enabled ? 'bg-primary' : 'bg-muted',
              )}
              role="switch"
              aria-checked={enabled}
            >
              <span
                className={cn(
                  'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transition-transform',
                  enabled ? 'translate-x-5' : 'translate-x-0',
                )}
              />
            </button>
          </div>

          {/* Отправитель */}
          <div className="bg-card space-y-3 rounded-lg border p-4">
            <div className="font-medium">Отправитель</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium">Имя отправителя</span>
                <input value={fromName} onChange={(e) => setFromName(e.target.value)} placeholder="ООО «Эрфольг»" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Адрес отправителя</span>
                <input value={fromEmail} onChange={(e) => setFromEmail(e.target.value)} placeholder="info@example.ru" className={inputCls} />
              </label>
            </div>
          </div>

          {/* SMTP */}
          <div className="bg-card space-y-3 rounded-lg border p-4">
            <div className="font-medium">SMTP (отправка)</div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium">Сервер</span>
                <input value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.example.ru" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Порт</span>
                <input value={smtpPort} onChange={(e) => setSmtpPort(e.target.value)} placeholder="465" inputMode="numeric" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Логин</span>
                <input value={smtpUser} onChange={(e) => setSmtpUser(e.target.value)} placeholder="info@example.ru" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Пароль</span>
                <input
                  type="password"
                  value={smtpPassword}
                  onChange={(e) => setSmtpPassword(e.target.value)}
                  placeholder={cfg.data?.hasSmtpPassword ? '•••••• (сохранён, пусто — не менять)' : 'не задан'}
                  className={inputCls}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={smtpSecure} onChange={(e) => setSmtpSecure(e.target.checked)} />
              SSL/TLS (порт 465). Снимите для STARTTLS (587) или локального MailHog (1025).
            </label>
          </div>

          {/* IMAP (Этап B) */}
          <div className="bg-card space-y-3 rounded-lg border p-4">
            <div className="font-medium">
              IMAP (входящие) <span className="text-muted-foreground text-xs font-normal">— приём входящих писем</span>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium">Сервер</span>
                <input value={imapHost} onChange={(e) => setImapHost(e.target.value)} placeholder="imap.example.ru" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Порт</span>
                <input value={imapPort} onChange={(e) => setImapPort(e.target.value)} placeholder="993" inputMode="numeric" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Логин</span>
                <input value={imapUser} onChange={(e) => setImapUser(e.target.value)} placeholder="info@example.ru" className={inputCls} />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Пароль</span>
                <input
                  type="password"
                  value={imapPassword}
                  onChange={(e) => setImapPassword(e.target.value)}
                  placeholder={cfg.data?.hasImapPassword ? '•••••• (сохранён, пусто — не менять)' : 'не задан'}
                  className={inputCls}
                />
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={imapSecure} onChange={(e) => setImapSecure(e.target.checked)} />
              SSL/TLS (порт 993)
            </label>
          </div>

          {/* Подпись */}
          <div className="bg-card space-y-3 rounded-lg border p-4">
            <div className="font-medium">Подпись</div>
            <p className="text-muted-foreground text-xs">
              Добавляется в конец каждого исходящего письма (контакты и реквизиты компании).
            </p>
            <textarea
              value={signature}
              onChange={(e) => setSignature(e.target.value)}
              rows={4}
              placeholder={'С уважением,\nООО «Эрфольг»\n+7 ...'}
              className={cn(inputCls, 'resize-y')}
            />
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={setConfig.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {setConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Сохранить
            </button>
            <button
              type="button"
              onClick={() => {
                setTestMsg(null);
                sendTest.mutate();
              }}
              disabled={sendTest.isPending}
              className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {sendTest.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              Отправить тест
            </button>
            {saved && (
              <span className="text-success inline-flex items-center gap-1 text-sm">
                <CheckCircle2 className="h-4 w-4" />
                Сохранено
              </span>
            )}
            {testMsg && <span className="text-muted-foreground text-sm">{testMsg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
