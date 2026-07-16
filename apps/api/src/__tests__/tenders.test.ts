/**
 * Тендеры (tenders + tender_payments):
 *   • createTender/getTender: суммы, «оплачено X из Y», остаток;
 *   • платежи частями: add/delete пересчитывают paid/rest;
 *   • summary за период: суммы/оплачено/ожидаем/кол-во, расторгнутые исключены;
 *   • мягкое удаление прячет тендер из списка.
 * Изоляция: contract_date в будущем месяце 2099-07; чистка по префиксу номера.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like, sql } from 'drizzle-orm';
import { getDb, tenders, withTenantTx } from '@erfolg/db';
import { uuidv7 } from 'uuidv7';
import { ensureSeed } from './setup';
import {
  addTenderPayment,
  createTender,
  deleteTender,
  deleteTenderPayment,
  getTender,
  listTenders,
  setTenderStatus,
  tendersSummary,
} from '../modules/tenders/repository';

let erfolgId = '';
const PREFIX = 'TESTTND-';
const PERIOD = { from: '2099-07-01', to: '2099-07-31' };

beforeAll(async () => {
  erfolgId = (await ensureSeed()).erfolgId;
});

async function clearTestData(): Promise<void> {
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.execute(sql`
      DELETE FROM tender_payments
      WHERE tender_id IN (SELECT id FROM tenders WHERE contract_number LIKE ${PREFIX + '%'})
    `);
    await tx.delete(tenders).where(like(tenders.contractNumber, `${PREFIX}%`));
  });
}

const baseTender = (num: string, amountKopecks: bigint) => ({
  clientId: uuidv7(),
  contractNumber: `${PREFIX}${num}`,
  purchaseNumber: null,
  amountKopecks,
  contractDate: '2099-07-10',
  dueDate: null,
  comment: null,
  createdBy: null,
});

describe('тендеры', () => {
  beforeEach(clearTestData);

  it('создание, платежи частями и остаток', async () => {
    const db = getDb();
    const { id } = await createTender(db, erfolgId, baseTender('01', 50_000_000n)); // 500 000 ₽

    let t = await getTender(db, erfolgId, id);
    expect(t).not.toBeNull();
    expect(t!.amountKopecks).toBe('50000000');
    expect(t!.paidKopecks).toBe('0');
    expect(t!.restKopecks).toBe('50000000');

    await addTenderPayment(db, erfolgId, {
      tenderId: id,
      amountKopecks: 20_000_000n,
      paidOn: '2099-07-15',
      note: 'аванс',
    });
    const p2 = await addTenderPayment(db, erfolgId, {
      tenderId: id,
      amountKopecks: 10_000_000n,
      paidOn: '2099-07-20',
      note: null,
    });

    t = await getTender(db, erfolgId, id);
    expect(t!.paidKopecks).toBe('30000000'); // 300 000 ₽
    expect(t!.restKopecks).toBe('20000000'); // 200 000 ₽
    expect(t!.payments).toHaveLength(2);

    await deleteTenderPayment(db, erfolgId, p2.id);
    t = await getTender(db, erfolgId, id);
    expect(t!.paidKopecks).toBe('20000000');
    expect(t!.payments).toHaveLength(1);
  });

  it('summary за период: суммы/оплачено/ожидаем, расторгнутые исключены', async () => {
    const db = getDb();
    const a = await createTender(db, erfolgId, baseTender('A', 100_000_000n)); // 1 000 000 ₽
    await createTender(db, erfolgId, baseTender('B', 30_000_000n)); // 300 000 ₽
    const c = await createTender(db, erfolgId, baseTender('C', 999_000_000n)); // расторгнем
    await setTenderStatus(db, erfolgId, c.id, 'cancelled');
    await addTenderPayment(db, erfolgId, {
      tenderId: a.id,
      amountKopecks: 40_000_000n,
      paidOn: '2099-07-12',
      note: null,
    });

    const s = await tendersSummary(db, erfolgId, PERIOD);
    expect(s.amountKopecks).toBe('130000000'); // A + B, без C
    expect(s.paidKopecks).toBe('40000000');
    expect(s.outstandingKopecks).toBe('90000000');
    expect(s.count).toBe(2);
  });

  it('мягкое удаление прячет тендер из списка', async () => {
    const db = getDb();
    const { id } = await createTender(db, erfolgId, baseTender('D', 1_000_00n));
    let list = await listTenders(db, erfolgId, { ...PERIOD, search: PREFIX });
    expect(list.items.some((x) => x.id === id)).toBe(true);

    await deleteTender(db, erfolgId, id);
    list = await listTenders(db, erfolgId, { ...PERIOD, search: PREFIX });
    expect(list.items.some((x) => x.id === id)).toBe(false);
    expect(await getTender(db, erfolgId, id)).toBeNull();
  });
});
