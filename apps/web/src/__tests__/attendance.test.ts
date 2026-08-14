/**
 * Журнал посещений: подсчёты месяца и печатный табель.
 *
 * Итог на экране и итог в подписываемом табеле считает ОДИН код (lib/attendance),
 * поэтому тесты держат именно его. Отдельно проверяем, что у таблицы табеля число
 * колонок сходится с числом заголовков и ширин: разъехавшаяся на один столбец
 * сетка сдвинула бы все отметки на соседние числа месяца, а на глаз в 31 колонке
 * такое не ловится.
 */
import { describe, it, expect } from 'vitest';
import type { TDocumentDefinitions } from 'pdfmake/interfaces';
import {
  buildAttendanceRows,
  formatWorkedTime,
  monthDays,
  monthTitle,
  statusCode,
  summarize,
  timeToMinutes,
  workedMinutes,
  type AttendanceRecord,
} from '../lib/attendance';
import { buildAttendanceSheetDoc } from '../lib/pdf/attendance-sheet';
import { ERFOLG_FALLBACK } from '../lib/pdf/branding';

const rec = (over: Partial<AttendanceRecord> = {}): AttendanceRecord => ({
  userId: 'u1',
  workDate: '2026-08-03',
  status: 'present',
  arrivedAt: '09:00',
  leftAt: '18:00',
  note: null,
  ...over,
});

describe('дни месяца', () => {
  it('февраль високосного года — 29 дней', () => {
    expect(monthDays(2024, 2)).toHaveLength(29);
    expect(monthDays(2026, 2)).toHaveLength(28);
  });

  it('выходные помечены: 1 августа 2026 — суббота, 3 августа — понедельник', () => {
    const days = monthDays(2026, 8);
    expect(days[0]).toEqual({ date: '2026-08-01', day: 1, isWeekend: true });
    expect(days[1]).toEqual({ date: '2026-08-02', day: 2, isWeekend: true });
    expect(days[2]).toEqual({ date: '2026-08-03', day: 3, isWeekend: false });
  });

  it('название месяца — по-русски', () => {
    expect(monthTitle(2026, 8)).toBe('Август 2026');
  });
});

describe('время и часы', () => {
  it('«ЧЧ:ММ» переводится в минуты, мусор — в null', () => {
    expect(timeToMinutes('09:30')).toBe(570);
    expect(timeToMinutes('00:00')).toBe(0);
    expect(timeToMinutes('')).toBeNull();
    expect(timeToMinutes(null)).toBeNull();
    expect(timeToMinutes('25:00')).toBeNull();
    expect(timeToMinutes('девять')).toBeNull();
  });

  it('отработано за день = уход минус приход', () => {
    expect(workedMinutes({ arrivedAt: '09:00', leftAt: '18:00' })).toBe(540);
    expect(workedMinutes({ arrivedAt: '09:15', leftAt: '17:45' })).toBe(510);
  });

  it('без времени и при уходе не позже прихода — null, а не ноль', () => {
    expect(workedMinutes({ arrivedAt: '09:00', leftAt: null })).toBeNull();
    expect(workedMinutes({ arrivedAt: null, leftAt: null })).toBeNull();
    expect(workedMinutes({ arrivedAt: '18:00', leftAt: '09:00' })).toBeNull();
    expect(workedMinutes({ arrivedAt: '09:00', leftAt: '09:00' })).toBeNull();
  });

  it('часы печатаются по-человечески, ноль — прочерком', () => {
    expect(formatWorkedTime(0)).toBe('—');
    expect(formatWorkedTime(90)).toBe('1 ч 30 мин');
    expect(formatWorkedTime(120)).toBe('2 ч');
  });
});

describe('итоги за месяц', () => {
  it('считает дни по видам и суммирует только заполненное время', () => {
    const totals = summarize([
      rec({ workDate: '2026-08-03' }),
      rec({ workDate: '2026-08-04', arrivedAt: '10:00', leftAt: '16:00' }),
      rec({ workDate: '2026-08-05', arrivedAt: null, leftAt: null }),
      rec({ workDate: '2026-08-06', status: 'sick', arrivedAt: null, leftAt: null }),
      rec({ workDate: '2026-08-07', status: 'vacation', arrivedAt: null, leftAt: null }),
    ]);
    expect(totals.countByStatus.present).toBe(3);
    expect(totals.countByStatus.sick).toBe(1);
    expect(totals.countByStatus.vacation).toBe(1);
    expect(totals.markedDays).toBe(5);
    expect(totals.workedMinutes).toBe(540 + 360);
  });

  it('явка без указанного времени видна отдельно — её часы в сумму не попали', () => {
    const totals = summarize([rec({ arrivedAt: null, leftAt: null })]);
    expect(totals.workedMinutes).toBe(0);
    expect(totals.presentWithoutTime).toBe(1);
  });

  it('больничный без времени за «явку без времени» не считается', () => {
    const totals = summarize([rec({ status: 'sick', arrivedAt: null, leftAt: null })]);
    expect(totals.presentWithoutTime).toBe(0);
  });
});

describe('строки табеля', () => {
  const employees = [
    { userId: 'u1', fullName: 'Иванов И. И.', role: 'engineer' as const },
    { userId: 'u2', fullName: 'Петров П. П.', role: 'dispatcher' as const },
  ];
  const days = monthDays(2026, 8);

  it('код стоит ровно в своём числе месяца, остальные клетки пустые', () => {
    const rows = buildAttendanceRows(
      employees,
      [
        rec({ userId: 'u1', workDate: '2026-08-03' }),
        rec({
          userId: 'u1',
          workDate: '2026-08-05',
          status: 'sick',
          arrivedAt: null,
          leftAt: null,
        }),
      ],
      days,
    );
    const ivanov = rows[0];
    expect(ivanov?.codes).toHaveLength(31);
    expect(ivanov?.codes[2]).toBe(statusCode('present'));
    expect(ivanov?.codes[4]).toBe(statusCode('sick'));
    expect(ivanov?.codes[3]).toBe('');
    expect(ivanov?.totals.countByStatus.present).toBe(1);
  });

  it('сотрудник без отметок остаётся в табеле пустой строкой', () => {
    const rows = buildAttendanceRows(employees, [], days);
    expect(rows).toHaveLength(2);
    expect(rows[1]?.fullName).toBe('Петров П. П.');
    expect(rows[1]?.codes.every((c) => c === '')).toBe(true);
    expect(rows[1]?.totals.markedDays).toBe(0);
  });

  it('должность подставляется по роли', () => {
    const rows = buildAttendanceRows(employees, [], days);
    expect(rows[0]?.position).toBe('Инженер');
    expect(rows[1]?.position).toBe('Диспетчер');
  });
});

describe('печатный табель', () => {
  const days = monthDays(2026, 8).map((d) => ({ day: d.day, isWeekend: d.isWeekend }));

  function doc(rowsCount: number): TDocumentDefinitions {
    return buildAttendanceSheetDoc({
      tenant: { ...ERFOLG_FALLBACK },
      monthTitle: 'Август 2026',
      days,
      rows: Array.from({ length: rowsCount }, (_, i) => ({
        fullName: `Сотрудник ${i + 1}`,
        position: 'Инженер',
        codes: days.map(() => 'Я'),
        presentDays: days.length,
        workedText: '248 ч',
      })),
      legend: [{ code: 'Я', label: 'Явка' }],
      compiledBy: 'Хаджиев Т. Р.',
      compiledAt: '2026-09-01T00:00:00.000Z',
    });
  }

  /** Таблица табеля — единственный блок с `table` в документе. */
  function sheetTable(d: TDocumentDefinitions) {
    const content = d.content as unknown as Array<Record<string, unknown>>;
    const block = content.find((c) => c && typeof c === 'object' && 'table' in c);
    return block?.table as { widths: unknown[]; body: unknown[][] };
  }

  it('число ширин, заголовков и клеток строки совпадает', () => {
    const table = sheetTable(doc(2));
    // 3 служебные колонки + 31 число месяца + «Явок» + «Отработано».
    expect(table.widths).toHaveLength(3 + 31 + 2);
    expect(table.body[0]).toHaveLength(table.widths.length);
    expect(table.body[1]).toHaveLength(table.widths.length);
  });

  it('лист альбомный — иначе 31 колонка не помещается', () => {
    expect(doc(1).pageOrientation).toBe('landscape');
  });

  it('пустой месяц печатается с честной пометкой, а не пустым листом', () => {
    const json = JSON.stringify(doc(0));
    expect(json).toContain('За этот месяц отметок посещений нет.');
    expect(sheetTable(doc(0)).body).toHaveLength(1);
  });

  it('в документе есть шапка, месяц и подписи', () => {
    const json = JSON.stringify(doc(1));
    expect(json).toContain('Табель учёта рабочего времени');
    expect(json).toContain('Август 2026');
    expect(json).toContain('Составил (подпись)');
    expect(json).toContain(ERFOLG_FALLBACK.director);
  });

  it('денег в табеле нет — это учётный документ, не расчётный', () => {
    const json = JSON.stringify(doc(1));
    expect(json).not.toContain('₽');
    expect(json.toLowerCase()).not.toContain('зарплат');
  });
});
