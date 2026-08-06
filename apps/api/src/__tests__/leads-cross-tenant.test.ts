/**
 * Лиды (перенос из v1) — изоляция между тенантами (RLS) + скоринг + конвертация.
 *
 * Проверяем:
 *   1. calculateLeadScore — чистая логика скоринга (без БД).
 *   2. listLeads/getLeadById/archiveLead чужого тенанта не видят/не трогают чужой лид (RLS).
 *   3. convertLeadToClient создаёт клиента, помечает лид won, идемпотентен при повторе.
 *   4. leadFunnelStats считает воронку.
 *
 * Тесты идут под app_runtime (DATABASE_URL) — RLS реально применяется.
 */
import { describe, it, expect, afterAll, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { clients, getDb, leads, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  archiveLead,
  convertLeadToClient,
  createLead,
  getLeadById,
  leadFunnelStats,
  listLeads,
} from '../modules/leads/repository';
import { calculateLeadScore } from '../modules/leads/scoring';
import { getClient } from '../modules/clients/repository';
import { convertLeadToClientCmd } from '../modules/leads/service';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

/** Минимальный CmdCtx для проверки серверной валидации конвертации. */
function makeCmdCtx() {
  return {
    db: getDb(),
    tenant: {
      id: erfolgId,
      subdomain: 'erfolg',
      displayName: 'ООО Эрфольг',
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    } as ResolvedTenant,
    session: {
      tenantId: erfolgId,
      userId: null,
      username: 'director',
      role: 'director',
      fullName: 'Director',
      expiresAt: Date.now() + 60_000,
    } as unknown as SessionData,
    audit: { ip: null, userAgent: null },
  };
}

let erfolgId = '';
let demoId = '';

const TEST_PREFIX = 'TEST-LEAD-';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
});

async function clearTestData(): Promise<void> {
  for (const t of [erfolgId, demoId]) {
    await withTenantTx(getDb(), t, async (tx) => {
      // Сначала лиды (у них FK на clients), затем клиенты, созданные конвертацией.
      await tx.delete(leads).where(like(leads.name, `${TEST_PREFIX}%`));
      await tx.delete(clients).where(like(clients.displayName, `${TEST_PREFIX}%`));
    });
  }
}

beforeEach(clearTestData);
// Не оставляем мусор в dev-БД после последнего прогона (beforeEach чистит только до теста).
afterAll(clearTestData);

describe('calculateLeadScore (чистая логика)', () => {
  it('крупный + email + referral + negotiation → 95', () => {
    const s = calculateLeadScore({
      estimatedValue: 150_000,
      email: 'a@b.ru',
      source: 'referral',
      status: 'negotiation',
      updatedAt: new Date(),
    });
    expect(s).toBe(95); // 30 +20(>100k) +15(email) +10(referral) +20(negotiation)
  });

  it('won → 100, lost → 0', () => {
    expect(calculateLeadScore({ estimatedValue: 0, source: 'other', status: 'won' })).toBe(100);
    expect(
      calculateLeadScore({ estimatedValue: 999_999, source: 'referral', status: 'lost' }),
    ).toBe(0);
  });

  it('результат всегда в диапазоне [0,100]', () => {
    const s = calculateLeadScore({
      estimatedValue: 1_000_000,
      email: 'x@y.z',
      source: 'referral',
      status: 'new',
      updatedAt: new Date(),
    });
    expect(s).toBeGreaterThanOrEqual(0);
    expect(s).toBeLessThanOrEqual(100);
  });
});

describe('leads — изоляция между тенантами (RLS)', () => {
  it('listLeads чужого тенанта не видит лид', async () => {
    const { id } = await createLead(getDb(), erfolgId, {
      name: `${TEST_PREFIX}Acme`,
      source: 'website',
      estimatedValue: 100_000,
      score: 50,
    });
    expect(id).toBeTruthy();

    const erfolgList = await listLeads(getDb(), erfolgId, { search: TEST_PREFIX });
    const demoList = await listLeads(getDb(), demoId, { search: TEST_PREFIX });
    expect(erfolgList.items.some((l) => l.id === id)).toBe(true);
    expect(demoList.items.some((l) => l.id === id)).toBe(false);
  });

  it('getLeadById по чужому id → null', async () => {
    const { id } = await createLead(getDb(), erfolgId, { name: `${TEST_PREFIX}Beta`, score: 30 });
    expect(await getLeadById(getDb(), demoId, id)).toBeNull();
    expect((await getLeadById(getDb(), erfolgId, id))?.id).toBe(id);
  });

  it('archiveLead по чужому id → false, по своему → true и пропадает из списка', async () => {
    const { id } = await createLead(getDb(), erfolgId, { name: `${TEST_PREFIX}Gamma`, score: 30 });
    expect(await archiveLead(getDb(), demoId, id)).toBe(false);
    expect(await archiveLead(getDb(), erfolgId, id)).toBe(true);
    const list = await listLeads(getDb(), erfolgId, { search: TEST_PREFIX });
    expect(list.items.some((l) => l.id === id)).toBe(false);
  });
});

describe('leads — конвертация и воронка', () => {
  it('convertLeadToClient создаёт клиента, помечает лид won, идемпотентен', async () => {
    const { id } = await createLead(getDb(), erfolgId, {
      name: `${TEST_PREFIX}ConvertMe`,
      phone: '+70000000000',
      source: 'tender',
      estimatedValue: 500_000,
      score: 60,
    });

    const res = await convertLeadToClient(getDb(), erfolgId, id, {
      clientType: 'legal',
      inn: '7712345678',
      kpp: '771201001',
    });
    expect(res).not.toBeNull();

    const lead = await getLeadById(getDb(), erfolgId, id);
    expect(lead?.status).toBe('won');
    expect(lead?.convertedClientId).toBe(res!.clientId);

    // повторная конвертация — null (идемпотентность)
    expect(await convertLeadToClient(getDb(), erfolgId, id, { clientType: 'legal' })).toBeNull();

    // клиент реально создан в том же тенанте с реквизитами лида
    const client = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.select().from(clients).where(eq(clients.id, res!.clientId)).limit(1),
    );
    expect(client[0]?.displayName).toBe(`${TEST_PREFIX}ConvertMe`);
    expect(client[0]?.inn).toBe('7712345678');
  });

  it('физлицо: ФИО шифруется, телефон и адрес переносятся, имя — инициалами', async () => {
    // Ветка individual раньше не была покрыта — она и дала баг: телефон, адрес
    // и email обнулялись явно, ФИО не заполнялось вовсе, карточка выходила
    // пустой и звонить было некуда.
    const { id } = await createLead(getDb(), erfolgId, {
      name: `${TEST_PREFIX}Заявка с сайта`,
      phone: '+79281234567',
      email: 'petrov@example.test',
      address: 'г. Грозный, ул. Победы, 1',
      source: 'website',
      score: 40,
    });

    const res = await convertLeadToClient(getDb(), erfolgId, id, {
      clientType: 'individual',
      individualFullName: 'Петров Пётр Петрович',
    });
    expect(res).not.toBeNull();

    const dto = await getClient(getDb(), erfolgId, res!.clientId);
    expect(dto?.individualFullName).toBe('Петров Пётр Петрович');
    expect(dto?.individualPhone).toBe('+79281234567');
    expect(dto?.individualAddress).toBe('г. Грозный, ул. Победы, 1');
    expect(dto?.email).toBe('petrov@example.test');
    // Имя карточки — из ФИО, а не «Заявка с сайта».
    expect(dto?.displayName).toBe('Петров П.П.');

    // ПДн лежат открыто (миграция 0078) — читаем колонку напрямую, минуя репозиторий.
    // Раньше здесь проверялось обратное: что в full_name_encrypted лежат байты, а не
    // текст. Шифрование сняли осознанно — ключ хранился на том же сервере, что и база,
    // поэтому от её кражи не защищал, а его потеря делала картотеку нечитаемой навсегда.
    // Сама шифрованная колонка удалена уборкой 0081, поэтому сверяем только открытую.
    const raw = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ plain: clients.individualFullName })
        .from(clients)
        .where(eq(clients.id, res!.clientId)),
    );
    expect(raw[0]?.plain).toBe('Петров Пётр Петрович');
  });

  it('физлицо без ФИО не создаётся — инвариант больше не обходится', async () => {
    const { id } = await createLead(getDb(), erfolgId, {
      name: `${TEST_PREFIX}БезФИО`,
      source: 'website',
      score: 10,
    });

    await expect(
      convertLeadToClientCmd(makeCmdCtx(), { leadId: id, clientType: 'individual' }),
    ).rejects.toThrow(/Для физлица обязательно ФИО/);

    // Лид не помечен сконвертированным — можно повторить с ФИО.
    const lead = await getLeadById(getDb(), erfolgId, id);
    expect(lead?.convertedClientId).toBeNull();
  });

  it('leadFunnelStats считает стадии', async () => {
    await createLead(getDb(), erfolgId, {
      name: `${TEST_PREFIX}P1`,
      status: 'proposal',
      estimatedValue: 200_000,
      score: 50,
    });
    await createLead(getDb(), erfolgId, {
      name: `${TEST_PREFIX}Lost1`,
      status: 'lost',
      estimatedValue: 999_999,
      score: 0,
    });
    const stats = await leadFunnelStats(getDb(), erfolgId);
    expect(stats.total).toBeGreaterThanOrEqual(2);
    expect(stats.byStatus.lost.count).toBeGreaterThanOrEqual(1);
    expect(stats.byStatus.proposal.count).toBeGreaterThanOrEqual(1);
  });
});
