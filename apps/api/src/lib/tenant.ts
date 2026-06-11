/**
 * Резолв tenant'а из HTTP-запроса.
 *
 * Источники в порядке приоритета:
 * 1. Header X-Tenant-Subdomain (для dev и для PWA где subdomain не работает)
 * 2. Subdomain в Host-заголовке: <slug>.erfolgcrm.ru / <slug>.localhost:3000
 *
 * Зарезервированные subdomain'ы (не tenant'ы): app, api, www, admin.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { tenants, type Db } from '@erfolg/db';
import type { Request } from 'express';

const RESERVED_SUBDOMAINS = new Set(['app', 'api', 'www', 'admin', 'static', 'cdn']);

export interface ResolvedTenant {
  id: string;
  subdomain: string;
  displayName: string;
  status: 'trial' | 'active' | 'suspended' | 'cancelled';
  timezone: string;
  /** ARN ключа в Yandex KMS, NULL в dev (используем PII_ENCRYPTION_KEY из env). */
  kmsKeyId: string | null;
}

export function extractSubdomain(req: Request): string | null {
  const explicit = req.header('x-tenant-subdomain');
  if (explicit) return explicit.toLowerCase().trim();

  const host = req.header('host') ?? '';
  const hostname = host.split(':')[0] ?? '';
  if (!hostname) return null;
  const parts = hostname.split('.');

  // <slug>.erfolgcrm.ru → 3 части
  // <slug>.localhost → 2 части
  if (parts.length < 2) return null;

  const candidate = parts[0]?.toLowerCase();
  if (!candidate) return null;
  if (RESERVED_SUBDOMAINS.has(candidate)) return null;

  return candidate;
}

/**
 * После пивота tenant фактически один — нет смысла ходить за ним в БД на
 * каждый запрос. Кэшируем на 60 секунд: смена status/timezone подхватится
 * в течение минуты, что для single-company более чем достаточно.
 */
const TENANT_CACHE_TTL_MS = 60_000;
const tenantCache = new Map<string, { value: ResolvedTenant | null; until: number }>();

export async function resolveTenant(
  db: Db,
  req: Request,
): Promise<ResolvedTenant | null> {
  const subdomain = extractSubdomain(req);
  if (!subdomain) return null;

  const hit = tenantCache.get(subdomain);
  if (hit && hit.until > Date.now()) return hit.value;

  const rows = await db
    .select({
      id: tenants.id,
      subdomain: tenants.subdomain,
      displayName: tenants.displayName,
      status: tenants.status,
      timezone: tenants.timezone,
      kmsKeyId: tenants.kmsKeyId,
    })
    .from(tenants)
    .where(and(eq(tenants.subdomain, subdomain), isNull(tenants.deletedAt)))
    .limit(1);

  const value = rows[0] ?? null;
  tenantCache.set(subdomain, { value, until: Date.now() + TENANT_CACHE_TTL_MS });
  return value;
}
