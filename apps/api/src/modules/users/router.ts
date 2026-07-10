/**
 * tRPC роутер users.
 *
 * - list / setHourlyCostRate — Этап 9.F.
 * - create / update / setActive / resetPassword — Этап 10' (директор).
 * - changeMyPassword — авторизованный пользователь меняет свой пароль.
 *
 * Все мутации пишут запись в audit_logs (152-ФЗ).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { StaffPosition } from '@erfolg/shared';
import { authedProcedure, directorProcedure, router } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import {
  changeMyPassword,
  createUser,
  getUserById,
  LastDirectorError,
  listUsers,
  resetPassword,
  setUserActive,
  updateHourlyCostRate,
  updateUser,
  updateUserPayout,
  UserConflictError,
  WrongPasswordError,
} from './repository';

const usernameSchema = z
  .string()
  .trim()
  .min(3, 'Минимум 3 символа')
  .max(64)
  .regex(/^[a-z0-9._-]+$/i, 'Только латиница, цифры, точка, дефис, подчёркивание');

const passwordSchema = z
  .string()
  .min(8, 'Минимум 8 символов')
  .max(200, 'Слишком длинный пароль');

const emailSchema = z
  .string()
  .trim()
  .email('Некорректный email')
  .max(200)
  .or(z.literal(''))
  .nullable()
  .optional();

const phoneSchema = z.string().trim().max(50).nullable().optional();

const fullNameSchema = z.string().trim().min(1, 'Укажите ФИО').max(200);

// Должность выбирается только из фиксированного перечня (StaffPosition) —
// произвольный текст отклоняется. Пустое значение допускается (null).
const positionSchema = StaffPosition.nullable().optional();

const roleSchema = z.enum(['director', 'dispatcher', 'engineer']);

function mapConflict(err: unknown): never {
  if (err instanceof UserConflictError) {
    throw new TRPCError({
      code: 'CONFLICT',
      message: err.message,
      cause: err.field,
    });
  }
  if (err instanceof LastDirectorError) {
    throw new TRPCError({ code: 'BAD_REQUEST', message: err.message });
  }
  if (err instanceof WrongPasswordError) {
    throw new TRPCError({ code: 'UNAUTHORIZED', message: err.message });
  }
  throw err;
}

export const usersRouter = router({
  list: authedProcedure
    .input(
      z
        .object({
          onlyEngineers: z.boolean().optional(),
          includeBlocked: z.boolean().optional(),
        })
        .optional(),
    )
    .query(async ({ ctx, input }) => {
      const rows = await listUsers(ctx.db, ctx.tenant.id, {
        onlyEngineers: input?.onlyEngineers,
        includeBlocked: input?.includeBlocked,
      });
      // Ставка и персональная ЗП (оклад/бонус) — зарплатные данные: видны только директору.
      // Остальным список нужен лишь для выпадающих назначений (id + ФИО).
      if (ctx.session?.role === 'director') return rows;
      return rows.map((r) => ({
        ...r,
        hourlyCostRateKopecks: '0',
        payoutBaseSalaryKopecks: null,
        payoutBonusPercent: null,
      }));
    }),

  getById: directorProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const user = await getUserById(ctx.db, ctx.tenant.id, input.userId);
      if (!user) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
      }
      return user;
    }),

  create: directorProcedure
    .input(
      z.object({
        username: usernameSchema,
        password: passwordSchema,
        fullName: fullNameSchema,
        position: positionSchema,
        email: emailSchema,
        phone: phoneSchema,
        role: roleSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const created = await createUser(ctx.db, ctx.tenant.id, {
          username: input.username,
          password: input.password,
          fullName: input.fullName,
          position: input.position ?? null,
          email: input.email || null,
          phone: input.phone ?? null,
          role: input.role,
        });
        await writeAudit(ctx.db, ctx.tenant.id, {
          userId: ctx.session.userId,
          action: 'create',
          entityType: 'user',
          entityId: created.id,
          after: {
            username: created.username,
            fullName: created.fullName,
            role: created.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return created;
      } catch (err) {
        mapConflict(err);
      }
    }),

  update: directorProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        fullName: fullNameSchema.optional(),
        position: positionSchema,
        email: emailSchema,
        phone: phoneSchema,
        role: roleSchema.optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const before = await getUserById(ctx.db, ctx.tenant.id, input.userId);
      if (!before) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
      }
      const roleChanged = input.role !== undefined && input.role !== before.role;
      try {
        const updated = await updateUser(ctx.db, ctx.tenant.id, input.userId, {
          fullName: input.fullName,
          position: input.position,
          email: input.email === undefined ? undefined : input.email || null,
          phone: input.phone,
          role: input.role,
        });
        if (!updated) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
        }
        await writeAudit(ctx.db, ctx.tenant.id, {
          userId: ctx.session.userId,
          action: roleChanged ? 'role_changed' : 'update',
          entityType: 'user',
          entityId: updated.id,
          before: {
            fullName: before.fullName,
            position: before.position,
            email: before.email,
            phone: before.phone,
            role: before.role,
          },
          after: {
            fullName: updated.fullName,
            position: updated.position,
            email: updated.email,
            phone: updated.phone,
            role: updated.role,
          },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      } catch (err) {
        mapConflict(err);
      }
    }),

  setActive: directorProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        isActive: z.boolean(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.userId === ctx.session.userId && !input.isActive) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Нельзя заблокировать самого себя',
        });
      }
      try {
        const updated = await setUserActive(
          ctx.db,
          ctx.tenant.id,
          input.userId,
          input.isActive,
        );
        if (!updated) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
        }
        await writeAudit(ctx.db, ctx.tenant.id, {
          userId: ctx.session.userId,
          action: 'update',
          entityType: 'user',
          entityId: updated.id,
          after: { isActive: updated.isActive },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return updated;
      } catch (err) {
        mapConflict(err);
      }
    }),

  resetPassword: directorProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        newPassword: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ok = await resetPassword(
        ctx.db,
        ctx.tenant.id,
        input.userId,
        input.newPassword,
      );
      if (!ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'password_changed',
        entityType: 'user',
        entityId: input.userId,
        context: { resetByAdmin: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return { ok: true };
    }),

  changeMyPassword: authedProcedure
    .input(
      z.object({
        oldPassword: z.string().min(1).max(200),
        newPassword: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        const ok = await changeMyPassword(
          ctx.db,
          ctx.session.tenantId,
          ctx.session.userId,
          input.oldPassword,
          input.newPassword,
        );
        if (!ok) {
          throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
        }
        await writeAudit(ctx.db, ctx.session.tenantId, {
          userId: ctx.session.userId,
          action: 'password_changed',
          entityType: 'user',
          entityId: ctx.session.userId,
          context: { resetByAdmin: false },
          ip: ctx.ip,
          userAgent: ctx.userAgent,
        });
        return { ok: true };
      } catch (err) {
        mapConflict(err);
      }
    }),

  setHourlyCostRate: directorProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        rateKopecks: z.string().regex(/^\d+$/, 'Должно быть число копеек ≥ 0'),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await updateHourlyCostRate(
        ctx.db,
        ctx.tenant.id,
        input.userId,
        BigInt(input.rateKopecks),
      );
      if (!result) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
      }
      return result;
    }),

  /** Персональная ЗП сотрудника: оклад (копейки) + бонус %. null ⇒ вернуть на глобальное правило. */
  setUserPayout: directorProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        baseSalaryKopecks: z.string().regex(/^\d+$/, 'Должно быть число копеек ≥ 0').nullable(),
        bonusPercent: z.number().int().min(0).max(100).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await updateUserPayout(ctx.db, ctx.tenant.id, input.userId, {
        baseSalaryKopecks: input.baseSalaryKopecks !== null ? BigInt(input.baseSalaryKopecks) : null,
        bonusPercent: input.bonusPercent,
      });
      if (!result) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Пользователь не найден' });
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'user_payout',
        entityId: input.userId,
        after: { baseSalaryKopecks: input.baseSalaryKopecks, bonusPercent: input.bonusPercent },
        ip: ctx.ip,
        userAgent: ctx.userAgent,
      });
      return result;
    }),
});
