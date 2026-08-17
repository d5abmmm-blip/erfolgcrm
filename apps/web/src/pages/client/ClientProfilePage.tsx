import { useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'wouter';
import { Loader2, Save, KeyRound, FileDown, ShieldAlert } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { assertOnlineForFile } from '../../lib/offline/require-online';

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

  /* ── Мои данные (152-ФЗ): выгрузка и запрос на удаление ── */
  const [, navigate] = useLocation();
  const [exporting, setExporting] = useState(false);
  const [dataMsg, setDataMsg] = useState<string | null>(null);
  const [dataErr, setDataErr] = useState<string | null>(null);
  // Удаление — двумя шагами: первый клик раскрывает объяснение последствий.
  const [confirmDeletion, setConfirmDeletion] = useState(false);

  const onExportMyData = async () => {
    setExporting(true);
    setDataErr(null);
    setDataMsg(null);
    try {
      // Без связи в сеть не идём: на паузе запрос не завершится никогда,
      // и кнопка навсегда осталась бы «Собираю…» (lib/offline/require-online).
      assertOnlineForFile('выгрузка ваших данных');
      const data = await utils.clientCabinet.exportMyData.fetch();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `мои-данные-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setDataMsg('Файл со всеми вашими данными сохранён на устройство');
    } catch (e) {
      setDataErr(e instanceof Error ? e.message : 'Не удалось собрать файл');
    } finally {
      setExporting(false);
    }
  };

  const requestDeletion = trpc.clientCabinet.requestAccountDeletion.useMutation({
    onSuccess: () => {
      // Сервер уже отозвал согласия и сессии и снял куку — уводим на вход.
      navigate('/client/login');
    },
    onError: (e) => setDataErr(e.message),
  });

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

      <section className="bg-card space-y-4 rounded-md border p-4 md:p-6">
        <h3 className="text-sm font-semibold">Мои данные</h3>
        <p className="text-muted-foreground text-sm">
          По закону о персональных данных (152-ФЗ) вы можете получить копию всех данных о себе или
          попросить удалить учётную запись.
        </p>

        {dataMsg && <Note kind="ok" text={dataMsg} />}
        {dataErr && <Note kind="err" text={dataErr} />}

        <button
          type="button"
          onClick={() => void onExportMyData()}
          disabled={exporting}
          className="border-input bg-background hover:bg-muted/40 inline-flex h-10 items-center gap-2 rounded-md border px-4 text-sm font-medium disabled:opacity-50"
        >
          {exporting ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <FileDown className="h-4 w-4" />
          )}
          {exporting ? 'Собираю файл…' : 'Скачать мои данные (файл)'}
        </button>

        {!confirmDeletion ? (
          <div>
            <button
              type="button"
              onClick={() => setConfirmDeletion(true)}
              className="text-destructive hover:bg-destructive/10 inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium"
            >
              <ShieldAlert className="h-4 w-4" />
              Удалить мой аккаунт
            </button>
          </div>
        ) : (
          <div className="border-destructive/30 bg-destructive/5 space-y-3 rounded-md border p-4">
            <p className="text-sm">
              Вход в кабинет закроется сразу, согласия на обработку данных будут отозваны. Документы
              по вашим заявкам и счетам закон о бухгалтерском учёте обязывает хранить 5 лет — они
              будут удалены по окончании этого срока. Если позже захотите вернуться, доступ сможет
              восстановить сервисный центр.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => requestDeletion.mutate()}
                disabled={requestDeletion.isPending}
                className="bg-destructive text-destructive-foreground hover:bg-destructive/90 inline-flex h-10 items-center gap-2 rounded-md px-4 text-sm font-medium disabled:opacity-50"
              >
                {requestDeletion.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Да, закрыть доступ и удалить данные
              </button>
              <button
                type="button"
                onClick={() => setConfirmDeletion(false)}
                className="border-input bg-background hover:bg-muted/40 inline-flex h-10 items-center rounded-md border px-4 text-sm font-medium"
              >
                Отмена
              </button>
            </div>
          </div>
        )}
      </section>
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
