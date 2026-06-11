/**
 * /settings/security — двухфакторная аутентификация (TOTP).
 *
 * Если 2FA выключена → кнопка «Включить 2FA», запускающая wizard
 *   1) QR + secret  →  2) ввод кода  →  3) показ recovery-кодов (один раз).
 *
 * Если 2FA включена → инфо-блок и две операции:
 *   • Сгенерировать новые recovery-коды (требует пароль + TOTP).
 *   • Отключить 2FA (требует пароль + TOTP).
 *
 * Доступно всем ролям, но для директора подсвечено как обязательное (152-ФЗ).
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  KeyRound,
  Loader2,
  RefreshCw,
  Shield,
  ShieldOff,
  X,
} from 'lucide-react';
import QRCode from 'qrcode';
import { trpc } from '../lib/trpc';

type WizardStep = 'qr' | 'verify' | 'codes';

export function SecurityPage() {
  const me = trpc.auth.me.useQuery();
  const [wizardOpen, setWizardOpen] = useState(false);
  const [regenOpen, setRegenOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [showCodesAfterRegen, setShowCodesAfterRegen] = useState<string[] | null>(null);

  const isDirector = me.data?.user.role === 'director';
  const enabled = me.data?.user.twoFactorEnabled ?? false;

  return (
    <div className="mx-auto max-w-2xl space-y-4 p-4 md:p-6">
      <div>
        <Link href="/settings" className="text-primary text-sm hover:underline">
          ← Настройки
        </Link>
        <h1 className="mt-2 text-xl font-semibold md:text-2xl">Безопасность аккаунта</h1>
        <p className="text-muted-foreground text-sm">
          Двухфакторная аутентификация защищает вход даже при утечке пароля.
        </p>
      </div>

      {isDirector && !enabled && (
        <div className="bg-warning/10 text-warning border-warning/30 flex items-start gap-3 rounded-lg border p-4 text-sm">
          <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
          <div>
            <div className="font-medium">Включите 2FA — требование 152-ФЗ.</div>
            <div className="opacity-90">
              Роль «Директор» имеет доступ ко всем ПДн клиентов. Без второго фактора защита
              слабее минимальной.
            </div>
          </div>
        </div>
      )}

      <div className="bg-card rounded-lg border p-5">
        <div className="flex items-start gap-4">
          <div
            className={`grid h-12 w-12 place-items-center rounded-md ${
              enabled ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'
            }`}
          >
            {enabled ? <Shield className="h-6 w-6" /> : <ShieldOff className="h-6 w-6" />}
          </div>
          <div className="flex-1">
            <div className="font-medium">
              {enabled ? '2FA активна' : '2FA не настроена'}
            </div>
            <div className="text-muted-foreground mt-0.5 text-sm">
              {enabled
                ? 'При входе понадобится 6-значный код из приложения Authenticator (Google Authenticator, Aegis, 1Password и др.)'
                : 'Включите 2FA, чтобы защитить аккаунт даже при утечке пароля.'}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {!enabled && (
                <button
                  type="button"
                  onClick={() => setWizardOpen(true)}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition"
                >
                  <Shield className="h-4 w-4" />
                  Включить 2FA
                </button>
              )}
              {enabled && (
                <>
                  <button
                    type="button"
                    onClick={() => setRegenOpen(true)}
                    className="bg-secondary hover:bg-muted inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Новые recovery-коды
                  </button>
                  <button
                    type="button"
                    onClick={() => setDisableOpen(true)}
                    className="bg-destructive/10 text-destructive hover:bg-destructive/20 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition"
                  >
                    <ShieldOff className="h-4 w-4" />
                    Отключить 2FA
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>

      {wizardOpen && (
        <Setup2faWizard
          username={me.data?.user.username ?? ''}
          onClose={() => setWizardOpen(false)}
          onDone={() => {
            setWizardOpen(false);
            me.refetch();
          }}
        />
      )}

      {regenOpen && (
        <RegenerateModal
          onClose={() => setRegenOpen(false)}
          onDone={(codes) => {
            setRegenOpen(false);
            setShowCodesAfterRegen(codes);
          }}
        />
      )}

      {showCodesAfterRegen && (
        <CodesShowModal
          codes={showCodesAfterRegen}
          onClose={() => setShowCodesAfterRegen(null)}
        />
      )}

      {disableOpen && (
        <DisableModal
          onClose={() => setDisableOpen(false)}
          onDone={() => {
            setDisableOpen(false);
            me.refetch();
          }}
        />
      )}
    </div>
  );
}

/* ============================== Setup wizard ============================== */

function Setup2faWizard({
  username: _username,
  onClose,
  onDone,
}: {
  username: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const [step, setStep] = useState<WizardStep>('qr');
  const [secret, setSecret] = useState<string | null>(null);
  const [otpauthUrl, setOtpauthUrl] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = trpc.auth.twoFactor.setup.start.useMutation({
    onSuccess: async (data) => {
      setSecret(data.secret);
      setOtpauthUrl(data.otpauthUrl);
      const svg = await QRCode.toString(data.otpauthUrl, {
        type: 'svg',
        margin: 1,
        width: 220,
      });
      setQrSvg(svg);
    },
    onError: (e) => setError(e.message),
  });

  const confirm = trpc.auth.twoFactor.setup.confirm.useMutation({
    onSuccess: (data) => {
      setRecoveryCodes(data.recoveryCodes);
      setStep('codes');
    },
    onError: (e) => setError(e.message),
  });

  useEffect(() => {
    start.mutate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmitVerify(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!secret) return;
    confirm.mutate({ secret, code: code.trim() });
  }

  return (
    <ModalShell title="Включение 2FA" onClose={onClose}>
      {step === 'qr' && (
        <div className="space-y-4">
          <ol className="text-muted-foreground text-sm">
            <li>1. Установите Google Authenticator, Aegis, 1Password или другой TOTP-клиент.</li>
            <li>2. Отсканируйте QR-код или введите секрет вручную.</li>
            <li>3. Подтвердите 6-значным кодом из приложения.</li>
          </ol>
          <div className="flex flex-col items-center gap-3">
            {qrSvg ? (
              <div
                className="rounded-md border bg-white p-3"
                dangerouslySetInnerHTML={{ __html: qrSvg }}
              />
            ) : (
              <div className="grid h-[220px] w-[220px] place-items-center rounded-md border">
                <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
              </div>
            )}
            {secret && (
              <div className="bg-muted text-muted-foreground w-full break-all rounded-md p-2 text-center font-mono text-xs">
                {secret}
              </div>
            )}
            {otpauthUrl && (
              <a
                href={otpauthUrl}
                className="text-primary text-xs hover:underline"
                rel="noopener"
              >
                Открыть в приложении
              </a>
            )}
          </div>
          {error && <ErrorBox message={error} />}
          <div className="flex justify-end gap-2">
            <SecondaryBtn onClick={onClose}>Отмена</SecondaryBtn>
            <PrimaryBtn onClick={() => setStep('verify')} disabled={!secret}>
              Дальше
            </PrimaryBtn>
          </div>
        </div>
      )}

      {step === 'verify' && (
        <form onSubmit={onSubmitVerify} className="space-y-4">
          <p className="text-muted-foreground text-sm">
            Введите 6-значный код из приложения, чтобы убедиться, что секрет сохранён правильно.
          </p>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="000000"
            className={`${inputCls} text-center text-2xl tracking-widest`}
            autoFocus
            maxLength={8}
          />
          {error && <ErrorBox message={error} />}
          <div className="flex justify-end gap-2">
            <SecondaryBtn onClick={() => setStep('qr')} type="button">
              ← Назад
            </SecondaryBtn>
            <PrimaryBtn type="submit" loading={confirm.isPending}>
              Подтвердить
            </PrimaryBtn>
          </div>
        </form>
      )}

      {step === 'codes' && recoveryCodes && (
        <CodesView codes={recoveryCodes} onContinue={onDone} />
      )}
    </ModalShell>
  );
}

/* ========================= Disable / Regenerate ========================= */

function DisableModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: () => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = trpc.auth.twoFactor.disable.useMutation({
    onSuccess: onDone,
    onError: (e) => setError(e.message),
  });
  return (
    <ModalShell title="Отключить 2FA" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          m.mutate({ password, code: code.trim() });
        }}
      >
        <div className="bg-warning/10 text-warning border-warning/30 rounded-md border p-3 text-sm">
          После отключения вход будет защищён только паролем.
        </div>
        <Field label="Пароль">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
            required
          />
        </Field>
        <Field label="Код из приложения">
          <input
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${inputCls} text-center tracking-widest`}
            placeholder="000000"
            required
          />
        </Field>
        {error && <ErrorBox message={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <SecondaryBtn type="button" onClick={onClose}>
            Отмена
          </SecondaryBtn>
          <button
            type="submit"
            disabled={m.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition disabled:opacity-50"
          >
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Отключить 2FA
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function RegenerateModal({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (codes: string[]) => void;
}) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = trpc.auth.twoFactor.regenerateRecoveryCodes.useMutation({
    onSuccess: (data) => onDone(data.recoveryCodes),
    onError: (e) => setError(e.message),
  });
  return (
    <ModalShell title="Новые recovery-коды" onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          m.mutate({ password, code: code.trim() });
        }}
      >
        <div className="text-muted-foreground text-sm">
          Старые коды перестанут работать сразу после генерации новых.
        </div>
        <Field label="Пароль">
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
            required
          />
        </Field>
        <Field label="Код из приложения">
          <input
            type="text"
            inputMode="numeric"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={`${inputCls} text-center tracking-widest`}
            placeholder="000000"
            required
          />
        </Field>
        {error && <ErrorBox message={error} />}
        <div className="flex justify-end gap-2 pt-1">
          <SecondaryBtn type="button" onClick={onClose}>
            Отмена
          </SecondaryBtn>
          <PrimaryBtn type="submit" loading={m.isPending}>
            Сгенерировать
          </PrimaryBtn>
        </div>
      </form>
    </ModalShell>
  );
}

function CodesShowModal({ codes, onClose }: { codes: string[]; onClose: () => void }) {
  return (
    <ModalShell title="Recovery-коды" onClose={onClose}>
      <CodesView codes={codes} onContinue={onClose} />
    </ModalShell>
  );
}

function CodesView({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  function download() {
    const text = [
      '# Erfolg CRM — recovery-коды 2FA',
      '# Каждый код одноразовый. Храните в надёжном месте.',
      '',
      ...codes,
    ].join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'erfolg-2fa-recovery.txt';
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div className="space-y-4">
      <div className="bg-warning/10 text-warning border-warning/30 flex items-start gap-3 rounded-md border p-3 text-sm">
        <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
        <div>
          Эти коды показываются <b>один раз</b>. Сохраните их в надёжном месте — они помогут
          войти, если вы потеряете телефон.
        </div>
      </div>
      <div className="bg-muted grid grid-cols-2 gap-2 rounded-md p-3 font-mono text-sm">
        {codes.map((c) => (
          <div key={c} className="text-center">
            {c}
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={download}
          className="bg-secondary hover:bg-muted inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition"
        >
          <Download className="h-4 w-4" />
          Скачать .txt
        </button>
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={confirmed}
          onChange={(e) => setConfirmed(e.target.checked)}
          className="mt-1"
        />
        <span>Я сохранил коды в надёжном месте.</span>
      </label>
      <div className="flex justify-end pt-1">
        <PrimaryBtn onClick={onContinue} disabled={!confirmed}>
          <CheckCircle2 className="h-4 w-4" />
          Готово
        </PrimaryBtn>
      </div>
    </div>
  );
}

/* ============================== Building blocks ============================== */

function ModalShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card relative w-full max-w-md rounded-lg border p-5 shadow-lg">
        <button
          type="button"
          onClick={onClose}
          className="text-muted-foreground hover:bg-muted absolute right-3 top-3 rounded-md p-1.5"
          aria-label="Закрыть"
        >
          <X className="h-4 w-4" />
        </button>
        <div className="mb-3 flex items-center gap-2">
          <KeyRound className="text-primary h-4 w-4" />
          <h3 className="font-semibold">{title}</h3>
        </div>
        {children}
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-foreground text-xs font-medium">{label}</span>
      {children}
    </label>
  );
}

function ErrorBox({ message }: { message: string }) {
  return (
    <div className="bg-destructive/10 text-destructive border-destructive/20 rounded-md border px-3 py-2 text-sm">
      {message}
    </div>
  );
}

function PrimaryBtn({
  children,
  onClick,
  type,
  loading,
  disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: 'button' | 'submit';
  loading?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      disabled={loading || disabled}
      className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition disabled:opacity-50"
    >
      {loading && <Loader2 className="h-4 w-4 animate-spin" />}
      {children}
    </button>
  );
}

function SecondaryBtn({
  children,
  onClick,
  type,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  type?: 'button';
}) {
  return (
    <button
      type={type ?? 'button'}
      onClick={onClick}
      className="bg-secondary hover:bg-muted inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium transition"
    >
      {children}
    </button>
  );
}

const inputCls =
  'border-input bg-background focus-visible:ring-ring placeholder:text-muted-foreground/60 flex h-10 w-full rounded-md border px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2';
