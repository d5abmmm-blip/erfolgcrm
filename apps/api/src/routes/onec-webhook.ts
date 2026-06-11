/**
 * REST endpoints для интеграции с 1С (Этап 8.F).
 *
 * URLs:
 *   POST /api/v1/onec/payments/:subdomain
 *     Body: { payments: [{ invoiceExternalId|invoiceNumber, amountKopecks, paidAt, method, comment? }] }
 *     Header: Authorization: Bearer <token>
 *
 * Безопасность:
 *   1. Tenant резолвится по `:subdomain` (не доверяемся payload'у).
 *   2. Token сверяется с saved hash через verifyTenantIncomingToken (constant-time).
 *   3. Любая ошибка отдаёт нейтральный 401/400, без раскрытия деталей.
 */
import express, { type Router } from 'express';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb, tenants } from '@erfolg/db';
import { logger } from '../lib/logger';
import {
  receivePaymentsFromOnecCmd,
  verifyTenantIncomingToken,
} from '../modules/onec';
import type { ResolvedTenant } from '../lib/tenant';

export function makeOnecWebhookRouter(): Router {
  const router = express.Router();

  router.use(express.json({ limit: '5mb' }));

  router.post('/payments/:subdomain', async (req, res) => {
    try {
      const subdomain = req.params.subdomain?.toLowerCase().trim() ?? '';
      const auth = req.header('authorization') ?? '';
      const token = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
      if (!subdomain || !token) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const db = getDb();
      const tenantRows = await db
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
      const tenantRow = tenantRows[0];
      if (!tenantRow) {
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      const ok = await verifyTenantIncomingToken(db, tenantRow.id, token);
      if (!ok) {
        logger.warn({ subdomain }, 'onec-webhook: invalid token');
        res.status(401).json({ error: 'unauthorized' });
        return;
      }
      if (tenantRow.status !== 'active') {
        res.status(403).json({ error: 'tenant inactive' });
        return;
      }
      const tenant: ResolvedTenant = {
        id: tenantRow.id,
        subdomain: tenantRow.subdomain,
        displayName: tenantRow.displayName,
        status: tenantRow.status,
        timezone: tenantRow.timezone,
        kmsKeyId: tenantRow.kmsKeyId,
      };
      const result = await receivePaymentsFromOnecCmd(db, tenant, { body: req.body });
      res.status(200).json({
        exchangeId: result.exchangeId,
        processed: result.processed,
        errorCount: result.errors.length,
        errors: result.errors,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error';
      logger.warn({ err }, 'onec-webhook: failed');
      res.status(400).json({ error: message });
    }
  });

  return router;
}
