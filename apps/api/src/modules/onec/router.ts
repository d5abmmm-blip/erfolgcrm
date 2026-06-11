/**
 * tRPC роутер 1С (Этап 8.F).
 *
 * Все операции — только для директора.
 *   - getConfig          — текущие настройки tenant'а.
 *   - setConfig          — включить/выключить + timezone.
 *   - generateToken      — выдать новый incoming-token (показывается один раз).
 *   - revokeToken        — отозвать.
 *   - exportInvoices     — ручной запуск выгрузки (возвращает XML строку).
 *   - listExchanges      — журнал обменов.
 */
import { z } from 'zod';
import { directorProcedure, router } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  exportInvoicesToOnecCmd,
  generateIncomingToken,
} from './service';
import {
  getConfig,
  listRecentExchanges,
  setIncomingTokenHash,
  upsertConfig,
} from './repository';

export const onecRouter = router({
  getConfig: directorProcedure.query(({ ctx }) => getConfig(ctx.db, ctx.tenant.id)),

  setConfig: directorProcedure
    .input(
      z.object({
        enabled: z.boolean().optional(),
        exportTimezone: z.string().max(50).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await upsertConfig(ctx.db, ctx.tenant.id, input);
      return getConfig(ctx.db, ctx.tenant.id);
    }),

  generateToken: directorProcedure.mutation(async ({ ctx }) => {
    const { token, hash } = generateIncomingToken();
    await setIncomingTokenHash(ctx.db, ctx.tenant.id, hash);
    // Возвращаем raw-token ОДИН РАЗ. Дальше виден только hash в БД.
    return { token };
  }),

  revokeToken: directorProcedure.mutation(async ({ ctx }) => {
    await setIncomingTokenHash(ctx.db, ctx.tenant.id, null);
    return { revoked: true };
  }),

  exportInvoices: directorProcedure.mutation(({ ctx }) => exportInvoicesToOnecCmd(buildCmdCtx(ctx))),

  listExchanges: directorProcedure
    .input(z.object({ limit: z.number().int().min(1).max(200).optional() }).optional())
    .query(({ ctx, input }) => listRecentExchanges(ctx.db, ctx.tenant.id, input?.limit ?? 50)),
});
