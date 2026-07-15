/**
 * tRPC роутер задач менеджеров (таск-лист).
 *
 * RBAC: список/создание/правка/удаление — staffProcedure (директор+диспетчер).
 * myList/setDone — engineerProcedure (staff тоже проходит), с проверкой владения
 * внутри setTaskDoneCmd (инженер закрывает только свои задачи).
 */
import { z } from 'zod';
import { engineerProcedure, router, staffProcedure } from '../../trpc/trpc';
import { buildCmdCtx } from '../../trpc/helpers';
import {
  createTaskCmd,
  deleteTaskCmd,
  listMyTasksQuery,
  listTasksQuery,
  setTaskDoneCmd,
  updateTaskCmd,
} from './service';
import type { TaskInput } from './repository';

const taskFields = {
  title: z.string().trim().min(1, 'Укажите название').max(300),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Дата в формате ГГГГ-ММ-ДД')
    .nullish(),
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Время в формате ЧЧ:ММ')
    .nullish(),
  notes: z.string().trim().max(2000).nullish(),
  assigneeUserId: z.string().uuid().nullish(),
  /** Push-напоминание накануне даты в 09:00 (пояс организации). */
  remind: z.boolean().optional().default(false),
};

type RawTaskInput = {
  title: string;
  date?: string | null;
  time?: string | null;
  notes?: string | null;
  assigneeUserId?: string | null;
  remind?: boolean;
};

/** Нормализуем nullish-поля zod в явные null для service/repository. */
function normalize(input: RawTaskInput): TaskInput {
  return {
    title: input.title,
    date: input.date ?? null,
    time: input.time ?? null,
    notes: input.notes?.trim() ? input.notes.trim() : null,
    assigneeUserId: input.assigneeUserId ?? null,
    remind: input.remind ?? false,
  };
}

export const tasksRouter = router({
  /** Все задачи компании — для панели «Задачи» в календаре (менеджеры). */
  list: staffProcedure
    .input(z.object({ includeDone: z.boolean().optional() }).optional())
    .query(({ ctx, input }) =>
      listTasksQuery(ctx.db, ctx.tenant, { includeDone: input?.includeDone ?? false }),
    ),

  /** Мои задачи — для мобилки инженера (назначенные ему). */
  myList: engineerProcedure
    .input(z.object({ includeDone: z.boolean().optional() }).optional())
    .query(({ ctx, input }) =>
      listMyTasksQuery(ctx.db, ctx.tenant, ctx.session.userId, {
        includeDone: input?.includeDone ?? false,
      }),
    ),

  create: staffProcedure
    .input(z.object(taskFields))
    .mutation(({ ctx, input }) => createTaskCmd(buildCmdCtx(ctx), normalize(input))),

  update: staffProcedure
    .input(z.object({ id: z.string().uuid(), ...taskFields }))
    .mutation(({ ctx, input }) => {
      const { id, ...rest } = input;
      return updateTaskCmd(buildCmdCtx(ctx), id, normalize(rest));
    }),

  /** Отметить «сделано»/снять. Инженер — только по своим задачам (проверка внутри). */
  setDone: engineerProcedure
    .input(z.object({ id: z.string().uuid(), isDone: z.boolean() }))
    .mutation(({ ctx, input }) => setTaskDoneCmd(buildCmdCtx(ctx), input.id, input.isDone)),

  delete: staffProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(({ ctx, input }) => deleteTaskCmd(buildCmdCtx(ctx), input.id)),
});
