/**
 * Текстовое описание событий заявки для мобильной «Истории».
 * Статусы и приоритеты берутся из общего словаря — не из локальных копий.
 */
import { describe, expect, it } from 'vitest';
import { describeTicketEvent } from '../lib/ticket-events';

describe('describeTicketEvent', () => {
  it('комментарий отдаёт текст как тело', () => {
    const d = describeTicketEvent({ type: 'note', payload: { comment: 'приехал, жду клиента' } });
    expect(d.title).toBe('Комментарий');
    expect(d.body).toBe('приехал, жду клиента');
  });

  it('смена статуса — человеческие подписи из словаря', () => {
    const d = describeTicketEvent({
      type: 'status_change',
      payload: { from: 'received', to: 'in_progress' },
    });
    expect(d.body).toBe('Принята → В работе');
  });

  it('назначение различает роль', () => {
    expect(
      describeTicketEvent({
        type: 'assignment_change',
        payload: { role: 'dispatcher', from: 'А', to: 'Б' },
      }).title,
    ).toBe('Назначен диспетчер');
    expect(
      describeTicketEvent({ type: 'assignment_change', payload: { from: null, to: 'Б' } }).body,
    ).toBe('— → Б');
  });

  it('печать документа называет бланк', () => {
    expect(
      describeTicketEvent({ type: 'document_printed', payload: { documentKind: 'defect_act' } })
        .title,
    ).toBe('Документ: Дефектный акт');
  });

  it('неизвестный payload не роняет', () => {
    const d = describeTicketEvent({ type: 'status_change', payload: {} });
    expect(d.title).toBe('Статус');
    expect(d.body).toContain('→');
  });
});
