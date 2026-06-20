/** Метки кассы (ДДС) — типы счетов и операций. Источник истины — enum'ы schema/cash.ts. */

export type CashAccountKind = 'cash' | 'bank' | 'card';
export type CashTxKind = 'income' | 'expense' | 'transfer';

export const CASH_ACCOUNT_KIND_LABEL: Record<CashAccountKind, string> = {
  cash: 'Наличные',
  bank: 'Расчётный счёт',
  card: 'Карта',
};

/** Метаданные типа операции: подпись, знак суммы и цвет (цвет = смысл). */
export const CASH_TX_KIND_META: Record<
  CashTxKind,
  { label: string; sign: string; cls: string }
> = {
  income: { label: 'Доход', sign: '+', cls: 'text-success' },
  expense: { label: 'Расход', sign: '−', cls: 'text-destructive' },
  transfer: { label: 'Перевод', sign: '', cls: 'text-muted-foreground' },
};

/** Метод оплаты по умолчанию → подпись (для настройки счёта). */
export const PAYMENT_METHOD_LABEL: Record<'cash' | 'card' | 'bank_transfer', string> = {
  cash: 'Наличные',
  card: 'Карта',
  bank_transfer: 'Перевод (банк)',
};
