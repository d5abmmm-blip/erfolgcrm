/**
 * Сколько клиент должен по своим счетам.
 *
 * Набор статусов «счёт с остатком» берётся из `@erfolg/shared` — то же самое
 * определение, из которого собран SQL дебиторки, плитки «Вам должны» и кнопки
 * «Напомнить». Своего списка здесь нет сознательно: второй список — это второе
 * определение, а они расходятся (см. «просрочено» у ТО, #165).
 */
import { isReceivableStatus, type InvoiceStatus } from '@erfolg/shared';

export interface InvoiceAmountLike {
  status: InvoiceStatus;
  totalAmountKopecks: string;
  paidAmountKopecks: string;
}

/**
 * Долг в копейках. Остаток по каждому счёту берётся отдельно и не уходит в
 * минус: переплата по одному счёту не гасит долг по другому — ровно так же
 * считается «к выплате» в ведомости зарплаты.
 */
export function clientDebtKopecks(list: readonly InvoiceAmountLike[]): number {
  let debt = 0;
  for (const i of list) {
    if (!isReceivableStatus(i.status)) continue;
    const rest = Number(i.totalAmountKopecks) - Number(i.paidAmountKopecks);
    if (rest > 0) debt += rest;
  }
  return debt;
}
