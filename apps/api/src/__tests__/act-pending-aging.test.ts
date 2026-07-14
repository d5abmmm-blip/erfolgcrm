/**
 * PR-6 «Подсветка залежавшейся готовой техники».
 *
 * computeTrafficLight для act_pending раньше всегда возвращал 'green'. Теперь готовая, но
 * не выданная техника стареет: свежая — зелёная, полежала — жёлтая, забыли надолго — красная.
 * Проверяем это и что поведение остальных статусов не изменилось. Чистая функция, без БД.
 */
import { describe, it, expect } from 'vitest';
import {
  ACT_PENDING_RED_DAYS,
  ACT_PENDING_WARN_DAYS,
  BOARD_STUCK_DAYS,
  BOARD_WARN_DAYS,
  computeTrafficLight,
} from '../modules/tickets/repository';

const NOW = Date.UTC(2026, 6, 15);

describe('computeTrafficLight — старение «Ожидает акта»', () => {
  it('только доделали (0 дней) — зелёный', () => {
    expect(computeTrafficLight('act_pending', 'ready_for_pickup', 0, null, NOW)).toBe('green');
  });

  it('свежее порога жёлтого — ещё зелёный', () => {
    expect(
      computeTrafficLight('act_pending', 'ready_for_pickup', ACT_PENDING_WARN_DAYS - 1, null, NOW),
    ).toBe('green');
  });

  it('полежало ≥ порога жёлтого — жёлтый («позвоните клиенту»)', () => {
    expect(
      computeTrafficLight('act_pending', 'ready_for_pickup', ACT_PENDING_WARN_DAYS, null, NOW),
    ).toBe('yellow');
  });

  it('лежит ≥ порога красного — красный («забыли»)', () => {
    expect(
      computeTrafficLight('act_pending', 'ready_for_pickup', ACT_PENDING_RED_DAYS, null, NOW),
    ).toBe('red');
  });

  it('SLA к готовой технике не применяется: просроченный SLA сам по себе не краснит свежую', () => {
    const overdue = new Date(NOW - 1000);
    expect(computeTrafficLight('act_pending', 'ready_for_pickup', 0, overdue, NOW)).toBe('green');
  });
});

describe('computeTrafficLight — регрессия для остальных статусов', () => {
  it('в работе, свежая, без причины — зелёный', () => {
    expect(computeTrafficLight('in_progress', null, 0, null, NOW)).toBe('green');
  });

  it('в работе, застряла ≥ STUCK — красный', () => {
    expect(computeTrafficLight('in_progress', null, BOARD_STUCK_DAYS, null, NOW)).toBe('red');
  });

  it('в работе, есть причина простоя — жёлтый', () => {
    expect(computeTrafficLight('in_progress', 'waiting_part', 0, null, NOW)).toBe('yellow');
  });

  it('в работе, замедлилась ≥ WARN — жёлтый', () => {
    expect(computeTrafficLight('in_progress', null, BOARD_WARN_DAYS, null, NOW)).toBe('yellow');
  });

  it('принята, просрочен SLA — красный', () => {
    const overdue = new Date(NOW - 1000);
    expect(computeTrafficLight('received', null, 0, overdue, NOW)).toBe('red');
  });
});
