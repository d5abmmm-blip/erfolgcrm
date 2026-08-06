/**
 * Telegram webhook endpoint.
 *
 * URL: POST /api/v1/telegram/webhook/:subdomain
 * Header: X-Telegram-Bot-Api-Secret-Token (выставляется Telegram'ом из webhook_secret).
 *
 * Безопасность:
 *   1. Tenant резолвится по `:subdomain` (не доверяемся payload'у).
 *   2. Secret сверяется с сохранённым через verifyWebhookSecret (constant-time).
 *   3. Любая ошибка → 200 OK с пустым телом, чтобы Telegram не зацикливал retry'ы. Логируем warn.
 */
import express, { type Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, tenants } from '@erfolg/db';
import { logger } from '../lib/logger';
import { processWebhook } from '../modules/telegram';
import type { TgUpdate } from '../lib/telegram-client';

export function makeTelegramWebhookRouter(): Router {
  const router = express.Router();

  // Telegram update'ы — JSON. Лимит 1MB (текстовые сообщения; фото — отдельный файл-ID).
  router.use(express.json({ limit: '1mb' }));

  router.post('/webhook/:subdomain', async (req, res) => {
    try {
      const subdomain = req.params.subdomain?.toLowerCase().trim() ?? '';
      const secret = req.header('x-telegram-bot-api-secret-token') ?? '';
      if (!subdomain || !secret) {
        res.status(200).end();
        return;
      }
      const db = getDb();
      const tenantRow = await db
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
      const t = tenantRow[0];
      if (!t || t.status === 'suspended' || t.status === 'cancelled') {
        res.status(200).end();
        return;
      }
      const update = req.body as TgUpdate;
      const result = await processWebhook({ db, tenant: t }, secret, update);
      if (!result.ok) {
        logger.warn({ subdomain, reason: result.reason }, 'telegram webhook rejected');
      }
      res.status(200).end();
    } catch (err: unknown) {
      logger.error({ err }, 'telegram webhook unexpected error');
      res.status(200).end();
    }
  });

  return router;
}
