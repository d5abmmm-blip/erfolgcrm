/**
 * Журнал посещений (табель): справочник видов дня и подсчёты по месяцу.
 *
 * Здесь только чистые функции — их использует и страница, и печатная форма, чтобы
 * итог на экране и итог в подписываемом документе считались ОДНИМ кодом. Разойтись
 * они не могут по построению.
 */

export type AttendanceStatus =
  | 'present'
  | 'day_off'
  | 'sick'
  | 'vacation'
  | 'business_trip'
  | 'absent'
  | 'unpaid_leave';

export interface AttendanceStatusMeta {
  key: AttendanceStatus;
  /** Полное название — для формы и легенды. */
  label: string;
  /** Буквенный код в клетке табеля (как в привычной форме Т-13). */
  code: string;
}

export const ATTENDANCE_STATUSES: readonly AttendanceStatusMeta[] = [
  { key: 'present', label: 'Явка', code: 'Я' },
  { key: 'day_off', label: 'Выходной', code: 'В' },
  { key: 'sick', label: 'Больничный', code: 'Б' },
  { key: 'vacation', label: 'Отпуск', code: 'ОТ' },
  { key: 'business_trip', label: 'Командировка', code: 'К' },
  { key: 'absent', label: 'Неявка', code: 'Н' },
  { key: 'unpaid_leave', label: 'За свой счёт', code: 'ДО' },
];

const BY_KEY = new Map(ATTENDANCE_STATUSES.map((s) => [s.key, s]));

export function statusCode(status: AttendanceStatus): string {
  return BY_KEY.get(status)?.code ?? '';
}

export function statusLabel(status: AttendanceStatus): string {
  return BY_KEY.get(status)?.label ?? status;
}

export interface AttendanceRecord {
  userId: string;
  /** YYYY-MM-DD */
  workDate: string;
  status: AttendanceStatus;
  /** HH:MM либо null */
  arrivedAt: string | null;
  leftAt: string | null;
  note: string | null;
}

export interface MonthDay {
  /** YYYY-MM-DD */
  date: string;
  /** Число месяца, 1..31 */
  day: number;
  /** Суббота или воскресенье — колонку подсвечиваем и на экране, и в печати. */
  isWeekend: boolean;
}

/** Дни месяца по порядку. Считаем в UTC — тут нет времени суток, только календарь. */
export function monthDays(year: number, month: number): MonthDay[] {
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = String(month).padStart(2, '0');
  const out: MonthDay[] = [];
  for (let day = 1; day <= last; day += 1) {
    const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
    out.push({
      date: `${year}-${mm}-${String(day).padStart(2, '0')}`,
      day,
      isWeekend: weekday === 0 || weekday === 6,
    });
  }
  return out;
}

/** «ЧЧ:ММ» → минуты от полуночи. Пустое/битое время — null, а не 0. */
export function timeToMinutes(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Отработано за день в минутах. null — если время не заполнено или уход не позже
 * прихода: считать такой день нулём нельзя, «часов не указано» и «отработал 0» —
 * разные вещи, и в итоговой сумме их путать не надо.
 */
export function workedMinutes(
  record: Pick<AttendanceRecord, 'arrivedAt' | 'leftAt'>,
): number | null {
  const from = timeToMinutes(record.arrivedAt);
  const to = timeToMinutes(record.leftAt);
  if (from === null || to === null || to <= from) return null;
  return to - from;
}

export interface AttendanceTotals {
  /** Сколько дней каждого вида. */
  countByStatus: Record<AttendanceStatus, number>;
  /** Всего отметок в месяце. */
  markedDays: number;
  /** Сумма отработанного времени по дням, где указаны и приход, и уход. */
  workedMinutes: number;
  /** Сколько явок осталось без времени — их часы в сумму не попали. */
  presentWithoutTime: number;
}

function emptyCounts(): Record<AttendanceStatus, number> {
  return {
    present: 0,
    day_off: 0,
    sick: 0,
    vacation: 0,
    business_trip: 0,
    absent: 0,
    unpaid_leave: 0,
  };
}

export function summarize(records: readonly AttendanceRecord[]): AttendanceTotals {
  const countByStatus = emptyCounts();
  let minutes = 0;
  let presentWithoutTime = 0;
  for (const r of records) {
    countByStatus[r.status] += 1;
    const worked = workedMinutes(r);
    if (worked !== null) minutes += worked;
    else if (r.status === 'present') presentWithoutTime += 1;
  }
  return {
    countByStatus,
    markedDays: records.length,
    workedMinutes: minutes,
    presentWithoutTime,
  };
}

/** Минуты → «162 ч 30 мин». Ноль показываем прочерком — так честнее пустой строки. */
export function formatWorkedTime(minutes: number): string {
  if (minutes <= 0) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

const RU_MONTHS_NOMINATIVE = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
] as const;

export function monthTitle(year: number, month: number): string {
  return `${RU_MONTHS_NOMINATIVE[month - 1] ?? ''} ${year}`;
}

export interface AttendanceEmployee {
  userId: string;
  fullName: string;
  role: 'director' | 'dispatcher' | 'engineer';
}

export const POSITION_LABELS: Record<AttendanceEmployee['role'], string> = {
  director: 'Директор',
  dispatcher: 'Диспетчер',
  engineer: 'Инженер',
};

export interface AttendanceSheetRow {
  userId: string;
  fullName: string;
  position: string;
  /** По одному коду на день месяца; пустая строка — отметки нет. */
  codes: string[];
  totals: AttendanceTotals;
}

/**
 * Строки табеля за месяц. Одна функция и для экрана, и для печати — итог в
 * распечатанном документе не может разойтись с тем, что видел менеджер.
 */
export function buildAttendanceRows(
  employees: readonly AttendanceEmployee[],
  records: readonly AttendanceRecord[],
  days: readonly MonthDay[],
): AttendanceSheetRow[] {
  const index = indexByUserAndDate(records);
  return employees.map((e) => {
    const byDate = index.get(e.userId);
    const mine = byDate ? [...byDate.values()] : [];
    return {
      userId: e.userId,
      fullName: e.fullName,
      position: POSITION_LABELS[e.role],
      codes: days.map((d) => {
        const rec = byDate?.get(d.date);
        return rec ? statusCode(rec.status) : '';
      }),
      totals: summarize(mine),
    };
  });
}

/** Записи одного сотрудника, по дате. Ключ — YYYY-MM-DD. */
export function indexByUserAndDate(
  records: readonly AttendanceRecord[],
): Map<string, Map<string, AttendanceRecord>> {
  const out = new Map<string, Map<string, AttendanceRecord>>();
  for (const r of records) {
    let byDate = out.get(r.userId);
    if (!byDate) {
      byDate = new Map();
      out.set(r.userId, byDate);
    }
    byDate.set(r.workDate, r);
  }
  return out;
}
