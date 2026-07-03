/**
 * /settings/users — управление пользователями одной компании.
 * Доступно только директору. Создание/редактирование/блокировка/сброс пароля.
 *
 * Логин (username) иммутабелен — это правило 1С-стиля. Если нужно поменять имя
 * пользователя, заводим нового и блокируем старого.
 */
import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import {
  KeyRound,
  Loader2,
  Lock,
  Pencil,
  Plus,
  Unlock,
  UserCircle2,
  X,
} from 'lucide-react';
import { STAFF_POSITIONS, type StaffPosition } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ConfirmDialog } from '../components/ui';
import { EngineerProfileSection } from '../components/EngineerProfileSection';

type Role = 'director' | 'dispatcher' | 'engineer';
const ROLE_LABEL: Record<Role, string> = {
  director: 'Директор',
  dispatcher: 'Диспетчер',
  engineer: 'Инженер',
};

interface UserRow {
  id: string;
  username: string;
  fullName: string;
  position: string | null;
  email: string | null;
  phone: string | null;
  role: Role;
  isActive: boolean;
  lastLoginAt: Date | null;
}

export function UsersPage() {
  const me = trpc.auth.me.useQuery();
  const [includeBlocked, setIncludeBlocked] = useState(false);
  const usersQ = trpc.users.list.useQuery({ includeBlocked });

  const [createOpen, setCreateOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserRow | null>(null);
  const [pwdUser, setPwdUser] = useState<UserRow | null>(null);

  if (me.data?.user.role !== 'director') {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="bg-destructive/10 text-destructive rounded-lg border border-destructive/30 p-4 text-sm">
          Раздел доступен только директору.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <div>
        <Link href="/settings" className="text-primary text-sm hover:underline">
          ← Настройки
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold md:text-2xl">Пользователи</h1>
            <p className="text-muted-foreground text-sm">
              Сотрудники компании, имеющие доступ в систему. Логин неизменяем — для
              переименования заведите нового и заблокируйте старого.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <label className="text-muted-foreground inline-flex cursor-pointer items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={includeBlocked}
                onChange={(e) => setIncludeBlocked(e.target.checked)}
                className="rounded border-input"
              />
              Показывать заблокированных
            </label>
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition"
            >
              <Plus className="h-4 w-4" />
              Создать
            </button>
          </div>
        </div>
      </div>

      <div className="bg-card overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase">
            <tr>
              <th className="p-3 text-left font-medium">ФИО / должность</th>
              <th className="p-3 text-left font-medium">Логин</th>
              <th className="p-3 text-left font-medium">Роль</th>
              <th className="p-3 text-left font-medium">Контакты</th>
              <th className="p-3 text-left font-medium">Последний вход</th>
              <th className="p-3 text-right font-medium">Действия</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {usersQ.isLoading && (
              <tr>
                <td colSpan={6} className="text-muted-foreground p-6 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            )}
            {usersQ.data?.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted-foreground p-6 text-center">
                  Пользователи не найдены
                </td>
              </tr>
            )}
            {usersQ.data?.map((u) => (
              <tr key={u.id} className={cn('hover:bg-muted/30', !u.isActive && 'opacity-60')}>
                <td className="p-3">
                  <div className="font-medium">{u.fullName}</div>
                  {u.position && (
                    <div className="text-muted-foreground text-xs">{u.position}</div>
                  )}
                </td>
                <td className="p-3 font-mono text-xs">
                  <div>{u.username}</div>
                  {!u.isActive && (
                    <span className="bg-destructive/10 text-destructive mt-1 inline-block rounded px-1.5 py-0.5 text-[10px] font-medium">
                      Заблокирован
                    </span>
                  )}
                </td>
                <td className="p-3">
                  <span
                    className={cn(
                      'rounded px-2 py-0.5 text-xs font-medium',
                      u.role === 'director' && 'bg-primary/10 text-primary',
                      u.role === 'dispatcher' && 'bg-accent/40',
                      u.role === 'engineer' && 'bg-secondary',
                    )}
                  >
                    {ROLE_LABEL[u.role]}
                  </span>
                </td>
                <td className="text-muted-foreground p-3 text-xs">
                  {u.email && <div>{u.email}</div>}
                  {u.phone && <div>{u.phone}</div>}
                </td>
                <td className="text-muted-foreground p-3 text-xs">
                  {u.lastLoginAt
                    ? new Date(u.lastLoginAt).toLocaleString('ru-RU', {
                        dateStyle: 'short',
                        timeStyle: 'short',
                      })
                    : '—'}
                </td>
                <td className="p-3 text-right">
                  <div className="inline-flex gap-1">
                    <IconButton
                      title="Редактировать"
                      onClick={() => setEditingUser(u)}
                    >
                      <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton
                      title="Сбросить пароль"
                      onClick={() => setPwdUser(u)}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                    </IconButton>
                    <BlockToggle user={u} disabled={u.id === me.data?.user.id} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateUserModal
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            void usersQ.refetch();
          }}
        />
      )}
      {editingUser && (
        <EditUserModal
          user={editingUser}
          onClose={() => setEditingUser(null)}
          onSaved={() => {
            setEditingUser(null);
            void usersQ.refetch();
          }}
        />
      )}
      {pwdUser && (
        <ResetPasswordModal
          user={pwdUser}
          onClose={() => setPwdUser(null)}
          onSaved={() => setPwdUser(null)}
        />
      )}
    </div>
  );
}

/* ========================== Дочерние компоненты ========================== */

function IconButton({
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
      disabled={disabled}
      onClick={onClick}
      className="bg-secondary hover:bg-muted rounded-md p-1.5 transition disabled:opacity-40"
    >
      {children}
    </button>
  );
}

function BlockToggle({ user, disabled }: { user: UserRow; disabled?: boolean }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const m = trpc.users.setActive.useMutation({
    onSuccess: () => {
      setOpen(false);
      return utils.users.list.invalidate();
    },
    onError: (e) => {
      setOpen(false);
      setError(e.message);
    },
  });
  const isBlocking = user.isActive;
  return (
    <>
      <button
        type="button"
        title={isBlocking ? 'Заблокировать' : 'Разблокировать'}
        disabled={disabled || m.isPending}
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        className={cn(
          'rounded-md p-1.5 transition disabled:opacity-40',
          isBlocking
            ? 'bg-secondary hover:bg-destructive/10 hover:text-destructive'
            : 'bg-success/10 text-success hover:bg-success/20',
        )}
      >
        {m.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : isBlocking ? (
          <Lock className="h-3.5 w-3.5" />
        ) : (
          <Unlock className="h-3.5 w-3.5" />
        )}
      </button>
      {error && (
        <div role="alert" className="text-destructive mt-1 text-[11px]">
          {error}
        </div>
      )}
      <ConfirmDialog
        open={open}
        title={isBlocking ? 'Заблокировать сотрудника?' : 'Разблокировать сотрудника?'}
        description={
          isBlocking
            ? `${user.fullName}: вход будет закрыт, активные сессии отозваны.`
            : `${user.fullName} снова сможет входить в систему.`
        }
        variant={isBlocking ? 'danger' : 'default'}
        confirmText={isBlocking ? 'Заблокировать' : 'Разблокировать'}
        loading={m.isPending}
        onConfirm={() => m.mutate({ userId: user.id, isActive: !user.isActive })}
        onCancel={() => setOpen(false)}
      />
    </>
  );
}

/* ========================== Модалы ========================== */

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
      <div className="bg-card max-h-[90vh] w-full max-w-md overflow-auto rounded-lg border shadow-lg">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
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
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-xs font-medium">
        {label}
        {required && <span className="text-destructive ml-0.5">*</span>}
      </div>
      <div className="mt-1">{children}</div>
      {hint && <div className="text-muted-foreground mt-1 text-[11px]">{hint}</div>}
    </label>
  );
}

function CreateUserModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [position, setPosition] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [role, setRole] = useState<Role>('dispatcher');
  const [error, setError] = useState<string | null>(null);

  const m = trpc.users.create.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    m.mutate({
      username,
      password,
      fullName,
      position: position ? (position as StaffPosition) : null,
      email: email || null,
      phone: phone || null,
      role,
    });
  };

  return (
    <ModalShell title="Новый пользователь" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 p-4">
        <div className="grid grid-cols-2 gap-3">
          <Field label="Логин" required hint="Латиница/цифры/.-_, мин. 3">
            <input
              autoFocus
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="bg-background w-full rounded-md border px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-primary/40"
            />
          </Field>
          <Field label="Пароль" required hint="Минимум 8 символов">
            <input
              type="text"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="bg-background w-full rounded-md border px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-primary/40"
            />
          </Field>
        </div>
        <Field label="ФИО" required>
          <input
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </Field>
        <Field label="Должность" hint="Выбирается из списка">
          <select
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="">— не указана —</option>
            {STAFF_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </Field>
          <Field label="Телефон">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </Field>
        </div>
        <Field label="Роль" required>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="director">Директор</option>
            <option value="dispatcher">Диспетчер</option>
            <option value="engineer">Инженер</option>
          </select>
        </Field>
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/30 p-2 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm font-medium"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={m.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-60"
          >
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Создать
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function EditUserModal({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [fullName, setFullName] = useState(user.fullName);
  const [position, setPosition] = useState(user.position ?? '');
  const [email, setEmail] = useState(user.email ?? '');
  const [phone, setPhone] = useState(user.phone ?? '');
  const [role, setRole] = useState<Role>(user.role);
  const [error, setError] = useState<string | null>(null);

  const m = trpc.users.update.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const isKnownPosition = (STAFF_POSITIONS as readonly string[]).includes(position);
    m.mutate({
      userId: user.id,
      fullName,
      // '' → очистить (null); должность из списка → сохранить;
      // прежнее значение вне списка → не трогаем (undefined), чтобы не потерять.
      position:
        position === ''
          ? null
          : isKnownPosition
            ? (position as StaffPosition)
            : undefined,
      email: email || null,
      phone: phone || null,
      role,
    });
  };

  return (
    <ModalShell title={`Редактирование · ${user.username}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 p-4">
        <div className="bg-muted/40 text-muted-foreground rounded-md p-2 text-xs">
          <div>
            <UserCircle2 className="mr-1 inline h-3.5 w-3.5" />
            <span className="font-mono">{user.username}</span>
          </div>
          <div className="mt-1">
            Логин неизменяем. Чтобы сменить пароль — кнопка «Сбросить пароль».
          </div>
        </div>
        <Field label="ФИО" required>
          <input
            autoFocus
            type="text"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </Field>
        <Field label="Должность" hint="Выбирается из списка">
          <select
            value={position}
            onChange={(e) => setPosition(e.target.value)}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="">— не указана —</option>
            {position && !(STAFF_POSITIONS as readonly string[]).includes(position) && (
              <option value={position}>{position} (прежнее значение)</option>
            )}
            {STAFF_POSITIONS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Email">
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </Field>
          <Field label="Телефон">
            <input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </Field>
        </div>
        <Field label="Роль" required>
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          >
            <option value="director">Директор</option>
            <option value="dispatcher">Диспетчер</option>
            <option value="engineer">Инженер</option>
          </select>
        </Field>
        {user.role === 'engineer' && <EngineerProfileSection userId={user.id} />}
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/30 p-2 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm font-medium"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={m.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-60"
          >
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Сохранить
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function ResetPasswordModal({
  user,
  onClose,
  onSaved,
}: {
  user: UserRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [pwd, setPwd] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = trpc.users.resetPassword.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  return (
    <ModalShell title={`Сброс пароля · ${user.username}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setError(null);
          m.mutate({ userId: user.id, newPassword: pwd });
        }}
        className="space-y-3 p-4"
      >
        <div className="bg-muted/40 text-muted-foreground rounded-md p-2 text-xs">
          После смены пароля все активные сессии пользователя будут завершены.
        </div>
        <Field label="Новый пароль" required hint="Минимум 8 символов">
          <input
            autoFocus
            type="text"
            value={pwd}
            onChange={(e) => setPwd(e.target.value)}
            required
            minLength={8}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm font-mono outline-none focus:ring-2 focus:ring-primary/40"
          />
        </Field>
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/30 p-2 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm font-medium"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={m.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition disabled:opacity-60"
          >
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Сменить пароль
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
