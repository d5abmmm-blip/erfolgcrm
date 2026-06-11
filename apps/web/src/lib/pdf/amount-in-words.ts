/**
 * Convert a kopecks amount to a Russian "пропись" string,
 * e.g. 1234567 → "Двенадцать тысяч триста сорок пять рублей 67 копеек".
 *
 * Simplified MVP implementation — handles up to 999 999 999 999,99
 * (hundreds of billions of roubles), which is far more than any realistic
 * service-centre invoice.
 */

const UNITS_M = [
  '',
  'один',
  'два',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
];

const UNITS_F = [
  '',
  'одна',
  'две',
  'три',
  'четыре',
  'пять',
  'шесть',
  'семь',
  'восемь',
  'девять',
];

const TEENS = [
  'десять',
  'одиннадцать',
  'двенадцать',
  'тринадцать',
  'четырнадцать',
  'пятнадцать',
  'шестнадцать',
  'семнадцать',
  'восемнадцать',
  'девятнадцать',
];

const TENS = [
  '',
  '',
  'двадцать',
  'тридцать',
  'сорок',
  'пятьдесят',
  'шестьдесят',
  'семьдесят',
  'восемьдесят',
  'девяносто',
];

const HUNDREDS = [
  '',
  'сто',
  'двести',
  'триста',
  'четыреста',
  'пятьсот',
  'шестьсот',
  'семьсот',
  'восемьсот',
  'девятьсот',
];

type Gender = 'm' | 'f';

/** Convert a 0..999 group to words, picking units gender (m/f). */
function groupToWords(n: number, gender: Gender): string {
  if (n === 0) return '';
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const t = Math.floor((n % 100) / 10);
  const u = n % 10;
  if (h > 0) parts.push(HUNDREDS[h] ?? '');
  if (t === 1) {
    parts.push(TEENS[u] ?? '');
  } else {
    if (t > 0) parts.push(TENS[t] ?? '');
    if (u > 0) parts.push((gender === 'f' ? UNITS_F[u] : UNITS_M[u]) ?? '');
  }
  return parts.join(' ');
}

/** Pick correct plural form: 1 — one, 2..4 — few, 5..0/11..14 — many. */
function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

interface ScaleEntry {
  one: string;
  few: string;
  many: string;
  gender: Gender;
}

const SCALES: ScaleEntry[] = [
  { one: '', few: '', many: '', gender: 'm' }, // units (rubles handled separately)
  { one: 'тысяча', few: 'тысячи', many: 'тысяч', gender: 'f' },
  { one: 'миллион', few: 'миллиона', many: 'миллионов', gender: 'm' },
  { one: 'миллиард', few: 'миллиарда', many: 'миллиардов', gender: 'm' },
];

/** Capitalise first letter of a string (unicode-safe enough for Cyrillic). */
function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/** Convert integer roubles to Russian words (without "рублей" suffix). */
function rublesIntegerToWords(rub: number): string {
  if (rub === 0) return 'ноль';
  const groups: number[] = [];
  let n = rub;
  while (n > 0) {
    groups.push(n % 1000);
    n = Math.floor(n / 1000);
  }
  // groups[0] is units, [1] thousands, [2] millions, [3] billions
  const parts: string[] = [];
  for (let i = groups.length - 1; i >= 0; i--) {
    const g = groups[i];
    if (g === undefined || g === 0) continue;
    const scale = SCALES[i];
    if (!scale) continue;
    const gender: Gender = i === 0 ? 'm' : scale.gender;
    parts.push(groupToWords(g, gender));
    if (i > 0) parts.push(plural(g, scale.one, scale.few, scale.many));
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Convert an integer kopecks amount to a Russian "пропись" line.
 * Example: 1234567 → "Двенадцать тысяч триста сорок пять рублей 67 копеек".
 */
export function amountInWords(kopecks: number): string {
  const total = Math.max(0, Math.round(kopecks));
  const rub = Math.floor(total / 100);
  const kop = total % 100;
  const rubWords = rublesIntegerToWords(rub);
  const rubSuffix = plural(rub, 'рубль', 'рубля', 'рублей');
  const kopStr = String(kop).padStart(2, '0');
  const kopSuffix = plural(kop, 'копейка', 'копейки', 'копеек');
  return `${capitalize(rubWords)} ${rubSuffix} ${kopStr} ${kopSuffix}`;
}
