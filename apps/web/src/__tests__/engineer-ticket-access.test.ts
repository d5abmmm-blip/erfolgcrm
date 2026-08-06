/**
 * «Своя» заявка инженера в мобильном интерфейсе. Ключевой кейс — ПОМОЩНИК:
 * сервер (assertEngineerOwnsTicket) пускает его к documentClient/recordPrint,
 * а мобильный гейт проверял только ответственного, и помощник не видел
 * кнопок актов и реквизитов клиента.
 */
import { describe, expect, it } from 'vitest';
import { engineerOwnsTicket } from '../lib/engineer-ticket-access';

const engineer = { id: 'u1', role: 'engineer' as const };

describe('engineerOwnsTicket', () => {
  it('ответственный — своя', () => {
    expect(engineerOwnsTicket(engineer, { assignedEngineerId: 'u1' })).toBe(true);
  });

  it('помощник — тоже своя (как на сервере)', () => {
    expect(
      engineerOwnsTicket(engineer, {
        assignedEngineerId: 'u2',
        helperEngineers: [{ userId: 'u3' }, { userId: 'u1' }],
      }),
    ).toBe(true);
  });

  it('чужая и неназначенная — нет', () => {
    expect(engineerOwnsTicket(engineer, { assignedEngineerId: 'u2' })).toBe(false);
    expect(engineerOwnsTicket(engineer, { assignedEngineerId: null })).toBe(false);
    expect(engineerOwnsTicket(engineer, { assignedEngineerId: null, helperEngineers: [] })).toBe(
      false,
    );
  });

  it('директор и диспетчер — без ограничений', () => {
    expect(engineerOwnsTicket({ id: 'x', role: 'director' }, { assignedEngineerId: null })).toBe(
      true,
    );
    expect(engineerOwnsTicket({ id: 'x', role: 'dispatcher' }, { assignedEngineerId: 'u2' })).toBe(
      true,
    );
  });

  it('нет пользователя или заявки — false, а не падение', () => {
    expect(engineerOwnsTicket(undefined, { assignedEngineerId: 'u1' })).toBe(false);
    expect(engineerOwnsTicket(engineer, undefined)).toBe(false);
  });
});
