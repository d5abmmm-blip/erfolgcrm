/**
 * Шаг 2 переноса: загрузка данных WinServisePro в ErfolgCRM (PostgreSQL).
 *
 * Читает winservice-export.json (его делает scripts/import-winservice/export-fdb.mjs)
 * и раскладывает по таблицам CRM. Работает как owner — RLS обходится как в seed.ts.
 *
 * Идемпотентность: id всех строк — детерминированный UUIDv5 от старого ID,
 * вставка через ON CONFLICT (id) DO NOTHING. Повторный запуск ничего не дублирует
 * и дольёт только недостающее.
 *
 * Запуск (сухой прогон — ничего не пишет, только отчёт):
 *   pnpm --filter @erfolg/db tsx src/import-winservice.ts --dry-run
 * Запуск (реальная загрузка):
 *   pnpm --filter @erfolg/db tsx src/import-winservice.ts
 * Файл выгрузки можно указать первым аргументом или env IMPORT_FILE.
 *
 * Маппинг и компромиссы — см. README рядом с экспортом и комментарии ниже.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash as argonHash } from 'argon2';
import { eq, sql } from 'drizzle-orm';
import { makeDb } from './client';
import { getTenantEncryptionKey } from './crypto';
import { classifyClientType, initialsDisplayName } from './import-winservice-classify';
import {
  assetEvents,
  assets,
  tenants,
  ticketEvents,
  tickets,
  users,
  workOrderLines,
  workOrders,
} from './schema';

// ───────────────────────── конфиг / аргументы ─────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const DRY_RUN = process.argv.includes('--dry-run');
const fileArg = process.argv.slice(2).find((a) => !a.startsWith('--'));
const IMPORT_FILE = resolve(
  fileArg ??
    process.env.IMPORT_FILE ??
    join(__dirname, '../../..', 'scripts/import-winservice/winservice-export.json'),
);
const DATABASE_URL =
  process.env.DATABASE_OWNER_URL ??
  process.env.DATABASE_URL ??
  'postgresql://erfolg:dev_only_password@localhost:5432/erfolg_dev';

/**
 * Пароль-заглушка для перенесённых сотрудников. Аккаунты создаются НЕАКТИВНЫМИ
 * (isActive:false): они нужны как ссылки «кто делал наряд/менял статус», но войти нельзя,
 * пока директор явно не активирует нужного человека и не задаст ему нормальный пароль.
 * Так на боевой базе не появляется пачка живых логинов с общим паролем (в старой базе
 * несколько «Администраторов» → роль director с полным доступом к финансам и ПДн).
 */
const TEMP_PASSWORD = 'Erfolg-Import-2026';

// ───────────────────────── helpers ─────────────────────────
type Row = Record<string, unknown>;

const str = (v: unknown): string | null => {
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length ? s : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return null; // null / object / array / прочее
};
const clip = (v: unknown, max: number): string | null => {
  const s = str(v);
  return s == null ? null : s.slice(0, max);
};
const int = (v: unknown): number | null => {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
};
const numRub = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const kop = (v: unknown): bigint => BigInt(Math.round(numRub(v) * 100));
const dt = (v: unknown): Date | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};

// Детерминированный UUIDv5 от строкового ключа — стабилен между запусками.
const NS = Buffer.from('1b671a6440d5491e99b0da01ff1f3341', 'hex');
function uuid5(name: string): string {
  const h = createHash('sha1');
  h.update(NS);
  h.update(Buffer.from(name, 'utf8'));
  const b = h.digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50; // версия 5
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80; // вариант RFC 4122
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
const idOf = (kind: string, oldId: string | number): string => uuid5(`${kind}:${oldId}`);

// Транслитерация ФИО → ascii-логин.
const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
};
function translit(s: string): string {
  return s
    .toLowerCase()
    .split('')
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join('')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 50);
}

// Бюджетник по названию (subtype). Юрлицо-признаки и инициалы — в import-winservice-classify.ts.
// ВАЖНО: \b в JS не работает с кириллицей, поэтому границу слова задаём через (?<!\p{L})…(?!\p{L}) с флагом u.
const BUDGET_RE =
  /(?<!\p{L})(ГБУ|ФГБУ|ФГКУ|ГАУ|ГКУ|ГУП|МУП|ФКУ|ФБУ|МБУ|ГБОУ|ФГБОУ|МБОУ|ОГБУ|КГБУ|МБДОУ|ДОУ|УБ|ГБ|РБ|РКБ|ЦРБ|РДКБ|ДКБ|РКЦ|ПЦ|ФАП)(?!\p{L})|бюджетн|казённ|казенн|государствен|муниципальн|комиссариат/iu;

// Статусы WinServisePro → ticket_status CRM.
const STATUS_MAP: Record<number, 'received' | 'in_progress' | 'closed' | 'cancelled'> = {
  5: 'received', // Приняли
  1: 'in_progress', // На ремонте
  3: 'in_progress', // Нужны запчасти
  6: 'in_progress', // По гарантии
  2: 'closed', // Аппарат готов
  10: 'closed', // Сделано на месте
  16: 'closed', // Отдали для проверки
  8: 'closed', // Отдали на неделю
  9: 'closed', // На списание
  13: 'closed', // Возврат
  15: 'cancelled', // Возврат без ремонта
  14: 'cancelled', // Заказчик отказался от ремонта
};

// ───────────────────────── загрузка экспорта ─────────────────────────
interface ExportShape {
  exportedAt: string;
  counts: Record<string, number>;
  tables: Record<string, Row[]>;
}

function loadExport(): ExportShape {
  const raw = readFileSync(IMPORT_FILE, 'utf-8');
  return JSON.parse(raw) as ExportShape;
}

function indexBy(rows: Row[], key = 'ID'): Map<number, Row> {
  const m = new Map<number, Row>();
  for (const r of rows) {
    const k = int(r[key]);
    if (k != null) m.set(k, r);
  }
  return m;
}

// ───────────────────────── основной маппинг ─────────────────────────
async function main(): Promise<void> {
  console.info(`WinServisePro → ErfolgCRM import  ${DRY_RUN ? '(DRY-RUN)' : '(LIVE)'}`);
  console.info(`Файл выгрузки: ${IMPORT_FILE}`);

  const data = loadExport();
  const T = data.tables;
  const warnings: string[] = [];

  // словари
  const manufacturers = indexBy(T.MANUFACTURER ?? []);
  const deviceTypes = indexBy(T.DEVICETYPE ?? []);
  const models = indexBy(T.MODEL ?? []);
  const workCatalog = indexBy(T.OWORK ?? []);
  const details = indexBy(T.DETAIL ?? []);
  const orderStatuses = indexBy(T.ORDERSTATUS ?? []);
  const repairTypesCat = indexBy(T.REPAIRTYPE ?? []);
  const clientsById = indexBy(T.CLIENT ?? []);

  const nameOf = (m: Map<number, Row>, id: unknown, field = 'DESCRIPTION'): string | null =>
    id == null ? null : str(m.get(int(id) as number)?.[field]);

  const db = DRY_RUN ? null : makeDb(DATABASE_URL);

  // Целевой tenant. In-app путь (кнопка «Загрузка старой базы») пробрасывает
  // IMPORT_TENANT_ID из HMAC-токена (на проде это 'crm'); CLI на dev без этой env
  // по-прежнему целится в 'erfolg' (создаётся seed). Ключ шифрования ПДн от выбора
  // tenant НЕ зависит (crypto.ts берёт app-wide PII_ENCRYPTION_KEY), но tenant_id
  // должен быть верным — иначе данные уедут в чужой/несуществующий tenant.
  const IMPORT_TENANT_ID = process.env.IMPORT_TENANT_ID?.trim() || null;
  let tenantIdValue = 'DRYRUN-TENANT';
  let key = getTenantEncryptionKey({ id: tenantIdValue, kmsKeyId: null });
  if (db) {
    const t = IMPORT_TENANT_ID
      ? await db.select().from(tenants).where(eq(tenants.id, IMPORT_TENANT_ID)).limit(1)
      : await db.select().from(tenants).where(eq(tenants.subdomain, 'erfolg')).limit(1);
    if (!t[0]) {
      throw new Error(
        IMPORT_TENANT_ID
          ? `tenant с id=${IMPORT_TENANT_ID} не найден — проверьте IMPORT_TENANT_ID.`
          : 'tenant "erfolg" не найден — прогоните seed или задайте IMPORT_TENANT_ID.',
      );
    }
    tenantIdValue = t[0].id;
    key = getTenantEncryptionKey({ id: tenantIdValue, kmsKeyId: t[0].kmsKeyId });
  }

  // ───────── 1. Пользователи (OUSER → users) ─────────
  const userIdByOld = new Map<number, string>();
  const usedUsernames = new Set<string>();
  if (db) {
    const existing = await db
      .select({ u: users.username })
      .from(users)
      .where(eq(users.tenantId, tenantIdValue));
    existing.forEach((r) => usedUsernames.add(r.u.toLowerCase()));
  }
  const roleOf = (oroleId: number | null): 'director' | 'dispatcher' | 'engineer' =>
    oroleId === 1 ? 'director' : oroleId === 2 ? 'dispatcher' : 'engineer';
  const positionOf = (role: string): string =>
    role === 'director' ? 'Администратор' : role === 'dispatcher' ? 'Приёмщик' : 'Инженер';

  const passwordHash = DRY_RUN ? 'dryrun' : await argonHash(TEMP_PASSWORD);
  const userRows: Array<typeof users.$inferInsert> = [];
  for (const u of T.OUSER ?? []) {
    const oldId = int(u.ID);
    if (oldId == null) continue;
    const fullName = clip(u.DESCRIPTION, 200) ?? `Сотрудник ${oldId}`;
    const role = roleOf(int(u.OROLEID));
    let base = translit(fullName) || `user${oldId}`;
    if (usedUsernames.has(base)) base = `${base}_${oldId}`;
    usedUsernames.add(base);
    const newId = idOf('user', oldId);
    userIdByOld.set(oldId, newId);
    userRows.push({
      id: newId,
      tenantId: tenantIdValue,
      username: base.slice(0, 64),
      fullName,
      position: positionOf(role),
      role,
      passwordHash,
      // Неактивны: только как исторические ссылки-исполнители. Директор активирует вручную.
      isActive: false,
    });
  }
  const userIdFor = (oldId: unknown): string | null => {
    const k = int(oldId);
    return k != null && userIdByOld.has(k) ? userIdByOld.get(k)! : null;
  };

  // ───────── 2. Клиенты (CLIENT → clients + contacts) ─────────
  const GROUP_FOLDERS = new Set([0, 4, 5]); // «Клиенты», «Бюджетные учреждения», «Частные лица»
  const referencedClientIds = new Set<number>();
  for (const o of T.OORDER ?? []) {
    const c = int(o.CLIENTID);
    if (c != null) referencedClientIds.add(c);
  }
  // под какой группой висит клиент (рекурсивно ищем корень)
  function rootGroup(c: Row): number | null {
    let cur: Row | undefined = c;
    const guard = new Set<number>();
    while (cur) {
      const pid = int(cur.PARENTID);
      if (pid == null || pid === 0 || guard.has(pid)) return pid ?? null;
      guard.add(pid);
      const parent = clientsById.get(pid);
      if (!parent) return pid;
      if (GROUP_FOLDERS.has(pid)) return pid;
      cur = parent;
    }
    return null;
  }

  interface ClientPlan {
    id: string;
    type: 'legal' | 'individual';
    subtype: 'commercial' | 'budget' | null;
    displayName: string;
    inn: string | null;
    kpp: string | null;
    ogrn: string | null;
    legalAddress: string | null;
    phone: string | null;
    email: string | null;
    indFullName: string | null;
    indPhone: string | null;
    indAddress: string | null;
    notes: string | null;
    contact: { fullName: string; phone: string; position: string | null } | null;
  }
  const clientPlans: ClientPlan[] = [];
  const clientIdByOld = new Map<number, string>();
  let cntLegal = 0;
  let cntIndividual = 0;

  for (const c of T.CLIENT ?? []) {
    const oldId = int(c.ID);
    if (oldId == null) continue;
    const isGroup = int(c.ISGROUP) === 1;
    // пропускаем чистые папки-группы, если на них нет заявок
    if (isGroup && GROUP_FOLDERS.has(oldId) && !referencedClientIds.has(oldId)) continue;
    if (isGroup && !referencedClientIds.has(oldId) && GROUP_FOLDERS.has(oldId)) continue;

    const name = clip(c.DESCRIPTION, 200) ?? `Клиент ${oldId}`;
    const root = rootGroup(c);
    const inn = clip(c.INN, 12);
    const clientTypeOld = int(c.CLIENTTYPE);
    // Классификация вынесена в чистую classifyClientType (тестируется отдельно).
    // ИНН-признак юрлица — только при длине 10 (см. IMP-1 там же).
    const type: 'legal' | 'individual' = classifyClientType({ name, clientTypeOld, inn, root });

    const subtype: 'commercial' | 'budget' | null =
      type === 'legal' ? (root === 4 || BUDGET_RE.test(name) ? 'budget' : 'commercial') : null;

    const phone = clip(c.PHONE, 50) ?? clip(c.MOBILEPHONE, 50);
    const address = str(c.ADDRESS) ?? str(c.FACTADDRESS);

    // банковские реквизиты схемой не моделируются → сохраняем в notes, чтобы не потерять
    const bankBits: string[] = [];
    if (str(c.BANK)) bankBits.push(`Банк: ${str(c.BANK)}`);
    if (str(c.BIK)) bankBits.push(`БИК: ${str(c.BIK)}`);
    if (str(c.RS)) bankBits.push(`р/с: ${str(c.RS)}`);
    if (str(c.KS)) bankBits.push(`к/с: ${str(c.KS)}`);
    if (str(c.OGRN)) bankBits.push(`ОГРН: ${str(c.OGRN)}`);
    const noteParts = [str(c.NOTE), bankBits.length ? bankBits.join('; ') : null].filter(Boolean);
    const notes = noteParts.length ? noteParts.join('\n') : null;

    const newId = idOf('client', oldId);
    clientIdByOld.set(oldId, newId);

    const contactName = str(c.CONTACTFACE);
    const plan: ClientPlan = {
      id: newId,
      type,
      subtype,
      // Физлицо: в display_name только инициалы (полное ФИО — в indFullName → шифруется).
      // Юрлицо: название организации (не ПДн физлица).
      displayName: type === 'individual' ? initialsDisplayName(name) : name,
      inn: type === 'legal' ? inn : null,
      kpp: type === 'legal' ? clip(c.KPP, 9) : null,
      ogrn: type === 'legal' ? clip(c.OGRN, 15) : null,
      legalAddress: type === 'legal' ? address : null,
      phone: type === 'legal' ? phone : null,
      // email — plaintext-колонка. Для физлица это ПДн (в UI-форме физлица поля email нет
      // вовсе), поэтому пишем email только для юрлиц (рабочий B2B-контакт организации).
      email: type === 'legal' ? clip(c.EMAIL, 200) : null,
      indFullName: type === 'individual' ? name : null,
      indPhone: type === 'individual' ? phone : null,
      indAddress: type === 'individual' ? address : null,
      notes,
      contact:
        type === 'legal' && contactName
          ? {
              fullName: contactName,
              phone: phone ?? 'не указан',
              position: clip(c.CONTACTJOB, 100),
            }
          : null,
    };
    clientPlans.push(plan);
    if (type === 'legal') cntLegal += 1;
    else cntIndividual += 1;
  }

  // синтетический «клиент не указан» для заявок с CLIENTID=-1
  const FALLBACK_CLIENT_ID = idOf('client', 'fallback');
  let needFallbackClient = false;
  const clientIdFor = (oldId: unknown): string => {
    const k = int(oldId);
    if (k != null && clientIdByOld.has(k)) return clientIdByOld.get(k)!;
    needFallbackClient = true;
    return FALLBACK_CLIENT_ID;
  };

  // ───────── 3. Техника (assets) — дедуп по клиент+серийник+модель ─────────
  interface AssetPlan {
    id: string;
    ownerClientId: string;
    model: string;
    manufacturer: string | null;
    serialNumber: string | null;
    notes: string | null;
  }
  const assetPlans = new Map<string, AssetPlan>();
  const assetIdByOrder = new Map<number, string>();

  function deviceForOrder(o: Row): { model: string | null; manuf: string | null; serial: string | null; devType: string | null } {
    const manuf = nameOf(manufacturers, o.MANUFACTURERID);
    const model = nameOf(models, o.MODELID);
    const devType = nameOf(deviceTypes, o.DEVICETYPEID);
    const serial = int(o.NOSERIALNUMBER) === 1 ? null : clip(o.SERIALNUMBER, 100);
    return { model, manuf, serial, devType };
  }

  for (const o of T.OORDER ?? []) {
    const orderId = int(o.ID);
    if (orderId == null) continue;
    const { model, manuf, serial, devType } = deviceForOrder(o);
    if (!model && !manuf && !serial && !devType) continue; // нет инфы о технике
    const ownerClientId = clientIdFor(o.CLIENTID);
    const modelName = model ?? devType ?? 'Оборудование';
    const dedupeKey = `${int(o.CLIENTID) ?? 'x'}|${serial ?? ''}|${modelName}|${manuf ?? ''}`;
    let plan = assetPlans.get(dedupeKey);
    if (!plan) {
      plan = {
        id: uuid5(`asset:${dedupeKey}`),
        ownerClientId,
        model: modelName.slice(0, 200),
        manufacturer: manuf ? manuf.slice(0, 200) : null,
        serialNumber: serial,
        notes: devType ? `Тип оборудования: ${devType}` : null,
      };
      assetPlans.set(dedupeKey, plan);
    }
    assetIdByOrder.set(orderId, plan.id);
  }

  // ───────── 4. Заявки + наряды + строки + события ─────────
  const ticketRows: Array<typeof tickets.$inferInsert> = [];
  const workOrderRows: Array<typeof workOrders.$inferInsert> = [];
  const eventRows: Array<typeof ticketEvents.$inferInsert> = [];
  const statusCount: Record<string, number> = {};

  // строки нарядов по заявкам (WORKRECORD + DETAILRECORD)
  const worksByOrder = new Map<number, Row[]>();
  for (const w of T.WORKRECORD ?? []) {
    const oid = int(w.ORDERID);
    if (oid == null) continue;
    (worksByOrder.get(oid) ?? worksByOrder.set(oid, []).get(oid)!).push(w);
  }
  const detailsByOrder = new Map<number, Row[]>();
  for (const d of T.DETAILRECORD ?? []) {
    const oid = int(d.ORDERID);
    if (oid == null) continue;
    (detailsByOrder.get(oid) ?? detailsByOrder.set(oid, []).get(oid)!).push(d);
  }
  const historyByOrder = new Map<number, Row[]>();
  for (const h of T.STATUSHISTORY ?? []) {
    const oid = int(h.ORDERID);
    if (oid == null) continue;
    (historyByOrder.get(oid) ?? historyByOrder.set(oid, []).get(oid)!).push(h);
  }

  const lineRows: Array<typeof workOrderLines.$inferInsert> = [];

  for (const o of T.OORDER ?? []) {
    const orderId = int(o.ID);
    if (orderId == null) continue;

    const statusId = int(o.ORDERSTATUSID);
    const status = (statusId != null && STATUS_MAP[statusId]) || 'closed';
    statusCount[status] = (statusCount[status] ?? 0) + 1;

    const repairTypeOld = int(o.REPAIRTYPE);
    const repairType: 'paid' | 'warranty' | 'service_contract' =
      statusId === 6 ? 'warranty' : repairTypeOld === 2 ? 'paid' : 'service_contract';

    const receivedAt = dt(o.ORDERDATE) ?? new Date('2015-01-01T00:00:00Z');
    const closedish = dt(o.GIVEOUTDATE) ?? dt(o.RELEASEDATE) ?? dt(o.EXECUTIONDATEFACT) ?? receivedAt;
    const closedAt = status === 'closed' ? closedish : null;
    const cancelledAt = status === 'cancelled' ? closedish : null;

    const ticketId = idOf('ticket', orderId);
    const ticketNumber = `WSP-${orderId}`;
    const { devType } = deviceForOrder(o);

    const noteBits = [
      '[Перенос из WinServisePro]',
      str(o.ORDERNUMBER) ? `Старый № заказа: ${str(o.ORDERNUMBER)}` : null,
      str(o.DESCRIPTION) ? str(o.DESCRIPTION) : null,
      devType ? `Тип оборудования: ${devType}` : null,
      str(o.COMPLECT) ? `Комплектация: ${str(o.COMPLECT)}` : null,
      str(o.NOTE) ? `Примечание: ${str(o.NOTE)}` : null,
      str(o.COMMENT) ? `Комментарий: ${str(o.COMMENT)}` : null,
      repairTypeOld === 1 || repairTypeOld === 3
        ? `Договор: ${nameOf(repairTypesCat, o.REPAIRTYPE) ?? ''}`.trim()
        : null,
    ].filter(Boolean);

    ticketRows.push({
      id: ticketId,
      tenantId: tenantIdValue,
      ticketNumber,
      barcode: clip(o.BARCODE, 64) ?? `WSP-${orderId}`,
      clientId: clientIdFor(o.CLIENTID),
      assetId: assetIdByOrder.get(orderId) ?? null,
      source: 'manual',
      intakeMethod: 'brought_in',
      repairType,
      priority: 'normal',
      status,
      symptom: str(o.DISREPAIRFROMCLIENT),
      notes: noteBits.join('\n'),
      assignedEngineerId: userIdFor(o.MASTERID),
      assignedDispatcherId: userIdFor(o.MANAGERID),
      receivedAt,
      closedAt,
      cancelledAt,
      cancelReason: status === 'cancelled' ? (str(o.DISREPAIR) ?? 'Перенос из WinServisePro') : null,
      createdAt: receivedAt,
      updatedAt: closedish,
    });

    // наряд 1:1
    const works = kop(o.WORKSUM);
    const parts = kop(o.DETAILSUM);
    const orderSum = kop(o.ORDERSUM);
    const total = orderSum > 0n ? orderSum : works + parts;
    const cost = kop(o.EXPENSESSUM);
    workOrderRows.push({
      id: idOf('wo', orderId),
      tenantId: tenantIdValue,
      ticketId,
      orderNumber: ticketNumber,
      engineerId: userIdFor(o.MASTERID),
      diagnosis: str(o.DISREPAIR),
      recommendation: str(o.RECOMENDATION),
      vatRate: 'without_vat',
      worksAmountKopecks: works,
      partsAmountKopecks: parts,
      expensesAmountKopecks: 0n,
      totalAmountKopecks: total,
      paidAmountKopecks: kop(o.PAYSUM),
      costAmountKopecks: cost,
      marginAmountKopecks: total - cost,
      createdAt: receivedAt,
      updatedAt: closedish,
    });

    // строки наряда
    let idx = 0;
    for (const w of worksByOrder.get(orderId) ?? []) {
      const recId = int(w.ID);
      const qty = numRub(w.QTY) || 1;
      const price = kop(w.PRICE);
      lineRows.push({
        id: idOf('wol-w', recId ?? `${orderId}-${idx}`),
        tenantId: tenantIdValue,
        workOrderId: idOf('wo', orderId),
        lineType: 'work',
        name: (nameOf(workCatalog, w.WORKID) ?? 'Работа').slice(0, 500),
        unit: 'шт',
        quantity: String(qty),
        unitPriceKopecks: price,
        amountKopecks: BigInt(Math.round(qty * Number(price))),
        engineerId: userIdFor(w.MASTERID),
        orderIdx: idx++,
      });
    }
    for (const d of detailsByOrder.get(orderId) ?? []) {
      const recId = int(d.ID);
      const qty = numRub(d.QTY) || 1;
      const price = kop(d.PRICE);
      lineRows.push({
        id: idOf('wol-d', recId ?? `${orderId}-${idx}`),
        tenantId: tenantIdValue,
        workOrderId: idOf('wo', orderId),
        lineType: 'part',
        name: (nameOf(details, d.DETAILID) ?? 'Запчасть').slice(0, 500),
        unit: 'шт',
        quantity: String(qty),
        unitPriceKopecks: price,
        amountKopecks: BigInt(Math.round(qty * Number(price))),
        engineerId: null,
        orderIdx: idx++,
      });
    }

    // события: создание + история статусов
    eventRows.push({
      id: idOf('te-created', orderId),
      tenantId: tenantIdValue,
      ticketId,
      userId: userIdFor(o.OUSERID),
      type: 'created',
      payload: { comment: 'Заявка заведена (перенос из WinServisePro)' },
      createdAt: receivedAt,
    });
    for (const h of historyByOrder.get(orderId) ?? []) {
      const hid = int(h.ID);
      if (hid == null) continue;
      eventRows.push({
        id: idOf('te-sh', hid),
        tenantId: tenantIdValue,
        ticketId,
        userId: userIdFor(h.OUSERID),
        type: 'status_change',
        payload: { to: nameOf(orderStatuses, h.STATUSID) ?? `статус ${int(h.STATUSID) ?? '?'}` },
        createdAt: dt(h.STATUSDATE) ?? receivedAt,
      });
    }
  }

  // фикс check-констрейнта: для work fix lines: lineType 'work' allows engineerId; ok.

  // ───────────────────────── ОТЧЁТ ─────────────────────────
  console.info('\n──────── План переноса ────────');
  console.info(`Сотрудники (users):        ${userRows.length}`);
  console.info(`Клиенты (clients):         ${clientPlans.length}  (юрлиц: ${cntLegal}, физлиц: ${cntIndividual})`);
  console.info(`  из них с контактным лицом: ${clientPlans.filter((c) => c.contact).length}`);
  console.info(`Техника (assets):          ${assetPlans.size}`);
  console.info(`Заявки (tickets):          ${ticketRows.length}`);
  console.info(`Наряды (work_orders):      ${workOrderRows.length}`);
  console.info(`Строки нарядов:            ${lineRows.length}`);
  console.info(`События (ticket_events):   ${eventRows.length}`);
  console.info(`Статусы заявок:            ${JSON.stringify(statusCount)}`);
  if (needFallbackClient) console.info(`  + синтетический «Клиент не указан» (для заявок без клиента)`);
  if (warnings.length) {
    console.info('\nПредупреждения:');
    warnings.slice(0, 20).forEach((w) => console.info('  ! ' + w));
  }

  if (DRY_RUN) {
    console.info('\nDRY-RUN: в базу ничего не записано. Примеры:');
    console.info('  client[0]:', JSON.stringify(clientPlans[0]));
    console.info('  ticket[0]:', JSON.stringify({ ...ticketRows[0], notes: '…' }));
    process.exit(0);
  }

  // ───────────────────────── ЗАПИСЬ ─────────────────────────
  if (!db) throw new Error('no db');
  console.info('\nЗапись в БД…');

  // 1. users
  await insertChunked(userRows, async (chunk) => {
    await db.insert(users).values(chunk).onConflictDoNothing();
  });
  console.info(`  ✓ users: ${userRows.length}`);

  // 2. clients (+ fallback) через raw SQL с pgp_sym_encrypt
  if (needFallbackClient) {
    clientPlans.unshift({
      id: FALLBACK_CLIENT_ID,
      type: 'individual',
      subtype: null,
      displayName: 'Клиент не указан (перенос)',
      inn: null, kpp: null, ogrn: null, legalAddress: null, phone: null, email: null,
      indFullName: 'Клиент не указан', indPhone: null, indAddress: null,
      notes: 'Заявки из WinServisePro без указанного клиента.', contact: null,
    });
  }
  for (const c of clientPlans) {
    await db.execute(sql`
      INSERT INTO clients (
        id, tenant_id, type, subtype, display_name,
        inn, kpp, ogrn, legal_address, phone, email,
        full_name_encrypted, phone_encrypted, address_encrypted,
        notes, status
      ) VALUES (
        ${c.id}, ${tenantIdValue}, ${c.type}::client_type, ${c.subtype}::client_subtype,
        ${c.displayName}, ${c.inn}, ${c.kpp}, ${c.ogrn}, ${c.legalAddress}, ${c.phone}, ${c.email},
        ${c.indFullName ? sql`pgp_sym_encrypt(${c.indFullName}::text, ${key})` : sql`NULL`},
        ${c.indPhone ? sql`pgp_sym_encrypt(${c.indPhone}::text, ${key})` : sql`NULL`},
        ${c.indAddress ? sql`pgp_sym_encrypt(${c.indAddress}::text, ${key})` : sql`NULL`},
        ${c.notes}, 'active'
      ) ON CONFLICT (id) DO NOTHING
    `);
    if (c.contact) {
      await db.execute(sql`
        INSERT INTO contacts (id, tenant_id, client_id, full_name_encrypted, phone_encrypted, email, position, is_primary)
        VALUES (
          ${uuid5(`contact:${c.id}`)}, ${tenantIdValue}, ${c.id},
          pgp_sym_encrypt(${c.contact.fullName}::text, ${key}),
          pgp_sym_encrypt(${c.contact.phone}::text, ${key}),
          ${null}, ${c.contact.position}, true
        ) ON CONFLICT (id) DO NOTHING
      `);
    }
  }
  console.info(`  ✓ clients: ${clientPlans.length}`);

  // 3. assets + asset_events
  const assetArr = [...assetPlans.values()];
  await insertChunked(assetArr, async (chunk) => {
    await db
      .insert(assets)
      .values(
        chunk.map((a) => ({
          id: a.id,
          tenantId: tenantIdValue,
          ownerClientId: a.ownerClientId,
          model: a.model,
          manufacturer: a.manufacturer,
          serialNumber: a.serialNumber,
          notes: a.notes,
          lifecycleStatus: 'in_service' as const,
        })),
      )
      .onConflictDoNothing();
  });
  await insertChunked(assetArr, async (chunk) => {
    await db
      .insert(assetEvents)
      .values(
        chunk.map((a) => ({
          id: uuid5(`ae:${a.id}`),
          tenantId: tenantIdValue,
          assetId: a.id,
          userId: null,
          type: 'created' as const,
          payload: { comment: 'Перенос из WinServisePro' },
        })),
      )
      .onConflictDoNothing();
  });
  console.info(`  ✓ assets: ${assetArr.length}`);

  // 4. tickets, work_orders, lines, events
  await insertChunked(ticketRows, async (chunk) => {
    await db.insert(tickets).values(chunk).onConflictDoNothing();
  });
  console.info(`  ✓ tickets: ${ticketRows.length}`);
  await insertChunked(workOrderRows, async (chunk) => {
    await db.insert(workOrders).values(chunk).onConflictDoNothing();
  });
  console.info(`  ✓ work_orders: ${workOrderRows.length}`);
  await insertChunked(lineRows, async (chunk) => {
    await db.insert(workOrderLines).values(chunk).onConflictDoNothing();
  });
  console.info(`  ✓ work_order_lines: ${lineRows.length}`);
  await insertChunked(eventRows, async (chunk) => {
    await db.insert(ticketEvents).values(chunk).onConflictDoNothing();
  });
  console.info(`  ✓ ticket_events: ${eventRows.length}`);

  console.info('\n✓ Импорт завершён.');
  process.exit(0);
}

async function insertChunked<T>(rows: T[], fn: (chunk: T[]) => Promise<void>, size = 500): Promise<void> {
  for (let i = 0; i < rows.length; i += size) {
    await fn(rows.slice(i, i + size));
  }
}

main().catch((err) => {
  console.error('Импорт упал:', err);
  process.exit(1);
});
