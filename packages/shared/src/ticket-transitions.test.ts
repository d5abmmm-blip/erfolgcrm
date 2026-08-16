/**
 * Таблица переходов статусов — одна на сервер и на экран.
 *
 * Тесты держат ровно те случаи, на которых интерфейс расходился с сервером:
 * мобильная кнопка «Готов к акту» из «Диагностики», перетаскивание карточки на
 * канбане в произвольную колонку и кнопки «Закрыть наряд» при любом статусе.
 */
import { describe, it, expect } from 'vitest';
import {
  allowedNextStatuses,
  canTransitionTicket,
  ALLOWED_TICKET_TRANSITIONS,
} from './ticket-transitions';

describe('allowedNextStatuses', () => {
  it('из «Диагностики» нельзя сразу в «Ожидает акта» — только через «В работе»', () => {
    expect(allowedNextStatuses('diagnostics')).toEqual(['in_progress', 'cancelled']);
    expect(canTransitionTicket('diagnostics', 'act_pending')).toBe(false);
    expect(canTransitionTicket('diagnostics', 'in_progress')).toBe(true);
  });

  it('инженеру отмена недоступна, поэтому в его списке её нет', () => {
    expect(allowedNextStatuses('diagnostics', 'engineer')).toEqual(['in_progress']);
    expect(canTransitionTicket('in_progress', 'cancelled', 'engineer')).toBe(false);
    expect(canTransitionTicket('in_progress', 'cancelled', 'dispatcher')).toBe(true);
  });

  it('из «Ожидает акта» можно закрыть, вернуть в работу и отменить', () => {
    expect(allowedNextStatuses('act_pending')).toEqual(['closed', 'in_progress', 'cancelled']);
    // Инженер закрывать заявку не может — закрытие не в его списке.
    expect(allowedNextStatuses('act_pending', 'engineer')).toEqual(['in_progress']);
  });

  it('из закрытой и отменённой ходов нет — только «Переоткрыть» у директора', () => {
    expect(allowedNextStatuses('closed')).toEqual([]);
    expect(allowedNextStatuses('cancelled')).toEqual([]);
  });

  it('«ничего не менять» ошибкой не считается', () => {
    expect(canTransitionTicket('in_progress', 'in_progress')).toBe(true);
    expect(canTransitionTicket('closed', 'closed')).toBe(true);
  });

  it('у каждого статуса есть запись — иначе экран упадёт на неизвестном', () => {
    const statuses = Object.keys(ALLOWED_TICKET_TRANSITIONS);
    expect(statuses).toContain('estimate');
    expect(statuses).toContain('approval');
    for (const s of statuses) {
      expect(Array.isArray(ALLOWED_TICKET_TRANSITIONS[s as never])).toBe(true);
    }
  });
});
