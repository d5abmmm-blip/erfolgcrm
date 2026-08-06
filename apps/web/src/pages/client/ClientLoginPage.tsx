import { useState, type FormEvent } from 'react';
import { Loader2, Building2, ShieldCheck } from 'lucide-react';
import { trpc, setTenantSubdomain, getTenantSubdomain } from '../../lib/trpc';

/** Личный режим: при заданном VITE_DEFAULT_TENANT поле «Код сервисного центра» скрыто. */
const DEFAULT_TENANT = ((import.meta.env.VITE_DEFAULT_TENANT as string | undefined) ?? '')
  .trim()
  .toLowerCase();

export function ClientLoginPage() {
  const utils = trpc.useUtils();
  const [tenant, setTenant] = useState(() => getTenantSubdomain() ?? (DEFAULT_TENANT || 'erfolg'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const login = trpc.clientAuth.login.useMutation({
    onSuccess: async () => {
      await utils.clientAuth.me.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!tenant.trim()) {
      setError('Укажите код сервисного центра');
      return;
    }
    setTenantSubdomain(tenant.trim().toLowerCase());
    login.mutate({ email: email.trim(), password });
  }

  return (
    <div className="grid h-full md:grid-cols-2">
      <aside className="from-primary to-accent relative hidden flex-col justify-between bg-gradient-to-br p-8 text-white md:flex md:p-12">
        <div className="flex items-center gap-3">
          <img src="/favicon.png" alt="ER" className="h-10 w-10 rounded-md bg-white/95 p-1" />
          <div className="leading-tight">
            <div className="text-base font-semibold">Кабинет клиента</div>
            <div className="text-xs uppercase tracking-wider opacity-80">ООО «Эрфольг»</div>
          </div>
        </div>

        <div className="space-y-6">
          <h1 className="text-3xl font-semibold leading-tight md:text-4xl">
            Заявки и счета вашей клиники — в одном окне
          </h1>
          <p className="max-w-md text-base opacity-90">
            Отслеживайте ремонты медтехники, скачивайте счета на оплату, подавайте новые заявки без
            звонка диспетчеру.
          </p>
          <ul className="space-y-3 text-sm opacity-95">
            <Feature
              icon={ShieldCheck}
              text="Защищённый канал, доступ только для вашей организации"
            />
            <Feature icon={Building2} text="История ремонтов и ТО по каждой единице техники" />
          </ul>
        </div>

        <div className="text-xs opacity-70">© 2026 ErfolgCRM</div>
      </aside>

      <main className="flex items-center justify-center p-6 md:p-12">
        <div className="bg-card w-full max-w-sm space-y-6 rounded-xl border p-6 md:p-8 md:shadow-sm">
          <div className="md:hidden">
            <img src="/favicon.png" alt="ErfolgCRM" className="mx-auto h-12 w-12" />
          </div>

          <div className="space-y-1.5 text-center md:text-left">
            <h2 className="text-2xl font-semibold">Вход в кабинет</h2>
            <p className="text-muted-foreground text-sm">
              Используйте email и пароль, выданные вашим сервисным центром
            </p>
          </div>

          <form onSubmit={onSubmit} className="space-y-4">
            {!DEFAULT_TENANT && (
              <Field label="Код сервисного центра" hint="Например: erfolg">
                <input
                  type="text"
                  value={tenant}
                  onChange={(e) => setTenant(e.target.value)}
                  className={inputCls}
                  required
                />
              </Field>
            )}
            <Field label="Email">
              <input
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="vasya@klinika.ru"
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
              Забыли пароль? Обратитесь в сервисный центр.
            </p>
          </form>
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
