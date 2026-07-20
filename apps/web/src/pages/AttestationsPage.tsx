/**
 * /settings/attestations — Stage 10'.I, аттестация инженеров.
 *
 * Доступно директору (управление) + диспетчеру (read-only).
 * Инженер сюда не заходит — список ниже.
 *
 * Бизнес: при назначении инженера на заявку с asset.required_attestation_category
 * проверяется наличие действующей аттестации по этой категории. Без аттестации
 * назначение разрешено, но возвращается warning (см. tickets/service.ts).
 */
import { useState } from 'react';
import { Link } from 'wouter';
import {
  Award,
  ChevronLeft,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ConfirmDialog } from '../components/ui';

type Status = 'active' | 'expiring_soon' | 'expired';

interface AttestationRow {
  id: string;
  engineerId: string;
  engineerFullName: string | null;
  category: string;
  issuedBy: string | null;
  certificateNumber: string | null;
  issuedAt: string;
  validUntil: string | null;
  notes: string | null;
  status: Status;
}

const STATUS_META: Record<Status, { label: string; cls: string }> = {
  active: { label: 'Действует', cls: 'bg-success/10 text-success' },
  expiring_soon: { label: 'Истекает', cls: 'bg-warning/15 text-warning' },
  expired: { label: 'Просрочена', cls: 'bg-destructive/10 text-destructive' },
};

export function AttestationsPage() {
  const me = trpc.auth.me.useQuery();
  const role = me.data?.user.role;
  const isDirector = role === 'director';
  const isStaff = role === 'director' || role === 'dispatcher';

  const [editing, setEditing] = useState<AttestationRow | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const listQ = trpc.attestations.list.useQuery({ includeExpired: true });

  if (!isStaff) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <div className="bg-destructive/10 text-destructive rounded-lg border border-destructive/30 p-4 text-sm">
          Раздел доступен только директору и диспетчеру.
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4 md:p-6">
      <div>
        <Link
          href="/settings"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" />К настройкам
        </Link>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="inline-flex items-center gap-2 text-xl font-semibold md:text-2xl">
              <Award className="text-primary h-5 w-5" />
              Аттестация инженеров
            </h1>
            <p className="text-muted-foreground text-sm">
              Допуски инженеров к работе с категориями медтехники. Когда у техники
              задана требуемая категория, диспетчер увидит предупреждение при
              назначении инженера без действующей аттестации.
            </p>
          </div>
          {isDirector && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition"
            >
              <Plus className="h-4 w-4" />
              Добавить аттестацию
            </button>
          )}
        </div>
      </div>

      <div className="bg-card overflow-hidden rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-xs uppercase">
            <tr>
              <th className="p-3 text-left font-medium">Инженер</th>
              <th className="p-3 text-left font-medium">Категория</th>
              <th className="p-3 text-left font-medium">Выдан / №</th>
              <th className="p-3 text-left font-medium">Действует до</th>
              <th className="p-3 text-left font-medium">Статус</th>
              {isDirector && <th className="p-3 text-right font-medium">Действия</th>}
            </tr>
          </thead>
          <tbody className="divide-y">
            {listQ.isLoading && (
              <tr>
                <td colSpan={isDirector ? 6 : 5} className="text-muted-foreground p-6 text-center">
                  <Loader2 className="mx-auto h-4 w-4 animate-spin" />
                </td>
              </tr>
            )}
            {/* Без этой ветки сбой загрузки выглядел как пустая таблица, и
                директор читал её как «допусков не заведено». */}
            {listQ.error && (
              <tr>
                <td colSpan={isDirector ? 6 : 5} className="p-6">
                  <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
                    Не удалось загрузить аттестации: {listQ.error.message}
                  </div>
                </td>
              </tr>
            )}
            {!listQ.error && listQ.data?.length === 0 && (
              <tr>
                <td colSpan={isDirector ? 6 : 5} className="text-muted-foreground p-6 text-center">
                  Аттестации не заведены
                </td>
              </tr>
            )}
            {listQ.data?.map((a) => {
              const meta = STATUS_META[a.status];
              return (
                <tr key={a.id} className={cn('hover:bg-muted/30', a.status === 'expired' && 'opacity-70')}>
                  <td className="p-3 font-medium">
                    {a.engineerFullName ?? '—'}
                  </td>
                  <td className="p-3">{a.category}</td>
                  <td className="text-muted-foreground p-3 text-xs">
                    {a.issuedBy && <div>{a.issuedBy}</div>}
                    {a.certificateNumber && (
                      <div className="font-mono">№ {a.certificateNumber}</div>
                    )}
                    <div>выдан {a.issuedAt}</div>
                  </td>
                  <td className="p-3 text-xs">
                    {a.validUntil ?? <span className="text-muted-foreground">бессрочно</span>}
                  </td>
                  <td className="p-3">
                    <span className={cn('rounded px-2 py-0.5 text-xs font-medium', meta.cls)}>
                      {meta.label}
                    </span>
                  </td>
                  {isDirector && (
                    <td className="p-3 text-right">
                      <div className="inline-flex gap-1">
                        <button
                          type="button"
                          title="Редактировать"
                          onClick={() => setEditing(a)}
                          className="bg-secondary hover:bg-muted rounded-md p-1.5"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <DeleteButton id={a.id} />
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateAttestationModal
          onClose={() => setCreateOpen(false)}
          onSaved={() => {
            setCreateOpen(false);
            void listQ.refetch();
          }}
        />
      )}
      {editing && (
        <EditAttestationModal
          row={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void listQ.refetch();
          }}
        />
      )}
    </div>
  );
}

function DeleteButton({ id }: { id: string }) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const m = trpc.attestations.remove.useMutation({
    onSuccess: () => {
      setOpen(false);
      return utils.attestations.list.invalidate();
    },
  });
  return (
    <>
      <button
        type="button"
        title="Удалить"
        aria-label="Удалить аттестацию"
        disabled={m.isPending}
        onClick={() => setOpen(true)}
        className="bg-secondary hover:bg-destructive/10 hover:text-destructive rounded-md p-1.5 disabled:opacity-40"
      >
        {m.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
      </button>
      <ConfirmDialog
        open={open}
        title="Удалить аттестацию?"
        description="Запись останется в базе для аудита."
        variant="danger"
        confirmText="Удалить"
        loading={m.isPending}
        onConfirm={() => m.mutate({ id })}
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
  return (
    <div className="bg-background/80 fixed inset-0 z-50 flex items-center justify-center p-4 backdrop-blur-sm">
      <div className="bg-card max-h-[90vh] w-full max-w-lg overflow-auto rounded-lg border shadow-lg">
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

function FormFields({
  engineerId,
  setEngineerId,
  category,
  setCategory,
  issuedBy,
  setIssuedBy,
  certNo,
  setCertNo,
  issuedAt,
  setIssuedAt,
  validUntil,
  setValidUntil,
  notes,
  setNotes,
  isEdit,
}: {
  engineerId: string;
  setEngineerId: (v: string) => void;
  category: string;
  setCategory: (v: string) => void;
  issuedBy: string;
  setIssuedBy: (v: string) => void;
  certNo: string;
  setCertNo: (v: string) => void;
  issuedAt: string;
  setIssuedAt: (v: string) => void;
  validUntil: string;
  setValidUntil: (v: string) => void;
  notes: string;
  setNotes: (v: string) => void;
  isEdit: boolean;
}) {
  const engineersQ = trpc.users.list.useQuery({ onlyEngineers: true });
  const cats = trpc.attestations.categories.useQuery();
  return (
    <div className="space-y-3">
      <div>
        <Label required>Инженер</Label>
        <select
          value={engineerId}
          onChange={(e) => setEngineerId(e.target.value)}
          required
          disabled={isEdit}
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
        >
          <option value="">— выберите —</option>
          {engineersQ.data?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.fullName} ({e.username})
            </option>
          ))}
        </select>
        {isEdit && (
          <p className="text-muted-foreground mt-1 text-[11px]">
            Сменить инженера у аттестации нельзя — удалите и создайте новую.
          </p>
        )}
      </div>
      <div>
        <Label required>Категория</Label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          required
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        >
          <option value="">— выберите —</option>
          {cats.data?.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label required>Выдан</Label>
          <input
            type="date"
            value={issuedAt}
            onChange={(e) => setIssuedAt(e.target.value)}
            required
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
        <div>
          <Label hint="пусто = бессрочно">Действует до</Label>
          <input
            type="date"
            value={validUntil}
            onChange={(e) => setValidUntil(e.target.value)}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>
      </div>
      <div>
        <Label>Кем выдан</Label>
        <input
          type="text"
          value={issuedBy}
          onChange={(e) => setIssuedBy(e.target.value)}
          placeholder="Учебный центр / производитель"
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
      <div>
        <Label>№ удостоверения</Label>
        <input
          type="text"
          value={certNo}
          onChange={(e) => setCertNo(e.target.value)}
          className="bg-background w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
      <div>
        <Label>Заметки</Label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </div>
    </div>
  );
}

function Label({
  children,
  hint,
  required,
}: {
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="text-xs font-medium">
      {children}
      {required && <span className="text-destructive ml-0.5">*</span>}
      {hint && <span className="text-muted-foreground ml-1 font-normal">({hint})</span>}
    </div>
  );
}

function CreateAttestationModal({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [engineerId, setEngineerId] = useState('');
  const [category, setCategory] = useState('');
  const [issuedBy, setIssuedBy] = useState('');
  const [certNo, setCertNo] = useState('');
  const [issuedAt, setIssuedAt] = useState(today);
  const [validUntil, setValidUntil] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  const m = trpc.attestations.create.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!engineerId || !category) {
      setError('Выберите инженера и категорию');
      return;
    }
    m.mutate({
      engineerId,
      category,
      issuedBy: issuedBy || null,
      certificateNumber: certNo || null,
      issuedAt,
      validUntil: validUntil || null,
      notes: notes || null,
    });
  };

  return (
    <ModalShell title="Новая аттестация" onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 p-4">
        <FormFields
          engineerId={engineerId}
          setEngineerId={setEngineerId}
          category={category}
          setCategory={setCategory}
          issuedBy={issuedBy}
          setIssuedBy={setIssuedBy}
          certNo={certNo}
          setCertNo={setCertNo}
          issuedAt={issuedAt}
          setIssuedAt={setIssuedAt}
          validUntil={validUntil}
          setValidUntil={setValidUntil}
          notes={notes}
          setNotes={setNotes}
          isEdit={false}
        />
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/30 p-2 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={m.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium"
          >
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Создать
          </button>
        </div>
      </form>
    </ModalShell>
  );
}

function EditAttestationModal({
  row,
  onClose,
  onSaved,
}: {
  row: AttestationRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [category, setCategory] = useState(row.category);
  const [issuedBy, setIssuedBy] = useState(row.issuedBy ?? '');
  const [certNo, setCertNo] = useState(row.certificateNumber ?? '');
  const [issuedAt, setIssuedAt] = useState(row.issuedAt);
  const [validUntil, setValidUntil] = useState(row.validUntil ?? '');
  const [notes, setNotes] = useState(row.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const m = trpc.attestations.update.useMutation({
    onSuccess: () => onSaved(),
    onError: (e) => setError(e.message),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    m.mutate({
      id: row.id,
      patch: {
        category,
        issuedBy: issuedBy || null,
        certificateNumber: certNo || null,
        issuedAt,
        validUntil: validUntil || null,
        notes: notes || null,
      },
    });
  };

  return (
    <ModalShell title={`Редактирование · ${row.engineerFullName ?? ''}`} onClose={onClose}>
      <form onSubmit={submit} className="space-y-3 p-4">
        <FormFields
          engineerId={row.engineerId}
          setEngineerId={() => undefined}
          category={category}
          setCategory={setCategory}
          issuedBy={issuedBy}
          setIssuedBy={setIssuedBy}
          certNo={certNo}
          setCertNo={setCertNo}
          issuedAt={issuedAt}
          setIssuedAt={setIssuedAt}
          validUntil={validUntil}
          setValidUntil={setValidUntil}
          notes={notes}
          setNotes={setNotes}
          isEdit
        />
        {error && (
          <div className="bg-destructive/10 text-destructive rounded-md border border-destructive/30 p-2 text-xs">
            {error}
          </div>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onClose}
            className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={m.isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-60 inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium"
          >
            {m.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Сохранить
          </button>
        </div>
      </form>
    </ModalShell>
  );
}
