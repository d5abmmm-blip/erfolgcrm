/**
 * Stage 10'.H — admin-страница управления учётками клиентского кабинета.
 *
 * Маршрут: /clients/:id/cabinet-users (доступна директору).
 * Позволяет создать/заблокировать/восстановить/сбросить пароль логинам клиента.
 */
import { useRoute, Link } from 'wouter';
import { useState, type FormEvent } from 'react';
import {
  ArrowLeft,
  Loader2,
  Lock,
  Unlock,
  KeyRound,
  Plus,
  X,
  Trash2,
} from 'lucide-react';
import { trpc } from '../lib/trpc';

export function ClientCabinetUsersPage() {
  const [, params] = useRoute<{ id: string }>('/clients/:id/cabinet-users');
  const clientId = params?.id ?? '';

  const utils = trpc.useUtils();
  const client = trpc.clients.get.useQuery({ id: clientId }, { enabled: Boolean(clientId) });
  const list = trpc.adminClientUsers.list.useQuery(
    { clientId },
    { enabled: Boolean(clientId) },
  );

  const [showCreate, setShowCreate] = useState(false);
  const [resetTarget, setResetTarget] = useState<string | null>(null);

  const setActive = trpc.adminClientUsers.setActive.useMutation({
    onSuccess: () => utils.adminClientUsers.list.invalidate(),
  });
  const remove = trpc.adminClientUsers.remove.useMutation({
    onSuccess: () => utils.adminClientUsers.list.invalidate(),
  });

  if (client.isLoading || list.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }
  if (client.error || !client.data) {
    return (
      <div className="space-y-3 p-6">
        <BackLink id={clientId} />
        <div className="text-destructive text-sm">Клиент не найден</div>
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <BackLink id={clientId} />
          <h2 className="mt-1 text-xl font-semibold">
            Доступ в кабинет: {client.data.displayName}
          </h2>
          <p className="text-muted-foreground text-sm">
            Логины сотрудников клиники для входа в личный кабинет
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium"
        >
          <Plus className="h-4 w-4" />
          Создать логин
        </button>
      </div>

      {(list.data ?? []).length === 0 ? (
        <div className="bg-card text-muted-foreground rounded-md border p-8 text-center text-sm">
          Учётки доступа в кабинет ещё не созданы
        </div>
      ) : (
        <div className="bg-card overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs uppercase">
              <tr>
                <th className="px-3 py-2 text-left">Email</th>
                <th className="px-3 py-2 text-left">ФИО</th>
                <th className="px-3 py-2 text-left">Должность</th>
                <th className="px-3 py-2 text-left">Последний вход</th>
                <th className="px-3 py-2 text-left">Статус</th>
                <th className="px-3 py-2 text-right">Действия</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {(list.data ?? []).map((u) => (
                <tr key={u.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 font-medium">{u.email}</td>
                  <td className="px-3 py-2">{u.fullName}</td>
                  <td className="px-3 py-2 text-muted-foreground">{u.position ?? '—'}</td>
                  <td className="px-3 py-2 text-muted-foreground text-xs">
                    {u.lastLoginAt
                      ? new Intl.DateTimeFormat('ru-RU', {
                          dateStyle: 'short',
                          timeStyle: 'short',
                        }).format(new Date(u.lastLoginAt))
                      : '—'}
                  </td>
                  <td className="px-3 py-2">
                    {u.isActive ? (
                      <span className="bg-success/10 text-success rounded px-2 py-0.5 text-xs">
                        Активна
                      </span>
                    ) : (
                      <span className="bg-destructive/10 text-destructive rounded px-2 py-0.5 text-xs">
                        Заблокирована
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex justify-end gap-1">
                      <IconBtn
                        title={u.isActive ? 'Заблокировать' : 'Разблокировать'}
                        onClick={() =>
                          setActive.mutate({ id: u.id, isActive: !u.isActive })
                        }
                        disabled={setActive.isPending}
                      >
                        {u.isActive ? <Lock className="h-4 w-4" /> : <Unlock className="h-4 w-4" />}
                      </IconBtn>
                      <IconBtn
                        title="Сбросить пароль"
                        onClick={() => setResetTarget(u.id)}
                      >
                        <KeyRound className="h-4 w-4" />
                      </IconBtn>
                      <IconBtn
                        title="Удалить (мягко)"
                        onClick={() => {
                          if (confirm(`Удалить логин ${u.email}? Восстановить можно только обращением в поддержку.`)) {
                            remove.mutate({ id: u.id });
                          }
                        }}
                      >
                        <Trash2 className="text-destructive h-4 w-4" />
                      </IconBtn>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && (
        <CreateClientUserModal clientId={clientId} onClose={() => setShowCreate(false)} />
      )}
      {resetTarget && (
        <ResetPasswordModal
          id={resetTarget}
          onClose={() => setResetTarget(null)}
        />
      )}
    </div>
  );
}

function BackLink({ id }: { id: string }) {
  return (
    <Link
      href={`/clients/${id}`}
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
    >
      <ArrowLeft className="h-4 w-4" />К карточке клиента
    </Link>
  );
}

function IconBtn({
  title,
  onClick,
  disabled,
  children,
}: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="text-muted-foreground hover:text-foreground hover:bg-muted grid h-7 w-7 place-items-center rounded transition disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function CreateClientUserModal({
  clientId,
  onClose,
}: {
  clientId: string;
  onClose: () => void;
}) {
  const utils = trpc.useUtils();
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [position, setPosition] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  const create = trpc.adminClientUsers.create.useMutation({
    onSuccess: async () => {
      await utils.adminClientUsers.list.invalidate();
      onClose();
    },
    onError: (e) => setError(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError('Пароль не короче 8 символов');
      return;
    }
    create.mutate({ clientId, email: email.trim(), fullName, position, phone, password });
  }

  return (
    <Modal title="Новая учётка клиента" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-3">
        <Field label="Email">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className={inputCls}
            required
          />
        </Field>
        <Field label="ФИО">
          <input
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className={inputCls}
            required
          />
        </Field>
        <Field label="Должность">
          <input
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Телефон">
          <input
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className={inputCls}
          />
        </Field>
        <Field label="Стартовый пароль" hint="Сообщите клиенту лично; смена доступна в кабинете">
          <input
            type="text"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className={inputCls}
            required
          />
        </Field>
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/20 px-3 py-2 text-sm">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-9 items-center rounded-md px-3 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={create.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium disabled:opacity-50"
          >
            {create.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Создать
          </button>
        </div>
      </form>
    </Modal>
  );
}

function ResetPasswordModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [pwd, setPwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = trpc.adminClientUsers.resetPassword.useMutation({
    onSuccess: onClose,
    onError: (e) => setError(e.message),
  });

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (pwd.length < 8) {
      setError('Пароль не короче 8 символов');
      return;
    }
    reset.mutate({ id, newPassword: pwd });
  }

  return (
    <Modal title="Сбросить пароль" onClose={onClose}>
      <form onSubmit={onSubmit} className="space-y-3">
        <p className="text-muted-foreground text-sm">
          Сообщите клиенту новый пароль лично или защищённым каналом.
        </p>
        <Field label="Новый пароль">
          <input
            type="text"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            className={inputCls}
            required
          />
        </Field>
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/20 px-3 py-2 text-sm">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-9 items-center rounded-md px-3 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={reset.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-9 items-center gap-2 rounded-md px-3 text-sm font-medium disabled:opacity-50"
          >
            {reset.isPending && <Loader2 className="h-4 w-4 animate-spin" />}Сбросить
          </button>
        </div>
      </form>
    </Modal>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-card w-full max-w-md rounded-lg border p-5 shadow-lg">
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground rounded p-1"
            aria-label="Закрыть"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
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

const inputCls =
  'border-input bg-background flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';
