/**
 * Чистые помощники тредов почты (Этап C). Без внешних импортов — легко юнит-тестируются.
 *
 * Тред группируется по корневому Message-ID. Клиенты получателя строят ветку по
 * In-Reply-To / References; мы повторяем ту же логику на своей стороне, чтобы показывать
 * переписку одной цепочкой и навешивать ответы на правильный thread_id.
 */

/**
 * Ключ треда — корневой Message-ID: references[0] || inReplyTo || собственный messageId.
 * references — строка Message-ID через пробел ИЛИ null; берём первый непустой токен.
 */
export function computeThreadId(
  inReplyTo: string | null,
  references: string | null,
  ownMessageId: string | null,
): string | null {
  if (references) {
    const first = references
      .split(/\s+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0)[0];
    if (first) return first;
  }
  if (inReplyTo && inReplyTo.trim()) return inReplyTo.trim();
  if (ownMessageId && ownMessageId.trim()) return ownMessageId.trim();
  return null;
}

/**
 * Нормализует References к одной строке Message-ID через пробел.
 * Массив → join по одному пробелу; строка → как есть (trim); пусто → null.
 */
export function normalizeReferences(refs: string | string[] | null | undefined): string | null {
  if (refs == null) return null;
  if (Array.isArray(refs)) {
    const joined = refs
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(' ');
    return joined.length > 0 ? joined : null;
  }
  const trimmed = refs.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** Тема помечена спамом провайдером: reg.ru вставляет ***SPAM*** в Subject. */
export function isSpamSubject(subject: string | null | undefined): boolean {
  if (!subject) return false;
  return /\*\*\*\s*SPAM\s*\*\*\*/i.test(subject);
}
