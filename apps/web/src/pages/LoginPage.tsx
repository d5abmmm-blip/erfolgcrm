import { useState, type FormEvent } from 'react';
import { Loader2, ShieldCheck, Building2, KeyRound } from 'lucide-react';
import { trpc, setTenantSubdomain, getTenantSubdomain } from '../lib/trpc';

type Step = 'password' | '2fa';

/**
 * Личный режим: если VITE_DEFAULT_TENANT задан (single-tenant инсталляция),
 * поле «Код организации» скрывается и организация подставляется автоматически.
 */
const DEFAULT_TENANT = ((import.meta.env.VITE_DEFAULT_TENANT as string | undefined) ?? '')
  .trim()
  .toLowerCase();

export function LoginPage() {
  const utils = trpc.useUtils();
  const [tenant, setTenant] = useState(() => getTenantSubdomain() ?? DEFAULT_TENANT);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const [step, setStep] = useState<Step>('password');
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);

  const login = trpc.auth.login.useMutation({
    onSuccess: async (data) => {
      if (data.needs2fa) {
        setChallengeToken(data.challengeToken);
        setStep('2fa');
        setCode('');
        setError(null);
        return;
      }
      await utils.auth.me.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const verify = trpc.auth.verify2fa.useMutation({
    onSuccess: async () => {
      await utils.auth.me.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!tenant.trim()) {
      setError('Укажите код вашей организации (subdomain)');
      return;
    }
    setTenantSubdomain(tenant.trim().toLowerCase());
    login.mutate({ username: username.trim(), password });
  }

  function onSubmit2fa(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!challengeToken) return;
    verify.mutate({ challengeToken, code: code.trim() });
  }

  function backToPassword() {
    setStep('password');
    setChallengeToken(null);
    setCode('');
    setError(null);
    setUseRecovery(false);
  }

  return (
    <div className="grid h-full overflow-y-auto md:grid-cols-2">
      {/* Левая панель: брендинг */}
      <aside className="from-primary to-accent relative hidden flex-col justify-between bg-gradient-to-br p-8 text-white md:flex md:p-12">
        <div className="flex items-center gap-3">
          <img src="/favicon.png" alt="ER" className="h-10 w-10 rounded-md bg-white/95 p-1" />
          <div className="leading-tight">
            <div className="text-base font-semibold">ErfolgCRM</div>
            <div className="text-xs uppercase tracking-wider opacity-80">
              для сервисных центров медтехники
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <h1 className="text-3xl font-semibold leading-tight md:text-4xl">
            Заявки, ремонты и журнал ТО — в одной системе
          </h1>
          <p className="max-w-md text-base opacity-90">
            СРМ для сервисных центров медицинской техники с учётом требований Росздравнадзора.
            Хостинг в РФ, соответствие 152-ФЗ.
          </p>
          <ul className="space-y-3 text-sm opacity-95">
            <Feature icon={ShieldCheck} text="Шифрование ПДн и журнал доступа из коробки" />
            <Feature icon={Building2} text="Все данные — в вашей собственной базе" />
          </ul>
        </div>

        <div className="text-xs opacity-70">© 2026 ErfolgCRM</div>
      </aside>

      {/* Правая панель: форма */}
      <main className="flex items-center justify-center p-6 md:p-12">
        <div className="bg-card w-full max-w-sm space-y-6 rounded-xl border p-6 md:p-8 md:shadow-sm">
          <div className="md:hidden">
            <img src="/favicon.png" alt="ErfolgCRM" className="mx-auto h-12 w-12" />
          </div>

          {step === 'password' && (
            <>
              <div className="space-y-1.5 text-center md:text-left">
                <h2 className="text-2xl font-semibold">Вход в систему</h2>
                <p className="text-muted-foreground text-sm">
                  Используйте свой логин и пароль, выданные администратором
                </p>
              </div>

              <form onSubmit={onSubmit} className="space-y-4">
                {!DEFAULT_TENANT && (
                  <Field label="Код организации" hint="Например: erfolg">
                    <input
                      type="text"
                      autoComplete="organization"
                      value={tenant}
                      onChange={(e) => setTenant(e.target.value)}
                      placeholder="erfolg"
                      className={inputCls}
                      required
                    />
                  </Field>
                )}
                <Field label="Логин">
                  <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="director"
                    className={inputCls}
                    required
                  />
                </Field>
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

                {error && <ErrorBox message={error} />}

                <button
                  type="submit"
                  disabled={login.isPending}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium transition disabled:opacity-50"
                >
                  {login.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Войти
                </button>

                <p className="text-muted-foreground text-center text-xs">
                  Забыли пароль? Обратитесь к директору вашей организации.
                </p>
              </form>
            </>
          )}

          {step === '2fa' && (
            <>
              <div className="space-y-1.5 text-center md:text-left">
                <div className="bg-primary/10 text-primary mb-2 inline-flex h-10 w-10 items-center justify-center rounded-md">
                  <KeyRound className="h-5 w-5" />
                </div>
                <h2 className="text-2xl font-semibold">Двухфакторная проверка</h2>
                <p className="text-muted-foreground text-sm">
                  {useRecovery
                    ? 'Введите один из 12-значных recovery-кодов, которые сохранили при настройке.'
                    : 'Откройте приложение Authenticator на телефоне и введите 6-значный код.'}
                </p>
              </div>

              <form onSubmit={onSubmit2fa} className="space-y-4">
                <Field label={useRecovery ? 'Recovery-код' : 'Код из приложения'}>
                  <input
                    type="text"
                    inputMode={useRecovery ? 'text' : 'numeric'}
                    autoComplete="one-time-code"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder={useRecovery ? 'XXXX-XXXX-XXXX' : '000000'}
                    className={`${inputCls} text-center text-lg tracking-widest`}
                    autoFocus
                    required
                  />
                </Field>

                {error && <ErrorBox message={error} />}

                <button
                  type="submit"
                  disabled={verify.isPending}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium transition disabled:opacity-50"
                >
                  {verify.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                  Подтвердить
                </button>

                <div className="flex items-center justify-between text-xs">
                  <button
                    type="button"
                    onClick={backToPassword}
                    className="text-muted-foreground hover:text-foreground underline-offset-4 hover:underline"
                  >
                    ← Назад
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setUseRecovery(!useRecovery);
                      setCode('');
                      setError(null);
                    }}
                    className="text-primary underline-offset-4 hover:underline"
                  >
                    {useRecovery ? 'У меня есть код из приложения' : 'Использовать recovery-код'}
                  </button>
                </div>
              </form>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

const inputCls =
  'border-input bg-background focus-visible:ring-ring placeholder:text-muted-foreground/60 flex h-10 w-full rounded-md border px-3 py-2 text-sm transition focus-visible:outline-none focus-visible:ring-2';

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block space-y-1.5">
      <span className="text-foreground text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="text-muted-foreground block text-xs">{hint}</span>}
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

function Feature({ icon: Icon, text }: { icon: typeof ShieldCheck; text: string }) {
  return (
    <li className="flex items-start gap-2.5">
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{text}</span>
    </li>
  );
}
