/**
 * Загрузка технического архива ремонтов (repair_archive) из выгрузки WinServisePro.
 *
 * Наполняет справочник «как чинили раньше» для AI-диагностики по симптому:
 *   модель · производитель · тип · симптом · что нашли · что делали · год.
 *
 * ⚠️ ПДн НЕ переносим: ни ФИО/телефонов/адресов клиентов, ни сотрудников, ни номеров
 *    договоров. Только техническая информация о ремонте. Это НЕ полный перенос заявок
 *    (тот — src/import-winservice.ts); это отдельный обезличенный справочник.
 *
 * Идемпотентность: id = детерминированный UUIDv5 от «repair_archive:<orderId>»,
 *    вставка ON CONFLICT DO NOTHING. Повторный запуск ничего не дублирует.
 *
 * Запуск (сухой прогон — только отчёт, в БД ничего не пишет):
 *   pnpm --filter @erfolg/db tsx src/import-repair-archive.ts --dry-run
 * Реальная загрузка (dev, tenant erfolg по умолчанию):
 *   pnpm --filter @erfolg/db import-repair-archive
 * Прод (tenant crm):
 *   IMPORT_TENANT=crm DATABASE_OWNER_URL=... pnpm --filter @erfolg/db import-repair-archive
 * Файл выгрузки — первый аргумент, либо env IMPORT_FILE.
 */
import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { makeDb } from './client';
import { repairArchive, tenants } from './schema';

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
const TENANT_SUBDOMAIN = process.env.IMPORT_TENANT ?? 'erfolg';

// ───────────────────────── helpers ─────────────────────────
type Row = Record<string, unknown>;

const str = (v: unknown): string | null => {
  if (typeof v === 'string') {
    const s = v.trim();
    return s.length ? s : null;
  }
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  return null;
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
const yearOf = (v: unknown): number | null => {
  const s = str(v);
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  return y >= 1990 && y <= 2100 ? y : null;
};

// Детерминированный UUIDv5 от строкового ключа — стабилен между запусками.
const NS = Buffer.from('1b671a6440d5491e99b0da01ff1f3341', 'hex');
function uuid5(name: string): string {
  const h = createHash('sha1');
  h.update(NS);
  h.update(Buffer.from(name, 'utf8'));
  const b = h.digest().subarray(0, 16);
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x50;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

interface ExportShape {
  exportedAt: string;
  counts: Record<string, number>;
  tables: Record<string, Row[]>;
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
  console.info(`WinServisePro → repair_archive  ${DRY_RUN ? '(DRY-RUN)' : '(LIVE)'}`);
  console.info(`Файл выгрузки: ${IMPORT_FILE}`);
  console.info(`Tenant: ${TENANT_SUBDOMAIN}`);

  const data = JSON.parse(readFileSync(IMPORT_FILE, 'utf-8')) as ExportShape;
  const T = data.tables;

  const manufacturers = indexBy(T.MANUFACTURER ?? []);
  const deviceTypes = indexBy(T.DEVICETYPE ?? []);
  const models = indexBy(T.MODEL ?? []);
  const workCatalog = indexBy(T.OWORK ?? []);
  const details = indexBy(T.DETAIL ?? []);
  const nameOf = (m: Map<number, Row>, id: unknown, field = 'DESCRIPTION'): string | null =>
    id == null ? null : str(m.get(int(id) as number)?.[field]);

  // Работы и запчасти по заявкам (для «что делали»).
  const worksByOrder = new Map<number, string[]>();
  for (const w of T.WORKRECORD ?? []) {
    const oid = int(w.ORDERID);
    if (oid == null) continue;
    const name = nameOf(workCatalog, w.WORKID);
    if (!name) continue;
    (worksByOrder.get(oid) ?? worksByOrder.set(oid, []).get(oid)!).push(name);
  }
  const detailsByOrder = new Map<number, string[]>();
  for (const d of T.DETAILRECORD ?? []) {
    const oid = int(d.ORDERID);
    if (oid == null) continue;
    const name = nameOf(details, d.DETAILID);
    if (!name) continue;
    (detailsByOrder.get(oid) ?? detailsByOrder.set(oid, []).get(oid)!).push(name);
  }

  function worksSummaryFor(orderId: number): string | null {
    const parts = [
      ...(worksByOrder.get(orderId) ?? []),
      ...(detailsByOrder.get(orderId) ?? []),
    ];
    if (!parts.length) return null;
    const uniq = Array.from(new Set(parts.map((p) => p.trim()).filter(Boolean)));
    const joined = uniq.join('; ');
    return joined.length ? joined.slice(0, 1000) : null;
  }

  type ArchiveRow = typeof repairArchive.$inferInsert;
  const rows: ArchiveRow[] = [];
  let skippedNoText = 0;

  // tenant id
  const db = DRY_RUN ? null : makeDb(DATABASE_URL);
  let tenantIdValue = 'DRYRUN-TENANT';
  if (db) {
    const t = await db.select().from(tenants).where(eq(tenants.subdomain, TENANT_SUBDOMAIN)).limit(1);
    if (!t[0]) throw new Error(`tenant "${TENANT_SUBDOMAIN}" не найден — проверьте IMPORT_TENANT/seed.`);
    tenantIdValue = t[0].id;
  }

  for (const o of T.OORDER ?? []) {
    const orderId = int(o.ID);
    if (orderId == null) continue;

    const symptom = str(o.DISREPAIRFROMCLIENT);
    const diagnosis = str(o.DISREPAIR);
    const works = worksSummaryFor(orderId);

    // Строки без единого технического текста бесполезны для диагностики — пропускаем.
    if (!symptom && !diagnosis && !works) {
      skippedNoText += 1;
      continue;
    }

    const model = clip(nameOf(models, o.MODELID), 300);
    const manufacturer = clip(nameOf(manufacturers, o.MANUFACTURERID), 200);
    const deviceType = clip(nameOf(deviceTypes, o.DEVICETYPEID), 200);

    rows.push({
      // PK включает tenant, чтобы совпадать с уникальным ключом (tenant_id, source_ref):
      // иначе загрузка того же экспорта во второй tenant на той же БД молча тёрлась бы
      // по глобальному PK, хотя (tenant, source_ref) — новая строка.
      id: uuid5(`repair_archive:${tenantIdValue}:${orderId}`),
      tenantId: tenantIdValue,
      sourceRef: `WSP-${orderId}`,
      deviceModel: model,
      manufacturer,
      deviceType,
      symptom,
      diagnosis,
      worksSummary: works,
      year: yearOf(o.ORDERDATE),
    });
  }

  console.info('\n──────── План загрузки ────────');
  console.info(`Всего заявок в выгрузке:      ${(T.OORDER ?? []).length}`);
  console.info(`Записей в архив:              ${rows.length}`);
  console.info(`  с симптомом:               ${rows.filter((r) => r.symptom).length}`);
  console.info(`  с диагнозом:               ${rows.filter((r) => r.diagnosis).length}`);
  console.info(`  с описанием работ:         ${rows.filter((r) => r.worksSummary).length}`);
  console.info(`  с моделью:                 ${rows.filter((r) => r.deviceModel).length}`);
  console.info(`Пропущено (нет тех. текста): ${skippedNoText}`);

  if (DRY_RUN) {
    console.info('\nDRY-RUN: в базу ничего не записано. Пример записи:');
    console.info('  ', JSON.stringify(rows[0]));
    process.exit(0);
  }

  if (!db) throw new Error('no db');
  console.info('\nЗапись в БД…');
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(repairArchive).values(rows.slice(i, i + 500)).onConflictDoNothing();
  }
  console.info(`  ✓ repair_archive: ${rows.length}`);
  console.info('\n✓ Загрузка архива завершена.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Загрузка архива упала:', err);
  process.exit(1);
});
