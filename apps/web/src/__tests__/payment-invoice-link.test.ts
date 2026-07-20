/**
 * Привязка платежа к счёту (карточка заявки).
 *
 * Зачем: раньше форма платежа не слала invoiceId вообще — счёт оставался
 * неоплаченным, попадал в дебиторку и робот слал напоминание клиенту, который
 * уже заплатил. Здесь проверяем два решения формы: какие счета вообще можно
 * гасить и какой подставить по умолчанию.
 */
import { describe, expect, it } from 'vitest';
import { defaultInvoiceId, NO_INVOICE, payableInvoices } from '../components/TicketPayments';

const inv = (id: string, status: string) => ({ id, status });

describe('payableInvoices', () => {
  it('берёт ровно те статусы, что попадают в дебиторку', () => {
    const all = [
      inv('a', 'issued'),
      inv('b', 'partially_paid'),
      inv('c', 'overdue'),
      inv('d', 'draft'),
      inv('e', 'paid'),
      inv('f', 'cancelled'),
    ];
    expect(payableInvoices(all).map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('черновик не предлагается — сервер его отклонит', () => {
    expect(payableInvoices([inv('d', 'draft')])).toEqual([]);
  });

  it('отменённый не предлагается — оживлять его оплатой нельзя', () => {
    expect(payableInvoices([inv('f', 'cancelled')])).toEqual([]);
  });

  it('полностью оплаченный больше не предлагается', () => {
    expect(payableInvoices([inv('e', 'paid')])).toEqual([]);
  });

  it('пустой список счетов не ломает форму', () => {
    expect(payableInvoices([])).toEqual([]);
  });
});

describe('defaultInvoiceId', () => {
  it('единственный ждущий счёт подставляется сам — это и есть починка', () => {
    expect(defaultInvoiceId([inv('a', 'issued')])).toBe('a');
  });

  it('когда счетов несколько — не угадываем, выбирает человек', () => {
    expect(defaultInvoiceId([inv('a', 'issued'), inv('b', 'overdue')])).toBe(NO_INVOICE);
  });

  it('когда счетов нет — платёж без счёта, как раньше', () => {
    expect(defaultInvoiceId([])).toBe(NO_INVOICE);
  });

  it('частично оплаченный счёт тоже подставляется — доплату надо привязать', () => {
    const payable = payableInvoices([inv('a', 'partially_paid'), inv('b', 'paid')]);
    expect(defaultInvoiceId(payable)).toBe('a');
  });
});
