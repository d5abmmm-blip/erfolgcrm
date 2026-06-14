/**
 * Готовые шаблоны писем клиентам (Этап A). Плейсхолдеры подставляются на клиенте.
 *
 * Поддерживаемые плейсхолдеры: {{clientName}}, {{ticketNumber}}, {{invoiceNumber}}, {{company}}.
 * Редактируемые из UI шаблоны — отдельная задача (позже).
 */
export interface MailTemplate {
  id: string;
  label: string;
  subject: string;
  body: string;
}

export const MAIL_TEMPLATES: readonly MailTemplate[] = [
  {
    id: 'ticket_ready',
    label: 'Заявка готова',
    subject: 'Заявка № {{ticketNumber}} готова к выдаче',
    body:
      'Здравствуйте, {{clientName}}!\n\n' +
      'Сообщаем, что работы по заявке № {{ticketNumber}} завершены — технику можно забрать.\n' +
      'Если удобно согласовать доставку или у вас остались вопросы — ответьте на это письмо.\n\n' +
      'С уважением,\n{{company}}',
  },
  {
    id: 'invoice',
    label: 'Счёт на оплату',
    subject: 'Счёт на оплату № {{invoiceNumber}}',
    body:
      'Здравствуйте, {{clientName}}!\n\n' +
      'Направляем счёт № {{invoiceNumber}} на оплату (во вложении).\n' +
      'После поступления оплаты приступим к работам / отгрузке.\n\n' +
      'С уважением,\n{{company}}',
  },
  {
    id: 'payment_reminder',
    label: 'Напоминание об оплате',
    subject: 'Напоминание об оплате счёта № {{invoiceNumber}}',
    body:
      'Здравствуйте, {{clientName}}!\n\n' +
      'Напоминаем о необходимости оплаты счёта № {{invoiceNumber}}.\n' +
      'Если оплата уже прошла — просто проигнорируйте это письмо.\n\n' +
      'С уважением,\n{{company}}',
  },
];

/** Подставляет {{placeholder}} значениями из vars (отсутствующие — пустая строка). */
export function applyTemplate(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(/\{\{(\w+)\}\}/g, (_, key: string) => vars[key] ?? '');
}
