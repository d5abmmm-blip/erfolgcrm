/**
 * Срок по заявке в мобильной очереди инженера.
 *
 * До правки просрочка показывалась только в часах — на телефоне инженера
 * висело «просрочено на 196 ч», что читается как шум. Теперь от двух суток
 * переходим на дни. Будущий срок оставлен как был: до суток — часы, дальше дни.
 */
export function fmtDeadline(d: Date | string | null, now: number = Date.now()): string {
  if (!d) return '';
  const date = typeof d === 'string' ? new Date(d) : d;
  const diffH = Math.round((date.getTime() - now) / 3_600_000);
  if (diffH < 0) {
    const h = Math.abs(diffH);
    if (h < 48) return `просрочено на ${h} ч`;
    return `просрочено на ${Math.round(h / 24)} дн`;
  }
  if (diffH < 24) return `осталось ${diffH} ч`;
  return `осталось ${Math.round(diffH / 24)} дн`;
}
