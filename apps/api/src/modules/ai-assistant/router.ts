/**
 * tRPC роутер AI-ассистента.
 *
 * - status     — настроен ли LLM (из БД tenant'а или env). Фронт показывает подсказку.
 * - send       — основной эндпоинт диалога (текст/подтверждение write/вложения).
 * - getConfig  — реквизиты подключения к LLM БЕЗ ключа (директор). Для Настроек.
 * - setConfig  — сохранить реквизиты (директор). Ключ write-only, шифруется.
 * - testConfig — проверка связи: реальный мини-вызов модели (директор).
 *
 * send/status — authedProcedure (ассистент доступен любому сотруднику, права на
 * конкретные операции проверяются внутри инструментов). Настройки — directorProcedure.
 */
import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { authedProcedure, directorProcedure, router, staffProcedure } from '../../trpc/trpc';
import { writeAudit } from '../../lib/audit';
import { callLlm } from './llm';
import { getLlmConfigDto, loadLlmRuntimeConfig, upsertLlmConfig } from './config';
import { runAssistant } from './service';
import { explainTicketBlock, getOrBuildDailySummary } from './proactive';

const turnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
});

/**
 * Вложение: имя, MIME и содержимое в base64. Потолок ~13.6M base64-символов ≈ 10 МБ файла.
 * До 4 файлов за раз. Изображения читает vision-модель, из PDF/Word извлекается текст.
 */
const attachmentSchema = z.object({
  name: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(150),
  dataBase64: z.string().min(1).max(13_600_000),
});

const sendInput = z.object({
  messages: z.array(turnSchema).min(1).max(40),
  confirm: z
    .object({
      tool: z.string().min(1).max(64),
      args: z.record(z.unknown()),
    })
    .optional(),
  attachments: z.array(attachmentSchema).max(4).optional(),
});

const setConfigInput = z.object({
  enabled: z.boolean(),
  apiStyle: z.enum(['openai', 'anthropic']),
  baseUrl: z.string().trim().max(500).nullable(),
  model: z.string().trim().max(120).nullable(),
  /** Новый ключ. Пусто/не задан — не менять сохранённый. */
  apiKey: z.string().max(500).optional(),
});

export const aiAssistantRouter = router({
  status: authedProcedure.query(async ({ ctx }) => ({
    configured: (await loadLlmRuntimeConfig(ctx.db, ctx.tenant)) != null,
  })),

  getConfig: directorProcedure.query(({ ctx }) => getLlmConfigDto(ctx.db, ctx.tenant)),

  setConfig: directorProcedure.input(setConfigInput).mutation(async ({ ctx, input }) => {
    // Нельзя включить ассистента без полного конфига (иначе он молча упадёт в env/«не настроен»).
    if (input.enabled) {
      const newKey = Boolean(input.apiKey?.trim());
      const hasKey = newKey || (await getLlmConfigDto(ctx.db, ctx.tenant)).hasApiKey;
      if (!input.baseUrl?.trim() || !input.model?.trim() || !hasKey) {
        throw new TRPCError({
          code: 'BAD_REQUEST',
          message: 'Чтобы включить ассистента, заполните базовый URL, модель и API-ключ.',
        });
      }
    }
    await upsertLlmConfig(ctx.db, ctx.tenant, {
      enabled: input.enabled,
      apiStyle: input.apiStyle,
      baseUrl: input.baseUrl?.trim() || null,
      model: input.model?.trim() || null,
      apiKey: input.apiKey?.trim() || undefined,
    });
    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'update',
      entityType: 'llm_config',
      entityId: ctx.tenant.id,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
      context: {
        enabled: input.enabled,
        apiStyle: input.apiStyle,
        baseUrl: input.baseUrl,
        model: input.model,
        apiKeyChanged: Boolean(input.apiKey?.trim()),
      },
    });
    return getLlmConfigDto(ctx.db, ctx.tenant);
  }),

  testConfig: directorProcedure.mutation(async ({ ctx }) => {
    const cfg = await loadLlmRuntimeConfig(ctx.db, ctx.tenant);
    if (!cfg) {
      return { ok: false as const, error: 'Не настроено: укажите ключ и модель и сохраните.' };
    }
    try {
      const reply = await callLlm(
        [
          { role: 'system', content: 'Проверка связи. Ответь одним словом.' },
          { role: 'user', content: 'Ответь одним словом: работает' },
        ],
        [],
        cfg,
      );
      return { ok: true as const, model: cfg.model, reply: (reply.content ?? '').slice(0, 80) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : 'Ошибка связи с LLM' };
    }
  }),

  send: authedProcedure.input(sendInput).mutation(async ({ ctx, input }) => {
    try {
      return await runAssistant(ctx, input.messages, input.confirm, input.attachments);
    } catch (err) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: err instanceof Error ? err.message : 'Ошибка AI-ассистента',
      });
    }
  }),

  /**
   * Утренняя AI-сводка для менеджера (данные всегда, текст LLM из кэша на день).
   * staff — директор/диспетчер. Инженер работает в мобильном.
   */
  dailySummary: staffProcedure.query(({ ctx }) => getOrBuildDailySummary(ctx.db, ctx.tenant)),

  /** «Почему застряло?» — объяснение простоя заявки (факты + LLM-формулировка). */
  explainTicketBlock: staffProcedure
    .input(z.object({ ticketId: z.string().uuid() }))
    .query(({ ctx, input }) => explainTicketBlock(ctx.db, ctx.tenant, input.ticketId)),
});
