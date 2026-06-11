/**
 * Унифицированный CmdCtx + buildCmdCtx для всех роутеров.
 *
 * Раньше каждый роутер локально переопределял interface CmdCtx и function buildCmdCtx
 * (с микро-различиями в полях). Теперь единая структура — service-слой опирается на
 * один тип, добавление поля в audit/whatever не требует трогать каждый роутер.
 *
 * NB: ip/userAgent в `audit` сохранены как отдельная вложенность ради совместимости
 * со старыми writeAudit-вызовами, но также доступны на верхнем уровне CmdCtx.
 */
import type { Db } from '@erfolg/db';
import type { ResolvedTenant } from '../lib/tenant';
import type { SessionData } from '../lib/session';

export interface AuditMeta {
  ip: string | null;
  userAgent: string | null;
}

export interface CmdCtx {
  db: Db;
  tenant: ResolvedTenant;
  session: SessionData;
  /** Аудит-контекст. Удобство: writeAudit(ctx.db, ctx.tenant.id, { ..., ip: ctx.audit.ip }). */
  audit: AuditMeta;
  /**
   * Денормализованные поля для кода, которому не хочется лезть в session/audit.
   * Optional — старые callsite (тесты, скрипты) могут собирать только
   * основной набор `{ db, tenant, session, audit }`. buildCmdCtx из роутеров заполнит всё.
   */
  tenantId?: string;
  userId?: string;
  role?: SessionData['role'];
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Источник входа: tRPC-context из authedProcedure (session !== null) ИЛИ совместимый объект
 * с теми же полями. Принимаем `session?` как not-null — если roleProcedure пропустил, значит он есть.
 */
export interface BuildCmdCtxInput {
  db: Db;
  tenant: ResolvedTenant;
  session: SessionData;
  ip: string;
  userAgent: string | undefined;
}

export function buildCmdCtx(ctx: BuildCmdCtxInput): CmdCtx {
  const ua = ctx.userAgent ?? null;
  const ip = ctx.ip ?? null;
  return {
    db: ctx.db,
    tenant: ctx.tenant,
    session: ctx.session,
    audit: { ip, userAgent: ua },
    tenantId: ctx.tenant.id,
    userId: ctx.session.userId,
    role: ctx.session.role,
    ip,
    userAgent: ua,
  };
}
