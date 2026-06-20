/**
 * Seed-скрипт для локальной разработки.
 *
 * Создаёт:
 * - 3 тарифных плана (start/pro/corp)
 * - 2 тестовых tenant'а: "erfolg" (реальные данные ООО Эрфольг) и "demo" (синтетика для тестов изоляции)
 * - В каждом tenant'е: директор, диспетчер, инженер с известными паролями
 *
 * Запуск: pnpm --filter @erfolg/db tsx src/seed.ts
 *
 * ВАЖНО: пароли demo_director / demo_dispatcher / demo_engineer — только для разработки.
 * В production seed'а нет, tenant'ы создаются через Control Plane (Этап 10).
 */
import 'dotenv/config';
import { hash } from 'argon2';
import { and, eq, sql } from 'drizzle-orm';
import { makeDb } from './client';
import { getTenantEncryptionKey } from './crypto';
import {
  assetEvents,
  assets,
  cashAccounts,
  cashCategories,
  clients,
  contacts,
  inventoryBatches,
  inventoryItems,
  inventoryMovements,
  maintenanceSchedules,
  payments,
  plans,
  tenantCounters,
  tenants,
  ticketEvents,
  tickets,
  users,
  workOrderLines,
  workOrders,
} from './schema';

// Seed работает как owner (erfolg), не как app_runtime (RLS бы не пустил).
const DATABASE_URL =
  process.env.DATABASE_OWNER_URL ??
  process.env.DATABASE_URL ??
  'postgresql://erfolg:dev_only_password@localhost:5432/erfolg_dev';

async function main() {
  console.info('Seeding database:', DATABASE_URL.replace(/:[^@]+@/, ':***@'));
  const db = makeDb(DATABASE_URL);

  await seedPlans(db);
  const erfolgTenantId = await seedTenant(db, {
    subdomain: 'erfolg',
    displayName: 'ООО «Эрфольг»',
    legalName: 'Общество с ограниченной ответственностью «Эрфольг»',
    slogan: 'Техническое обслуживание и ремонт медицинской техники',
    inn: '2014006736',
    kpp: '201401001',
    legalAddress: '364031, Респ Чеченская, г Грозный, р-н Ахматовский, ул Мичурина, двлд 98',
    phone: '8 (928) 895-70-70',
    email: 'erfolgmt@mail.ru',
    bankName: 'ЧЕЧЕНСКИЙ РФ АО "РОССЕЛЬХОЗБАНК" Г. Грозный',
    bankAccount: '40702810734000003523',
    correspondentAccount: '30101810600000000719',
    bik: '049690719',
    licenseSeries: 'ФС-99-04',
    licenseNumber: '000295',
    licenseDate: new Date('2013-08-21'),
    licenseAuthority: 'Росздравнадзор',
  });

  const demoTenantId = await seedTenant(db, {
    subdomain: 'demo',
    displayName: 'СЦ «Демо-Медтех»',
    legalName: 'ООО «Демо-Медтех»',
    slogan: 'Тестовый tenant для проверки изоляции',
    inn: '7700000000',
    kpp: '770001001',
    phone: '+7 (495) 000-00-00',
    email: 'demo@example.com',
  });

  await seedUsers(db, erfolgTenantId, 'erfolg');
  await seedUsers(db, demoTenantId, 'demo');

  await seedClientsAndAssets(db, erfolgTenantId, 'erfolg');
  await seedClientsAndAssets(db, demoTenantId, 'demo');

  await seedTickets(db, erfolgTenantId, 'erfolg');
  await seedTickets(db, demoTenantId, 'demo');

  await seedStage5(db, erfolgTenantId, 'erfolg');

  await seedCash(db, erfolgTenantId, 'erfolg');
  await seedCash(db, demoTenantId, 'demo');

  console.info('\n✓ Seed complete.');
  console.info('\nLogins (tenant / username / password):');
  console.info('  erfolg / director  / erfolg_director_2026');
  console.info('  erfolg / dispatcher / erfolg_dispatcher_2026');
  console.info('  erfolg / engineer  / erfolg_engineer_2026');
  console.info('  demo   / director   / demo_director_2026');
  console.info('  demo   / dispatcher / demo_dispatcher_2026');
  console.info('  demo   / engineer   / demo_engineer_2026');
  process.exit(0);
}

async function seedPlans(db: ReturnType<typeof makeDb>) {
  const planSeeds = [
    {
      code: 'start' as const,
      name: 'Старт',
      description: 'Для небольших СЦ до 5 пользователей',
      monthlyPriceRub: 4900,
      yearlyPriceRub: 49000,
      sortOrder: 10,
      features: {
        maxUsers: 5,
        maxClients: 100,
        maxTicketsPerMonth: 200,
        hasTelegramBot: false,
        hasMaintenanceLog: true,
        hasOneCExport: false,
        hasCustomBranding: false,
        hasPrioritySupport: false,
      },
    },
    {
      code: 'pro' as const,
      name: 'Про',
      description: 'Полный функционал для растущего СЦ',
      monthlyPriceRub: 12900,
      yearlyPriceRub: 129000,
      sortOrder: 20,
      features: {
        maxUsers: 20,
        maxClients: 1000,
        maxTicketsPerMonth: 2000,
        hasTelegramBot: true,
        hasMaintenanceLog: true,
        hasOneCExport: true,
        hasCustomBranding: false,
        hasPrioritySupport: false,
      },
    },
    {
      code: 'corp' as const,
      name: 'Корп',
      description: 'Безлимитно + брендирование + приоритетная поддержка',
      monthlyPriceRub: 29900,
      yearlyPriceRub: 299000,
      sortOrder: 30,
      features: {
        maxUsers: null,
        maxClients: null,
        maxTicketsPerMonth: null,
        hasTelegramBot: true,
        hasMaintenanceLog: true,
        hasOneCExport: true,
        hasCustomBranding: true,
        hasPrioritySupport: true,
      },
    },
  ];

  for (const p of planSeeds) {
    const existing = await db.select().from(plans).where(eq(plans.code, p.code)).limit(1);
    if (existing.length > 0) continue;
    await db.insert(plans).values(p);
    console.info(`  + plan: ${p.code}`);
  }
}

async function seedTenant(
  db: ReturnType<typeof makeDb>,
  data: typeof tenants.$inferInsert,
): Promise<string> {
  const existing = await db.select().from(tenants).where(eq(tenants.subdomain, data.subdomain)).limit(1);
  if (existing[0]) {
    console.info(`  = tenant: ${data.subdomain} (already exists)`);
    return existing[0].id;
  }
  const [created] = await db.insert(tenants).values({ ...data, status: 'active' }).returning();
  if (!created) throw new Error('Tenant insert returned nothing');
  console.info(`  + tenant: ${data.subdomain}`);
  return created.id;
}

async function seedUsers(db: ReturnType<typeof makeDb>, tid: string, prefix: string) {
  const seeds = [
    {
      username: 'director',
      fullName: 'Хаджиев Тимур Рамзанович',
      position: 'Директор',
      role: 'director' as const,
      password: `${prefix}_director_2026`,
    },
    {
      username: 'dispatcher',
      fullName: 'Иванова Анна Петровна',
      position: 'Диспетчер',
      role: 'dispatcher' as const,
      password: `${prefix}_dispatcher_2026`,
    },
    {
      username: 'engineer',
      fullName: 'Алероев Адам Алиевич',
      position: 'Старший инженер',
      role: 'engineer' as const,
      password: `${prefix}_engineer_2026`,
    },
  ];

  for (const u of seeds) {
    const existing = await db
      .select()
      .from(users)
      .where(eq(users.tenantId, tid))
      .limit(50);
    if (existing.some((x) => x.username === u.username)) {
      console.info(`  = user: ${prefix}/${u.username} (already exists)`);
      continue;
    }
    const passwordHash = await hash(u.password);
    await db.insert(users).values({
      tenantId: tid,
      username: u.username,
      fullName: u.fullName,
      position: u.position,
      role: u.role,
      passwordHash,
    });
    console.info(`  + user: ${prefix}/${u.username}`);
  }
}

/**
 * Seed клиентов и техники для двух tenant'ов.
 *
 * erfolg: 4 клиента (1 бюджетник + 2 коммерческих юрлица + 1 физлицо), 9 единиц техники.
 * demo:   2 клиента + 2 единицы техники — для проверки cross-tenant изоляции.
 *
 * Идемпотентен: проверка по (tenantId, displayName) для клиентов и (tenantId, serialNumber)
 * для assets. Шифрованные поля пишутся через pgp_sym_encrypt с per-tenant ключом.
 */
async function seedClientsAndAssets(
  db: ReturnType<typeof makeDb>,
  tenantIdValue: string,
  prefix: string,
): Promise<void> {
  // Для шифрования нужен tenant. Передаём минимум — { id, kmsKeyId }.
  const key = getTenantEncryptionKey({ id: tenantIdValue, kmsKeyId: null });

  type ContactSeed = {
    fullName: string;
    phone: string;
    email?: string;
    position?: string;
    isPrimary?: boolean;
  };
  type ClientSeed = {
    type: 'legal' | 'individual';
    subtype?: 'commercial' | 'budget' | null;
    displayName: string;
    inn?: string;
    kpp?: string;
    ogrn?: string;
    legalAddress?: string;
    phone?: string;
    email?: string;
    treasuryAccount?: string;
    eksAccount?: string;
    personalAccount?: string;
    individualFullName?: string;
    individualPhone?: string;
    individualAddress?: string;
    notes?: string;
    contactsToCreate?: ContactSeed[];
    assetsToCreate?: Array<{
      model: string;
      manufacturer?: string;
      serialNumber: string;
      inventoryNumber?: string;
      location?: string;
      lifecycleStatus?:
        | 'in_service'
        | 'in_repair'
        | 'awaiting_parts'
        | 'reserve'
        | 'decommissioned';
      riskClass?: '1' | '2a' | '2b' | '3';
      commissionedAt?: string;
      warrantyUntil?: string;
    }>;
  };

  const erfolgSeeds: ClientSeed[] = [
    {
      type: 'legal',
      subtype: 'budget',
      displayName: 'ГБУ «Грозненская ЦРБ»',
      inn: '2014567890',
      kpp: '201401001',
      ogrn: '1022001234567',
      legalAddress: '364000, Чеченская Республика, г. Грозный, ул. Больничная, д. 12',
      phone: '+7 (8712) 22-33-44',
      email: 'crb-grozny@gov.chr.ru',
      treasuryAccount: '03224643960000009100',
      eksAccount: '40102810145370000001',
      personalAccount: 'Л/С 03014567890',
      contactsToCreate: [
        {
          fullName: 'Магомадов Руслан Идрисович',
          phone: '+79280001122',
          email: 'r.magomadov@crb-grozny.ru',
          position: 'Главный инженер',
          isPrimary: true,
        },
      ],
      assetsToCreate: [
        {
          model: 'Mindray DC-30',
          manufacturer: 'Mindray',
          serialNumber: 'MDR-DC30-2021-0017',
          inventoryNumber: 'УЗИ-001',
          location: 'Кабинет УЗД, 2 этаж',
          riskClass: '2b',
          commissionedAt: '2021-03-15',
          warrantyUntil: '2024-03-15',
        },
        {
          model: 'Tuttnauer 3870EA',
          manufacturer: 'Tuttnauer',
          serialNumber: 'TTN-3870-2019-0042',
          inventoryNumber: 'АВТ-002',
          location: 'ЦСО',
          riskClass: '2a',
          commissionedAt: '2019-05-10',
        },
        {
          model: 'Schiller CARDIOVIT AT-101',
          manufacturer: 'Schiller',
          serialNumber: 'SCH-AT101-2020-0089',
          inventoryNumber: 'ЭКГ-003',
          location: 'Кабинет функц. диагностики',
          riskClass: '2a',
          commissionedAt: '2020-08-22',
        },
        {
          model: 'Philips HeartStart FRx',
          manufacturer: 'Philips',
          serialNumber: 'PHL-FRX-2022-0011',
          inventoryNumber: 'ДЕФ-004',
          location: 'Реанимация',
          riskClass: '2b',
          commissionedAt: '2022-01-30',
          warrantyUntil: '2026-01-30',
        },
        {
          model: 'Braun Infusomat Space',
          manufacturer: 'B. Braun',
          serialNumber: 'BBR-INF-2021-0203',
          inventoryNumber: 'ИНФ-005',
          location: 'Хирургия',
          lifecycleStatus: 'in_repair',
          riskClass: '2b',
          commissionedAt: '2021-11-04',
        },
      ],
    },
    {
      type: 'legal',
      subtype: 'commercial',
      displayName: 'ООО «Стом. клиника Улыбка»',
      inn: '7705012345',
      kpp: '770501001',
      ogrn: '1037705098765',
      legalAddress: '115035, г. Москва, ул. Пятницкая, д. 25',
      phone: '+7 (495) 555-12-34',
      email: 'info@ulybka-clinic.ru',
      contactsToCreate: [
        {
          fullName: 'Соколова Мария Игоревна',
          phone: '+79161112233',
          email: 'sokolova@ulybka-clinic.ru',
          position: 'Главный врач',
          isPrimary: true,
        },
      ],
      assetsToCreate: [
        {
          model: 'MELAG Vacuklav 31 B+',
          manufacturer: 'MELAG',
          serialNumber: 'MLG-V31B-2022-0301',
          inventoryNumber: 'АВТ-СТ-01',
          location: 'Стерилизационная',
          riskClass: '2a',
          commissionedAt: '2022-04-12',
          warrantyUntil: '2025-04-12',
        },
        {
          model: 'A-dec 500',
          manufacturer: 'A-dec',
          serialNumber: 'ADC-500-2021-0078',
          inventoryNumber: 'СУ-СТ-02',
          location: 'Кабинет №1',
          riskClass: '2a',
          commissionedAt: '2021-09-01',
        },
      ],
    },
    {
      type: 'legal',
      subtype: 'commercial',
      displayName: 'ООО «Медцентр Здоровье»',
      inn: '7728009876',
      kpp: '772801001',
      legalAddress: '117418, г. Москва, ул. Профсоюзная, д. 84',
      phone: '+7 (495) 333-44-55',
      contactsToCreate: [
        {
          fullName: 'Новиков Павел Андреевич',
          phone: '+79263334455',
          email: 'novikov@zdorovie-mc.ru',
          position: 'Технический директор',
          isPrimary: true,
        },
      ],
      assetsToCreate: [
        {
          model: 'Samsung HS40',
          manufacturer: 'Samsung Medison',
          serialNumber: 'SMS-HS40-2023-0145',
          inventoryNumber: 'УЗИ-ЗД-01',
          location: 'Каб. 305',
          riskClass: '2b',
          commissionedAt: '2023-02-18',
          warrantyUntil: '2026-02-18',
        },
      ],
    },
    {
      type: 'individual',
      displayName: 'Иванов И.И.',
      individualFullName: 'Иванов Иван Иванович',
      individualPhone: '+79261234567',
      individualAddress: 'г. Москва, ул. Тверская, д. 1, кв. 15',
      assetsToCreate: [
        {
          model: 'Omron M3 Comfort',
          manufacturer: 'Omron',
          serialNumber: 'OMR-M3-2024-A0023',
          location: 'У владельца',
          riskClass: '1',
          commissionedAt: '2024-01-12',
        },
      ],
    },
  ];

  const demoSeeds: ClientSeed[] = [
    {
      type: 'legal',
      subtype: 'commercial',
      displayName: 'ООО «Демо-Клиника»',
      inn: '7700000111',
      legalAddress: '101000, г. Москва, ул. Тестовая, д. 1',
      phone: '+7 (495) 999-00-11',
      assetsToCreate: [
        {
          model: 'Demo Device X1',
          manufacturer: 'DemoCorp',
          serialNumber: 'DEMO-X1-0001',
          location: 'Demo room',
        },
      ],
    },
    {
      type: 'individual',
      displayName: 'Петров П.П.',
      individualFullName: 'Петров Петр Петрович',
      individualPhone: '+79009990011',
      individualAddress: 'г. Тестов, ул. Демо, д. 2',
      assetsToCreate: [
        {
          model: 'Demo Tonometer',
          manufacturer: 'DemoCorp',
          serialNumber: 'DEMO-T-0002',
        },
      ],
    },
  ];

  const seedSet = prefix === 'erfolg' ? erfolgSeeds : demoSeeds;

  let createdClients = 0;
  let createdContacts = 0;
  let createdAssets = 0;

  for (const seed of seedSet) {
    const existing = await db
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.tenantId, tenantIdValue), eq(clients.displayName, seed.displayName)))
      .limit(1);

    let clientId: string;
    if (existing[0]) {
      clientId = existing[0].id;
    } else {
      const insertResult = await db.execute<{ id: string }>(sql`
        INSERT INTO clients (
          tenant_id, type, subtype, display_name,
          inn, kpp, ogrn, legal_address, phone, email,
          treasury_account, eks_account, personal_account,
          full_name_encrypted, phone_encrypted, address_encrypted,
          notes, status
        ) VALUES (
          ${tenantIdValue}, ${seed.type}::client_type, ${seed.subtype ?? null}::client_subtype,
          ${seed.displayName},
          ${seed.inn ?? null}, ${seed.kpp ?? null}, ${seed.ogrn ?? null},
          ${seed.legalAddress ?? null}, ${seed.phone ?? null}, ${seed.email ?? null},
          ${seed.treasuryAccount ?? null}, ${seed.eksAccount ?? null}, ${seed.personalAccount ?? null},
          ${seed.individualFullName ? sql`pgp_sym_encrypt(${seed.individualFullName}::text, ${key})` : sql`NULL`},
          ${seed.individualPhone ? sql`pgp_sym_encrypt(${seed.individualPhone}::text, ${key})` : sql`NULL`},
          ${seed.individualAddress ? sql`pgp_sym_encrypt(${seed.individualAddress}::text, ${key})` : sql`NULL`},
          ${seed.notes ?? null}, 'active'
        ) RETURNING id
      `);
      const newId = (insertResult as unknown as Array<{ id: string }>)[0]?.id;
      if (!newId) throw new Error(`client insert returned nothing: ${seed.displayName}`);
      clientId = newId;
      createdClients += 1;
      console.info(`  + ${prefix} client: ${seed.displayName}`);
    }

    for (const c of seed.contactsToCreate ?? []) {
      const existingContacts = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(and(eq(contacts.tenantId, tenantIdValue), eq(contacts.clientId, clientId)));
      if (existingContacts.length > 0) continue;

      await db.execute(sql`
        INSERT INTO contacts (
          tenant_id, client_id, full_name_encrypted, phone_encrypted,
          email, position, is_primary
        ) VALUES (
          ${tenantIdValue}, ${clientId},
          pgp_sym_encrypt(${c.fullName}::text, ${key}),
          pgp_sym_encrypt(${c.phone}::text, ${key}),
          ${c.email ?? null}, ${c.position ?? null}, ${c.isPrimary ?? false}
        )
      `);
      createdContacts += 1;
    }

    for (const a of seed.assetsToCreate ?? []) {
      const existingAssets = await db
        .select({ id: assets.id })
        .from(assets)
        .where(and(eq(assets.tenantId, tenantIdValue), eq(assets.serialNumber, a.serialNumber)))
        .limit(1);
      if (existingAssets[0]) continue;

      const [insertedAsset] = await db
        .insert(assets)
        .values({
          tenantId: tenantIdValue,
          ownerClientId: clientId,
          model: a.model,
          manufacturer: a.manufacturer,
          serialNumber: a.serialNumber,
          inventoryNumber: a.inventoryNumber,
          location: a.location,
          lifecycleStatus: a.lifecycleStatus ?? 'in_service',
          riskClass: a.riskClass,
          commissionedAt: a.commissionedAt,
          warrantyUntil: a.warrantyUntil,
        })
        .returning({ id: assets.id });
      if (!insertedAsset) throw new Error(`asset insert returned nothing: ${a.serialNumber}`);

      // Системное событие создания (userId = null)
      await db.insert(assetEvents).values({
        tenantId: tenantIdValue,
        assetId: insertedAsset.id,
        userId: null,
        type: 'created',
        payload: {},
      });
      createdAssets += 1;
    }
  }

  if (createdClients + createdContacts + createdAssets > 0) {
    console.info(
      `  + ${prefix}: clients=${createdClients}, contacts=${createdContacts}, assets=${createdAssets}`,
    );
  } else {
    console.info(`  = ${prefix} clients/assets already seeded`);
  }
}

/**
 * Seed заявок (tickets) + событий + нарядов + строк нарядов.
 *
 * erfolg: 4 заявки в разных статусах (received / diagnostics / in_progress / closed),
 * каждая со своими ticket_events и (для in_progress / closed) наряд с строками.
 * demo:   1 заявка для проверки cross-tenant изоляции.
 *
 * Идемпотентен: проверка по (tenantId, ticketNumber). Все вставки прямые,
 * RLS обходим как owner-сессией. tenant_counters обновляется UPSERT'ом.
 */
type TicketSeed = {
  ticketNumber: string;
  clientName: string;
  assetSerial: string;
  status:
    | 'received'
    | 'diagnostics'
    | 'estimate'
    | 'approval'
    | 'in_progress'
    | 'act_pending'
    | 'closed'
    | 'cancelled';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  intakeMethod: 'onsite_visit' | 'brought_in' | 'pickup';
  repairType: 'paid' | 'warranty' | 'service_contract';
  symptom: string;
  assignEngineer?: boolean;
  closedDaysAgo?: number;
  events: Array<{
    type:
      | 'created'
      | 'status_change'
      | 'assignment_change'
      | 'priority_change'
      | 'sla_change'
      | 'note'
      | 'document_printed';
    payload?: Record<string, unknown>;
  }>;
  workOrder?: {
    diagnosis: string;
    repairDescription?: string;
    lines: Array<{
      lineType: 'work' | 'part' | 'expense';
      name: string;
      unit?: string;
      quantity: string;
      unitPriceKopecks: bigint;
      orderIdx?: number;
    }>;
  };
};

const ERFOLG_TICKET_SEEDS: TicketSeed[] = [
  {
    ticketNumber: 'T-2026-000001',
    clientName: 'ГБУ «Грозненская ЦРБ»',
    assetSerial: 'MDR-DC30-2021-0017',
    status: 'received',
    priority: 'high',
    intakeMethod: 'brought_in',
    repairType: 'paid',
    symptom: 'После грозы не включается монитор УЗИ-аппарата',
    events: [{ type: 'created' }],
  },
  {
    ticketNumber: 'T-2026-000002',
    clientName: 'ООО «Стом. клиника Улыбка»',
    assetSerial: 'MLG-V31B-2022-0301',
    status: 'diagnostics',
    intakeMethod: 'onsite_visit',
    repairType: 'warranty',
    symptom: 'Срабатывает датчик давления, прерывает цикл',
    assignEngineer: true,
    events: [
      { type: 'created' },
      { type: 'assignment_change', payload: { role: 'engineer' } },
      { type: 'status_change', payload: { from: 'received', to: 'diagnostics' } },
    ],
  },
  {
    ticketNumber: 'T-2026-000003',
    clientName: 'ООО «Медцентр Здоровье»',
    assetSerial: 'SMS-HS40-2023-0145',
    status: 'in_progress',
    intakeMethod: 'pickup',
    repairType: 'paid',
    symptom: 'Перестал распознаваться датчик C5-2',
    assignEngineer: true,
    events: [
      { type: 'created' },
      { type: 'assignment_change', payload: { role: 'engineer' } },
      { type: 'status_change', payload: { from: 'received', to: 'diagnostics' } },
      { type: 'status_change', payload: { from: 'diagnostics', to: 'in_progress' } },
    ],
    workOrder: {
      diagnosis: 'Окислены контакты разъёма датчика, требуется замена ремонт',
      repairDescription: 'Зачистка контактов, замена кабеля датчика',
      lines: [
        {
          lineType: 'work',
          name: 'Диагностика УЗИ-аппарата',
          quantity: '1',
          unitPriceKopecks: 350_000n,
          orderIdx: 0,
        },
        {
          lineType: 'work',
          name: 'Ремонт коннектора датчика C5-2',
          quantity: '2',
          unitPriceKopecks: 350_000n,
          orderIdx: 1,
        },
        {
          lineType: 'part',
          name: 'Кабель датчика C5-2 (оригинал)',
          quantity: '1',
          unitPriceKopecks: 2_850_000n,
          orderIdx: 2,
        },
      ],
    },
  },
  {
    ticketNumber: 'T-2026-000004',
    clientName: 'Иванов И.И.',
    assetSerial: 'OMR-M3-2024-A0023',
    status: 'closed',
    intakeMethod: 'brought_in',
    repairType: 'paid',
    symptom: 'Тонометр выдаёт ошибку Err при измерении',
    closedDaysAgo: 1,
    events: [
      { type: 'created' },
      { type: 'status_change', payload: { from: 'received', to: 'diagnostics' } },
      { type: 'status_change', payload: { from: 'diagnostics', to: 'in_progress' } },
      { type: 'status_change', payload: { from: 'in_progress', to: 'act_pending' } },
      { type: 'status_change', payload: { from: 'act_pending', to: 'closed' } },
    ],
    workOrder: {
      diagnosis: 'Загрязнён клапан манжеты, требуется чистка',
      repairDescription: 'Чистка пневмосистемы, замена манжеты',
      lines: [
        {
          lineType: 'work',
          name: 'Чистка и калибровка тонометра',
          quantity: '1',
          unitPriceKopecks: 80_000n,
          orderIdx: 0,
        },
        {
          lineType: 'part',
          name: 'Манжета Omron M Comfort',
          quantity: '1',
          unitPriceKopecks: 120_000n,
          orderIdx: 1,
        },
      ],
    },
  },
];

const DEMO_TICKET_SEEDS: TicketSeed[] = [
  {
    ticketNumber: 'T-2026-000001',
    clientName: 'ООО «Демо-Клиника»',
    assetSerial: 'DEMO-X1-0001',
    status: 'received',
    intakeMethod: 'brought_in',
    repairType: 'paid',
    symptom: 'Демо-симптом для проверки изоляции',
    events: [{ type: 'created' }],
  },
];

async function resolveTicketRefs(
  db: ReturnType<typeof makeDb>,
  tenantIdValue: string,
): Promise<{
  byClient: Map<string, string>;
  bySerial: Map<string, string>;
  engineerId: string | null;
  dispatcherId: string | null;
}> {
  const cli = await db
    .select({ id: clients.id, name: clients.displayName })
    .from(clients)
    .where(eq(clients.tenantId, tenantIdValue));
  const byClient = new Map(cli.map((r) => [r.name, r.id]));

  const ast = await db
    .select({ id: assets.id, sn: assets.serialNumber })
    .from(assets)
    .where(eq(assets.tenantId, tenantIdValue));
  const bySerial = new Map(
    ast.filter((r): r is { id: string; sn: string } => r.sn !== null).map((r) => [r.sn, r.id]),
  );

  const usrs = await db
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.tenantId, tenantIdValue));
  const engineerId = usrs.find((u) => u.role === 'engineer')?.id ?? null;
  const dispatcherId = usrs.find((u) => u.role === 'dispatcher')?.id ?? null;

  return { byClient, bySerial, engineerId, dispatcherId };
}

function buildStatusTimestamps(seed: TicketSeed): {
  closedAt: Date | null;
  cancelledAt: Date | null;
} {
  if (seed.status === 'closed') {
    const days = seed.closedDaysAgo ?? 1;
    return {
      closedAt: new Date(Date.now() - days * 24 * 60 * 60 * 1000),
      cancelledAt: null,
    };
  }
  if (seed.status === 'cancelled') {
    return { closedAt: null, cancelledAt: new Date() };
  }
  return { closedAt: null, cancelledAt: null };
}

interface InsertedTotals {
  events: number;
  workOrders: number;
  lines: number;
}

async function insertTicketEventRows(
  db: ReturnType<typeof makeDb>,
  tenantIdValue: string,
  ticketId: string,
  seed: TicketSeed,
  refs: { engineerId: string | null },
): Promise<number> {
  const baseTime = Date.now() - 60 * 60 * 1000;
  const rows = seed.events.map((e, i) => {
    const payload = { ...(e.payload ?? {}) };
    if (e.type === 'assignment_change' && refs.engineerId) {
      payload.to = refs.engineerId;
      payload.from = null;
    }
    return {
      tenantId: tenantIdValue,
      ticketId,
      userId: null,
      type: e.type,
      payload,
      createdAt: new Date(baseTime + i * 60_000),
    };
  });
  if (rows.length > 0) await db.insert(ticketEvents).values(rows);
  return rows.length;
}

async function insertWorkOrderForTicket(
  db: ReturnType<typeof makeDb>,
  tenantIdValue: string,
  ticketId: string,
  seed: TicketSeed,
  engineerId: string | null,
): Promise<{ workOrders: number; lines: number }> {
  if (!seed.workOrder) return { workOrders: 0, lines: 0 };
  let works = 0n;
  let parts = 0n;
  let expenses = 0n;
  const lineRows = seed.workOrder.lines.map((l) => {
    const [intPart, fracRaw = ''] = l.quantity.split('.');
    const frac = (fracRaw + '000').slice(0, 3);
    const thousandths = BigInt(`${intPart}${frac}`);
    const amount = (thousandths * l.unitPriceKopecks + 500n) / 1000n;
    if (l.lineType === 'work') works += amount;
    else if (l.lineType === 'part') parts += amount;
    else expenses += amount;
    return { line: l, amount };
  });
  const total = works + parts + expenses;
  const [inserted] = await db
    .insert(workOrders)
    .values({
      tenantId: tenantIdValue,
      ticketId,
      orderNumber: seed.ticketNumber,
      engineerId,
      diagnosis: seed.workOrder.diagnosis,
      repairDescription: seed.workOrder.repairDescription ?? null,
      vatRate: '5',
      worksAmountKopecks: works,
      partsAmountKopecks: parts,
      expensesAmountKopecks: expenses,
      totalAmountKopecks: total,
    })
    .returning({ id: workOrders.id });
  if (!inserted) throw new Error('seed: work_order insert returned nothing');

  await db.insert(workOrderLines).values(
    lineRows.map(({ line, amount }) => ({
      tenantId: tenantIdValue,
      workOrderId: inserted.id,
      lineType: line.lineType,
      name: line.name,
      unit: line.unit ?? 'шт',
      quantity: line.quantity,
      unitPriceKopecks: line.unitPriceKopecks,
      amountKopecks: amount,
      engineerId: line.lineType === 'work' ? engineerId : null,
      orderIdx: line.orderIdx ?? 0,
    })),
  );
  return { workOrders: 1, lines: lineRows.length };
}

async function seedSingleTicket(
  db: ReturnType<typeof makeDb>,
  tenantIdValue: string,
  prefix: string,
  seed: TicketSeed,
  refs: Awaited<ReturnType<typeof resolveTicketRefs>>,
): Promise<InsertedTotals | null> {
  const existing = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.tenantId, tenantIdValue), eq(tickets.ticketNumber, seed.ticketNumber)))
    .limit(1);
  if (existing[0]) return null;

  const clientId = refs.byClient.get(seed.clientName);
  const assetId = refs.bySerial.get(seed.assetSerial);
  if (!clientId) {
    console.warn(`  ! ${prefix}: client "${seed.clientName}" не найден, пропуск тикета`);
    return null;
  }

  const ts = buildStatusTimestamps(seed);
  const [insertedTicket] = await db
    .insert(tickets)
    .values({
      tenantId: tenantIdValue,
      ticketNumber: seed.ticketNumber,
      barcode: `T${seed.ticketNumber}-${prefix.toUpperCase()}-DEMO`,
      clientId,
      assetId: assetId ?? null,
      source: 'call',
      intakeMethod: seed.intakeMethod,
      repairType: seed.repairType,
      priority: seed.priority ?? 'normal',
      status: seed.status,
      symptom: seed.symptom,
      assignedDispatcherId: refs.dispatcherId,
      assignedEngineerId: seed.assignEngineer ? refs.engineerId : null,
      closedAt: ts.closedAt,
      cancelledAt: ts.cancelledAt,
    })
    .returning({ id: tickets.id });
  if (!insertedTicket) throw new Error('seed: ticket insert returned nothing');

  const eventsCount = await insertTicketEventRows(db, tenantIdValue, insertedTicket.id, seed, {
    engineerId: refs.engineerId,
  });
  const wo = await insertWorkOrderForTicket(
    db,
    tenantIdValue,
    insertedTicket.id,
    seed,
    refs.engineerId,
  );

  console.info(`  + ${prefix} ticket ${seed.ticketNumber} [${seed.status}]`);
  return { events: eventsCount, workOrders: wo.workOrders, lines: wo.lines };
}

async function seedTickets(
  db: ReturnType<typeof makeDb>,
  tenantIdValue: string,
  prefix: string,
): Promise<void> {
  const seedSet = prefix === 'erfolg' ? ERFOLG_TICKET_SEEDS : DEMO_TICKET_SEEDS;
  const refs = await resolveTicketRefs(db, tenantIdValue);

  let tCount = 0;
  let eCount = 0;
  let woCount = 0;
  let lCount = 0;

  for (const seed of seedSet) {
    const totals = await seedSingleTicket(db, tenantIdValue, prefix, seed, refs);
    if (!totals) continue;
    tCount += 1;
    eCount += totals.events;
    woCount += totals.workOrders;
    lCount += totals.lines;
  }

  if (tCount > 0) {
    await db
      .insert(tenantCounters)
      .values({ tenantId: tenantIdValue, kind: 'ticket', year: 2026, lastValue: seedSet.length })
      .onConflictDoUpdate({
        target: [tenantCounters.tenantId, tenantCounters.kind, tenantCounters.year],
        set: {
          lastValue: sql`GREATEST(${tenantCounters.lastValue}, ${seedSet.length})`,
          updatedAt: new Date(),
        },
      });
    console.info(
      `  + ${prefix}: tickets=${tCount}, events=${eCount}, work_orders=${woCount}, lines=${lCount}`,
    );
  } else {
    console.info(`  = ${prefix} tickets already seeded`);
  }
}

/**
 * Этап 5: seed-данные склада, ТО и платежей.
 * Идемпотентно: проверки по (tenant, name) для items, (tenant, ticket+amount) для платежей.
 *
 * Создаёт:
 *   - 3 inventory_items типичных для медтехники
 *   - 3 партии для одного из items с разными expires_at (для FEFO-проверки)
 *   - 1 maintenance_schedule с next_due_at в прошлом (overdue-демонстрация)
 *   - 1 payment на закрытую заявку T-2026-000004
 */
async function seedStage5(
  db: ReturnType<typeof makeDb>,
  tenantIdValue: string,
  prefix: string,
): Promise<void> {
  const itemSeeds = [
    {
      name: 'Датчик SpO2 Nellcor MAX-A',
      sku: 'NLC-MAX-A',
      manufacturer: 'Medtronic',
      unit: 'шт',
      minStock: '2',
      category: 'Датчики',
    },
    {
      name: 'Кабель ЭКГ 5-отведений (ЕС-съёмные)',
      sku: 'ECG-5-EU',
      manufacturer: 'Schiller',
      unit: 'шт',
      minStock: '1',
      category: 'Кабели',
    },
    {
      name: 'Фильтр HEPA для ИВЛ Hamilton C3',
      sku: 'HAM-C3-HEPA',
      manufacturer: 'Hamilton',
      unit: 'шт',
      minStock: '5',
      category: 'Расходники',
    },
  ];

  const itemIds = new Map<string, string>();
  for (const seed of itemSeeds) {
    const existing = await db
      .select({ id: inventoryItems.id })
      .from(inventoryItems)
      .where(and(eq(inventoryItems.tenantId, tenantIdValue), eq(inventoryItems.name, seed.name)))
      .limit(1);
    if (existing[0]) {
      itemIds.set(seed.name, existing[0].id);
      continue;
    }
    const [inserted] = await db
      .insert(inventoryItems)
      .values({ tenantId: tenantIdValue, ...seed })
      .returning({ id: inventoryItems.id });
    if (inserted) {
      itemIds.set(seed.name, inserted.id);
      console.info(`  + ${prefix} inventory_item: ${seed.name}`);
    }
  }

  // 3 партии на «Датчик SpO2» с разными сроками — для теста FEFO выбора.
  const sensorItemId = itemIds.get('Датчик SpO2 Nellcor MAX-A');
  if (sensorItemId) {
    const day = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const batches = [
      {
        batchCode: 'BATCH-2024-12',
        quantity: '5',
        unitCostKopecks: 450_000n,
        supplier: 'ООО «МедОптТорг»',
        receivedAt: new Date(now - 60 * day),
        expiresAt: new Date(now - 1 * day), // просроченная (будет первой в FEFO)
      },
      {
        batchCode: 'BATCH-2025-03',
        quantity: '10',
        unitCostKopecks: 470_000n,
        supplier: 'ООО «МедОптТорг»',
        receivedAt: new Date(now - 30 * day),
        expiresAt: new Date(now + 10 * day),
      },
      {
        batchCode: 'BATCH-2026-01',
        quantity: '20',
        unitCostKopecks: 490_000n,
        supplier: 'АО «Медтехника-Север»',
        receivedAt: new Date(now - 5 * day),
        expiresAt: new Date(now + 90 * day),
      },
    ];
    for (const b of batches) {
      const existing = await db
        .select({ id: inventoryBatches.id })
        .from(inventoryBatches)
        .where(
          and(
            eq(inventoryBatches.tenantId, tenantIdValue),
            eq(inventoryBatches.itemId, sensorItemId),
            eq(inventoryBatches.batchCode, b.batchCode),
          ),
        )
        .limit(1);
      if (existing[0]) continue;
      const [batch] = await db
        .insert(inventoryBatches)
        .values({
          tenantId: tenantIdValue,
          itemId: sensorItemId,
          batchCode: b.batchCode,
          quantityInitial: b.quantity,
          quantityRemaining: b.quantity,
          unitCostKopecks: b.unitCostKopecks,
          supplier: b.supplier,
          receivedAt: b.receivedAt,
          expiresAt: b.expiresAt,
        })
        .returning({ id: inventoryBatches.id });
      if (batch) {
        await db.insert(inventoryMovements).values({
          tenantId: tenantIdValue,
          itemId: sensorItemId,
          batchId: batch.id,
          quantity: b.quantity,
          kind: 'inbound',
          referenceType: 'manual',
          comment: `Приход партии ${b.batchCode}`,
        });
        console.info(`  + ${prefix} inventory_batch: ${b.batchCode}`);
      }
    }
  }

  // Один график ТО — на просрочку.
  const someAsset = await db
    .select({ id: assets.id })
    .from(assets)
    .where(eq(assets.tenantId, tenantIdValue))
    .limit(1);
  const assetId = someAsset[0]?.id;
  if (assetId) {
    const existing = await db
      .select({ id: maintenanceSchedules.id })
      .from(maintenanceSchedules)
      .where(
        and(
          eq(maintenanceSchedules.tenantId, tenantIdValue),
          eq(maintenanceSchedules.assetId, assetId),
        ),
      )
      .limit(1);
    if (!existing[0]) {
      const day = 24 * 60 * 60 * 1000;
      await db.insert(maintenanceSchedules).values({
        tenantId: tenantIdValue,
        assetId,
        kind: 'planned',
        intervalDays: 180,
        lastDoneAt: new Date(Date.now() - 200 * day),
        nextDueAt: new Date(Date.now() - 20 * day), // overdue
        notes: 'Плановое ТО раз в полгода',
      });
      console.info(`  + ${prefix} maintenance_schedule (overdue)`);
    }
  }

  // Платёж на закрытую заявку.
  const closedTicket = await db
    .select({ id: tickets.id })
    .from(tickets)
    .where(and(eq(tickets.tenantId, tenantIdValue), eq(tickets.status, 'closed')))
    .limit(1);
  const closedTicketId = closedTicket[0]?.id;
  if (closedTicketId) {
    const existing = await db
      .select({ id: payments.id })
      .from(payments)
      .where(eq(payments.ticketId, closedTicketId))
      .limit(1);
    if (!existing[0]) {
      const amount = 200_000n;
      await db.insert(payments).values({
        tenantId: tenantIdValue,
        ticketId: closedTicketId,
        amountKopecks: amount,
        method: 'cash',
        paidAt: new Date(),
        comment: 'Полная оплата при выдаче',
      });
      // Пересчитываем materialized paid_amount_kopecks.
      await db
        .update(workOrders)
        .set({ paidAmountKopecks: amount })
        .where(
          and(
            eq(workOrders.tenantId, tenantIdValue),
            eq(workOrders.ticketId, closedTicketId),
          ),
        );
      console.info(`  + ${prefix} payment for closed ticket`);
    }
  }
}

/**
 * Касса / ДДС: дефолтные денежные счета и статьи доходов/расходов.
 * Идемпотентно: счета по (tenant, name), статьи по (tenant, name, direction).
 * Синхронизация существующих payments в кассу — на Этапе B (backfill-миграция + cash-sync).
 */
async function seedCash(
  db: ReturnType<typeof makeDb>,
  tenantIdValue: string,
  prefix: string,
): Promise<void> {
  const accountSeeds: Array<typeof cashAccounts.$inferInsert> = [
    { tenantId: tenantIdValue, name: 'Наличные', kind: 'cash', defaultForMethod: 'cash', sortOrder: 10 },
    {
      tenantId: tenantIdValue,
      name: 'Расчётный счёт',
      kind: 'bank',
      defaultForMethod: 'bank_transfer',
      sortOrder: 20,
    },
    { tenantId: tenantIdValue, name: 'Карта', kind: 'card', defaultForMethod: 'card', sortOrder: 30 },
  ];

  let createdAccounts = 0;
  for (const a of accountSeeds) {
    const existing = await db
      .select({ id: cashAccounts.id })
      .from(cashAccounts)
      .where(and(eq(cashAccounts.tenantId, tenantIdValue), eq(cashAccounts.name, a.name)))
      .limit(1);
    if (existing[0]) continue;
    await db.insert(cashAccounts).values(a);
    createdAccounts += 1;
  }

  const categorySeeds: Array<typeof cashCategories.$inferInsert> = [
    // Доходы
    {
      tenantId: tenantIdValue,
      name: 'Оплата по заявкам',
      direction: 'income',
      isSystem: true,
      systemCode: 'ticket_payment',
      sortOrder: 10,
    },
    { tenantId: tenantIdValue, name: 'Продажа техники и запчастей', direction: 'income', sortOrder: 20 },
    { tenantId: tenantIdValue, name: 'Прочий доход', direction: 'income', sortOrder: 30 },
    // Расходы
    { tenantId: tenantIdValue, name: 'Зарплата', direction: 'expense', sortOrder: 10 },
    { tenantId: tenantIdValue, name: 'Закупка запчастей', direction: 'expense', sortOrder: 20 },
    { tenantId: tenantIdValue, name: 'Аренда', direction: 'expense', sortOrder: 30 },
    { tenantId: tenantIdValue, name: 'Налоги и взносы', direction: 'expense', sortOrder: 40 },
    { tenantId: tenantIdValue, name: 'ГСМ и транспорт', direction: 'expense', sortOrder: 50 },
    { tenantId: tenantIdValue, name: 'Связь и ПО', direction: 'expense', sortOrder: 60 },
    { tenantId: tenantIdValue, name: 'Хозяйственные расходы', direction: 'expense', sortOrder: 70 },
    { tenantId: tenantIdValue, name: 'Прочие расходы', direction: 'expense', sortOrder: 80 },
  ];

  let createdCategories = 0;
  for (const c of categorySeeds) {
    const existing = await db
      .select({ id: cashCategories.id })
      .from(cashCategories)
      .where(
        and(
          eq(cashCategories.tenantId, tenantIdValue),
          eq(cashCategories.name, c.name),
          eq(cashCategories.direction, c.direction),
        ),
      )
      .limit(1);
    if (existing[0]) continue;
    await db.insert(cashCategories).values(c);
    createdCategories += 1;
  }

  // Синхронизация существующих оплат по заявкам в кассу (как backfill-миграция 0048,
  // но для платежей, созданных seed'ом ПОСЛЕ наката миграций). Идемпотентно (NOT EXISTS).
  await db.execute(sql`
    INSERT INTO cash_transactions (
      tenant_id, kind, account_id, category_id, amount_kopecks, occurred_on,
      comment, payment_id, invoice_id, ticket_id, user_id, source
    )
    SELECT p.tenant_id, 'income', acc.id, cat.id, p.amount_kopecks, p.paid_at::date,
           'Оплата по заявке', p.id, p.invoice_id, p.ticket_id, p.user_id, 'payment'
      FROM payments p
      JOIN LATERAL (
        SELECT a.id FROM cash_accounts a
         WHERE a.tenant_id = p.tenant_id AND a.deleted_at IS NULL AND a.is_archived = false
           AND (a.default_for_method = p.method
                OR a.kind::text = CASE p.method::text
                                    WHEN 'cash' THEN 'cash' WHEN 'card' THEN 'card'
                                    WHEN 'bank_transfer' THEN 'bank' END)
         ORDER BY (a.default_for_method = p.method) DESC, a.sort_order ASC
         LIMIT 1
      ) acc ON true
      LEFT JOIN cash_categories cat
        ON cat.tenant_id = p.tenant_id AND cat.system_code = 'ticket_payment' AND cat.deleted_at IS NULL
     WHERE p.tenant_id = ${tenantIdValue}
       AND NOT EXISTS (
         SELECT 1 FROM cash_transactions ct
          WHERE ct.tenant_id = p.tenant_id AND ct.payment_id = p.id AND ct.deleted_at IS NULL
       )
  `);
  await db.execute(sql`
    UPDATE cash_accounts a
       SET balance_kopecks = a.opening_balance_kopecks + COALESCE((
             SELECT SUM(CASE
                      WHEN ct.kind='income'   AND ct.account_id=a.id THEN ct.amount_kopecks
                      WHEN ct.kind='expense'  AND ct.account_id=a.id THEN -ct.amount_kopecks
                      WHEN ct.kind='transfer' AND ct.account_id=a.id THEN -ct.amount_kopecks
                      WHEN ct.kind='transfer' AND ct.counter_account_id=a.id THEN ct.amount_kopecks
                      ELSE 0 END)
               FROM cash_transactions ct
              WHERE ct.deleted_at IS NULL AND (ct.account_id=a.id OR ct.counter_account_id=a.id)
           ), 0)
     WHERE a.tenant_id = ${tenantIdValue} AND a.deleted_at IS NULL
  `);

  if (createdAccounts + createdCategories > 0) {
    console.info(`  + ${prefix} cash: accounts=${createdAccounts}, categories=${createdCategories}`);
  } else {
    console.info(`  = ${prefix} cash already seeded`);
  }
}

main().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
