/**
 * Наряд закрытой заявки правится три дня, дальше — только руководитель.
 *
 * ЧТО БЫЛО. Ни в сервисе нарядов, ни в интерфейсе не было ни одной проверки
 * статуса заявки: строку в наряд можно было добавить в закрытую заявку любой
 * давности. А от строк наряда считается зарплата — то есть правка задним
 * числом меняет суммы УЖЕ ВЫПЛАЧЕННОГО периода, и никто этого не заметит.
 * Беда общесистемная: на десктопе права были те же.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (2026-08-07): «закрытую заявку можно редактировать ещё
 * три дня, а дальше нужно, чтобы давал разрешение администратор» → после трёх
 * дней наряд правят только директор и диспетчер. Сам факт, что правит
 * руководитель, и есть разрешение.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import {
  CLOSED_WORK_ORDER_EDIT_DAYS,
  assertWorkOrderEditable,
  mayEditWorkOrder,
} from '../modules/work-orders/edit-window';

const NOW = new Date('2026-08-07T12:00:00.000Z').getTime();
const day = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW - days * day);

const engineer = 'engineer' as const;
const dispatcher = 'dispatcher' as const;
const director = 'director' as const;

describe('окно правки закрытого наряда', () => {
  it('открытую заявку правят как обычно', () => {
    expect(mayEditWorkOrder(engineer, { status: 'in_progress', closedAt: null }, NOW)).toBe(true);
  });

  it('только что закрытую — можно', () => {
    expect(mayEditWorkOrder(engineer, { status: 'closed', closedAt: ago(0) }, NOW)).toBe(true);
  });

  it('на третий день ещё можно', () => {
    expect(
      mayEditWorkOrder(
        engineer,
        { status: 'closed', closedAt: ago(CLOSED_WORK_ORDER_EDIT_DAYS) },
        NOW,
      ),
    ).toBe(true);
  });

  it('на четвёртый инженеру уже нельзя', () => {
    expect(
      mayEditWorkOrder(
        engineer,
        { status: 'closed', closedAt: ago(CLOSED_WORK_ORDER_EDIT_DAYS + 1) },
        NOW,
      ),
    ).toBe(false);
  });

  it('руководителю можно всегда — это и есть «разрешение администратора»', () => {
    const old = { status: 'closed' as const, closedAt: ago(400) };
    expect(mayEditWorkOrder(dispatcher, old, NOW)).toBe(true);
    expect(mayEditWorkOrder(director, old, NOW)).toBe(true);
  });

  /**
   * У импортированных заявок дата закрытия может отсутствовать. Считать их
   * «закрытыми только что» нельзя — это ровно та дыра, которую закрываем.
   */
  it('закрыта, но даты закрытия нет — инженеру нельзя', () => {
    expect(mayEditWorkOrder(engineer, { status: 'closed', closedAt: null }, NOW)).toBe(false);
  });

  it('три дня — это три дня, а не «пока не сменился месяц»', () => {
    expect(CLOSED_WORK_ORDER_EDIT_DAYS).toBe(3);
  });
});

describe('отказ объясняет причину и срок', () => {
  it('называет, сколько дней назад закрыта, и к кому идти', () => {
    let caught: unknown;
    try {
      assertWorkOrderEditable(engineer, { status: 'closed', closedAt: ago(12) }, NOW);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    const err = caught as TRPCError;
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toContain('12');
    expect(err.message.toLowerCase()).toContain('руководител');
  });

  it('в окне трёх дней молчит', () => {
    expect(() =>
      assertWorkOrderEditable(engineer, { status: 'closed', closedAt: ago(1) }, NOW),
    ).not.toThrow();
  });

  it('диспетчер проходит молча', () => {
    expect(() =>
      assertWorkOrderEditable(dispatcher, { status: 'closed', closedAt: ago(400) }, NOW),
    ).not.toThrow();
  });
});
