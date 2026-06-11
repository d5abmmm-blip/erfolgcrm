/**
 * tRPC роутер календаря компании.
 *
 * RBAC: staffProcedure (директор + диспетчер) — как у «Графика»: инженеры
 * видят свои выезды в PWA и недельном графике, общий календарь — операционный
 * инструмент менеджеров.
 */
import { z } from 'zod';
import { router, staffProcedure } from '../../trpc/trpc';
import { listMonthEvents } from './repository';

export const calendarRouter = router({
  month: staffProcedure
    .input(
      z.object({
        year: z.number().int().min(2020).max(2100),
        month: z.number().int().min(1).max(12),
      }),
    )
    .query(({ ctx, input }) =>
      listMonthEvents(ctx.db, ctx.tenant.id, ctx.tenant.timezone, input.year, input.month),
    ),
});
