/**
 * Чистые помощники для ответа/пересылки писем (Этап C). Без зависимостей и побочных
 * эффектов — легко покрываются unit-тестами. Весь текст — на русском (как видит менеджер).
 *
 * Формат даты — простой `dd.MM.yyyy HH:mm` (локаль ru-RU неявно через ручную сборку,
 * чтобы не тащить formatter и не зависеть от окружения тестов).
 */

/** `dd.MM.yyyy HH:mm` или null, если дата пустая/невалидная. */
function fmtQuoteDate(d: Date | string | null): string | null {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(date.getDate())}.${p(date.getMonth() + 1)}.${date.getFullYear()} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/** Каждую строку тела — с префиксом «> ». Пустой/нулевой текст → ничего не цитируем. */
function quoteLines(bodyText: string | null): string {
  if (!bodyText) return '';
  return bodyText
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}

/**
 * Тело ответа: пустые строки сверху + строка-атрибуция + процитированное тело.
 *  → "\n\n<dd.MM.yyyy HH:mm>, <from> писал(а):\n> line1\n> line2…"
 * Если даты нет — опускаем её часть; если тела нет — цитировать нечего.
 */
export function buildReplyBody(o: {
  from: string | null;
  date: Date | string | null;
  bodyText: string | null;
}): string {
  const who = o.from?.trim() || 'отправитель';
  const date = fmtQuoteDate(o.date);
  const attribution = date ? `${date}, ${who} писал(а):` : `${who} писал(а):`;
  const quoted = quoteLines(o.bodyText);
  return `\n\n${attribution}\n${quoted}`;
}

/**
 * Тело пересылки: заголовочный блок «Пересланное сообщение» + исходное тело как есть.
 *  → "\n\n---------- Пересланное сообщение ----------\nОт: …\nДата: …\nКому: …\nТема: …\n\n<bodyText>"
 */
export function buildForwardBody(o: {
  from: string | null;
  to: string | null;
  date: Date | string | null;
  subject: string | null;
  bodyText: string | null;
}): string {
  const date = fmtQuoteDate(o.date);
  const lines = [
    '---------- Пересланное сообщение ----------',
    `От: ${o.from?.trim() || '—'}`,
    `Дата: ${date ?? '—'}`,
    `Кому: ${o.to?.trim() || '—'}`,
    `Тема: ${o.subject?.trim() || '(без темы)'}`,
  ];
  return `\n\n${lines.join('\n')}\n\n${o.bodyText ?? ''}`;
}

/**
 * Заголовок References для треда: все References родителя + Message-ID родителя.
 * Разбиваем по пробельным символам, убираем пустые, дедуплицируем с сохранением порядка.
 */
export function buildReferences(
  parentReferences: string | null,
  parentMessageId: string | null,
): string[] {
  const raw = [...(parentReferences ?? '').split(/\s+/), parentMessageId ?? ''];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** «Re: X», но без удвоения префикса (регистронезависимо). Пустая тема → «Re:». */
export function replySubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  if (/^re:/i.test(s)) return s;
  return s ? `Re: ${s}` : 'Re:';
}

/** «Fwd: X», но без удвоения префикса (регистронезависимо). Пустая тема → «Fwd:». */
export function forwardSubject(subject: string | null): string {
  const s = (subject ?? '').trim();
  if (/^fwd:/i.test(s)) return s;
  return s ? `Fwd: ${s}` : 'Fwd:';
}
