import { useEffect, useState, type FormEvent } from 'react';
import { Loader2, Save, KeyRound } from 'lucide-react';
import { trpc } from '../../lib/trpc';

export function ClientProfilePage() {
  const me = trpc.clientAuth.me.useQuery();
  const utils = trpc.useUtils();

  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [position, setPosition] = useState('');
  const [profileMsg, setProfileMsg] = useState<string | null>(null);
  const [profileErr, setProfileErr] = useState<string | null>(null);

  useEffect(() => {
    if (me.data) {
      setFullName(me.data.user.fullName);
    }
  }, [me.data]);

  const update = trpc.clientCabinet.updateProfile.useMutation({
    onSuccess: async () => {
      setProfileMsg('Профиль сохранён');
      setProfileErr(null);
      await utils.clientAuth.me.invalidate();
    },
    onError: (e) => {
      setProfileErr(e.message);
      setProfileMsg(null);
    },
  });

  const [oldPwd, setOldPwd] = useState('');
  const [newPwd, setNewPwd] = useState('');
  const [pwdMsg, setPwdMsg] = useState<string | null>(null);
  const [pwdErr, setPwdErr] = useState<string | null>(null);

  const changePwd = trpc.clientAuth.changeMyPassword.useMutation({
    onSuccess: async () => {
      setPwdMsg('Пароль изменён. Возможно, нужно войти заново.');
      setPwdErr(null);
      setOldPwd('');
      setNewPwd('');
      await utils.clientAuth.me.invalidate();
    },
    onError: (e) => {
      setPwdErr(e.message);
      setPwdMsg(null);
    },
  });

  function onSaveProfile(e: FormEvent) {
    e.preventDefault();
    setProfileMsg(null);
    setProfileErr(null);
    update.mutate({
      fullName,
      phone: phone || null,
      position: position || null,
    });
  }

  function onChangePwd(e: FormEvent) {
    e.preventDefault();
    setPwdMsg(null);
    setPwdErr(null);
    if (newPwd.length < 8) {
      setPwdErr('Новый пароль должен быть не короче 8 символов');
      return;
    }
    changePwd.mutate({ oldPassword: oldPwd, newPassword: newPwd });
  }

  if (me.isLoading || !me.data) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-xl space-y-4 p-4 md:p-6">
      <form onSubmit={onSaveProfile} className="bg-card space-y-4 rounded-md border p-4 md:p-6">
        <h3 className="text-sm font-semibold">Личные данные</h3>

        <Field label="Email">
          <input
            type="email"
            value={me.data.user.email}
            disabled
            className="border-input bg-muted h-10 w-full rounded-md border px-3 text-sm"
          />
        </Field>
        <Field label="ФИО">
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            required
          />
        </Field>
        <Field label="Должность" hint="Например: главный бухгалтер">
          <input
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
          />
        </Field>
        <Field label="Телефон">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
          />
        </Field>

        {profileMsg && <Note kind="ok" text={profileMsg} />}
        {profileErr && <Note kind="err" text={profileErr} />}

        <button
          type="submit"
          disabled={update.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium disabled:opacity-50"
        >
          {update.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Save className="h-4 w-4" />
          )}
          Сохранить
        </button>
      </form>

      <form onSubmit={onChangePwd} className="bg-card space-y-4 rounded-md border p-4 md:p-6">
        <h3 className="text-sm font-semibold">Сменить пароль</h3>

        <Field label="Текущий пароль">
          <input
            type="password"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            required
          />
        </Field>
        <Field label="Новый пароль" hint="Минимум 8 символов">
          <input
            type="password"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            className="border-input bg-background h-10 w-full rounded-md border px-3 text-sm"
            required
          />
        </Field>

        {pwdMsg && <Note kind="ok" text={pwdMsg} />}
        {pwdErr && <Note kind="err" text={pwdErr} />}

        <button
          type="submit"
          disabled={changePwd.isPending}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium disabled:opacity-50"
        >
          {changePwd.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <KeyRound className="h-4 w-4" />
          )}
          Сменить пароль
        </button>
      </form>
    </div>
  );
}

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

function Note({ kind, text }: { kind: 'ok' | 'err'; text: string }) {
  const cls =
    kind === 'ok'
      ? 'bg-success/10 text-success border-success/20'
      : 'bg-destructive/10 text-destructive border-destructive/20';
  return <div className={`rounded-md border px-3 py-2 text-sm ${cls}`}>{text}</div>;
}
