/**
 * Тип техники берём из архива ремонтов, когда в карточке он не заполнен.
 *
 * Зачем это вообще: подсказка «кому отдать заявку» сверяет навык инженера с типом
 * техники, а на бою `assets.device_type` пуст у ВСЕХ 5044 единиц — сравнивать не с
 * чем, и вся проверка навыков молчит. При этом типы в базе есть: в перенесённом
 * архиве ремонтов они проставлены у 4266 строк из 4267, и по названию модели
 * сходятся с 4289 единицами техники из 5044.
 *
 * Правила, которые здесь закреплены:
 *   • модель, у которой в архиве РАЗНЫЕ типы, не даёт ничего — угадывать нельзя;
 *   • свой тип в карточке техники всегда сильнее архивного;
 *   • словарь типов для подсказок берётся из реальных данных (архив + заведённая
 *     техника), а не из выдуманного списка в коде: иначе навык «Кардиограф» никогда
 *     не совпадёт с техникой «ЭКГ»;
 *   • архив одного тенанта не виден другому.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { assets, getDb, repairArchive, users, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { appRouter } from '../trpc/router';
import { deviceTypeByModel } from '../modules/assets/repository';
import type { Context } from '../trpc/context';
import type { SessionData } from '../lib/session';

const PREFIX = 'TEST-DT-';
const MODEL_ONE = 'TEST-DT-Модель-Однозначная';
const MODEL_AMBIGUOUS = 'TEST-DT-Модель-Спорная';
const TYPE_COMMON = 'TEST-DT-Частый';
const TYPE_RARE = 'TEST-DT-Редкий';

let erfolgId = '';
let demoId = '';
let dispatcherId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;
  const [disp] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: users.id }).from(users).where(eq(users.role, 'dispatcher')).limit(1),
  );
  if (!disp) throw new Error('seed missing dispatcher');
  dispatcherId = disp.id;
});

beforeEach(async () => {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx.delete(repairArchive).where(like(repairArchive.sourceRef, `${PREFIX}%`));
      await tx.delete(assets).where(like(assets.model, `${PREFIX}%`));
    });
  }
  // Архив: частый тип встречается трижды, редкий — один раз, спорная модель даёт
  // два разных типа. Регистр и пробелы намеренно разные — они не должны плодить
  // одинаковые записи в словаре.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.insert(repairArchive).values([
      {
        tenantId: erfolgId,
        sourceRef: `${PREFIX}1`,
        deviceModel: MODEL_ONE,
        deviceType: TYPE_COMMON,
      },
      {
        tenantId: erfolgId,
        sourceRef: `${PREFIX}2`,
        deviceModel: MODEL_ONE,
        deviceType: `  ${TYPE_COMMON.toLowerCase()}  `,
      },
      {
        tenantId: erfolgId,
        sourceRef: `${PREFIX}3`,
        deviceModel: `${MODEL_ONE.toLowerCase()}  `,
        deviceType: TYPE_COMMON,
      },
      {
        tenantId: erfolgId,
        sourceRef: `${PREFIX}4`,
        deviceModel: 'TEST-DT-Другая-Модель',
        deviceType: TYPE_RARE,
      },
      {
        tenantId: erfolgId,
        sourceRef: `${PREFIX}5`,
        deviceModel: MODEL_AMBIGUOUS,
        deviceType: TYPE_RARE,
      },
      {
        tenantId: erfolgId,
        sourceRef: `${PREFIX}6`,
        deviceModel: MODEL_AMBIGUOUS,
        deviceType: TYPE_COMMON,
      },
    ]);
  });
});

function fakeRes() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = { cookie: () => {}, clearCookie: () => {}, req: { cookies: {} } };
  return res;
}

function makeCtx(tenantId: string, subdomain: string): Context {
  const session: SessionData = {
    tenantId,
    userId: dispatcherId,
    username: 'dispatcher-test',
    role: 'dispatcher',
    fullName: 'Test dispatcher',
    expiresAt: Date.now() + 3600_000,
  };
  return {
    db: getDb(),
    tenant: {
      id: tenantId,
      subdomain,
      displayName: subdomain,
      status: 'active',
      timezone: 'Europe/Moscow',
      kmsKeyId: null,
    },
    session,
    clientUser: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    res: fakeRes(),
  };
}

/** Завести единицу техники напрямую — без событий и аудита, они здесь не проверяются. */
async function makeAsset(model: string, deviceType: string | null): Promise<string> {
  const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .insert(assets)
      .values({ tenantId: erfolgId, model, deviceType })
      .returning({ id: assets.id }),
  );
  return rows[0]!.id;
}

describe('тип техники по модели из архива', () => {
  it('однозначная модель даёт тип', async () => {
    await expect(deviceTypeByModel(getDb(), erfolgId, MODEL_ONE)).resolves.toBe(TYPE_COMMON);
  });

  it('регистр и лишние пробелы в модели не мешают', async () => {
    await expect(
      deviceTypeByModel(getDb(), erfolgId, `  ${MODEL_ONE.toUpperCase()} `),
    ).resolves.toBe(TYPE_COMMON);
  });

  it('модель с разными типами не даёт ничего — угадывать нельзя', async () => {
    await expect(deviceTypeByModel(getDb(), erfolgId, MODEL_AMBIGUOUS)).resolves.toBeNull();
  });

  it('незнакомая модель — null', async () => {
    await expect(
      deviceTypeByModel(getDb(), erfolgId, 'TEST-DT-Такой-модели-нет'),
    ).resolves.toBeNull();
  });

  it('архив чужого тенанта не подсказывает', async () => {
    await expect(deviceTypeByModel(getDb(), demoId, MODEL_ONE)).resolves.toBeNull();
  });
});

describe('карточка техники отдаёт разрешённый тип', () => {
  it('пустой тип подставляется из архива и помечен источником', async () => {
    const id = await makeAsset(MODEL_ONE, null);
    const asset = await appRouter.createCaller(makeCtx(erfolgId, 'erfolg')).assets.get({ id });
    expect(asset.deviceType).toBeNull();
    expect(asset.deviceTypeResolved).toBe(TYPE_COMMON);
    expect(asset.deviceTypeSource).toBe('archive');
  });

  it('свой тип сильнее архивного', async () => {
    const id = await makeAsset(MODEL_ONE, 'Свой тип');
    const asset = await appRouter.createCaller(makeCtx(erfolgId, 'erfolg')).assets.get({ id });
    expect(asset.deviceTypeResolved).toBe('Свой тип');
    expect(asset.deviceTypeSource).toBe('own');
  });

  it('спорная модель оставляет тип неизвестным', async () => {
    const id = await makeAsset(MODEL_AMBIGUOUS, null);
    const asset = await appRouter.createCaller(makeCtx(erfolgId, 'erfolg')).assets.get({ id });
    expect(asset.deviceTypeResolved).toBeNull();
    expect(asset.deviceTypeSource).toBeNull();
  });
});

describe('словарь типов техники', () => {
  it('берёт типы из архива, а не только из заведённой техники', async () => {
    const list = await appRouter.createCaller(makeCtx(erfolgId, 'erfolg')).assets.deviceTypes();
    expect(list).toContain(TYPE_COMMON);
    expect(list).toContain(TYPE_RARE);
  });

  it('один и тот же тип в разном регистре не двоится', async () => {
    const list = await appRouter.createCaller(makeCtx(erfolgId, 'erfolg')).assets.deviceTypes();
    const same = list.filter((t) => t.trim().toLowerCase() === TYPE_COMMON.toLowerCase());
    expect(same).toHaveLength(1);
  });

  it('частый тип идёт раньше редкого — с него и начинают отмечать', async () => {
    const list = await appRouter.createCaller(makeCtx(erfolgId, 'erfolg')).assets.deviceTypes();
    expect(list.indexOf(TYPE_COMMON)).toBeLessThan(list.indexOf(TYPE_RARE));
  });

  it('чужой тенант этих типов не видит', async () => {
    const list = await appRouter.createCaller(makeCtx(demoId, 'demo')).assets.deviceTypes();
    expect(list).not.toContain(TYPE_COMMON);
  });
});
