/**
 * tRPC роутер раздела «Сотрудники».
 *
 * RBAC: staffProcedure — директор и менеджер (решение владельца 2026-08-14: карточка
 * нужна менеджеру для назначения заявок). Денег здесь нет вовсе: ставки, ведомости и
 * выплаты живут в разделе зарплаты и закрыты директором — на этой карточке они
 * появятся отдельной вкладкой со своей проверкой роли, а не заодно с загрузкой.
 *
 * Только чтение: навыки правит engineerProfile.setSkills (директор), отсутствия —
 * engineerProfile.setAvailability. Второй раз те же мутации не заводим.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { router, staffProcedure } from '../../trpc/trpc';
import { getStaffCard, getStaffWork, listStaff } from './repository';
import { STATS_SINCE, STATS_SINCE_LABEL } from '../../lib/stats-since';

export const staffRouter = router({
  list: staffProcedure
    .input(z.object({ includeBlocked: z.boolean().optional() }).optional())
    .query(async ({ ctx, input }) => ({
      statsSince: STATS_SINCE,
      statsSinceLabel: STATS_SINCE_LABEL,
      rows: await listStaff(ctx.db, ctx.tenant.id, ctx.tenant.timezone, {
        includeBlocked: input?.includeBlocked,
      }),
    })),

  /**
   * История работы человека за период — вкладка «Работа».
   *
   * Период считается по ДАТЕ ЗАКРЫТИЯ и приходит готовыми границами с экрана
   * (полуинтервал). Денег в ответе нет вовсе: карточку открывают и менеджеру.
   */
  work: staffProcedure
    .input(
      z.object({
        userId: z.string().uuid(),
        from: z.date(),
        to: z.date(),
      }),
    )
    .query(async ({ ctx, input }) => ({
      statsSince: STATS_SINCE,
      statsSinceLabel: STATS_SINCE_LABEL,
      work: await getStaffWork(ctx.db, ctx.tenant.id, input.userId, {
        from: input.from,
        to: input.to,
      }),
    })),

  get: staffProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const card = await getStaffCard(ctx.db, ctx.tenant.id, ctx.tenant.timezone, input.userId);
      if (!card) throw new TRPCError({ code: 'NOT_FOUND', message: 'Сотрудник не найден' });
      return { statsSince: STATS_SINCE, statsSinceLabel: STATS_SINCE_LABEL, card };
    }),
});
