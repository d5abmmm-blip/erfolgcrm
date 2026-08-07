/**
 * Человеческий текст вместо «Failed to fetch» и «storage PUT 403».
 * Инженер в поле должен понимать, что делать, а не что сломалось.
 *
 * Живёт отдельно от экрана: этим же текстом подписываются фото, упавшие при
 * фоновой отправке из очереди, когда никакого экрана рядом нет.
 */
export function humanUploadError(err: unknown): string {
  const raw = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (!navigator.onLine || raw.includes('Failed to fetch') || raw.includes('NetworkError')) {
    return 'Нет связи — фото не отправлено';
  }
  if (/storage PUT (401|403)/.test(raw))
    return 'Хранилище отклонило файл — позовите администратора';
  if (/storage PUT 4\d\d/.test(raw)) return 'Файл не принят хранилищем';
  if (/storage PUT 5\d\d/.test(raw)) return 'Хранилище недоступно — повторите';
  return raw || 'Не удалось отправить фото';
}
