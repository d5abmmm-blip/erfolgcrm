/**
 * Напоминание об аттестациях в шапке.
 *
 * Раньше фильтровалось только 'expiring_soon', поэтому на следующий день после
 * окончания допуска сигнал ПРОПАДАЛ — система замолкала ровно тогда, когда
 * инженер уже работает без действующей аттестации.
 *
 * Сервер просроченные отдаёт (запрос идёт без includeExpired) — их выбрасывал
 * именно клиентский фильтр.
 */
import { describe, it, expect } from 'vitest';
import { splitAttestations } from '../components/HeaderNudges';
import { formatNextDue } from '../components/MaintenanceScheduleForm';

describe('аттестации в напоминаниях шапки', () => {
  it('просроченный допуск больше не теряется', () => {
    const { expired } = splitAttestations([{ status: 'expired' }, { status: 'expired' }]);
    expect(expired).toBe(2);
  });

  it('истекающие считаются отдельно от просроченных', () => {
    // Смешивать нельзя: «истекает» — запланировать обучение,
    // «просрочен» — снять с работ сегодня. Это разные действия.
    const r = splitAttestations([
      { status: 'expired' },
      { status: 'expiring_soon' },
      { status: 'expiring_soon' },
    ]);
    expect(r).toEqual({ expired: 1, expiringSoon: 2 });
  });

  it('действующие допуски не шумят', () => {
    expect(splitAttestations([{ status: 'active' }, { status: 'active' }])).toEqual({
      expired: 0,
      expiringSoon: 0,
    });
  });

  it('пустой список — пусто', () => {
    expect(splitAttestations([])).toEqual({ expired: 0, expiringSoon: 0 });
  });

  it('неизвестный статус не ломает подсчёт', () => {
    expect(splitAttestations([{ status: 'что-то новое' }])).toEqual({
      expired: 0,
      expiringSoon: 0,
    });
  });
});

describe('подсказка «следующее ТО» в форме графика', () => {
  it('считает срок от даты последнего ТО, а не от сегодня', () => {
    // 10 дней от 1 января — 11 января. Раньше форма дату не слала вовсе,
    // и срок всегда отсчитывался от сегодняшнего дня.
    expect(formatNextDue('2026-01-01', '10')).toContain('11.01.2026');
  });

  it('честно предупреждает, что срок уже прошёл', () => {
    expect(formatNextDue('2020-01-01', '30')).toContain('уже просрочено');
  });

  it('будущий срок про просрочку не пишет', () => {
    const давноВперёд = new Date(Date.now() + 400 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    expect(formatNextDue(давноВперёд, '30')).not.toContain('просрочено');
  });

  it('битая дата не роняет форму', () => {
    expect(formatNextDue('не дата', '30')).toBe('—');
  });
});
