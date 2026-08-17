/**
 * «Своя заявка» для инженера считается одинаково на сервере и на экране.
 *
 * На десктопе второй инженер (помощник) не видел кнопок актов и реквизитов
 * клиента: экран сверял только назначенного, а сервер помощнику всё это отдаёт.
 */
import { describe, it, expect } from 'vitest';
import { ticketBelongsToEngineer } from './ticket-ownership';

describe('ticketBelongsToEngineer', () => {
  it('назначенный инженер — своя заявка', () => {
    expect(ticketBelongsToEngineer('u1', { assignedEngineerId: 'u1' })).toBe(true);
  });

  it('второй инженер — тоже своя: на технику выезжали вдвоём', () => {
    expect(
      ticketBelongsToEngineer('u2', { assignedEngineerId: 'u1', helperEngineerIds: ['u2'] }),
    ).toBe(true);
  });

  it('посторонний инженер — чужая', () => {
    expect(
      ticketBelongsToEngineer('u3', { assignedEngineerId: 'u1', helperEngineerIds: ['u2'] }),
    ).toBe(false);
  });

  it('без пользователя — чужая, а не «всем можно»', () => {
    expect(ticketBelongsToEngineer(null, { assignedEngineerId: null })).toBe(false);
    expect(ticketBelongsToEngineer(undefined, { assignedEngineerId: 'u1' })).toBe(false);
  });
});
