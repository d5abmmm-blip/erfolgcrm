/**
 * Карточка сотрудника, вкладка «Кадры»: аттестации, техника, отсутствия, табель.
 *
 * Сделана как ФОРМА ВЕДЕНИЯ, а не витрина. Причина простая: на бою во всех трёх
 * модулях по нулю записей — не потому, что негде хранить, а потому что формы были
 * спрятаны в настройках и в модалке правки пользователя, куда никто не заходит.
 * Показывать здесь прочерки и отправлять человека «в настройки» значило бы оставить
 * вкладку пустой навсегда.
 *
 * Отпуск живёт в двух местах и связывать их автоматически НЕЛЬЗЯ (решение владельца
 * 2026-08-14): «Отсутствия» — это план, влияющий на подсказку «кому отдать заявку», а
 * табель — факт, который печатают и подписывают. Поэтому здесь есть галочка «отметить
 * и в табеле» и отдельная подсветка расхождения, но нет молчаливой синхронизации.
 */
import { useMemo, useState } from 'react';
import { Link } from 'wouter';
import {
  Award,
  CalendarOff,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  Wrench,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ConfirmDialog } from './ui';
import { QueryError } from './QueryError';
import { COMMON_DEVICE_TYPES } from '../lib/device-types';
import { AWAY_LABELS, formatAwayRange, pluralRu } from '../lib/staff';
import { formatWorkedTime, monthTitle, summarize, type AttendanceRecord } from '../lib/attendance';
import {
  alreadyMarkedPhrase,
  attendanceBreakdown,
  awayKindToAttendanceStatus,
  daysWord,
  formatDateRu,
  markedDaysPhrase,
  sortAttestations,
  todayIso,
  unmarkedAwayDays,
  validityPhrase,
  validityTone,
  VALIDITY_TONE_LABELS,
  type AwayInterval,
  type AwayKind,
  type ValidityTone,
} from '../lib/staff-hr';

const TONE_CLASS: Record<ValidityTone, string> = {
  ok: 'bg-success/10 text-success',
  soon: 'bg-warning/15 text-warning',
  expired: 'bg-destructive/10 text-destructive',
};

const INPUT_CLASS =
  'bg-background focus:ring-primary/40 w-full rounded-md border px-2.5 py-1.5 text-sm outline-none focus:ring-2';

export function StaffHrTab({
  userId,
  role,
  isDirector,
}: {
  userId: string;
  role: 'director' | 'dispatcher' | 'engineer';
  isDirector: boolean;
}) {
  const today = todayIso();
  const availQ = trpc.engineerProfile.listAvailability.useQuery({ userId });
  const away: AwayInterval[] = (availQ.data ?? []).map((a) => ({
    kind: a.kind,
    dateFrom: a.dateFrom,
    dateTo: a.dateTo,
  }));

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="space-y-4 lg:col-span-2">
        {role === 'engineer' ? (
          <AttestationsBlock userId={userId} isDirector={isDirector} today={today} />
        ) : (
          <section className="bg-card text-muted-foreground rounded-lg border p-4 text-sm">
            Аттестации и типы техники ведут инженерам — у этой роли их нет. Отпуска и табель ниже
            работают для всех.
          </section>
        )}
        <TimesheetBlock userId={userId} away={away} />
      </div>

      <div className="space-y-4">
        {role === 'engineer' && <SkillsBlock userId={userId} isDirector={isDirector} />}
        <AwayBlock userId={userId} today={today} rows={availQ.data ?? []} error={availQ.error} />
      </div>
    </div>
  );
}

/* ========================== Аттестации ========================== */

interface AttestationForm {
  id: string | null;
  category: string;
  issuedAt: string;
  validUntil: string;
  issuedBy: string;
  certificateNumber: string;
  notes: string;
}

function emptyForm(today: string): AttestationForm {
  return {
    id: null,
    category: '',
    issuedAt: today,
    validUntil: '',
    issuedBy: '',
    certificateNumber: '',
    notes: '',
  };
}

function AttestationsBlock({
  userId,
  isDirector,
  today,
}: {
  userId: string;
  isDirector: boolean;
  today: string;
}) {
  const utils = trpc.useUtils();
  const listQ = trpc.attestations.list.useQuery({ engineerId: userId, includeExpired: true });
  const categoriesQ = trpc.attestations.categories.useQuery();
  const [form, setForm] = useState<AttestationForm | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toRemove, setToRemove] = useState<string | null>(null);

  const refresh = () => {
    void utils.attestations.list.invalidate();
    void utils.attestations.getEngineerCategories.invalidate();
  };

  const create = trpc.attestations.create.useMutation({
    onSuccess: () => {
      setForm(null);
      refresh();
    },
    onError: (e) => setError(e.message),
  });
  const update = trpc.attestations.update.useMutation({
    onSuccess: () => {
      setForm(null);
      refresh();
    },
    onError: (e) => setError(e.message),
  });
  const remove = trpc.attestations.remove.useMutation({
    onSuccess: () => {
      setToRemove(null);
      refresh();
    },
    onError: (e) => setError(e.message),
  });

  const rows = useMemo(() => sortAttestations(listQ.data ?? [], today), [listQ.data, today]);
  const saving = create.isPending || update.isPending;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setError(null);
    if (!form.category) {
      setError('Выберите категорию');
      return;
    }
    const payload = {
      category: form.category,
      issuedAt: form.issuedAt,
      validUntil: form.validUntil || null,
      issuedBy: form.issuedBy || null,
      certificateNumber: form.certificateNumber || null,
      notes: form.notes || null,
    };
    if (form.id) update.mutate({ id: form.id, patch: payload });
    else create.mutate({ engineerId: userId, ...payload });
  };

  return (
    <section className="bg-card rounded-lg border">
      <header className="flex items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
          <Award className="text-muted-foreground h-3.5 w-3.5" />
          Аттестации и допуски
        </h2>
        {form === null && (
          <button
            type="button"
            onClick={() => {
              setError(null);
              setForm(emptyForm(today));
            }}
            className="bg-secondary hover:bg-muted inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs font-medium"
          >
            <Plus className="h-3 w-3" />
            Добавить
          </button>
        )}
      </header>

      {listQ.error && (
        <div className="p-4">
          <QueryError error={listQ.error} onRetry={() => void listQ.refetch()} />
        </div>
      )}

      {form && (
        <form onSubmit={submit} className="bg-muted/30 space-y-3 border-b p-4">
          <div>
            <FieldLabel required>Категория техники</FieldLabel>
            <select
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
              className={INPUT_CLASS}
            >
              <option value="">— выберите —</option>
              {categoriesQ.data?.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <FieldLabel required>Выдана</FieldLabel>
              <input
                type="date"
                value={form.issuedAt}
                onChange={(e) => setForm({ ...form, issuedAt: e.target.value })}
                required
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <FieldLabel hint="пусто = бессрочно">Действует до</FieldLabel>
              <input
                type="date"
                value={form.validUntil}
                onChange={(e) => setForm({ ...form, validUntil: e.target.value })}
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <FieldLabel>Кем выдана</FieldLabel>
              <input
                type="text"
                value={form.issuedBy}
                onChange={(e) => setForm({ ...form, issuedBy: e.target.value })}
                placeholder="Учебный центр / производитель"
                className={INPUT_CLASS}
              />
            </div>
            <div>
              <FieldLabel>№ удостоверения</FieldLabel>
              <input
                type="text"
                value={form.certificateNumber}
                onChange={(e) => setForm({ ...form, certificateNumber: e.target.value })}
                className={cn(INPUT_CLASS, 'font-mono')}
              />
            </div>
          </div>
          {error && (
            <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2 text-xs">
              {error}
            </div>
          )}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setForm(null);
                setError(null);
              }}
              className="bg-secondary hover:bg-muted rounded-md px-3 py-1.5 text-xs"
            >
              Отмена
            </button>
            <button
              type="submit"
              disabled={saving}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-60"
            >
              {saving && <Loader2 className="h-3 w-3 animate-spin" />}
              {form.id ? 'Сохранить' : 'Добавить'}
            </button>
          </div>
        </form>
      )}

      {listQ.isLoading ? (
        <div className="text-muted-foreground p-4 text-sm">Загрузка…</div>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground p-4 text-sm">
          Ни одной аттестации не заведено. Пока их нет, проверка при назначении на технику с
          требуемым допуском молчит: программе нечего сравнивать.
        </p>
      ) : (
        <ul className="divide-y">
          {rows.map((a) => {
            const tone = validityTone(a.validUntil, today);
            return (
              <li key={a.id} className="flex items-start gap-3 px-4 py-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{a.category}</span>
                    <span
                      className={cn(
                        'rounded px-1.5 py-0.5 text-[11px] font-medium',
                        TONE_CLASS[tone],
                      )}
                    >
                      {VALIDITY_TONE_LABELS[tone]}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-0.5 text-xs">
                    {validityPhrase(a.validUntil, today)} · выдана {formatDateRu(a.issuedAt)}
                    {a.certificateNumber && ` · № ${a.certificateNumber}`}
                    {a.issuedBy && ` · ${a.issuedBy}`}
                  </div>
                </div>
                <div className="flex shrink-0 gap-1">
                  <button
                    type="button"
                    title="Изменить"
                    aria-label="Изменить аттестацию"
                    onClick={() => {
                      setError(null);
                      setForm({
                        id: a.id,
                        category: a.category,
                        issuedAt: a.issuedAt,
                        validUntil: a.validUntil ?? '',
                        issuedBy: a.issuedBy ?? '',
                        certificateNumber: a.certificateNumber ?? '',
                        notes: a.notes ?? '',
                      });
                    }}
                    className="bg-secondary hover:bg-muted rounded-md p-1.5"
                  >
                    <Pencil className="h-3 w-3" />
                  </button>
                  {isDirector && (
                    <button
                      type="button"
                      title="Удалить"
                      aria-label="Удалить аттестацию"
                      onClick={() => setToRemove(a.id)}
                      className="bg-secondary hover:bg-destructive/10 hover:text-destructive rounded-md p-1.5"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {!isDirector && rows.length > 0 && (
        <p className="text-muted-foreground border-t px-4 py-2 text-[11px]">
          Удалить аттестацию может только директор. Ошибочную запись поправьте через «Изменить».
        </p>
      )}

      <ConfirmDialog
        open={toRemove !== null}
        title="Удалить аттестацию?"
        description="Запись останется в базе для аудита, но из карточки и из проверки допусков исчезнет."
        variant="danger"
        confirmText="Удалить"
        loading={remove.isPending}
        onConfirm={() => toRemove && remove.mutate({ id: toRemove })}
        onCancel={() => setToRemove(null)}
      />
    </section>
  );
}

/* ========================== Техника (навыки) ========================== */

function SkillsBlock({ userId, isDirector }: { userId: string; isDirector: boolean }) {
  const utils = trpc.useUtils();
  const skillsQ = trpc.engineerProfile.listSkills.useQuery();
  const [custom, setCustom] = useState('');

  const mine = useMemo(
    () => (skillsQ.data ?? []).filter((s) => s.userId === userId).map((s) => s.deviceType),
    [skillsQ.data, userId],
  );

  const setSkills = trpc.engineerProfile.setSkills.useMutation({
    onSuccess: () => {
      void utils.engineerProfile.listSkills.invalidate();
      // Карточка и список сотрудников показывают эту же технику — иначе на вкладке
      // «Сейчас» останется старый набор до перезагрузки страницы.
      void utils.staff.get.invalidate();
      void utils.staff.list.invalidate();
    },
  });

  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...COMMON_DEVICE_TYPES, ...mine]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [mine]);

  return (
    <section className="bg-card rounded-lg border">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <Wrench className="text-muted-foreground h-3.5 w-3.5" />
        <h2 className="text-sm font-semibold">Обслуживает технику</h2>
        {setSkills.isPending && <Loader2 className="text-muted-foreground h-3 w-3 animate-spin" />}
      </header>
      <div className="p-4">
        {!isDirector ? (
          <>
            {mine.length > 0 ? (
              <div className="flex flex-wrap gap-1.5">
                {mine.map((t) => (
                  <span
                    key={t}
                    className="bg-secondary text-secondary-foreground rounded px-2 py-0.5 text-xs"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : (
              <p className="text-muted-foreground text-sm">Не заполнено.</p>
            )}
            <p className="text-muted-foreground mt-3 text-[11px]">
              Список типов техники правит директор.
            </p>
          </>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {options.map((t) => {
                const on = mine.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    disabled={setSkills.isPending}
                    onClick={() =>
                      setSkills.mutate({
                        userId,
                        deviceTypes: on ? mine.filter((s) => s !== t) : [...mine, t],
                      })
                    }
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-xs transition disabled:opacity-60',
                      on
                        ? 'bg-primary/10 text-primary border-primary/30'
                        : 'bg-background text-muted-foreground hover:bg-muted',
                    )}
                  >
                    {t}
                  </button>
                );
              })}
            </div>
            <div className="mt-2 flex gap-2">
              <input
                type="text"
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                placeholder="Свой тип техники"
                className={cn(INPUT_CLASS, 'text-xs')}
              />
              <button
                type="button"
                disabled={!custom.trim() || setSkills.isPending}
                onClick={() => {
                  const t = custom.trim();
                  if (t && !mine.some((s) => s.toLowerCase() === t.toLowerCase())) {
                    setSkills.mutate({ userId, deviceTypes: [...mine, t] });
                  }
                  setCustom('');
                }}
                className="bg-secondary hover:bg-muted shrink-0 rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
              >
                Добавить
              </button>
            </div>
            {mine.length === 0 && (
              <p className="text-muted-foreground mt-3 text-[11px]">
                Пока техника не указана, подсказка «кому отдать заявку» этого инженера не
                предлагает.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* ========================== Отсутствия (план) ========================== */

interface AwayRow {
  id: string;
  kind: AwayKind;
  dateFrom: string;
  dateTo: string;
  note: string | null;
}

function AwayBlock({
  userId,
  today,
  rows,
  error,
}: {
  userId: string;
  today: string;
  rows: AwayRow[];
  error: { message: string } | null;
}) {
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<AwayKind>('vacation');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [note, setNote] = useState('');
  const [alsoTimesheet, setAlsoTimesheet] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [filled, setFilled] = useState<{ created: number; skipped: number } | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = () => {
    void utils.engineerProfile.listAvailability.invalidate();
    void utils.engineerProfile.availabilityToday.invalidate();
    void utils.staff.get.invalidate();
    void utils.staff.list.invalidate();
  };

  const add = trpc.engineerProfile.setAvailability.useMutation();
  const del = trpc.engineerProfile.deleteAvailability.useMutation({ onSuccess: refresh });
  const fill = trpc.attendance.fillRange.useMutation();

  const timesheetStatus = awayKindToAttendanceStatus(kind);

  const submit = async () => {
    setFormError(null);
    setFilled(null);
    if (!from || !to) {
      setFormError('Укажите обе даты');
      return;
    }
    if (to < from) {
      setFormError('Дата окончания раньше даты начала');
      return;
    }
    setBusy(true);
    try {
      await add.mutateAsync({ userId, kind, dateFrom: from, dateTo: to, note: note || null });
      if (alsoTimesheet && timesheetStatus) {
        const res = await fill.mutateAsync({
          userId,
          dateFrom: from,
          dateTo: to,
          status: timesheetStatus,
        });
        setFilled(res);
        void utils.attendance.month.invalidate();
      }
      setFrom('');
      setTo('');
      setNote('');
      refresh();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusy(false);
    }
  };

  const sorted = [...rows].sort((a, b) => b.dateFrom.localeCompare(a.dateFrom));

  return (
    <section className="bg-card rounded-lg border">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <CalendarOff className="text-muted-foreground h-3.5 w-3.5" />
        <h2 className="text-sm font-semibold">Отпуска и отсутствия</h2>
      </header>

      <div className="space-y-3 p-4">
        {error && (
          <div className="text-destructive text-xs">Не удалось загрузить: {error.message}</div>
        )}

        {sorted.length === 0 ? (
          <p className="text-muted-foreground text-sm">Ничего не отмечено.</p>
        ) : (
          <ul className="space-y-1.5">
            {sorted.map((r) => {
              const past = r.dateTo < today;
              return (
                <li
                  key={r.id}
                  className={cn('flex items-center gap-2 text-sm', past && 'opacity-60')}
                >
                  <span className="bg-secondary shrink-0 rounded px-1.5 py-0.5 text-[11px]">
                    {AWAY_LABELS[r.kind]}
                  </span>
                  <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
                    {formatAwayRange(r.dateFrom, r.dateTo)}
                    {r.note ? ` · ${r.note}` : ''}
                  </span>
                  <button
                    type="button"
                    onClick={() => del.mutate({ id: r.id })}
                    aria-label="Удалить отсутствие"
                    className="text-muted-foreground hover:text-destructive shrink-0"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </li>
              );
            })}
          </ul>
        )}

        <div className="space-y-2 border-t pt-3">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as AwayKind)}
            className={cn(INPUT_CLASS, 'text-xs')}
          >
            <option value="vacation">Отпуск</option>
            <option value="day_off">Выходной</option>
            <option value="onsite">На выезде</option>
          </select>
          <div className="grid grid-cols-2 gap-2">
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              aria-label="Дата начала"
              className={cn(INPUT_CLASS, 'text-xs')}
            />
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              aria-label="Дата окончания"
              className={cn(INPUT_CLASS, 'text-xs')}
            />
          </div>
          <input
            type="text"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Заметка (необязательно)"
            className={cn(INPUT_CLASS, 'text-xs')}
          />

          {timesheetStatus ? (
            <label className="flex items-start gap-2 text-xs">
              <input
                type="checkbox"
                checked={alsoTimesheet}
                onChange={(e) => setAlsoTimesheet(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Отметить эти дни и в табеле
                <span className="text-muted-foreground block text-[11px]">
                  Дни, уже отмеченные в журнале, останутся как есть.
                </span>
              </span>
            </label>
          ) : (
            <p className="text-muted-foreground text-[11px]">
              «На выезде» в табель не переносится: в этот день человек работает, и явку в журнале
              ставят по факту.
            </p>
          )}

          <button
            type="button"
            disabled={busy}
            onClick={() => void submit()}
            className="bg-secondary hover:bg-muted inline-flex w-full items-center justify-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            Добавить
          </button>

          {formError && <div className="text-destructive text-[11px]">{formError}</div>}
          {filled && (
            <div className="text-muted-foreground text-[11px]">
              {filled.created === 0
                ? `Табель не изменился: ${alreadyMarkedPhrase(filled.skipped)} раньше.`
                : `В табеле ${markedDaysPhrase(filled.created)}${
                    filled.skipped > 0 ? `, ${alreadyMarkedPhrase(filled.skipped)} раньше` : ''
                  }.`}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

/* ========================== Табель ========================== */

function TimesheetBlock({ userId, away }: { userId: string; away: AwayInterval[] }) {
  const utils = trpc.useUtils();
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const [filled, setFilled] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  const monthQ = trpc.attendance.month.useQuery({ year, month });
  const fill = trpc.attendance.fillRange.useMutation();

  const mine = useMemo(
    () => ((monthQ.data?.records ?? []) as AttendanceRecord[]).filter((r) => r.userId === userId),
    [monthQ.data?.records, userId],
  );
  const totals = useMemo(() => summarize(mine), [mine]);
  const breakdown = attendanceBreakdown(totals.countByStatus);

  const range = { from: monthQ.data?.from ?? '', to: monthQ.data?.to ?? '' };
  const gaps = useMemo(() => {
    if (!range.from || !range.to) return [];
    return unmarkedAwayDays(away, new Set(mine.map((r) => r.workDate)), range);
  }, [away, mine, range.from, range.to]);

  const shiftMonth = (delta: number) => {
    const d = new Date(Date.UTC(year, month - 1 + delta, 1));
    setYear(d.getUTCFullYear());
    setMonth(d.getUTCMonth() + 1);
    setFilled(null);
  };

  /** Проставить в табель то, что уже отмечено планом, но в журнале отсутствует. */
  const fillGaps = async () => {
    setBusy(true);
    let created = 0;
    try {
      for (const interval of away) {
        const status = awayKindToAttendanceStatus(interval.kind);
        if (!status) continue;
        const from = interval.dateFrom > range.from ? interval.dateFrom : range.from;
        const to = interval.dateTo < range.to ? interval.dateTo : range.to;
        if (!from || !to || to < from) continue;
        const res = await fill.mutateAsync({ userId, dateFrom: from, dateTo: to, status });
        created += res.created;
      }
      await utils.attendance.month.invalidate();
      setFilled(created);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="bg-card rounded-lg border">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 className="inline-flex items-center gap-2 text-sm font-semibold">
          <CalendarRange className="text-muted-foreground h-3.5 w-3.5" />
          Табель
        </h2>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => shiftMonth(-1)}
            aria-label="Предыдущий месяц"
            className="bg-secondary hover:bg-muted rounded-md p-1"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <span className="min-w-[7.5rem] text-center text-xs font-medium">
            {monthTitle(year, month)}
          </span>
          <button
            type="button"
            onClick={() => shiftMonth(1)}
            aria-label="Следующий месяц"
            className="bg-secondary hover:bg-muted rounded-md p-1"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="space-y-3 p-4">
        {monthQ.error && <QueryError error={monthQ.error} onRetry={() => void monthQ.refetch()} />}

        {monthQ.isLoading ? (
          <div className="text-muted-foreground text-sm">Загрузка…</div>
        ) : breakdown.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            За этот месяц отметок нет. Табель ведут в{' '}
            <Link href="/attendance" className="underline underline-offset-2">
              журнале посещений
            </Link>
            .
          </p>
        ) : (
          <>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {breakdown.map((b) => (
                <span key={b.label}>
                  {b.label} <span className="font-semibold tabular-nums">{b.count}</span>
                </span>
              ))}
            </div>
            <div className="text-muted-foreground text-xs">
              Отработано {formatWorkedTime(totals.workedMinutes)}
              {totals.presentWithoutTime > 0 &&
                ` · у ${totals.presentWithoutTime} ${pluralRu(totals.presentWithoutTime, 'явки', 'явок', 'явок')} время не проставлено`}
            </div>
          </>
        )}

        {gaps.length > 0 && (
          <div className="bg-warning/10 border-warning/30 space-y-2 rounded-md border p-3 text-xs">
            <div>
              По плану отсутствия в этом месяце {gaps.length} {daysWord(gaps.length)} без отметки в
              табеле. План и табель — разные вещи: первое влияет на подсказку «кому отдать заявку»,
              второе печатают и подписывают.
            </div>
            <button
              type="button"
              disabled={busy}
              onClick={() => void fillGaps()}
              className="bg-secondary hover:bg-muted inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-medium disabled:opacity-50"
            >
              {busy && <Loader2 className="h-3 w-3 animate-spin" />}
              Проставить в табель
            </button>
          </div>
        )}

        {filled !== null && (
          <div className="text-muted-foreground text-xs">
            {filled === 0
              ? 'Все эти дни уже были отмечены раньше — в табеле ничего не изменилось.'
              : `В табеле ${markedDaysPhrase(filled)}.`}
          </div>
        )}

        {breakdown.length > 0 && (
          <Link
            href="/attendance"
            className="text-muted-foreground hover:text-foreground inline-block text-xs underline underline-offset-2"
          >
            Открыть журнал посещений
          </Link>
        )}
      </div>
    </section>
  );
}

/* ========================== Мелочи ========================== */

function FieldLabel({
  children,
  hint,
  required,
}: {
  children: React.ReactNode;
  hint?: string;
  required?: boolean;
}) {
  return (
    <div className="mb-1 text-xs font-medium">
      {children}
      {required && <span className="text-destructive ml-0.5">*</span>}
      {hint && <span className="text-muted-foreground ml-1 font-normal">({hint})</span>}
    </div>
  );
}
