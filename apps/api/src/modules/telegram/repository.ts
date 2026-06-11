/**
 * Repository для telegram_bot_configs. tenant_id = PRIMARY KEY (один бот на tenant).
 *
 * bot_token и webhook_secret шифруются на стороне БД через pgcrypto. Plain-text не уходит
 * в логи, не попадает в audit. В DTO для UI токен НЕ отдаётся; только bot_username + masked.
 */
import { eq, sql } from 'drizzle-orm';
import {
  getTenantEncryptionKey,
  telegramBotConfigs,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export interface TelegramConfigPublicDto {
  enabled: boolean;
  botUsername: string | null;
  defaultDispatcherUserId: string | null;
  hasToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TelegramConfigSecretDto extends TelegramConfigPublicDto {
  /** Plain-text токен. НИКОГДА не отдавать в API — только воркеру. */
  botToken: string;
  webhookSecret: string;
}

export interface UpsertConfigInput {
  botToken: string;
  webhookSecret: string;
  botUsername?: string | null;
  enabled?: boolean;
  defaultDispatcherUserId?: string | null;
}

export async function getPublicConfig(
  db: Db,
  tenant: { id: string; kmsKeyId: string | null },
): Promise<TelegramConfigPublicDto | null> {
  return withTenantTx(db, tenant.id, async (tx) => {
    const rows = await tx
      .select({
        enabled: telegramBotConfigs.enabled,
        botUsername: telegramBotConfigs.botUsername,
        defaultDispatcherUserId: telegramBotConfigs.defaultDispatcherUserId,
        hasToken: sql<boolean>`${telegramBotConfigs.botTokenEncrypted} IS NOT NULL`,
        createdAt: telegramBotConfigs.createdAt,
        updatedAt: telegramBotConfigs.updatedAt,
      })
      .from(telegramBotConfigs)
      .limit(1);
    return rows[0] ?? null;
  });
}

interface SecretRow {
  bot_token: string;
  webhook_secret: string;
  bot_username: string | null;
  default_dispatcher_user_id: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export async function getSecretConfig(
  db: Db,
  tenant: { id: string; kmsKeyId: string | null },
): Promise<TelegramConfigSecretDto | null> {
  const key = getTenantEncryptionKey(tenant);
  return withTenantTx(db, tenant.id, async (tx) => {
    const result = await tx.execute(sql`
      SELECT
        pgp_sym_decrypt(bot_token_encrypted::bytea, ${key})::text AS bot_token,
        pgp_sym_decrypt(webhook_secret_encrypted::bytea, ${key})::text AS webhook_secret,
        bot_username,
        default_dispatcher_user_id,
        enabled,
        created_at,
        updated_at
      FROM telegram_bot_configs
      LIMIT 1
    `);
    const rows = result as unknown as SecretRow[];
    const r = rows[0];
    if (!r) return null;
    return {
      botToken: r.bot_token,
      webhookSecret: r.webhook_secret,
      botUsername: r.bot_username,
      defaultDispatcherUserId: r.default_dispatcher_user_id,
      enabled: r.enabled,
      hasToken: true,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  });
}

export async function upsertConfig(
  db: Db,
  tenant: { id: string; kmsKeyId: string | null },
  input: UpsertConfigInput,
): Promise<void> {
  const key = getTenantEncryptionKey(tenant);
  await withTenantTx(db, tenant.id, async (tx) => {
    await tx.execute(sql`
      INSERT INTO telegram_bot_configs (
        tenant_id, bot_token_encrypted, webhook_secret_encrypted,
        bot_username, enabled, default_dispatcher_user_id
      ) VALUES (
        ${tenant.id},
        pgp_sym_encrypt(${input.botToken}::text, ${key}),
        pgp_sym_encrypt(${input.webhookSecret}::text, ${key}),
        ${input.botUsername ?? null},
        ${input.enabled ?? true},
        ${input.defaultDispatcherUserId ?? null}
      )
      ON CONFLICT (tenant_id) DO UPDATE SET
        bot_token_encrypted = EXCLUDED.bot_token_encrypted,
        webhook_secret_encrypted = EXCLUDED.webhook_secret_encrypted,
        bot_username = EXCLUDED.bot_username,
        enabled = EXCLUDED.enabled,
        default_dispatcher_user_id = EXCLUDED.default_dispatcher_user_id,
        updated_at = now()
    `);
  });
}

export async function setEnabled(
  db: Db,
  tenantId: string,
  enabled: boolean,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(telegramBotConfigs)
      .set({ enabled, updatedAt: sql`now()` })
      .where(eq(telegramBotConfigs.tenantId, tenantId));
  });
}

/** Сравнить переданный secret c сохранённым (constant-time). Возвращает true если совпали. */
export async function verifyWebhookSecret(
  db: Db,
  tenant: { id: string; kmsKeyId: string | null },
  candidate: string,
): Promise<boolean> {
  const cfg = await getSecretConfig(db, tenant);
  if (!cfg || !cfg.enabled) return false;
  // node:crypto.timingSafeEqual требует одинаковой длины; сравниваем по длине + побайтово.
  if (cfg.webhookSecret.length !== candidate.length) return false;
  let diff = 0;
  for (let i = 0; i < candidate.length; i++) {
    diff |= cfg.webhookSecret.charCodeAt(i) ^ candidate.charCodeAt(i);
  }
  return diff === 0;
}
