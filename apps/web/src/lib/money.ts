/**
 * Хелперы преобразования копеек ↔ рублей. Копейки приходят как строка (bigint
 * сериализуется через superjson + JSON), форматируем для русской локали.
 *
 * Если у тебя сумма в копейках (string или bigint) — используй formatRub/formatRubWhole.
 * Для числа в рублях — используй formatRubFromNumber.
 */

/** Внутренний хелпер: копейки в рубли (число) */
function kopecksToRubNumber(kopecks: bigint | number | string): number {
  if (typeof kopecks === 'bigint') return Number(kopecks) / 100;
  if (typeof kopecks === 'number') return kopecks / 100;
  const n = Number(kopecks);
  if (Number.isNaN(n)) return 0;
  return n / 100;
}

/**
 * Форматирует копейки в "1 234,56 ₽" (с двумя знаками после запятой).
 * Это основной формат — для счетов, нарядов, платежей.
 */
export function formatRub(amountKopecks: bigint | number | string): string {
  const rub = kopecksToRubNumber(amountKopecks);
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(rub);
}

/**
 * Форматирует копейки без копеек: "1 235 ₽" — для крупных сумм в дашборде,
 * где две дробные цифры мешают читать ряды.
 */
export function formatRubWhole(amountKopecks: bigint | number | string): string {
  const rub = kopecksToRubNumber(amountKopecks);
  return new Intl.NumberFormat('ru-RU', {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 0,
  }).format(rub);
}

/** Форматирует копейки-в-string в "12 345,67" (без символа валюты). */
export function kopecksToRub(s: string): string {
  if (!s) return '0,00';
  const neg = s.startsWith('-');
  const raw = neg ? s.slice(1) : s;
  const padded = raw.padStart(3, '0');
  const intPart = padded.slice(0, -2);
  const fracPart = padded.slice(-2);
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${grouped},${fracPart}`;
}

/** Преобразует копейки-в-string в число рублей (для input type=number). */
export function kopecksToRubInput(s: string): string {
  if (!s) return '0';
  try {
    const big = BigInt(s);
    const rub = big / 100n;
    return rub.toString();
  } catch {
    return '0';
  }
}
