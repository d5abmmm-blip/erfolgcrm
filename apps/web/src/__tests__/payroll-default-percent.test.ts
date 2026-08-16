/**
 * Процент, который ведомость подставляет в поле «% от работ».
 *
 * ЧТО БЫЛО. Поле всегда предзаполнялось `pieceworkPercent` — процентом СДЕЛКИ, —
 * независимо от режима расчёта. А на бою режим `salary_bonus`: платят оклад плюс
 * `bonusPercent`. Сделка настроена на 30 %, бонус на 15 %, то есть директор жал
 * «Посчитать» и получал сделку ВДВОЕ больше той, что система считает зарплатой
 * везде ещё: в плитке «ЗП к выплате» на главной и в себестоимости строк наряда
 * (обе идут через resolveWorkPercent). Ведомость потом проводится в кассу.
 *
 * Правило то же, что на сервере (resolveWorkPercent): режим решает, какой процент
 * общий. Личные проценты сотрудников одним полем не выражаются — они у каждого
 * свои, и поправить строку руками ведомость позволяет намеренно.
 */
import { describe, it, expect } from 'vitest';
import { defaultWorkPercent } from '../pages/PayrollPage';

describe('defaultWorkPercent', () => {
  it('сделка — берём процент сделки', () => {
    expect(defaultWorkPercent({ mode: 'piecework', pieceworkPercent: 30, bonusPercent: 15 })).toBe(
      30,
    );
  });

  it('оклад с бонусом — берём процент бонуса, а не сделки: это и был просчёт вдвое', () => {
    expect(
      defaultWorkPercent({ mode: 'salary_bonus', pieceworkPercent: 30, bonusPercent: 15 }),
    ).toBe(15);
  });

  it('правила ещё не загрузились — ноль, а не выдуманное число', () => {
    expect(defaultWorkPercent(undefined)).toBe(0);
  });

  it('процент не задан — ноль', () => {
    expect(
      defaultWorkPercent({ mode: 'salary_bonus', pieceworkPercent: 30, bonusPercent: null }),
    ).toBe(0);
  });
});
