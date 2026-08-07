/**
 * Экранное зеркало правила «наряд закрытой заявки правится три дня».
 * Смысл: не давать вводить то, что сервер отклонит, — иначе инженер набьёт
 * строку, нажмёт сохранить и потеряет ввод вместе с объяснением.
 */
import { describe, expect, it } from 'vitest';
import {
  CLOSED_WORK_ORDER_EDIT_DAYS,
  closedWorkOrderNotice,
  mayEditWorkOrder,
} from '../lib/work-order-window';

const NOW = new Date('2026-08-07T12:00:00.000Z').getTime();
const ago = (d: number) => new Date(NOW - d * 24 * 60 * 60 * 1000);

describe('можно ли править наряд', () => {
  it('открытая заявка — да', () => {
    expect(mayEditWorkOrder('engineer', { status: 'in_progress' }, NOW)).toBe(true);
  });

  it('закрыта вчера — да', () => {
    expect(mayEditWorkOrder('engineer', { status: 'closed', closedAt: ago(1) }, NOW)).toBe(true);
  });

  it('закрыта две недели назад — инженеру нет', () => {
    expect(mayEditWorkOrder('engineer', { status: 'closed', closedAt: ago(14) }, NOW)).toBe(false);
  });

  it('руководителю можно всегда', () => {
    const old = { status: 'closed', closedAt: ago(400) };
    expect(mayEditWorkOrder('dispatcher', old, NOW)).toBe(true);
    expect(mayEditWorkOrder('director', old, NOW)).toBe(true);
  });

  it('срок совпадает с серверным', () => {
    expect(CLOSED_WORK_ORDER_EDIT_DAYS).toBe(3);
  });
});

describe('подпись под нарядом', () => {
  it('называет срок и к кому идти', () => {
    const text = closedWorkOrderNotice({ status: 'closed', closedAt: ago(12) }, NOW);
    expect(text).toContain('12');
    expect(text?.toLowerCase()).toContain('руководител');
  });

  it('в окне трёх дней молчит', () => {
    expect(closedWorkOrderNotice({ status: 'closed', closedAt: ago(2) }, NOW)).toBeNull();
  });

  it('открытая заявка — молчит', () => {
    expect(closedWorkOrderNotice({ status: 'in_progress' }, NOW)).toBeNull();
  });
});
