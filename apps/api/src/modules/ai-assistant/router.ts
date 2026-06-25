/**
 * tRPC роутер AI-ассистента.
 *
 * - status — настроен ли LLM (есть ли ключ). Используется фронтом для подсказки.
 * - send   — основной эндпоинт: принимает историю диалога (и опц. подтверждённое
 *            действие), возвращает либо текст, либо запрос на подтверждение write.
 *
 * Все процедуры — authedProcedure: ассистент доступен любому вошедшему сотруднику,
 * а права на конкретные операции проверяются внутри вызываемых процедур (RBAC/RLS).
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { authedProcedure, router } from '../../trpc/trpc';
import { llmConfigured } from './llm';
import { runAssistant } from './service';

const turnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

const sendInput = z.object({
  messages: z.array(turnSchema).min(1).max(40),
  confirm: z
    .object({
      tool: z.string().min(1).max(64),
      args: z.record(z.unknown()),
    })
    .optional(),
});

export const aiAssistantRouter = router({
  status: authedProcedure.query(() => ({ configured: llmConfigured() })),

  send: authedProcedure.input(sendInput).mutation(async ({ ctx, input }) => {
    try {
      return await runAssistant(ctx, input.messages, input.confirm);
    } catch (err) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: err instanceof Error ? err.message : 'Ошибка AI-ассистента',
      });
    }
  }),
});
