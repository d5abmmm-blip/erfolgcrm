/**
 * Безопасный показ HTML-писем.
 *
 * Тело входящего письма — недоверенный HTML (риск XSS), поэтому НИКОГДА не вставляем его
 * сырым. Пропускаем через DOMPurify: вырезаются <script>, обработчики on*, javascript:-ссылки,
 * <iframe>/<object>/<embed>/<form>, теги <style>/<link>/<meta>/<base> и inline-стили
 * (чтобы письмо не «уехало» поверх интерфейса через position:fixed и т.п.).
 *
 * Внешние ссылки открываем в новой вкладке с rel=noopener — письмо не получит доступ к
 * window.opener.
 */
import DOMPurify from 'dompurify';

let hooked = false;
function ensureHooks(): void {
  if (hooked) return;
  hooked = true;
  DOMPurify.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A' && node.hasAttribute('href')) {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
  });
}

/** Очистить HTML письма для безопасного показа (dangerouslySetInnerHTML). */
export function sanitizeEmailHtml(html: string): string {
  ensureHooks();
  return DOMPurify.sanitize(html, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'form', 'link', 'meta', 'base'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false,
  });
}
