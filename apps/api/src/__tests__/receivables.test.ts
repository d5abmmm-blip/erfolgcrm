/**
 * Фича №10 «Дебиторка»:
 *   • receivablesReport — разбивка по срокам (aging), сводка, группировка по клиентам;
 *     считает по due_date (не по статусу-флагу), исключает оплаченные/черновики/отменённые.
 *   • listClientOverdueInvoices — только просроченные счета клиента (для кнопки «Напомнить»).
 *   • sendInvoiceReminder — общий код письма: шлёт, помечает reminderCount, игнорирует cooldown,
 *     пропускает клиента без email.
 *
 * Изоляция под ПАРАЛЛЕЛЬНЫЙ прогон тест-файлов на общей БД (vitest гонит файлы параллельно):
 *   • per-client проверки — по строке своего свежесозданного клиента (точные значения);
 *   • tenant-wide aging/summary — АБСОЛЮТНЫЕ `>=` (свои счета дают гарантированный минимум,
 *     их никто не удалит; before/after дельты были бы флаки — соседний файл добавляет/оплачивает).
 * Клиентов НЕ удаляем в cleanup (граф FK вокруг clients большой) — это безвредно: после чистки
 * счетов у них нет остатка, в дебиторку они не попадают.
 *
 * sendMail замокан через __setTransporterForTesting (как в invoice-reminder.test.ts).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, like } from 'drizzle-orm';
import {
  getDb,
  invoices,
  payments,
  tickets,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { archiveClient, createClient } from '../modules/clients/repository';
import { createTicket } from '../modules/tickets/repository';
import { getOrCreateWorkOrder, upsertLine } from '../modules/work-orders/repository';
import {
  createDraft,
  listClientOverdueInvoices,
  receivablesReport,
  transitionToIssued,
} from '../modules/invoices/repository';
import { sendInvoiceReminder } from '../modules/invoices/reminder';
import { sendReminderCmd } from '../modules/invoices/service';
import { addPayment } from '../modules/payments/repository';
import { __setTransporterForTesting } from '../lib/mailer';
import { getRedis } from '../lib/redis';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

let erfolgId = '';
let seedUserId = '';
let clientSeq = 0;

const TEST_PREFIX = 'TESTAR-';
const PRICE = 100_000n; // 1000 ₽ на счёт
const sentMail: Array<{ to: string; subject: string }> = [];

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  // Любой активный пользователь тенанта — для userId в CmdCtx (аудит ручного напоминания).
  const [u] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.tenantId, erfolgId)).limit(1),
  );
  seedUserId = u?.id ?? '';

  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (opts: any) => {
      sentMail.push({ to: opts.to, subject: opts.subject });
      return { messageId: `mock-${sentMail.length}` };
    }),
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterAll(() => {
  __setTransporterForTesting(null);
});

async function clearTestData(): Promise<void> {
  sentMail.length = 0;
  // Клиентов НЕ трогаем (FK-граф вокруг clients большой). Чистим только счета/тикеты/платежи
  // по префиксу — этого достаточно, чтобы прошлые прогоны не оставляли остатков в дебиторке.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(payments).where(like(payments.comment, `${TEST_PREFIX}%`));
    await tx.delete(invoices).where(like(invoices.notes, `${TEST_PREFIX}%`));
    await tx.delete(tickets).where(like(tickets.symptom, `${TEST_PREFIX}%`));
  });
}

async function makeDebtorClient(email: string | null): Promise<string> {
  clientSeq += 1;
  const { id } = await createClient(getDb(), erfolgId, {
    type: 'legal',
    displayName: `${TEST_PREFIX}debtor-${Date.now()}-${clientSeq}`,
    email,
  });
  return id;
}

/** Создаёт выставленный счёт клиенту с due_date = сегодня + offset дней (offset<0 = просрочен). */
async function makeInvoice(
  clientId: string,
  dueDaysOffset: number,
): Promise<{ invoiceId: string; ticketId: string }> {
  const { id: ticketId } = await createTicket(getDb(), erfolgId, null, {
    clientId,
    symptom: `${TEST_PREFIX}flow`,
  });
  const wo = await getOrCreateWorkOrder(getDb(), erfolgId, ticketId);
  await upsertLine(getDb(), erfolgId, wo.id, null, {
    lineType: 'work',
    name: `${TEST_PREFIX}work`,
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: PRICE,
  });
  const draft = await createDraft(getDb(), erfolgId, {
    workOrderId: wo.id,
    notes: `${TEST_PREFIX}inv`,
  });
  const issued = await transitionToIssued(getDb(), erfolgId, draft.id, {});
  if (!issued) throw new Error('issue failed');
  const due = new Date(Date.now() + dueDaysOffset * 86_400_000).toISOString().slice(0, 10);
  // issue_date заведомо раньше любого due (constraint due_date >= issue_date).
  const issue = new Date(Date.now() - 400 * 86_400_000).toISOString().slice(0, 10);
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.update(invoices).set({ dueDate: due, issueDate: issue }).where(eq(invoices.id, issued.id));
  });
  return { invoiceId: issued.id, ticketId };
}

function big(v: string): bigint {
  return BigInt(v);
}

function makeCmdCtx(tenantId: string) {
  const tenant: ResolvedTenant = {
    id: tenantId,
    subdomain: 'test',
    displayName: 'test',
    status: 'active',
    timezone: 'Europe/Moscow',
    kmsKeyId: null,
  };
  const session: SessionData = {
    tenantId,
    userId: seedUserId,
    username: 'test',
    role: 'dispatcher',
    fullName: 'Test User',
    expiresAt: Date.now() + 60_000,
  };
  return { db: getDb(), tenant, session, audit: { ip: null, userAgent: null } };
}

const reminderLockKey = (tenantId: string, invoiceId: string) =>
  `erfolg:invoice-reminder-lock:${tenantId}:${invoiceId}`;

describe('receivables — Дебиторка (фича №10)', () => {
  beforeEach(clearTestData);

  it('aging: мои счета попадают в корзины сроков, сводка их учитывает', async () => {
    const clientId = await makeDebtorClient('debtor@example.com');
    await makeInvoice(clientId, 10); // срок не наступил
    await makeInvoice(clientId, -5); // 1–30 дней
    await makeInvoice(clientId, -45); // 31–60 дней
    await makeInvoice(clientId, -90); // 60+ дней

    const r = await receivablesReport(getDb(), erfolgId);

    // Абсолютные минимумы: в каждой корзине есть хотя бы мой счёт (свои счета никто не удалит).
    expect(r.aging.notDue.count).toBeGreaterThanOrEqual(1);
    expect(big(r.aging.notDue.sumKopecks) >= PRICE).toBe(true);
    expect(r.aging.d1_30.count).toBeGreaterThanOrEqual(1);
    expect(big(r.aging.d1_30.sumKopecks) >= PRICE).toBe(true);
    expect(r.aging.d31_60.count).toBeGreaterThanOrEqual(1);
    expect(big(r.aging.d31_60.sumKopecks) >= PRICE).toBe(true);
    expect(r.aging.d60plus.count).toBeGreaterThanOrEqual(1);
    expect(big(r.aging.d60plus.sumKopecks) >= PRICE).toBe(true);

    // Сводка учитывает мои 4 счёта (всего) и 3 просроченных.
    expect(big(r.summary.totalOutstandingKopecks) >= PRICE * 4n).toBe(true);
    expect(big(r.summary.overdueOutstandingKopecks) >= PRICE * 3n).toBe(true);
    expect(r.summary.debtorCount).toBeGreaterThanOrEqual(1);
    expect(r.summary.invoiceCount).toBeGreaterThanOrEqual(4);
    expect(r.summary.overdueInvoiceCount).toBeGreaterThanOrEqual(3);
  });

  it('группирует по клиенту: всего/просрочено/кол-во/макс.просрочка — точно', async () => {
    const clientId = await makeDebtorClient('grouped@example.com');
    await makeInvoice(clientId, 10);
    await makeInvoice(clientId, -5);
    await makeInvoice(clientId, -90);

    const report = await receivablesReport(getDb(), erfolgId);
    const row = report.debtors.find((d) => d.clientId === clientId);
    expect(row).toBeDefined();
    if (!row) return;
    expect(big(row.totalOwedKopecks)).toBe(PRICE * 3n);
    expect(big(row.overdueOwedKopecks)).toBe(PRICE * 2n);
    expect(row.invoiceCount).toBe(3);
    expect(row.overdueInvoiceCount).toBe(2);
    expect(row.maxDaysOverdue).toBeGreaterThanOrEqual(60);
    expect(row.clientEmail).toBe('grouped@example.com');
  });

  it('оплаченный счёт исчезает из дебиторки', async () => {
    const clientId = await makeDebtorClient('paid@example.com');
    const { invoiceId, ticketId } = await makeInvoice(clientId, -5);

    let report = await receivablesReport(getDb(), erfolgId);
    expect(report.debtors.some((d) => d.clientId === clientId)).toBe(true);

    // Полная оплата → status paid, остаток 0 → не дебиторка.
    await addPayment(getDb(), erfolgId, {
      ticketId,
      invoiceId,
      amountKopecks: PRICE,
      method: 'bank_transfer',
      paidAt: new Date(),
      comment: `${TEST_PREFIX}pay`,
      userId: null,
    });

    report = await receivablesReport(getDb(), erfolgId);
    expect(report.debtors.some((d) => d.clientId === clientId)).toBe(false);
  });

  it('listClientOverdueInvoices — только просроченные счета клиента', async () => {
    const clientId = await makeDebtorClient('overdue-only@example.com');
    await makeInvoice(clientId, 10); // не просрочен — не должен попасть
    await makeInvoice(clientId, -5);
    await makeInvoice(clientId, -20);

    const list = await listClientOverdueInvoices(getDb(), erfolgId, clientId);
    expect(list).toHaveLength(2);
    expect(list.every((i) => new Date(i.dueDate) < new Date())).toBe(true);
  });

  it('sendInvoiceReminder шлёт письмо и инкрементирует reminderCount, игнорируя cooldown', async () => {
    const clientId = await makeDebtorClient('remind@example.com');
    await makeInvoice(clientId, -5);
    const [inv] = await listClientOverdueInvoices(getDb(), erfolgId, clientId);
    expect(inv).toBeDefined();
    if (!inv) return;

    const r1 = await sendInvoiceReminder(getDb(), { id: erfolgId, name: 'ТестКомпания' }, inv, { dryRun: false });
    expect(r1.outcome).toBe('sent');
    expect(sentMail.some((m) => m.to === 'remind@example.com')).toBe(true);

    // Повторный вызов сразу — cooldown НЕ мешает ручной кнопке.
    const r2 = await sendInvoiceReminder(getDb(), { id: erfolgId, name: 'ТестКомпания' }, inv, { dryRun: false });
    expect(r2.outcome).toBe('sent');

    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ count: invoices.reminderCount }).from(invoices).where(eq(invoices.id, inv.id)),
    );
    expect(row?.count).toBe(2);
  });

  it('sendInvoiceReminder пропускает клиента без email', async () => {
    const clientId = await makeDebtorClient(null);
    await makeInvoice(clientId, -5);
    const [inv] = await listClientOverdueInvoices(getDb(), erfolgId, clientId);
    expect(inv).toBeDefined();
    if (!inv) return;

    const res = await sendInvoiceReminder(getDb(), { id: erfolgId, name: 'ТестКомпания' }, inv, { dryRun: false });
    expect(res.outcome).toBe('skipped_no_email');
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ count: invoices.reminderCount }).from(invoices).where(eq(invoices.id, inv.id)),
    );
    expect(row?.count).toBe(0);
  });
});

/**
 * Архивный клиент: писем НЕ шлём, но долг из отчёта НЕ убираем.
 *
 * Асимметрия сознательная. Архивацию здесь используют как суррогат слияния дублей:
 * карточку-дубль прячут, а счета на ней настоящие. Поэтому цена двух ошибок разная —
 * лишнее письмо по дублю портит отношения, а спрятанный долг = прямой убыток.
 * Отсюда: письмо гасим, деньги в отчёте не трогаем ни одной цифрой.
 */
describe('архивный клиент: письма гасим, долг оставляем видимым', () => {
  beforeEach(clearTestData);

  it('sendInvoiceReminder НЕ пишет архивному клиенту', async () => {
    const clientId = await makeDebtorClient('archived-nomail@example.com');
    await makeInvoice(clientId, -5);
    const [inv] = await listClientOverdueInvoices(getDb(), erfolgId, clientId);
    expect(inv).toBeDefined();
    if (!inv) return;

    await archiveClient(getDb(), erfolgId, clientId);

    const res = await sendInvoiceReminder(
      getDb(),
      { id: erfolgId, name: 'ТестКомпания' },
      inv,
      { dryRun: false },
    );
    expect(res.outcome).toBe('skipped_archived');
    expect(sentMail.some((m) => m.to === 'archived-nomail@example.com')).toBe(false);

    // reminderCount НЕ трогаем: вернут клиента из архива — напоминание уйдёт как обычно.
    const [row] = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select({ count: invoices.reminderCount }).from(invoices).where(eq(invoices.id, inv.id)),
    );
    expect(row?.count).toBe(0);
  });

  it('ручная кнопка «Напомнить» по архивному — это НЕ ошибка отправки', async () => {
    const clientId = await makeDebtorClient('archived-manual@example.com');
    await makeInvoice(clientId, -5);
    await archiveClient(getDb(), erfolgId, clientId);

    const r = await sendReminderCmd(makeCmdCtx(erfolgId), clientId);
    expect(r.sent).toBe(0);
    expect(r.skippedArchived).toBe(1);
    // Ключевое: не failed. Иначе директор увидит красное «Не удалось отправить»
    // и будет жать кнопку повторно, думая что сломалась почта.
    expect(r.failed).toBe(0);
  });

  it('ДЕНЬГИ: долг архивного клиента остаётся в дебиторке теми же суммами, с пометкой', async () => {
    const clientId = await makeDebtorClient('archived-debt@example.com');
    await makeInvoice(clientId, -5);
    await makeInvoice(clientId, -40);

    const before = await receivablesReport(getDb(), erfolgId);
    const rowBefore = before.debtors.find((d) => d.clientId === clientId);
    expect(rowBefore).toBeDefined();
    expect(rowBefore?.clientArchived).toBe(false);

    await archiveClient(getDb(), erfolgId, clientId);

    const after = await receivablesReport(getDb(), erfolgId);
    const rowAfter = after.debtors.find((d) => d.clientId === clientId);

    // Строка на месте — долг не исчез с экрана.
    expect(rowAfter).toBeDefined();
    // Пометка появилась — человек видит, ПОЧЕМУ письма по ней не уходят.
    expect(rowAfter?.clientArchived).toBe(true);
    // И ни одна цифра не поехала.
    expect(rowAfter?.totalOwedKopecks).toBe(rowBefore?.totalOwedKopecks);
    expect(rowAfter?.overdueOwedKopecks).toBe(rowBefore?.overdueOwedKopecks);
    expect(rowAfter?.invoiceCount).toBe(rowBefore?.invoiceCount);
    expect(rowAfter?.overdueInvoiceCount).toBe(rowBefore?.overdueInvoiceCount);
  });

  it('ДЕНЬГИ: архивация не уменьшает сводку и корзины сроков', async () => {
    const clientId = await makeDebtorClient('archived-aging@example.com');
    await makeInvoice(clientId, -5);

    const before = await receivablesReport(getDb(), erfolgId);
    await archiveClient(getDb(), erfolgId, clientId);
    const after = await receivablesReport(getDb(), erfolgId);

    // Шапка экрана («Всего должны» / «Просрочено») считается из корзин, а корзины
    // клиентов вообще не джойнят. Если кто-то однажды «оптимизирует» отчёт фильтром
    // по архиву — эти четыре строки упадут первыми.
    expect(BigInt(after.summary.totalOutstandingKopecks)).toBeGreaterThanOrEqual(
      BigInt(before.summary.totalOutstandingKopecks),
    );
    expect(BigInt(after.summary.overdueOutstandingKopecks)).toBeGreaterThanOrEqual(
      BigInt(before.summary.overdueOutstandingKopecks),
    );
    expect(after.summary.debtorCount).toBeGreaterThanOrEqual(before.summary.debtorCount);
    expect(BigInt(after.aging.d1_30.sumKopecks)).toBeGreaterThanOrEqual(
      BigInt(before.aging.d1_30.sumKopecks),
    );
  });
});

describe('sendReminderCmd — ручная кнопка (F1: cooldown + защита от гонки)', () => {
  beforeEach(clearTestData);

  it('последовательный повтор в окне cooldown не шлёт дубль (skippedCooldown)', async () => {
    const clientId = await makeDebtorClient('cooldown@example.com');
    await makeInvoice(clientId, -5);

    const r1 = await sendReminderCmd(makeCmdCtx(erfolgId), clientId);
    expect(r1.sent).toBe(1);
    expect(r1.skippedCooldown).toBe(0);

    // сразу повторно: lastReminderSentAt свежий → cooldown пропускает, второе письмо не уходит
    const r2 = await sendReminderCmd(makeCmdCtx(erfolgId), clientId);
    expect(r2.sent).toBe(0);
    expect(r2.skippedCooldown).toBe(1);
    expect(r2.total).toBe(1);
    expect(sentMail.filter((m) => m.to === 'cooldown@example.com')).toHaveLength(1);
  });

  it('одновременный запрос: claim занят → счёт пропущен, письмо не дублируется', async () => {
    const clientId = await makeDebtorClient('race@example.com');
    const { invoiceId } = await makeInvoice(clientId, -5);

    // эмулируем «другой запрос уже шлёт этот счёт»: занимаем claim-ключ заранее.
    const key = reminderLockKey(erfolgId, invoiceId);
    await getRedis().set(key, '1', 'EX', 120);
    try {
      const res = await sendReminderCmd(makeCmdCtx(erfolgId), clientId);
      expect(res.sent).toBe(0);
      expect(res.skippedCooldown).toBe(1);
      expect(sentMail.some((m) => m.to === 'race@example.com')).toBe(false);
    } finally {
      await getRedis().del(key);
    }
  });
});
