/**
 * Этап 6 — фасад над хранилищем файлов.
 *
 * Production: Yandex Object Storage (S3-compatible) с bucket per-tenant
 *   `erfolgcrm-prod-{tenant_subdomain}`, KMS-шифрование at-rest.
 *
 * Development: локальная папка LOCAL_STORAGE_DIR (по умолчанию apps/api/.local-storage),
 *   presigned URLs указывают на /api/v1/storage/* эндпоинт API c HMAC-токеном.
 *   Это позволяет фронтенду использовать ОДИН и тот же flow (presigned PUT/GET)
 *   без зависимости от Yandex Cloud в dev.
 *
 * Переключение через STORAGE_DRIVER env: 'local' (default in dev) | 's3' (prod).
 *
 * Ключи объектов: tenants/<tenantId>/<kind>/<refType>/<refId>/<uuid>-<safeName>.
 * Защищаем от path traversal на уровне sanitizeKey() и через нормализацию пути.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import { s3ObjectStorage } from './object-storage-s3';

export interface PresignedPut {
  url: string;
  headers: Record<string, string>;
  expiresAt: Date;
}

export interface PresignedGet {
  url: string;
  expiresAt: Date;
}

export interface ObjectMeta {
  key: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: Date;
}

export interface ObjectStorage {
  /** Сгенерировать pre-signed PUT URL для прямого upload'а с фронтенда. */
  presignPut(args: {
    key: string;
    mimeType: string;
    sizeBytes: number;
    ttlSeconds?: number;
  }): Promise<PresignedPut>;
  /** Сгенерировать pre-signed GET URL для просмотра. */
  presignGet(key: string, ttlSeconds?: number): Promise<PresignedGet>;
  /** Серверная загрузка буфера напрямую (минуя presigned PUT). Для вложений из IMAP. */
  putBuffer(key: string, data: Buffer, mimeType: string): Promise<void>;
  /** Проверка факта загрузки (вызывается из confirmUpload). */
  head(key: string): Promise<ObjectMeta | null>;
  /** Удалить объект. Идемпотентно (нет ключа = OK). */
  remove(key: string): Promise<void>;
}

const DEFAULT_PUT_TTL = 15 * 60;
const DEFAULT_GET_TTL = 60 * 60;

export function buildObjectKey(input: {
  tenantId: string;
  kind: string;
  referenceType: string;
  referenceId: string;
  fileName: string;
}): string {
  const safeName = input.fileName
    .normalize('NFKD')
    .replace(/[^\w.\- ]+/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
  const uniq = randomUUID();
  return `tenants/${input.tenantId}/${input.kind}/${input.referenceType}/${input.referenceId}/${uniq}-${safeName}`;
}

// ───────── Local FS implementation (dev) ─────────

interface LocalCtx {
  rootDir: string;
  apiBaseUrl: string;
  secret: string;
}

function getLocalCtx(): LocalCtx {
  return {
    rootDir: process.env.LOCAL_STORAGE_DIR ?? join(process.cwd(), '.local-storage'),
    apiBaseUrl: process.env.API_PUBLIC_URL ?? `http://localhost:${process.env.API_PORT ?? '3030'}`,
    secret:
      process.env.STORAGE_LOCAL_SECRET ??
      process.env.SESSION_SECRET ??
      'dev_only_storage_secret_replace_in_prod',
  };
}

function safeFsPath(root: string, key: string): string {
  // Защита от path traversal: нормализуем + проверяем что результат внутри root.
  const normalizedKey = normalize(key).replace(/^([./\\]+)/, '');
  const full = resolve(root, normalizedKey);
  const rootResolved = resolve(root) + sep;
  if (full !== resolve(root) && !full.startsWith(rootResolved)) {
    throw new Error(`unsafe object key: ${key}`);
  }
  return full;
}

function signLocal(secret: string, op: 'put' | 'get', key: string, expEpochSec: number): string {
  return createHmac('sha256', secret).update(`${op}:${key}:${expEpochSec}`).digest('hex');
}

export function verifyLocalToken(args: {
  op: 'put' | 'get';
  key: string;
  exp: number;
  sig: string;
}): boolean {
  const ctx = getLocalCtx();
  if (!Number.isFinite(args.exp) || args.exp * 1000 < Date.now()) return false;
  const expected = signLocal(ctx.secret, args.op, args.key, args.exp);
  if (expected.length !== args.sig.length) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(args.sig, 'hex'));
}

function makeLocalUrl(op: 'put' | 'get', key: string, ttlSeconds: number): { url: string; exp: Date } {
  const ctx = getLocalCtx();
  const expSec = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = signLocal(ctx.secret, op, key, expSec);
  const params = new URLSearchParams({ op, key, exp: String(expSec), sig });
  return {
    url: `${ctx.apiBaseUrl}/api/v1/storage/${op}?${params.toString()}`,
    exp: new Date(expSec * 1000),
  };
}

async function localWrite(key: string, data: Buffer, mimeType: string): Promise<void> {
  const ctx = getLocalCtx();
  const file = safeFsPath(ctx.rootDir, key);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
  await writeFile(`${file}.meta.json`, JSON.stringify({ mimeType, uploadedAt: new Date().toISOString() }));
}

async function localRead(key: string): Promise<{ data: Buffer; mimeType: string } | null> {
  const ctx = getLocalCtx();
  const file = safeFsPath(ctx.rootDir, key);
  try {
    const [data, metaRaw] = await Promise.all([
      readFile(file),
      readFile(`${file}.meta.json`, 'utf-8').catch(() => '{}'),
    ]);
    const meta = JSON.parse(metaRaw) as { mimeType?: string };
    return { data, mimeType: meta.mimeType ?? 'application/octet-stream' };
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'ENOENT') return null;
    throw err;
  }
}

export const localObjectStorage: ObjectStorage = {
  presignPut({ key, ttlSeconds }) {
    const { url, exp } = makeLocalUrl('put', key, ttlSeconds ?? DEFAULT_PUT_TTL);
    return Promise.resolve({ url, headers: {}, expiresAt: exp });
  },
  presignGet(key, ttlSeconds) {
    const { url, exp } = makeLocalUrl('get', key, ttlSeconds ?? DEFAULT_GET_TTL);
    return Promise.resolve({ url, expiresAt: exp });
  },
  putBuffer(key, data, mimeType) {
    return localWrite(key, data, mimeType);
  },
  async head(key) {
    const ctx = getLocalCtx();
    const file = safeFsPath(ctx.rootDir, key);
    try {
      const [s, metaRaw] = await Promise.all([
        stat(file),
        readFile(`${file}.meta.json`, 'utf-8').catch(() => '{}'),
      ]);
      const meta = JSON.parse(metaRaw) as { mimeType?: string };
      return {
        key,
        sizeBytes: s.size,
        mimeType: meta.mimeType ?? 'application/octet-stream',
        uploadedAt: s.mtime,
      };
    } catch {
      return null;
    }
  },
  async remove(key) {
    const ctx = getLocalCtx();
    const file = safeFsPath(ctx.rootDir, key);
    await Promise.all([unlink(file).catch(() => undefined), unlink(`${file}.meta.json`).catch(() => undefined)]);
  },
};

export const localObjectStorageInternal = { write: localWrite, read: localRead };

// ───────── Factory ─────────

let cached: ObjectStorage | null = null;

export function getObjectStorage(): ObjectStorage {
  if (cached) return cached;
  const driver = process.env.STORAGE_DRIVER ?? (process.env.NODE_ENV === 'production' ? 's3' : 'local');
  // Block A prod-guard: local storage в проде = катастрофа (файлы исчезнут при рестарте контейнера,
  // нет шифрования at-rest, нет реплик). Падаем сразу, чтобы поймать misconfig до первого upload'а.
  if (process.env.NODE_ENV === 'production' && driver === 'local') {
    throw new Error(
      'STORAGE_DRIVER=local запрещён в production. Установите STORAGE_DRIVER=s3 и сконфигурируйте S3_* переменные.',
    );
  }
  cached = driver === 's3' ? s3ObjectStorage : localObjectStorage;
  return cached;
}

/** Только для тестов — позволяет подменить реализацию. */
export function __setObjectStorageForTesting(s: ObjectStorage | null): void {
  cached = s;
}
