/**
 * Публичный базовый адрес приложения — для ссылок, которые видит клиент
 * (сейчас — трек-ссылка в письме при смене статуса). На проде — https://crm.erfolgmt.ru
 * (задаётся в .env как API_PUBLIC_URL). Если не задан — возвращаем null, и
 * вызывающий деградирует (например, письмо уходит без трек-ссылки).
 */
export function resolvePublicBaseUrl(): string | null {
  const raw = (process.env.API_PUBLIC_URL ?? '').trim();
  if (!raw) return null;
  return raw.replace(/\/+$/, '');
}

/**
 * Полный публичный URL страницы отслеживания заявки по токену.
 * null — если базовый адрес не настроен (тогда ссылку в письмо не вставляем).
 */
export function buildTrackUrl(token: string): string | null {
  const base = resolvePublicBaseUrl();
  if (!base) return null;
  return `${base}/track/${token}`;
}
