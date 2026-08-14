/**
 * Вкладка «Кадры» на карточке сотрудника: подписи и подсчёты.
 *
 * Отдельно от компонента по той же причине, что и lib/staff.ts, — тексты и арифметику
 * можно проверить тестом без отрисовки. Здесь два узких места:
 *
 *   • срок аттестации словами («истекает через 1 день», а не «через 1 дней»);
 *   • расхождение плана и табеля — отпуск живёт в двух местах, и карточка обязана
 *     говорить об этом прямо, а не делать вид, что всё сошлось.
 *
 * Виды дня и их подписи берём из lib/attendance — того же кода, что считает журнал и
 * печатную форму. Второго справочника видов дня в системе быть не должно.
 */
import { ATTENDANCE_STATUSES, type AttendanceStatus } from './attendance';
import { pluralRu } from './staff';

export type AwayKind = 'day_off' | 'vacation' | 'onsite';

/** Тон срока: спокойный, «скоро истечёт», просрочено. */
export type ValidityTone = 'ok' | 'soon' | 'expired';

export const VALIDITY_TONE_LABELS: Record<ValidityTone, string> = {
  ok: 'Действует',
  soon: 'Истекает',
  expired: 'Просрочена',
};

/** За сколько дней до конца начинаем предупреждать. Столько же считает сервер. */
const SOON_DAYS = 30;

/**
 * Родительный падеж: «1 ноя», «5 мая». Свои названия, а не toLocaleDateString, —
 * тот добавляет «г.» на конце и меняет вид от версии Node к версии.
 */
const RU_MONTHS_SHORT = [
  'янв',
  'фев',
  'мар',
  'апр',
  'мая',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
] as const;

/** «2027-02-12» → «12 фев 2027». */
export function formatDateRu(iso: string): string {
  const [y, m, d] = iso.split('-');
  const month = RU_MONTHS_SHORT[Number(m) - 1] ?? m ?? '';
  return `${Number(d)} ${month} ${y}`;
}

export function daysWord(n: number): string {
  return pluralRu(n, 'день', 'дня', 'дней');
}

/**
 * Итог заливки табеля: «отмечен 1 день» / «отмечено 4 дня».
 * Сказуемое согласовано с числом — иначе подтверждение записи читается как лепет.
 */
export function markedDaysPhrase(n: number): string {
  return `${pluralRu(n, 'отмечен', 'отмечено', 'отмечено')} ${n} ${daysWord(n)}`;
}

/** «1 день уже был отмечен» / «3 дня уже были отмечены». */
export function alreadyMarkedPhrase(n: number): string {
  const verb = pluralRu(n, 'уже был отмечен', 'уже были отмечены', 'уже были отмечены');
  return `${n} ${daysWord(n)} ${verb}`;
}

/** Сегодня как YYYY-MM-DD по часам браузера (не по UTC — иначе вечером «уже завтра»). */
export function todayIso(now: Date = new Date()): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${mm}-${dd}`;
}

/** Календарных дней между датами. Считаем в UTC — тут только календарь. */
export function daysBetween(fromIso: string, toIso: string): number {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  return Math.round((to - from) / 86_400_000);
}

/** Дни периода включительно. Конец раньше начала — пусто, а не бесконечный цикл. */
export function daysInRange(from: string, to: string): string[] {
  const out: string[] = [];
  const last = Date.parse(`${to}T00:00:00Z`);
  const cursor = new Date(`${from}T00:00:00Z`);
  if (Number.isNaN(last) || Number.isNaN(cursor.getTime())) return out;
  while (cursor.getTime() <= last) {
    out.push(cursor.toISOString().slice(0, 10));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

export function validityTone(validUntil: string | null, today: string): ValidityTone {
  if (!validUntil) return 'ok';
  if (validUntil < today) return 'expired';
  return daysBetween(today, validUntil) <= SOON_DAYS ? 'soon' : 'ok';
}

/**
 * Срок словами. Пока до конца далеко — показываем дату (её и переписывают в
 * удостоверение), а когда близко — счёт дней: так видно, что пора шевелиться.
 */
export function validityPhrase(validUntil: string | null, today: string): string {
  if (!validUntil) return 'бессрочно';
  const left = daysBetween(today, validUntil);
  if (left < 0) {
    const overdue = -left;
    return `просрочена ${overdue} ${daysWord(overdue)} назад`;
  }
  if (left === 0) return 'истекает сегодня';
  if (left <= SOON_DAYS) return `истекает через ${left} ${daysWord(left)}`;
  return `действует до ${formatDateRu(validUntil)}`;
}

export interface AttestationLike {
  validUntil: string | null;
}

function urgencyRank(validUntil: string | null, today: string): number {
  if (!validUntil) return 3; // бессрочные — в конец, они не требуют внимания
  const tone = validityTone(validUntil, today);
  return tone === 'expired' ? 0 : tone === 'soon' ? 1 : 2;
}

/** Сначала то, что горит: просроченные, затем истекающие, затем спокойные. */
export function sortAttestations<T extends AttestationLike>(
  rows: readonly T[],
  today: string,
): T[] {
  return [...rows].sort((a, b) => {
    const ra = urgencyRank(a.validUntil, today);
    const rb = urgencyRank(b.validUntil, today);
    if (ra !== rb) return ra - rb;
    if (!a.validUntil || !b.validUntil) return 0;
    return a.validUntil.localeCompare(b.validUntil);
  });
}

/**
 * Чем плановое отсутствие становится в табеле. «На выезде» — ничем: человек в этот
 * день работает, и в табеле это явка, которую ставят по факту, а не заранее.
 */
export function awayKindToAttendanceStatus(kind: AwayKind): AttendanceStatus | null {
  if (kind === 'vacation') return 'vacation';
  if (kind === 'day_off') return 'day_off';
  return null;
}

export interface AwayInterval {
  kind: AwayKind;
  dateFrom: string;
  dateTo: string;
}

/**
 * Дни, которые по плану отсутствия попадают в показанный месяц, но в табеле не
 * отмечены. Именно это расхождение карточка и показывает: «по плану отпуск, а в
 * табеле пусто» — иначе два раздела годами живут каждый своей правдой.
 */
export function unmarkedAwayDays(
  away: readonly AwayInterval[],
  markedDates: ReadonlySet<string>,
  month: { from: string; to: string },
): string[] {
  const out = new Set<string>();
  for (const interval of away) {
    if (!awayKindToAttendanceStatus(interval.kind)) continue;
    const from = interval.dateFrom > month.from ? interval.dateFrom : month.from;
    const to = interval.dateTo < month.to ? interval.dateTo : month.to;
    for (const day of daysInRange(from, to)) {
      if (!markedDates.has(day)) out.add(day);
    }
  }
  return [...out].sort();
}

/** «Явка 12 · Больничный 2» — виды дня, которых в месяце не было, не показываем. */
export function attendanceBreakdown(
  counts: Record<AttendanceStatus, number>,
): Array<{ label: string; count: number }> {
  return ATTENDANCE_STATUSES.filter((s) => (counts[s.key] ?? 0) > 0).map((s) => ({
    label: s.label,
    count: counts[s.key] ?? 0,
  }));
}
