/**
 * Счета и долг клиента — на карточке самого клиента.
 *
 * ЧТО БЫЛО. На карточке клиента были реквизиты, контакты и техника. Ни счетов,
 * ни долга. Чтобы ответить на вопрос «сколько эта больница нам должна», человек
 * шёл в «Дебиторку» и искал там нужную строку среди всех.
 * `invoices.listByClient` при этом существует с самого начала.
 *
 * ПОЧЕМУ ДОЛГ СЧИТАЕТСЯ ПО СПИСКУ СТАТУСОВ ИЗ `@erfolg/shared`. Набор
 * «счёт с остатком» — issued / partially_paid / overdue — уже был единым для
 * отчёта «Дебиторка», плитки «Вам должны», кнопки «Напомнить» и частичного
 * индекса в базе, но лежал строкой прямо в SQL. Экран, посчитавший бы долг по
 * своему списку, стал бы вторым определением; так уже расходилось «просрочено»
 * у ТО в пяти местах (#165). Поэтому список переехал в общий пакет, а в
 * репозитории осталось SQL-зеркало, собранное из того же массива.
 *
 * Чего в долге НЕТ: черновиков (клиенту ещё не выставляли — требовать нечего),
 * оплаченных и отменённых.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import {
  RECEIVABLE_INVOICE_STATUSES,
  isReceivableStatus,
  type InvoiceStatus,
} from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { ClientInvoices } from '../components/ClientInvoices';
import { clientDebtKopecks } from '../lib/client-debt';

const CLIENT_ID = 'ffffffff-0000-4000-8000-0000000000d1';

function inv(over: Partial<ReturnType<typeof base>> = {}) {
  return { ...base(), ...over };
}
function base() {
  return {
    id: 'i-1',
    invoiceNumber: 'СЧ-001',
    clientId: CLIENT_ID,
    ticketId: 'ffffffff-0000-4000-8000-0000000000d2',
    workOrderId: 'ffffffff-0000-4000-8000-0000000000d3',
    status: 'issued' as InvoiceStatus,
    vatRate: '5' as const,
    totalAmountKopecks: '10000000',
    vatAmountKopecks: '476190',
    paidAmountKopecks: '0',
    issueDate: '2026-08-01',
    dueDate: '2026-08-15',
    notes: null as string | null,
    issuedAt: new Date('2026-08-01T00:00:00Z'),
    paidAt: null as Date | null,
    cancelledAt: null as Date | null,
    cancelReason: null as string | null,
    lastReminderSentAt: null as Date | null,
  };
}

let answer: unknown[] = [];

function renderBlock() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: (input) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          const paths = (url.split('/trpc/')[1] ?? '').split('?')[0]?.split(',') ?? [];
          const payload = paths.map((p) => ({
            result: { data: superjson.serialize(p === 'invoices.listByClient' ? answer : null) },
          }));
          return Promise.resolve(
            new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <ClientInvoices clientId={CLIENT_ID} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

afterEach(cleanup);

describe('какие счета считаются долгом', () => {
  it('список статусов один и тот же на обоих концах', () => {
    expect([...RECEIVABLE_INVOICE_STATUSES]).toEqual(['issued', 'partially_paid', 'overdue']);
    for (const s of RECEIVABLE_INVOICE_STATUSES) expect(isReceivableStatus(s)).toBe(true);
    for (const s of ['draft', 'paid', 'cancelled'] as const) {
      expect(isReceivableStatus(s)).toBe(false);
    }
  });

  it('долг — остаток по выставленным, частично оплаченным и просроченным', () => {
    const debt = clientDebtKopecks([
      inv({ id: 'a', status: 'issued', totalAmountKopecks: '10000000', paidAmountKopecks: '0' }),
      inv({
        id: 'b',
        status: 'partially_paid',
        totalAmountKopecks: '5000000',
        paidAmountKopecks: '2000000',
      }),
      inv({ id: 'c', status: 'overdue', totalAmountKopecks: '1000000', paidAmountKopecks: '0' }),
    ]);
    expect(debt).toBe(10000000 - 0 + (5000000 - 2000000) + 1000000);
  });

  it('черновик, оплаченный и отменённый в долг не идут', () => {
    const debt = clientDebtKopecks([
      inv({ id: 'a', status: 'draft', totalAmountKopecks: '9900000', paidAmountKopecks: '0' }),
      inv({ id: 'b', status: 'paid', totalAmountKopecks: '8800000', paidAmountKopecks: '8800000' }),
      inv({ id: 'c', status: 'cancelled', totalAmountKopecks: '7700000', paidAmountKopecks: '0' }),
    ]);
    expect(debt).toBe(0);
  });

  it('переплата по счёту не уходит в минус и не гасит долг по другому', () => {
    const debt = clientDebtKopecks([
      inv({
        id: 'a',
        status: 'issued',
        totalAmountKopecks: '1000000',
        paidAmountKopecks: '3000000',
      }),
      inv({ id: 'b', status: 'issued', totalAmountKopecks: '2000000', paidAmountKopecks: '0' }),
    ]);
    expect(debt).toBe(2000000);
  });
});

describe('блок счетов на карточке клиента', () => {
  it('показывает счета и общий долг', async () => {
    answer = [
      inv({ id: 'a', invoiceNumber: 'СЧ-001', status: 'issued' }),
      inv({
        id: 'b',
        invoiceNumber: 'СЧ-002',
        status: 'paid',
        paidAmountKopecks: '10000000',
      }),
    ];
    renderBlock();

    expect(await screen.findByText('СЧ-001')).toBeTruthy();
    expect(screen.getByText('СЧ-002')).toBeTruthy();
    // Долг только по первому: второй оплачен. Суммы в строках таблицы такие же,
    // поэтому проверяем именно подпись долга целиком.
    expect(screen.getByText(/^Долг: /)).toBeTruthy();
    expect(screen.getByText(/^Долг: /).textContent).toMatch(/100\s?000/);
  });

  it('всё оплачено — так и говорим, а не показываем ноль долга молча', async () => {
    answer = [inv({ id: 'b', status: 'paid', paidAmountKopecks: '10000000' })];
    renderBlock();

    expect(await screen.findByText(/Долга нет/)).toBeTruthy();
  });

  it('счетов нет — пишем прямо', async () => {
    answer = [];
    renderBlock();

    expect(await screen.findByText(/Счетов по этому клиенту нет/)).toBeTruthy();
  });
});
