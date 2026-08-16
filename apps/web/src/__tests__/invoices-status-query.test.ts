/**
 * Фильтр статуса на экране счетов берётся из адресной строки.
 *
 * ЗАЧЕМ. Плитки «Дебиторка» и «Просрочено» на главной ведут на /invoices?status=overdue,
 * а страница счетов держала фильтр в useState('') и адресную строку не читала вовсе —
 * открывался полный список. Директор жал «Просрочено», видел все счета подряд и делал
 * вывод, что просрочены все.
 */
import { describe, it, expect } from 'vitest';
import { invoiceStatusFromQuery } from '../pages/InvoicesPage';

describe('invoiceStatusFromQuery', () => {
  it('берёт статус из адреса — тот самый переход с плитки «Просрочено»', () => {
    expect(invoiceStatusFromQuery('?status=overdue')).toBe('overdue');
    expect(invoiceStatusFromQuery('?status=paid')).toBe('paid');
    expect(invoiceStatusFromQuery('?status=partially_paid')).toBe('partially_paid');
  });

  it('без параметра — все счета, как и было', () => {
    expect(invoiceStatusFromQuery('')).toBe('');
    expect(invoiceStatusFromQuery('?page=2')).toBe('');
  });

  it('незнакомый статус не притворяется фильтром', () => {
    expect(invoiceStatusFromQuery('?status=выдуманный')).toBe('');
    expect(invoiceStatusFromQuery('?status=')).toBe('');
  });
});
