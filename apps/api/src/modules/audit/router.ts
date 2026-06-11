/**
 * tRPC роутер audit — только директор.
 *
 * - list — пагинированный список с фильтрами + cursor.
 * - entityTypes — уникальные entity_type'ы (для фильтра).
 * - stats — карточки на верх страницы.
 *
 * НИКАКИХ мутаций. Журнал нельзя редактировать или удалять — это требование 152-ФЗ.
 */
import { z } from 'zod';
import { directorProcedure, router } from '../../trpc/trpc';
import { getAuditStats, listAuditLogs, listEntityTypes } from './repository';

const auditActionSchema = z.enum([
  'create',
  'update',
  'delete',
  'restore',
  'login',
  'logout',
  'login_failed',
  'password_changed',
  'role_changed',
  'export',
  'consent_given',
  'consent_revoked',
]);

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD');

export const auditRouter = router({
  list: directorProcedure
    .input(
      z
        .object({
          actions: z.array(auditActionSchema).optional(),
          entityTypes: z.array(z.string().min(1).max(50)).optional(),
          userId: z.string().uuid().nullable().optional(),
          dateFrom: isoDateSchema.optional(),
          dateTo: isoDateSchema.optional(),
          search: z.string().trim().max(200).optional(),
          limit: z.number().int().min(1).max(200).optional(),
          cursor: z
            .object({ ts: z.string(), id: z.string().uuid() })
            .nullable()
            .optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listAuditLogs(ctx.db, ctx.tenant.id, {
        actions: input?.actions,
        entityTypes: input?.entityTypes,
        userId: input?.userId ?? undefined,
        dateFrom: input?.dateFrom,
        dateTo: input?.dateTo,
        search: input?.search,
        limit: input?.limit,
        cursor: input?.cursor ?? undefined,
      }),
    ),

  entityTypes: directorProcedure.query(({ ctx }) =>
    listEntityTypes(ctx.db, ctx.tenant.id),
  ),

  stats: directorProcedure.query(({ ctx }) => getAuditStats(ctx.db, ctx.tenant.id)),
});
