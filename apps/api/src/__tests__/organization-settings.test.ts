/**
 * Реквизиты организации: читать и править.
 *
 * ЧТО БЫЛО. Колонки реквизитов в `tenants` заполнены сидом и БОЛЬШЕ НИКЕМ не
 * читаются: документы печатают зашитую в код константу
 * `apps/web/src/lib/pdf/branding.ts`. Сменился банк, адрес или директор —
 * правится исходник и пересобирается сайт. Экрана для правки не было вовсе.
 *
 * ПРО ПРОВЕРКИ ДЛИНЫ. ИНН, КПП, БИК и счета — не «просто текст»: неверный БИК
 * в счёте означает, что клиент не сможет заплатить, а узнает об этом бухгалтер
 * заказчика через неделю. Поэтому длины проверяются на сервере, а не только на
 * экране. Пустое значение при этом разрешено: у ИП нет КПП, у части организаций
 * не заполнен ОГРН, и заставлять выдумывать цифры нельзя.
 *
 * ПРО ПРАВА. Читать — вся контора (менеджер печатает счёт и договор), править —
 * только директор.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { getDb, tenants } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  organizationPatchSchema,
  readOrganization,
  updateOrganization,
} from '../modules/settings/organization';

let erfolgId = '';
let before: Record<string, unknown> = {};

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  before = (await readOrganization(getDb(), erfolgId)) as unknown as Record<string, unknown>;
});

/** Возвращаем реквизиты как были — их читают документы в других тестах. */
afterAll(async () => {
  await getDb()
    .update(tenants)
    .set({
      legalName: (before.legalName as string | null) ?? null,
      slogan: (before.slogan as string | null) ?? null,
      inn: (before.inn as string | null) ?? null,
      kpp: (before.kpp as string | null) ?? null,
      ogrn: (before.ogrn as string | null) ?? null,
      legalAddress: (before.legalAddress as string | null) ?? null,
      phone: (before.phone as string | null) ?? null,
      email: (before.email as string | null) ?? null,
      bankName: (before.bankName as string | null) ?? null,
      bankAccount: (before.bankAccount as string | null) ?? null,
      correspondentAccount: (before.correspondentAccount as string | null) ?? null,
      bik: (before.bik as string | null) ?? null,
      directorName: (before.directorName as string | null) ?? null,
    })
    .where(eq(tenants.id, erfolgId));
});

describe('чтение реквизитов', () => {
  it('отдаёт то, что лежит в базе, включая фамилию директора', async () => {
    await updateOrganization(getDb(), erfolgId, {
      legalName: 'ООО «Проверка»',
      directorName: 'Иванов Иван Иванович',
      bik: '049690719',
    });

    const org = await readOrganization(getDb(), erfolgId);
    expect(org.legalName).toBe('ООО «Проверка»');
    expect(org.directorName).toBe('Иванов Иван Иванович');
    expect(org.bik).toBe('049690719');
  });

  it('пустую строку кладёт как «не заполнено», а не как пробел', async () => {
    await updateOrganization(getDb(), erfolgId, { kpp: '' });
    expect((await readOrganization(getDb(), erfolgId)).kpp).toBeNull();
  });

  it('не тронутые поля остаются на месте', async () => {
    await updateOrganization(getDb(), erfolgId, { legalName: 'ООО «Первое»', phone: '+7 928' });
    await updateOrganization(getDb(), erfolgId, { phone: '+7 999' });

    const org = await readOrganization(getDb(), erfolgId);
    expect(org.legalName).toBe('ООО «Первое»');
    expect(org.phone).toBe('+7 999');
  });
});

describe('проверки банковских реквизитов', () => {
  const ok = (patch: Record<string, unknown>) =>
    expect(organizationPatchSchema.safeParse(patch).success).toBe(true);
  const bad = (patch: Record<string, unknown>) =>
    expect(organizationPatchSchema.safeParse(patch).success).toBe(false);

  it('ИНН — 10 или 12 цифр', () => {
    ok({ inn: '2014006736' });
    ok({ inn: '201400673612' });
    bad({ inn: '20140067' });
    bad({ inn: '2014abc736' });
  });

  it('КПП и БИК — ровно 9 цифр', () => {
    ok({ kpp: '201401001' });
    bad({ kpp: '20140100' });
    ok({ bik: '049690719' });
    bad({ bik: '04969071' });
  });

  it('счёт и корсчёт — ровно 20 цифр', () => {
    ok({ bankAccount: '40702810734000003523' });
    bad({ bankAccount: '4070281073400000352' });
    ok({ correspondentAccount: '30101810600000000719' });
    bad({ correspondentAccount: '30101810600000000719777' });
  });

  it('пусто разрешено — у ИП нет КПП, ОГРН заполнен не у всех', () => {
    ok({ kpp: '' });
    ok({ ogrn: '' });
    ok({ bankAccount: '' });
    ok({ inn: '' });
  });

  it('почта проверяется, а телефон — нет: его пишут как удобно', () => {
    ok({ email: 'info@erfolgmt.ru' });
    bad({ email: 'не почта' });
    ok({ phone: '8 (928) 895-70-70' });
  });
});
