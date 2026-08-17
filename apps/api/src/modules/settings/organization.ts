/**
 * Реквизиты организации — то, что печатается в документах.
 *
 * Колонки лежат в `tenants` (control-plane, без RLS — читаем и пишем напрямую по
 * id тенанта из контекста). Заполнены они были сидом и больше никем не читались:
 * бланки печатали зашитую в код константу `apps/web/src/lib/pdf/branding.ts`.
 *
 * ПРО ПРОВЕРКИ. ИНН, КПП, БИК и счета — не «просто текст»: неверный БИК в счёте
 * означает, что клиент не сможет заплатить, и узнает об этом бухгалтер заказчика
 * через неделю. Длины проверяются здесь, а не только на экране. Пустое значение
 * разрешено: у ИП нет КПП, ОГРН заполнен не у всех, и заставлять человека
 * выдумывать цифры нельзя. Телефон НЕ проверяем — его пишут как удобно
 * («8 (928) 895-70-70», «+7 928 895 70 70», два номера через запятую).
 */
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { tenants, type Db } from '@erfolg/db';

export interface OrganizationDto {
  /** Короткое имя компании; оно же в шапке интерфейса. Пустым не бывает. */
  displayName: string;
  legalName: string | null;
  slogan: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  bankAccount: string | null;
  correspondentAccount: string | null;
  bik: string | null;
  licenseSeries: string | null;
  licenseNumber: string | null;
  /** 'YYYY-MM-DD' либо null — на экране это поле-дата. */
  licenseDate: string | null;
  licenseAuthority: string | null;
  directorName: string | null;
}

/** Строка из цифр ровно указанной длины; пусто разрешено. */
function digits(lengths: number[], message: string) {
  return z
    .string()
    .trim()
    .max(30)
    .refine((v) => v === '' || (/^\d+$/.test(v) && lengths.includes(v.length)), message);
}

const optionalText = (max: number) => z.string().trim().max(max);

export const organizationPatchSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Название не может быть пустым').max(200),
    legalName: optionalText(500),
    slogan: optionalText(300),
    inn: digits([10, 12], 'ИНН — 10 цифр у организации или 12 у ИП'),
    kpp: digits([9], 'КПП — 9 цифр'),
    ogrn: digits([13, 15], 'ОГРН — 13 цифр, ОГРНИП — 15'),
    legalAddress: optionalText(1000),
    phone: optionalText(50),
    email: z
      .string()
      .trim()
      .max(200)
      .refine((v) => v === '' || z.string().email().safeParse(v).success, 'Проверьте адрес почты'),
    bankName: optionalText(300),
    bankAccount: digits([20], 'Расчётный счёт — 20 цифр'),
    correspondentAccount: digits([20], 'Корреспондентский счёт — 20 цифр'),
    bik: digits([9], 'БИК — 9 цифр'),
    licenseSeries: optionalText(20),
    licenseNumber: optionalText(50),
    licenseDate: z
      .string()
      .trim()
      .refine((v) => v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v), 'Проверьте дату лицензии'),
    licenseAuthority: optionalText(200),
    directorName: optionalText(200),
  })
  .partial()
  .strict();

export type OrganizationPatch = z.infer<typeof organizationPatchSchema>;

/** Пустая строка в форме означает «не заполнено», а не пробел в документе. */
function toNull(v: string | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? null : t;
}

export async function readOrganization(db: Db, tenantId: string): Promise<OrganizationDto> {
  const rows = await db
    .select({
      displayName: tenants.displayName,
      legalName: tenants.legalName,
      slogan: tenants.slogan,
      inn: tenants.inn,
      kpp: tenants.kpp,
      ogrn: tenants.ogrn,
      legalAddress: tenants.legalAddress,
      phone: tenants.phone,
      email: tenants.email,
      bankName: tenants.bankName,
      bankAccount: tenants.bankAccount,
      correspondentAccount: tenants.correspondentAccount,
      bik: tenants.bik,
      licenseSeries: tenants.licenseSeries,
      licenseNumber: tenants.licenseNumber,
      licenseDate: tenants.licenseDate,
      licenseAuthority: tenants.licenseAuthority,
      directorName: tenants.directorName,
    })
    .from(tenants)
    .where(eq(tenants.id, tenantId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Error('readOrganization: tenant not found');
  return {
    ...row,
    // В базе это timestamp, на экране — поле-дата. Отдаём 'YYYY-MM-DD'.
    licenseDate: row.licenseDate ? row.licenseDate.toISOString().slice(0, 10) : null,
  };
}

export async function updateOrganization(
  db: Db,
  tenantId: string,
  patch: OrganizationPatch,
): Promise<void> {
  const set: Record<string, unknown> = {};
  for (const key of [
    'displayName',
    'legalName',
    'slogan',
    'inn',
    'kpp',
    'ogrn',
    'legalAddress',
    'phone',
    'email',
    'bankName',
    'bankAccount',
    'correspondentAccount',
    'bik',
    'licenseSeries',
    'licenseNumber',
    'licenseAuthority',
    'directorName',
  ] as const) {
    const v = toNull(patch[key]);
    if (v !== undefined) set[key] = v;
  }
  // displayName стоит в шапке интерфейса и не может быть пустым — схема этого не
  // пропустит, но подстрахуемся: NOT NULL в базе упал бы сырой ошибкой.
  if (set.displayName === null) delete set.displayName;

  if (patch.licenseDate !== undefined) {
    const d = patch.licenseDate.trim();
    set.licenseDate = d === '' ? null : new Date(`${d}T00:00:00Z`);
  }

  if (Object.keys(set).length === 0) return;
  await db.update(tenants).set(set).where(eq(tenants.id, tenantId));
}
