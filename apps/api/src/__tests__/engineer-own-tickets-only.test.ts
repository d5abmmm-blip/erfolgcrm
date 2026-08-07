/**
 * Инженер меняет только СВОИ заявки.
 *
 * ЧТО БЫЛО. `engineerProcedure` — проверка РОЛИ, а не принадлежности. Инженер
 * мог открыть любую заявку компании (сканер ищет по всей базе), сменить ей
 * статус, написать комментарий и — главное — добавить строку в чужой наряд
 * с любой ценой и любым исполнителем, в том числе собой. От строк наряда
 * считается зарплата (30 % от строки), то есть это прямо про деньги.
 * Гейт стоял только на печати актов и реквизитах клиента.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА (2026-08-07): «смотреть всем, менять — только свои».
 * Чтение (карточка, поиск, история, наряд) остаётся открытым — инженер
 * приезжает на объект и должен понимать, что за аппарат перед ним.
 *
 * «Свои» = ответственный ИЛИ помощник, ровно как в печати актов.
 */
import { describe, it, expect } from 'vitest';
import { TRPCError } from '@trpc/server';
import { assertEngineerMayEdit, engineerMayEditTicket } from '../modules/tickets/service';

const ME = 'user-me';
const OTHER = 'user-other';

const engineer = { role: 'engineer' as const, userId: ME };
const dispatcher = { role: 'dispatcher' as const, userId: ME };
const director = { role: 'director' as const, userId: ME };

describe('кто может менять заявку', () => {
  it('ответственный — да', () => {
    expect(engineerMayEditTicket(engineer, { assignedEngineerId: ME })).toBe(true);
  });

  it('помощник — да: он выполнял ремонт наравне', () => {
    expect(
      engineerMayEditTicket(engineer, {
        assignedEngineerId: OTHER,
        helperEngineerIds: [ME],
      }),
    ).toBe(true);
  });

  it('посторонний инженер — нет', () => {
    expect(
      engineerMayEditTicket(engineer, { assignedEngineerId: OTHER, helperEngineerIds: [] }),
    ).toBe(false);
  });

  it('заявка вообще без инженера — нет', () => {
    expect(engineerMayEditTicket(engineer, { assignedEngineerId: null })).toBe(false);
  });

  it('диспетчер и директор — без ограничений', () => {
    expect(engineerMayEditTicket(dispatcher, { assignedEngineerId: OTHER })).toBe(true);
    expect(engineerMayEditTicket(director, { assignedEngineerId: OTHER })).toBe(true);
  });
});

describe('отказ объясняет причину человеку', () => {
  it('чужая заявка — FORBIDDEN с понятным текстом', () => {
    let caught: unknown;
    try {
      assertEngineerMayEdit(engineer, { assignedEngineerId: OTHER, helperEngineerIds: [] });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TRPCError);
    const err = caught as TRPCError;
    expect(err.code).toBe('FORBIDDEN');
    expect(err.message).toContain('не ваша');
  });

  it('своя заявка проходит молча', () => {
    expect(() => assertEngineerMayEdit(engineer, { assignedEngineerId: ME })).not.toThrow();
  });

  it('диспетчер проходит молча', () => {
    expect(() => assertEngineerMayEdit(dispatcher, { assignedEngineerId: OTHER })).not.toThrow();
  });
});
