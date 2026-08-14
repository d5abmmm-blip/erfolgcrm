/**
 * Вкладка «Кадры» на карточке сотрудника — чистые функции.
 *
 * Две вещи, ради которых тут вообще есть тесты:
 *
 * 1. Срок аттестации. «Истекает через 1 дней» и «просрочена 3 день назад» — ровно та
 *    небрежность, которую на экране не замечают годами. Плюс граница «скоро»: за 30
 *    дней предупреждаем, за 31 — ещё нет.
 *
 * 2. Расхождение плана и табеля. Отпуск живёт в двух местах: план («Отсутствия») и
 *    факт («Табель»). Внесли в одном — во втором пусто. Считаем именно дни без
 *    отметки, чтобы карточка могла сказать об этом прямо, а не делать вид, что всё
 *    сошлось.
 */
import { describe, it, expect } from 'vitest';
import {
  alreadyMarkedPhrase,
  attendanceBreakdown,
  awayKindToAttendanceStatus,
  daysWord,
  formatDateRu,
  markedDaysPhrase,
  sortAttestations,
  unmarkedAwayDays,
  validityPhrase,
  validityTone,
  VALIDITY_TONE_LABELS,
} from '../lib/staff-hr';

const TODAY = '2026-08-14';

describe('срок аттестации словами', () => {
  it('без даты окончания — бессрочно', () => {
    expect(validityPhrase(null, TODAY)).toBe('бессрочно');
    expect(validityTone(null, TODAY)).toBe('ok');
  });

  it('последний день действия — «истекает сегодня», а не «просрочена 0 дней назад»', () => {
    expect(validityPhrase('2026-08-14', TODAY)).toBe('истекает сегодня');
    expect(validityTone('2026-08-14', TODAY)).toBe('soon');
  });

  it('окончания склоняются по числу', () => {
    expect(validityPhrase('2026-08-15', TODAY)).toBe('истекает через 1 день');
    expect(validityPhrase('2026-08-16', TODAY)).toBe('истекает через 2 дня');
    expect(validityPhrase('2026-08-19', TODAY)).toBe('истекает через 5 дней');
    expect(validityPhrase('2026-08-13', TODAY)).toBe('просрочена 1 день назад');
    expect(validityPhrase('2026-08-11', TODAY)).toBe('просрочена 3 дня назад');
    expect(validityPhrase('2026-08-03', TODAY)).toBe('просрочена 11 дней назад');
  });

  it('граница «скоро» — тридцать дней', () => {
    expect(validityPhrase('2026-09-13', TODAY)).toBe('истекает через 30 дней');
    expect(validityTone('2026-09-13', TODAY)).toBe('soon');
    // На день дальше — уже спокойная подпись с датой.
    expect(validityPhrase('2026-09-14', TODAY)).toBe('действует до 14 сен 2026');
    expect(validityTone('2026-09-14', TODAY)).toBe('ok');
  });

  it('просроченная помечена отдельным тоном', () => {
    expect(validityTone('2026-08-13', TODAY)).toBe('expired');
    expect(Object.keys(VALIDITY_TONE_LABELS)).toHaveLength(3);
    expect(VALIDITY_TONE_LABELS.expired).toBe('Просрочена');
  });

  it('дата по-русски без «г.» на конце', () => {
    expect(formatDateRu('2027-02-12')).toBe('12 фев 2027');
    expect(formatDateRu('2026-11-01')).toBe('1 ноя 2026');
  });

  it('окончания слова «день»', () => {
    expect(daysWord(1)).toBe('день');
    expect(daysWord(2)).toBe('дня');
    expect(daysWord(5)).toBe('дней');
    expect(daysWord(11)).toBe('дней');
    expect(daysWord(21)).toBe('день');
  });
});

describe('порядок аттестаций', () => {
  it('сначала то, что горит: просроченные, потом истекающие, потом действующие и бессрочные', () => {
    const rows = [
      { id: 'forever', validUntil: null },
      { id: 'ok', validUntil: '2027-01-01' },
      { id: 'expired', validUntil: '2026-07-01' },
      { id: 'soon', validUntil: '2026-08-20' },
    ];
    expect(sortAttestations(rows, TODAY).map((r) => r.id)).toEqual([
      'expired',
      'soon',
      'ok',
      'forever',
    ]);
  });

  it('внутри группы — по дате окончания, ближайшая выше', () => {
    const rows = [
      { id: 'later', validUntil: '2026-08-25' },
      { id: 'sooner', validUntil: '2026-08-16' },
    ];
    expect(sortAttestations(rows, TODAY).map((r) => r.id)).toEqual(['sooner', 'later']);
  });
});

describe('план отсутствий против табеля', () => {
  const AUGUST = { from: '2026-08-01', to: '2026-08-31' };

  it('находит дни отпуска, которых нет в табеле', () => {
    const away = [{ kind: 'vacation' as const, dateFrom: '2026-08-20', dateTo: '2026-08-22' }];
    expect(unmarkedAwayDays(away, new Set(['2026-08-21']), AUGUST)).toEqual([
      '2026-08-20',
      '2026-08-22',
    ]);
  });

  it('всё отмечено — расхождения нет', () => {
    const away = [{ kind: 'vacation' as const, dateFrom: '2026-08-20', dateTo: '2026-08-21' }];
    expect(unmarkedAwayDays(away, new Set(['2026-08-20', '2026-08-21']), AUGUST)).toEqual([]);
  });

  it('период, начавшийся в прошлом месяце, обрезается по границам показанного', () => {
    const away = [{ kind: 'vacation' as const, dateFrom: '2026-07-28', dateTo: '2026-08-02' }];
    expect(unmarkedAwayDays(away, new Set(), AUGUST)).toEqual(['2026-08-01', '2026-08-02']);
  });

  it('«на выезде» в табель не просится — человек в этот день работает', () => {
    const away = [{ kind: 'onsite' as const, dateFrom: '2026-08-20', dateTo: '2026-08-21' }];
    expect(unmarkedAwayDays(away, new Set(), AUGUST)).toEqual([]);
    expect(awayKindToAttendanceStatus('onsite')).toBeNull();
    expect(awayKindToAttendanceStatus('vacation')).toBe('vacation');
    expect(awayKindToAttendanceStatus('day_off')).toBe('day_off');
  });

  it('пересекающиеся периоды не дают дубль одного дня', () => {
    const away = [
      { kind: 'vacation' as const, dateFrom: '2026-08-20', dateTo: '2026-08-22' },
      { kind: 'day_off' as const, dateFrom: '2026-08-21', dateTo: '2026-08-23' },
    ];
    expect(unmarkedAwayDays(away, new Set(), AUGUST)).toEqual([
      '2026-08-20',
      '2026-08-21',
      '2026-08-22',
      '2026-08-23',
    ]);
  });
});

// Ровно эта ошибка вылезла при живой проверке: «В табеле отмечено 4 дня, 1 день уже
// были отмечены раньше». Глагол обязан согласоваться с числом — иначе итог заливки
// читается как машинный лепет там, где человек ждёт подтверждения записи.
describe('отчёт о заливке табеля', () => {
  it('сказуемое согласовано с числом дней', () => {
    expect(markedDaysPhrase(1)).toBe('отмечен 1 день');
    expect(markedDaysPhrase(2)).toBe('отмечено 2 дня');
    expect(markedDaysPhrase(5)).toBe('отмечено 5 дней');
    expect(markedDaysPhrase(21)).toBe('отмечен 21 день');
  });

  it('про уже отмеченные дни — тоже', () => {
    expect(alreadyMarkedPhrase(1)).toBe('1 день уже был отмечен');
    expect(alreadyMarkedPhrase(3)).toBe('3 дня уже были отмечены');
    expect(alreadyMarkedPhrase(11)).toBe('11 дней уже были отмечены');
  });
});

describe('разбивка табеля по видам дня', () => {
  it('нули не показываем — иначе строка из семи прочерков', () => {
    const counts = {
      present: 12,
      day_off: 0,
      sick: 2,
      vacation: 5,
      business_trip: 0,
      absent: 0,
      unpaid_leave: 0,
    };
    expect(attendanceBreakdown(counts)).toEqual([
      { label: 'Явка', count: 12 },
      { label: 'Больничный', count: 2 },
      { label: 'Отпуск', count: 5 },
    ]);
  });

  it('пустой месяц — пустой список, а не «Явка 0»', () => {
    const counts = {
      present: 0,
      day_off: 0,
      sick: 0,
      vacation: 0,
      business_trip: 0,
      absent: 0,
      unpaid_leave: 0,
    };
    expect(attendanceBreakdown(counts)).toEqual([]);
  });
});
