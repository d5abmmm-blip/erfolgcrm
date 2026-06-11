/**
 * Маскирование PII в логах.
 * 152-ФЗ: email/телефоны/ФИО в логах — это утечка ПДн оператора.
 * Маскируем так, чтобы можно было найти конкретного человека по hash'у при разборе инцидента,
 * но без реальных данных в общих логах (Sentry/CloudWatch/etc).
 */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '<no-email>';
  const at = email.indexOf('@');
  if (at < 1) return '***';
  const user = email.slice(0, at);
  const domain = email.slice(at + 1);
  const visible = user.length <= 2 ? user[0] : user.slice(0, 2);
  return `${visible}***@${domain}`;
}

export function maskPhone(phone: string | null | undefined): string {
  if (!phone) return '<no-phone>';
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return '***';
  return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}

export function maskName(fullName: string | null | undefined): string {
  if (!fullName) return '<no-name>';
  const parts = fullName.trim().split(/\s+/);
  return parts.map((p) => p[0] + '.').join(' ');
}

/**
 * Паспорт: видны последние 2 цифры, остальное скрыто.
 * Серия+номер часто пишут разными форматами ("1234 567890" / "1234567890" / "1234-567890").
 * Чистим всё кроме цифр.
 */
export function maskPassport(passport: string | null | undefined): string {
  if (!passport) return '<no-passport>';
  const digits = passport.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `***${digits.slice(-2)}`;
}

/**
 * ИНН: первые 2 цифры (регион) + маска. Длина ИНН 10 (юрлицо) или 12 (физлицо).
 */
export function maskInn(inn: string | null | undefined): string {
  if (!inn) return '<no-inn>';
  const digits = inn.replace(/\D/g, '');
  if (digits.length < 4) return '***';
  return `${digits.slice(0, 2)}***${digits.slice(-2)}`;
}

/**
 * Block A: маскирование чувствительных полей в произвольном объекте контекста.
 * Возвращает новый объект — оригинал не мутирует.
 *
 * Пример:
 *   maskPiiInContext({ email: 'a@b.ru', other: 1 }) ⇒ { email: 'a***@b.ru', other: 1 }
 */
export function maskPiiInContext(
  ctx: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null | undefined {
  if (!ctx) return ctx;
  const out: Record<string, unknown> = { ...ctx };
  for (const key of Object.keys(out)) {
    const v = out[key];
    if (typeof v !== 'string') continue;
    const k = key.toLowerCase();
    if (k === 'email' || k.endsWith('email')) out[key] = maskEmail(v);
    else if (k === 'phone' || k.endsWith('phone')) out[key] = maskPhone(v);
    else if (k === 'passport' || k.endsWith('passport')) out[key] = maskPassport(v);
    else if (k === 'inn' || k.endsWith('inn')) out[key] = maskInn(v);
  }
  return out;
}
