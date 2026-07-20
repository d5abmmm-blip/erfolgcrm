/**
 * Отображаемое имя физлица из ФИО.
 *
 * Вынесено из clients/router.ts, потому что то же самое понадобилось при
 * переводе лида в клиента. В проекте уже была третья копия этой логики
 * (telegram/handler.ts) — четвёртую заводить нельзя, они разъедутся.
 */

/** «Иванов Иван Иванович» → «Иванов И.И.». Безопасно для одного слова. */
export function buildDisplayNameFromFio(fio: string): string {
  const parts = fio.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  const surname = parts[0]!;
  const initials = parts
    .slice(1)
    .map((p) => `${p[0]!.toUpperCase()}.`)
    .join('');
  return `${surname} ${initials}`;
}
