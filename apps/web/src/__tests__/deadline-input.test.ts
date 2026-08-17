/**
 * Срок, обещанный клиенту, из поля «дата».
 *
 * ЗАЧЕМ. Поле в форме — `type="date"`, оно отдаёт строку «2026-08-20». Форма делала
 * из неё `new Date('2026-08-20')`, а такая строка по стандарту читается как ПОЛНОЧЬ
 * UTC — то есть 03:00 по Грозному. Просрочка же считается как `deadline_at < now()`,
 * поэтому заявка со сроком «сегодня» становилась просроченной в три часа ночи, и
 * обещанный клиенту день фактически терялся целиком.
 *
 * Срок — это «до конца дня», поэтому берём последнюю секунду выбранной даты по
 * местному времени. Все, кто заводит заявки, сидят в одном городе с сервисом.
 */
import { describe, it, expect } from 'vitest';
import { deadlineInputToDate } from '../lib/deadline';

describe('deadlineInputToDate', () => {
  it('«20 августа» — это конец 20 августа по местному времени, а не полночь', () => {
    const d = deadlineInputToDate('2026-08-20');
    expect(d).not.toBeNull();
    expect(d!.getFullYear()).toBe(2026);
    expect(d!.getMonth()).toBe(7); // август
    expect(d!.getDate()).toBe(20);
    expect(d!.getHours()).toBe(23);
    expect(d!.getMinutes()).toBe(59);
  });

  it('заявка со сроком «сегодня» не считается просроченной среди дня', () => {
    // Полдень 20 августа по местному времени — до конца срока ещё половина дня.
    const midday = new Date(2026, 7, 20, 12, 0, 0).getTime();
    const deadline = deadlineInputToDate('2026-08-20');
    expect(deadline!.getTime()).toBeGreaterThan(midday);

    // И даже поздним вечером — пока день не кончился, срок не нарушен.
    const evening = new Date(2026, 7, 20, 23, 0, 0).getTime();
    expect(deadline!.getTime()).toBeGreaterThan(evening);
  });

  it('на следующий день срок уже нарушен', () => {
    const nextMorning = new Date(2026, 7, 21, 0, 30, 0).getTime();
    expect(deadlineInputToDate('2026-08-20')!.getTime()).toBeLessThan(nextMorning);
  });

  it('пусто и мусор — срока нет', () => {
    expect(deadlineInputToDate('')).toBeNull();
    expect(deadlineInputToDate('   ')).toBeNull();
    expect(deadlineInputToDate('20.08.2026')).toBeNull();
  });
});
