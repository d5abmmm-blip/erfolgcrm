/**
 * tRPC роутер roadmap. RBAC: цели компании — только директор.
 */
import { z } from 'zod';
import { RoadmapCategory, RoadmapPriority, RoadmapQuarter } from '@erfolg/shared';
import { directorProcedure, router } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import { archiveGoalCmd, createGoalCmd, listGoalsQuery, updateGoalCmd } from './service';

const goalFields = {
  quarter: RoadmapQuarter,
  year: z.number().int().min(2020).max(2100),
  title: z.string().trim().min(1).max(255),
  description: z.string().trim().max(5000).nullable().optional(),
  targetValue: z.number().int().min(0).nullable().optional(),
  currentValue: z.number().int().min(0).nullable().optional(),
  unit: z.string().trim().max(32).nullable().optional(),
  category: RoadmapCategory,
  priority: RoadmapPriority.optional(),
  /** Этапы цели (подшаги с галочками). Полный массив — заменяет прежний. */
  stages: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        title: z.string().trim().min(1).max(200),
        done: z.boolean(),
      }),
    )
    .max(50)
    .optional(),
};

export const roadmapRouter = router({
  list: directorProcedure
    .input(z.object({ year: z.number().int().min(2020).max(2100).optional() }))
    .query(({ ctx, input }) => listGoalsQuery(ctx.db, ctx.tenant, input)),

  create: directorProcedure
    .input(z.object(goalFields))
    .mutation(({ ctx, input }) => createGoalCmd(buildCmdCtx(ctx), input)),

  update: directorProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        patch: z
          .object({
            ...goalFields,
            quarter: RoadmapQuarter.optional(),
            year: z.number().int().min(2020).max(2100).optional(),
            title: z.string().trim().min(1).max(255).optional(),
            category: RoadmapCategory.optional(),
            isDone: z.boolean().optional(),
          })
          .strict(),
      }),
    )
    .mutation(({ ctx, input }) => updateGoalCmd(buildCmdCtx(ctx), input.id, input.patch)),

  archive: directorProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => archiveGoalCmd(buildCmdCtx(ctx), input.id)),
});
