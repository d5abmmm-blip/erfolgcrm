/**
 * tRPC-роутер архива ремонтов (AI-диагностика по симптому).
 *
 * RBAC:
 *   - searchSimilar — engineerProcedure (инженер тоже видит подсказку; читает справочник,
 *     LLM не вызывается).
 *   - summarize — staffProcedure (директор/диспетчер): дёргает LLM, оставляем за staff.
 */
import { z } from 'zod';
import { router, engineerProcedure, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { searchArchiveQuery, summarizeArchiveQuery } from './service';

const baseInput = z
  .object({
    ticketId: z.string().uuid().optional(),
    symptom: z.string().trim().max(1000).optional(),
    model: z.string().trim().max(300).optional(),
  })
  .refine(
    (v) =>
      Boolean(v.ticketId || (v.symptom && v.symptom.length > 0) || (v.model && v.model.length > 0)),
    { message: 'Нужен хотя бы один из параметров: ticketId, symptom или model' },
  );

const searchInput = z
  .object({
    ticketId: z.string().uuid().optional(),
    symptom: z.string().trim().max(1000).optional(),
    model: z.string().trim().max(300).optional(),
    limit: z.number().int().min(1).max(20).optional(),
  })
  .refine(
    (v) =>
      Boolean(v.ticketId || (v.symptom && v.symptom.length > 0) || (v.model && v.model.length > 0)),
    { message: 'Нужен хотя бы один из параметров: ticketId, symptom или model' },
  );

export const repairArchiveRouter = router({
  /** Похожие прошлые ремонты по симптому текущей заявки (или прямому symptom/model). */
  searchSimilar: engineerProcedure
    .input(searchInput)
    .query(({ ctx, input }) => searchArchiveQuery(buildCmdCtx(ctx), input)),

  /** ИИ-резюме «что обычно помогало» поверх найденных ремонтов (деградирует до null). */
  summarize: staffProcedure
    .input(baseInput)
    .query(({ ctx, input }) => summarizeArchiveQuery(buildCmdCtx(ctx), input)),
});
