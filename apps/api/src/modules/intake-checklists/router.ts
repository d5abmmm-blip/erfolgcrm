/**
 * Stage 10'.J — tRPC роутер чек-листов приёма/выдачи.
 *
 * RBAC: staffProcedure (директор + диспетчер).
 * Все мутации пишут writeAudit.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, staffProcedure } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import {
  createChecklistWithItems,
  getChecklistWithItems,
  listForTicket,
  softDelete,
  type ChecklistKind,
} from './repository';
import { listTemplates } from './templates';

const itemInputSchema = z.object({
  label: z.string().trim().min(1, 'Пункт пустой').max(300),
  status: z.enum(['ok', 'issue', 'na']),
  comment: z.string().trim().max(2000).nullable().optional(),
  photoAttachmentId: z.string().uuid().nullable().optional(),
});

const createInputSchema = z.object({
  ticketId: z.string().uuid(),
  kind: z.enum(['intake', 'handover']),
  items: z.array(itemInputSchema).min(1, 'Чек-лист не может быть пустым').max(100),
  clientSignatureName: z.string().trim().max(200).nullable().optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
});

export const intakeChecklistsRouter = router({
  getTemplates: staffProcedure.query(() => listTemplates()),

  listForTicket: staffProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) => listForTicket(ctx.db, ctx.tenant.id, input.ticketId)),

  get: staffProcedure
    .input(z.object({ checklistId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const row = await getChecklistWithItems(ctx.db, ctx.tenant.id, input.checklistId);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Чек-лист не найден' });
      }
      return row;
    }),

  create: staffProcedure
    .input(createInputSchema)
    .mutation(async ({ ctx, input }) => {
      const row = await createChecklistWithItems(
        ctx.db,
        ctx.tenant.id,
        input.ticketId,
        input.kind as ChecklistKind,
        input.items.map((it) => ({
          label: it.label,
          status: it.status,
          comment: it.comment ?? null,
          photoAttachmentId: it.photoAttachmentId ?? null,
        })),
        {
          completedByUserId: ctx.session.userId,
          clientSignatureName: input.clientSignatureName ?? null,
          notes: input.notes ?? null,
        },
      );
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'create',
        entityType: 'intake_checklist',
        entityId: row.id,
        after: {
          ticketId: row.ticketId,
          kind: row.kind,
          itemsCount: row.itemsCount,
          issuesCount: row.issuesCount,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    }),

  delete: staffProcedure
    .input(z.object({ checklistId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await softDelete(ctx.db, ctx.tenant.id, input.checklistId);
      if (!ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Чек-лист не найден' });
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'delete',
        entityType: 'intake_checklist',
        entityId: input.checklistId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ok: true };
    }),
});
