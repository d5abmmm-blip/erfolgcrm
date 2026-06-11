/**
 * Тесты на сквозную нумерацию заявок (tenant_counters + nextTicketNumber).
 *
 * Покрытие: первый номер за год = 000001; следующий = 000002; параллельные
 * вызовы дают уникальные значения без дыр; счётчик независим per tenant и per year.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { and, eq, gte, like } from 'drizzle-orm';
import { getDb, tenantCounters, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { nextTicketNumber } from '../modules/tickets/repository';

let erfolgId = '';
let demoId = '';

const TEST_YEAR = 2999;

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

async function clearTestCounters(): Promise<void> {
  // Удаляем только счётчики тестового года, чтобы не задеть seed (year=2026).
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx
      .delete(tenantCounters)
      .where(and(eq(tenantCounters.kind, 'ticket'), gte(tenantCounters.year, TEST_YEAR)));
  });
  await withTenantTx(getDb(), demoId, async (tx) => {
    await tx
      .delete(tenantCounters)
      .where(and(eq(tenantCounters.kind, 'ticket'), gte(tenantCounters.year, TEST_YEAR)));
  });
  // Также чистим тикеты с тестовым префиксом (если случайно создались)
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(tickets).where(like(tickets.ticketNumber, `T-${TEST_YEAR}-%`));
  });
}

describe('nextTicketNumber: сквозная нумерация', () => {
  beforeEach(async () => {
    await clearTestCounters();
  });

  it('первый раз для tenant + year = T-{year}-000001', async () => {
    const num = await withTenantTx(getDb(), erfolgId, (tx) =>
      nextTicketNumber(tx, erfolgId, TEST_YEAR),
    );
    expect(num).toBe(`T-${TEST_YEAR}-000001`);
  });

  it('следующий вызов = 000002', async () => {
    const a = await withTenantTx(getDb(), erfolgId, (tx) =>
      nextTicketNumber(tx, erfolgId, TEST_YEAR),
    );
    const b = await withTenantTx(getDb(), erfolgId, (tx) =>
      nextTicketNumber(tx, erfolgId, TEST_YEAR),
    );
    expect(a).toBe(`T-${TEST_YEAR}-000001`);
    expect(b).toBe(`T-${TEST_YEAR}-000002`);
  });

  it('параллельные вызовы дают 5 уникальных номеров без дыр', async () => {
    const numbers = await Promise.all(
      Array.from({ length: 5 }, () =>
        withTenantTx(getDb(), erfolgId, (tx) => nextTicketNumber(tx, erfolgId, TEST_YEAR)),
      ),
    );
    const unique = new Set(numbers);
    expect(unique.size).toBe(5);
    // Должны быть от 000001 до 000005, без пропусков
    const sorted = [...numbers].sort();
    expect(sorted).toEqual([
      `T-${TEST_YEAR}-000001`,
      `T-${TEST_YEAR}-000002`,
      `T-${TEST_YEAR}-000003`,
      `T-${TEST_YEAR}-000004`,
      `T-${TEST_YEAR}-000005`,
    ]);
  });

  it('erfolg и demo имеют независимые счётчики', async () => {
    const ea = await withTenantTx(getDb(), erfolgId, (tx) =>
      nextTicketNumber(tx, erfolgId, TEST_YEAR),
    );
    expect(ea).toBe(`T-${TEST_YEAR}-000001`);
    const da = await withTenantTx(getDb(), demoId, (tx) =>
      nextTicketNumber(tx, demoId, TEST_YEAR),
    );
    expect(da).toBe(`T-${TEST_YEAR}-000001`);
  });

  it('год меняется → счётчик начинается заново', async () => {
    const a = await withTenantTx(getDb(), erfolgId, (tx) =>
      nextTicketNumber(tx, erfolgId, TEST_YEAR),
    );
    expect(a).toBe(`T-${TEST_YEAR}-000001`);
    const b = await withTenantTx(getDb(), erfolgId, (tx) =>
      nextTicketNumber(tx, erfolgId, TEST_YEAR + 1),
    );
    expect(b).toBe(`T-${TEST_YEAR + 1}-000001`);
  });
});
