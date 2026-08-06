/**
 * tRPC роутер attestations.
 *
 * RBAC:
 *   - list / getEngineerCategories / categories — staffProcedure (директор + диспетчер).
 *   - create / update / remove — directorProcedure (только директор управляет).
 *
 * Все мутации пишут writeAudit (152-ФЗ — аудит изменений).
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import { directorProcedure, router, staffProcedure } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import { ATTESTATION_CATEGORIES } from './categories';
import {
  checkAttestationForAssignment,
  createAttestation,
  EngineerNotFoundError,
  getActiveCategoriesForEngineer,
  getAttestationById,
  listAttestations,
  softDeleteAttestation,
  updateAttestation,
} from './repository';

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате YYYY-MM-DD');

const createSchema = z
  .object({
    engineerId: z.string().uuid(),
    category: z.string().trim().min(1, 'Укажите категорию').max(100),
    issuedBy: z.string().trim().max(300).nullable().optional(),
    certificateNumber: z.string().trim().max(100).nullable().optional(),
    issuedAt: isoDateSchema,
    validUntil: isoDateSchema.nullable().optional(),
    documentAttachmentId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .refine((v) => !v.validUntil || v.validUntil >= v.issuedAt, {
    message: 'validUntil не может быть раньше issuedAt',
    path: ['validUntil'],
  });

const updateSchema = z
  .object({
    category: z.string().trim().min(1).max(100).optional(),
    issuedBy: z.string().trim().max(300).nullable().optional(),
    certificateNumber: z.string().trim().max(100).nullable().optional(),
    issuedAt: isoDateSchema.optional(),
    validUntil: isoDateSchema.nullable().optional(),
    documentAttachmentId: z.string().uuid().nullable().optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
  })
  .strict();

function mapEngineerErr(err: unknown): never {
  if (err instanceof EngineerNotFoundError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  throw err;
}

export const attestationsRouter = router({
  /** Словарь категорий — для UI селекта. */
  categories: staffProcedure.query(() => ATTESTATION_CATEGORIES),

  list: staffProcedure
    .input(
      z
        .object({
          engineerId: z.string().uuid().optional(),
          includeExpired: z.boolean().optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      listAttestations(ctx.db, ctx.tenant.id, {
        engineerId: input?.engineerId,
        includeExpired: input?.includeExpired,
      }),
    ),

  /** Активные категории конкретного инженера — для UI бейджа диспетчера. */
  getEngineerCategories: staffProcedure
    .input(z.object({ engineerId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      getActiveCategoriesForEngineer(ctx.db, ctx.tenant.id, input.engineerId),
    ),

  /**
   * Compliance-проверка пары инженер↔категория ассета. Возвращает строку-предупреждение
   * или null. Используется UI диспетчера до сохранения формы как preview-проверка.
   */
  checkAssignment: staffProcedure
    .input(
      z.object({
        engineerId: z.string().uuid(),
        requiredCategory: z.string().nullable(),
      }),
    )
    .query(({ ctx, input }) =>
      checkAttestationForAssignment(ctx.db, ctx.tenant.id, {
        engineerId: input.engineerId,
        requiredCategory: input.requiredCategory,
      }),
    ),

  create: directorProcedure.input(createSchema).mutation(async ({ ctx, input }) => {
    try {
      const row = await createAttestation(ctx.db, ctx.tenant.id, {
        engineerId: input.engineerId,
        category: input.category,
        issuedBy: input.issuedBy ?? null,
        certificateNumber: input.certificateNumber ?? null,
        issuedAt: input.issuedAt,
        validUntil: input.validUntil ?? null,
        documentAttachmentId: input.documentAttachmentId ?? null,
        notes: input.notes ?? null,
      });
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'create',
        entityType: 'engineer_attestation',
        entityId: row.id,
        after: {
          engineerId: row.engineerId,
          category: row.category,
          validUntil: row.validUntil,
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    } catch (err) {
      mapEngineerErr(err);
    }
  }),

  update: directorProcedure
    .input(z.object({ id: z.string().uuid(), patch: updateSchema }))
    .mutation(async ({ ctx, input }) => {
      const before = await getAttestationById(ctx.db, ctx.tenant.id, input.id);
      if (!before) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Аттестация не найдена' });
      }
      // Если меняется issuedAt и есть validUntil (или меняется validUntil) — проверим инвариант.
      const effectiveIssued = input.patch.issuedAt ?? before.issuedAt;
      const effectiveValid =
        input.patch.validUntil !== undefined ? input.patch.validUntil : before.validUntil;
      if (effectiveValid && effectiveValid < effectiveIssued) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'validUntil не может быть раньше issuedAt',
        });
      }
      const row = await updateAttestation(ctx.db, ctx.tenant.id, input.id, input.patch);
      if (!row) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Аттестация не найдена' });
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'engineer_attestation',
        entityId: row.id,
        before: {
          category: before.category,
          validUntil: before.validUntil,
        },
        after: {
          category: row.category,
          validUntil: row.validUntil,
          patchKeys: Object.keys(input.patch),
        },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return row;
    }),

  remove: directorProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await softDeleteAttestation(ctx.db, ctx.tenant.id, input.id);
      if (!ok) throw new TRPCError({ code: 'NOT_FOUND', message: 'Аттестация не найдена' });
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'delete',
        entityType: 'engineer_attestation',
        entityId: input.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ok: true };
    }),
});
