import { describe, it, expect } from 'vitest';
import { applyTemplate, MAIL_TEMPLATES } from '../lib/mail-templates';

describe('applyTemplate', () => {
  it('подставляет плейсхолдеры', () => {
    expect(
      applyTemplate('Заявка {{ticketNumber}} для {{clientName}}', {
        ticketNumber: 'T-1',
        clientName: 'ООО Тест',
      }),
    ).toBe('Заявка T-1 для ООО Тест');
  });

  it('отсутствующие плейсхолдеры → пустая строка', () => {
    expect(applyTemplate('Привет {{x}}!', {})).toBe('Привет !');
  });

  it('все встроенные шаблоны имеют тему и тело', () => {
    expect(MAIL_TEMPLATES.length).toBeGreaterThan(0);
    for (const t of MAIL_TEMPLATES) {
      expect(t.subject.length).toBeGreaterThan(0);
      expect(t.body.length).toBeGreaterThan(0);
    }
  });

  it('шаблон счёта подставляет номер счёта и компанию', () => {
    const tpl = MAIL_TEMPLATES.find((t) => t.id === 'invoice');
    expect(tpl).toBeTruthy();
    const body = applyTemplate(tpl!.body, {
      clientName: 'ООО Тест',
      invoiceNumber: 'INV-7',
      company: 'ООО Эрфольг',
    });
    expect(body).toContain('INV-7');
    expect(body).toContain('ООО Эрфольг');
    expect(body).not.toContain('{{');
  });
});
