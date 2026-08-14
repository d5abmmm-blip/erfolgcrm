/**
 * Текстовое описание событий заявки для мобильной «Истории».
 * Статусы и приоритеты берутся из общего словаря — не из локальных копий.
 */
import { describe, expect, it } from 'vitest';
import { describeTicketEvent, eventPriorityLabel, eventStatusLabel } from '../lib/ticket-events';

/**
 * Перенесённые заявки хранят историю статусов БЕЗ поля «из какого» и со статусами
 * старой программы, которых в CRM нет. Десктопная карточка печатала это буквально:
 * «undefined → Аппарат готов». Подписи обязаны переживать и пустое значение, и
 * незнакомое.
 */
describe('подписи событий переживают данные старой системы', () => {
  it('отсутствующее значение — прочерк, а не слово «undefined»', () => {
    expect(eventStatusLabel(undefined)).toBe('—');
    expect(eventStatusLabel(null)).toBe('—');
    expect(eventPriorityLabel(undefined)).toBe('—');
  });

  it('незнакомый статус старой программы показываем как есть, а не как «undefined»', () => {
    expect(eventStatusLabel('Аппарат готов')).toBe('Аппарат готов');
  });

  it('свои статусы и приоритеты переводятся по словарю', () => {
    expect(eventStatusLabel('in_progress')).toBe('В работе');
    expect(eventPriorityLabel('urgent')).toBeTruthy();
  });
});

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
