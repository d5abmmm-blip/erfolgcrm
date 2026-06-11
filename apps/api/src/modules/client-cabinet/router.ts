/**
 * tRPC роутеры для кабинета клиента (Stage 10'.H).
 *
 * Два роутера:
 *   • clientAuthRouter — публичный (login/logout/me/changeMyPassword).
 *   • clientCabinetRouter — требует clientUserProcedure.
 *
 * Также экспортируется adminClientUsersRouter — для управления учётками клиентов
 * со стороны staff (директор). Регистрируется как поддерево clients-роутера.
 */
import { TRPCError } from '@trpc/server';
import { z } from 'zod';
import {
  router,
  publicProcedure,
  tenantProcedure,
  clientUserProcedure,
  directorProcedure,
} from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import {
  CLIENT_COOKIE_NAME,
  loginClient,
  logoutClient,
  type LoginResult,
} from './auth';
import {
  changeMyClientPassword,
  ClientUserConflictError,
  ClientWrongPasswordError,
  createClientUser,
  getClientConsents,
  getClientDisplayName,
  getMyAssetById,
  getMyAssets,
  getMyContracts,
  getMyInvoices,
  getMyPaymentsForExport,
  getMyProfileForExport,
  getMyTicketById,
  getMyTickets,
  getMyTicketsForExport,
  listClientUsersForClient,
  markClientUserDeletionRequested,
  resetClientUserPassword,
  revokeAllClientSessions,
  revokeClientConsents,
  setClientUserActive,
  softDeleteClientUser,
  updateMyClientProfile,
} from './repository';
import { getMyAssetForCreateTicket, createTicketFromCabinet } from './service';

const passwordSchema = z.string().min(8).max(200);

export const clientAuthRouter = router({
  /** Шаг 1: вход по email + пароль. Создаёт cookie. */
  login: tenantProcedure
    .input(
      z.object({
        email: z.string().trim().email().max(200),
        password: z.string().min(1).max(200),
      }),
    )
    .mutation(async ({ ctx, input }): Promise<LoginResult> => {
      return loginClient(
        {
          db: ctx.db,
          tenantId: ctx.tenant.id,
          tenantSubdomain: ctx.tenant.subdomain,
          tenantDisplayName: ctx.tenant.displayName,
          ip: ctx.ip,
          userAgent: ctx.userAgent,
          res: ctx.res,
        },
        input,
      );
    }),

  logout: clientUserProcedure.mutation(async ({ ctx }) => {
    const cookie = (ctx.res.req.cookies as Record<string, string>)?.[CLIENT_COOKIE_NAME];
    await logoutClient(ctx.db, ctx.tenant.id, cookie, {
      res: ctx.res,
      clientUserId: ctx.clientUser.clientUserId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    });
    return { ok: true };
  }),

  /** Возвращает текущего клиента или null. Не требует авторизации. */
  me: publicProcedure.query(async ({ ctx }) => {
    if (!ctx.tenant || !ctx.clientUser) return null;
    const clientDisplayName = await getClientDisplayName(
      ctx.db,
      ctx.tenant.id,
      ctx.clientUser.clientId,
    );
    return {
      user: {
        id: ctx.clientUser.clientUserId,
        email: ctx.clientUser.email,
        fullName: ctx.clientUser.fullName,
        clientId: ctx.clientUser.clientId,
        clientDisplayName,
      },
      tenant: {
        subdomain: ctx.tenant.subdomain,
        displayName: ctx.tenant.displayName,
      },
    };
  }),

  changeMyPassword: clientUserProcedure
    .input(
      z.object({
        oldPassword: z.string().min(1).max(200),
        newPassword: passwordSchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        await changeMyClientPassword(
          ctx.db,
          ctx.tenant.id,
          ctx.clientUser.clientUserId,
          input.oldPassword,
          input.newPassword,
        );
      } catch (e) {
        if (e instanceof ClientWrongPasswordError) {
          throw new TRPCError({ code: 'BAD_REQUEST', message: e.message });
        }
        throw e;
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: null,
        action: 'password_changed',
        entityType: 'client_user',
        entityId: ctx.clientUser.clientUserId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { client_user_id: ctx.clientUser.clientUserId },
      });
      return { ok: true };
    }),
});

export const clientCabinetRouter = router({
  getDashboard: clientUserProcedure.query(async ({ ctx }) => {
    const { tenant, clientUser, db } = ctx;
    const [activeTickets, invoicesAll, displayName] = await Promise.all([
      getMyTickets(db, tenant.id, clientUser.clientId, { limit: 100 }),
      getMyInvoices(db, tenant.id, clientUser.clientId),
      getClientDisplayName(db, tenant.id, clientUser.clientId),
    ]);
    const open = activeTickets.filter(
      (t) => t.status !== 'closed' && t.status !== 'cancelled',
    );
    const unpaid = invoicesAll.filter(
      (i) => i.status === 'issued' || i.status === 'partially_paid' || i.status === 'overdue',
    );
    return {
      clientDisplayName: displayName,
      counters: {
        openTickets: open.length,
        unpaidInvoices: unpaid.length,
        totalAssets: (await getMyAssets(db, tenant.id, clientUser.clientId)).length,
      },
      recentTickets: open.slice(0, 5),
      recentInvoices: unpaid.slice(0, 5),
    };
  }),

  listAssets: clientUserProcedure.query(({ ctx }) =>
    getMyAssets(ctx.db, ctx.tenant.id, ctx.clientUser.clientId),
  ),

  getAsset: clientUserProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) =>
      getMyAssetById(ctx.db, ctx.tenant.id, ctx.clientUser.clientId, input.id),
    ),

  listTickets: clientUserProcedure
    .input(
      z
        .object({
          status: z.string().max(50).optional(),
        })
        .optional(),
    )
    .query(({ ctx, input }) =>
      getMyTickets(ctx.db, ctx.tenant.id, ctx.clientUser.clientId, {
        status: input?.status,
      }),
    ),

  getTicket: clientUserProcedure
    .input(z.object({ id: z.string().uuid() }))
    .query(({ ctx, input }) =>
      getMyTicketById(ctx.db, ctx.tenant.id, ctx.clientUser.clientId, input.id),
    ),

  createTicket: clientUserProcedure
    .input(
      z.object({
        assetId: z.string().uuid(),
        summary: z.string().trim().min(5).max(2000),
        contactPhone: z.string().trim().max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      // Явная проверка: asset действительно принадлежит этому клиенту.
      const asset = await getMyAssetForCreateTicket(
        ctx.db,
        ctx.tenant.id,
        ctx.clientUser.clientId,
        input.assetId,
      );
      if (!asset) {
        throw new TRPCError({
          code: 'FORBIDDEN',
          message: 'Эта техника не относится к вашей организации',
        });
      }
      const result = await createTicketFromCabinet(ctx.db, {
        tenantId: ctx.tenant.id,
        clientId: ctx.clientUser.clientId,
        assetId: input.assetId,
        summary: input.summary,
        contactPhone: input.contactPhone ?? null,
      });
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: null,
        action: 'create',
        entityType: 'ticket',
        entityId: result.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: {
          client_user_id: ctx.clientUser.clientUserId,
          source: 'client_cabinet',
          ticket_number: result.ticketNumber,
        },
      });
      return result;
    }),

  listInvoices: clientUserProcedure.query(({ ctx }) =>
    getMyInvoices(ctx.db, ctx.tenant.id, ctx.clientUser.clientId),
  ),

  listContracts: clientUserProcedure.query(({ ctx }) =>
    getMyContracts(ctx.db, ctx.tenant.id, ctx.clientUser.clientId),
  ),

  updateProfile: clientUserProcedure
    .input(
      z.object({
        fullName: z.string().trim().min(2).max(200).optional(),
        phone: z.string().trim().max(50).nullable().optional(),
        position: z.string().trim().max(200).nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const result = await updateMyClientProfile(
        ctx.db,
        ctx.tenant.id,
        ctx.clientUser.clientUserId,
        input,
      );
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: null,
        action: 'update',
        entityType: 'client_user',
        entityId: ctx.clientUser.clientUserId,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { client_user_id: ctx.clientUser.clientUserId, fields: Object.keys(input) },
      });
      return result;
    }),

  /* ───────────── 152-ФЗ DSAR ───────────── */

  /**
   * 152-ФЗ ст.14 — выгрузка ВСЕХ ПДн субъекта.
   * Возвращает JSON со всеми данными по client_user (профиль/согласия)
   * и связанному клиенту (заявки/счета/платежи/договоры/техника).
   */
  exportMyData: clientUserProcedure.query(async ({ ctx }) => {
    const { db, tenant, clientUser } = ctx;
    const [
      profile,
      consents,
      tickets,
      myAssets,
      myInvoices,
      myPayments,
      myContracts,
    ] = await Promise.all([
      getMyProfileForExport(db, tenant.id, clientUser.clientUserId),
      getClientConsents(db, tenant.id, clientUser.clientUserId),
      getMyTicketsForExport(db, tenant.id, clientUser.clientId),
      getMyAssets(db, tenant.id, clientUser.clientId),
      getMyInvoices(db, tenant.id, clientUser.clientId),
      getMyPaymentsForExport(db, tenant.id, clientUser.clientId),
      getMyContracts(db, tenant.id, clientUser.clientId),
    ]);

    await writeAudit(db, tenant.id, {
      userId: null,
      action: 'export',
      entityType: 'client_user',
      entityId: clientUser.clientUserId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      context: {
        client_user_id: clientUser.clientUserId,
        kind: 'dsar_export',
        tickets_count: tickets.length,
        invoices_count: myInvoices.length,
        payments_count: myPayments.length,
        assets_count: myAssets.length,
        contracts_count: myContracts.length,
      },
    });

    return {
      generatedAt: new Date().toISOString(),
      subject: {
        clientUserId: clientUser.clientUserId,
        tenantId: tenant.id,
        clientId: clientUser.clientId,
      },
      profile,
      consents,
      tickets,
      assets: myAssets,
      invoices: myInvoices,
      payments: myPayments,
      contracts: myContracts,
    };
  }),

  /**
   * 152-ФЗ ст.21 — запрос на удаление аккаунта.
   * Помечает client_users.deletion_requested_at, отзывает согласия и сессии.
   * Физическое удаление откладывается до окончания обязательного срока хранения
   * первичных бухгалтерских документов (5 лет).
   */
  requestAccountDeletion: clientUserProcedure.mutation(async ({ ctx }) => {
    const { db, tenant, clientUser, res } = ctx;

    const ok = await markClientUserDeletionRequested(
      db,
      tenant.id,
      clientUser.clientUserId,
    );
    if (!ok) {
      throw new TRPCError({
        code: 'NOT_FOUND',
        message: 'Учётная запись не найдена или уже удалена',
      });
    }

    await revokeClientConsents(db, tenant.id, clientUser.clientUserId);
    await revokeAllClientSessions(db, tenant.id, clientUser.clientUserId);

    await writeAudit(db, tenant.id, {
      userId: null,
      action: 'consent_revoked',
      entityType: 'client_user',
      entityId: clientUser.clientUserId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      context: {
        client_user_id: clientUser.clientUserId,
        kind: 'dsar_account_deletion_requested',
      },
    });

    res.clearCookie(CLIENT_COOKIE_NAME, { path: '/' });

    return { ok: true };
  }),
});

/* ───────────── Admin: управление учётками клиентов от лица staff ───────────── */

export const adminClientUsersRouter = router({
  list: directorProcedure
    .input(z.object({ clientId: z.string().uuid() }))
    .query(({ ctx, input }) =>
      listClientUsersForClient(ctx.db, ctx.tenant.id, input.clientId),
    ),

  create: directorProcedure
    .input(
      z.object({
        clientId: z.string().uuid(),
        email: z.string().trim().email().max(200),
        password: passwordSchema,
        fullName: z.string().trim().min(2).max(200),
        position: z.string().trim().max(200).optional(),
        phone: z.string().trim().max(50).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      let created;
      try {
        created = await createClientUser(ctx.db, ctx.tenant.id, input.clientId, {
          email: input.email,
          password: input.password,
          fullName: input.fullName,
          position: input.position,
          phone: input.phone,
        });
      } catch (e) {
        if (e instanceof ClientUserConflictError) {
          throw new TRPCError({ code: 'CONFLICT', message: e.message });
        }
        throw e;
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'create',
        entityType: 'client_user',
        entityId: created.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { client_id: input.clientId, client_email: created.email },
      });
      return created;
    }),

  setActive: directorProcedure
    .input(z.object({ id: z.string().uuid(), isActive: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const updated = await setClientUserActive(
        ctx.db,
        ctx.tenant.id,
        input.id,
        input.isActive,
      );
      if (!updated) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Учётка не найдена' });
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'update',
        entityType: 'client_user',
        entityId: input.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { is_active: input.isActive },
      });
      return updated;
    }),

  resetPassword: directorProcedure
    .input(z.object({ id: z.string().uuid(), newPassword: passwordSchema }))
    .mutation(async ({ ctx, input }) => {
      const ok = await resetClientUserPassword(
        ctx.db,
        ctx.tenant.id,
        input.id,
        input.newPassword,
      );
      if (!ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Учётка не найдена' });
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'password_changed',
        entityType: 'client_user',
        entityId: input.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { reset_by_admin: true },
      });
      return { ok: true };
    }),

  remove: directorProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      const ok = await softDeleteClientUser(ctx.db, ctx.tenant.id, input.id);
      if (!ok) {
        throw new TRPCError({ code: 'NOT_FOUND', message: 'Учётка не найдена' });
      }
      await writeAudit(ctx.db, ctx.tenant.id, {
        userId: ctx.session.userId,
        action: 'delete',
        entityType: 'client_user',
        entityId: input.id,
        ip: ctx.ip,
        userAgent: ctx.userAgent,
        context: { soft: true },
      });
      return { ok: true };
    }),
});
