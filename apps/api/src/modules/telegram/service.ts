/**
 * Service слой telegram. Ручки для UI настроек + entry-point для webhook'а.
 */
import { TRPCError } from '@trpc/server';
import { randomBytes } from 'node:crypto';
import type { Db } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import { getMe, setWebhook, deleteWebhook } from '../../lib/telegram-client';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import {
  getPublicConfig,
  getSecretConfig,
  setEnabled,
  upsertConfig,
  verifyWebhookSecret,
  type TelegramConfigPublicDto,
} from './repository';
import { handleUpdate } from './handler';
import type { TgUpdate } from '../../lib/telegram-client';

export async function getConfigQuery(ctx: {
  db: Db;
  tenant: ResolvedTenant;
}): Promise<TelegramConfigPublicDto | null> {
  return getPublicConfig(ctx.db, ctx.tenant);
}

export interface SetConfigInput {
  botToken: string;
  defaultDispatcherUserId?: string | null;
}

export async function setConfigCmd(
  ctx: CmdCtx,
  input: SetConfigInput,
): Promise<{ ok: true; botUsername: string | null }> {
  // Валидируем токен через getMe.
  const me = await getMe(input.botToken);
  if (!me.ok || !me.result) {
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `Telegram отверг токен: ${me.description ?? 'неверный токен'}`,
    });
  }
  const botUsername = me.result.username ?? null;
  // Свежий webhook_secret на каждое сохранение токена.
  const webhookSecret = randomBytes(32).toString('hex');
  await upsertConfig(ctx.db, ctx.tenant, {
    botToken: input.botToken,
    webhookSecret,
    botUsername,
    enabled: true,
    defaultDispatcherUserId: input.defaultDispatcherUserId ?? null,
  });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'telegram_bot_config',
    after: { botUsername, hasToken: true },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  // setWebhook на Telegram: URL берём из env + tenant subdomain.
  const baseUrl = process.env.TELEGRAM_WEBHOOK_BASE_URL ?? process.env.API_PUBLIC_URL ?? '';
  if (baseUrl) {
    const webhookUrl = `${baseUrl}/api/v1/telegram/webhook/${ctx.tenant.subdomain}`;
    // callback_query — нажатия inline-кнопок (нуджи инженерам). Боты, подключённые
    // ДО этой правки, получат callback_query только после пересохранения токена.
    await setWebhook(input.botToken, {
      url: webhookUrl,
      secret_token: webhookSecret,
      allowed_updates: ['message', 'edited_message', 'callback_query'],
      drop_pending_updates: true,
    });
  }
  return { ok: true, botUsername };
}

export async function disableCmd(ctx: CmdCtx): Promise<{ ok: true }> {
  const cfg = await getSecretConfig(ctx.db, ctx.tenant);
  if (cfg) await deleteWebhook(cfg.botToken, true).catch(() => undefined);
  await setEnabled(ctx.db, ctx.tenant.id, false);
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'update',
    entityType: 'telegram_bot_config',
    after: { enabled: false },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { ok: true };
}

export interface WebhookContext {
  db: Db;
  tenant: ResolvedTenant;
}

/** Точка входа из Express webhook-роута. Проверяет secret и диспатчит update. */
export async function processWebhook(
  ctx: WebhookContext,
  providedSecret: string,
  update: TgUpdate,
): Promise<{ ok: boolean; reason?: string }> {
  const ok = await verifyWebhookSecret(ctx.db, ctx.tenant, providedSecret);
  if (!ok) return { ok: false, reason: 'unauthorized' };
  const cfg = await getSecretConfig(ctx.db, ctx.tenant);
  if (!cfg || !cfg.enabled) return { ok: false, reason: 'disabled' };
  await handleUpdate(
    {
      db: ctx.db,
      tenant: ctx.tenant,
      botToken: cfg.botToken,
      defaultDispatcherUserId: cfg.defaultDispatcherUserId,
    },
    update,
  );
  return { ok: true };
}
