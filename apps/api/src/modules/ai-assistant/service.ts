/**
 * Логика AI-ассистента: stateless-цикл tool-use.
 *
 * Диалог хранится на клиенте и присылается целиком в каждом запросе. Сервер:
 *  1) прогоняет историю через модель с доступными инструментами;
 *  2) READ-инструменты выполняет сразу и возвращает результат модели (цикл);
 *  3) на первый же WRITE-инструмент ОСТАНАВЛИВАЕТСЯ и возвращает превью действия
 *     для подтверждения пользователем (ничего не меняя в БД);
 *  4) когда клиент присылает confirm — выполняет подтверждённое действие и даёт
 *     модели сформулировать итог.
 *
 * appRouter импортируется ЛЕНИВО (внутри функции), т.к. модуль ai-assistant сам
 * входит в appRouter — статический import создал бы цикл.
 */
import type { Context } from '../../trpc/context';
import { callLlm, type LlmContentPart, type LlmMessage } from './llm';
import { loadLlmRuntimeConfig } from './config';
import { getTool, isWriteTool, toolDefsForRole, type ToolRunCtx } from './tools';
import { redactClientPii } from './redact';
import { processAttachment, type IncomingAttachment } from './extract';

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface PendingAction {
  tool: string;
  args: Record<string, unknown>;
  preview: string;
}

export type AssistantResult =
  | { kind: 'message'; text: string }
  | { kind: 'confirm'; text: string | null; pendingAction: PendingAction };

const MAX_STEPS = 6;

const SYSTEM_PROMPT = `Ты — встроенный помощник CRM сервисного центра медтехники «Эрфольг».
Помогаешь сотруднику работать с заявками, клиентами, техникой, инженерами и счетами. Отвечай на русском языке.

Правила:
- Прежде чем что-то создавать или изменять, найди нужные сущности через инструменты поиска и получи их реальные ID. НИКОГДА не выдумывай ID (UUID).
- Для операций записи (создание заявки/клиента/договора/техники/сотрудника, назначение инженера, смена статуса, планирование, смена владельца техники, счета) система сама покажет пользователю карточку подтверждения. Не спрашивай «вы уверены?» текстом — просто вызови нужный инструмент с корректными аргументами.
- Если данных не хватает (неизвестен клиент/инженер/техника) — сначала найди их поиском или уточни у пользователя.
- На вопросы о бизнесе («сколько собрали/заработали/потратили», «прибыль», «сколько в кассе», «какие заявки зависли», «сколько заявок за месяц») вызывай read-инструменты get_finance_summary, list_aged_tickets, get_tickets_stats — это чтение, оно выполняется сразу без подтверждения. В ответе указывай период и откуда взялась цифра. Суммы возвращаются в копейках — переводи в рубли.
- Ты действуешь от имени текущего сотрудника; его права (роль) соблюдаются автоматически. Если операция запрещена — честно сообщи об этом.
- Отвечай кратко и по делу. Даты показывай в формате ДД.ММ.ГГГГ, суммы — в рублях.

Работа с документами:
- К сообщению пользователь может приложить документы. Текст PDF/Word добавляется в сообщение блоком «[Документ «…»]», изображения и сканы ты видишь сам.
- Из договора/реквизитов извлекай: название организации, ИНН, КПП, ОГРН, юр. адрес, телефон, email (или ФИО/телефон/адрес физлица), номер и дату договора, перечень оборудования (модель, производитель, серийный номер).
- Прежде чем заводить клиента — проверь поиском (по ИНН или названию), нет ли его уже. Если нашёл — используй существующий. Затем предложи завести договор (create_contract) и технику (create_asset) для этого клиента.
- Если данных для обязательных полей не хватает или документ нечитаемый — честно скажи, чего не хватает, и спроси.`;

function buildBaseMessages(history: ChatTurn[]): LlmMessage[] {
  const msgs: LlmMessage[] = [{ role: 'system', content: SYSTEM_PROMPT }];
  for (const t of history) msgs.push({ role: t.role, content: t.content });
  return msgs;
}

/**
 * Разбирает вложения и «вклеивает» их в ПОСЛЕДНЕЕ сообщение пользователя:
 *  - текст PDF/Word/txt — дописывается блоком в текстовую часть;
 *  - изображения — добавляются как image_url (их читает vision-модель);
 *  - нечитаемые — помечаются краткой пометкой.
 * Если картинок нет — content остаётся строкой (совместимо с любой моделью).
 */
async function attachToLastUserMessage(
  messages: LlmMessage[],
  attachments: IncomingAttachment[],
): Promise<void> {
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) return;

  const processed = await Promise.all(attachments.map(processAttachment));
  const textBlocks: string[] = [];
  const imageParts: LlmContentPart[] = [];

  for (const p of processed) {
    if (p.kind === 'text') {
      textBlocks.push(`\n\n[Документ «${p.name}»]\n${p.text}`);
    } else if (p.kind === 'image') {
      imageParts.push({ type: 'image_url', image_url: { url: p.imageDataUrl } });
      textBlocks.push(`\n\n[Изображение «${p.name}» — прочитай его содержимое]`);
    } else {
      textBlocks.push(`\n\n[Файл «${p.name}»: ${p.note}]`);
    }
  }

  const baseText = typeof lastUser.content === 'string' ? lastUser.content : '';
  const combinedText = `${baseText}${textBlocks.join('')}`;

  if (imageParts.length > 0) {
    lastUser.content = [{ type: 'text', text: combinedText }, ...imageParts];
  } else {
    lastUser.content = combinedText;
  }
}

function safeParseArgs(json: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(json);
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export async function runAssistant(
  ctx: Context,
  history: ChatTurn[],
  confirm?: { tool: string; args: Record<string, unknown> },
  attachments?: IncomingAttachment[],
): Promise<AssistantResult> {
  if (!ctx.tenant) {
    throw new Error('Нет контекста организации (требуется вход).');
  }
  if (!ctx.session) {
    throw new Error('Требуется вход.');
  }
  const llmCfg = await loadLlmRuntimeConfig(ctx.db, ctx.tenant);
  if (!llmCfg) {
    throw new Error(
      'AI-ассистент не настроен: задайте ключ и модель в Настройках → ИИ-ассистент (или переменные LLM_* на сервере).',
    );
  }

  // Ленивый импорт — разрыв цикла ai-assistant ↔ appRouter.
  const { appRouter } = await import('../../trpc/router');
  const caller = appRouter.createCaller(ctx);

  // Контекст для read-инструментов «спроси у системы» (прямой доступ к db+tenant).
  // role нужен для RBAC-гейта staff-only инструментов (финансы/заявки с ПДн),
  // которые обходят tRPC-caller и потому теряли бы проверку staffProcedure.
  const role = ctx.session.role;
  const toolCtx: ToolRunCtx = { db: ctx.db, tenant: ctx.tenant, role };

  // Инженеру не показываем staff-only инструменты — модель их даже не предложит.
  const toolDefs = toolDefsForRole(role);

  const messages = buildBaseMessages(history);

  // Вложения относятся к последнему ходу пользователя (приходят только с обычным
  // send, не с confirm). Разбираем и вклеиваем перед прогоном через модель.
  if (attachments?.length) {
    await attachToLastUserMessage(messages, attachments);
  }

  // Подтверждённое write-действие: выполняем и даём модели сформулировать итог.
  if (confirm) {
    const tool = getTool(confirm.tool);
    if (!tool || tool.kind !== 'write') {
      throw new Error(`Неизвестное действие для подтверждения: ${confirm.tool}`);
    }
    let resultJson: string;
    try {
      const result = await tool.run(caller, confirm.args, toolCtx);
      // PII-1: тот же фильтр ПДн, что и на read-пути — write-результат тоже уходит в LLM.
      resultJson = JSON.stringify({ ok: true, result: redactClientPii(result) });
    } catch (err) {
      resultJson = JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: [
        {
          id: 'confirmed',
          type: 'function',
          function: { name: confirm.tool, arguments: JSON.stringify(confirm.args) },
        },
      ],
    });
    messages.push({
      role: 'tool',
      tool_call_id: 'confirmed',
      name: confirm.tool,
      content: resultJson,
    });
  }

  for (let step = 0; step < MAX_STEPS; step++) {
    const reply = await callLlm(messages, toolDefs, llmCfg);

    if (reply.toolCalls.length === 0) {
      return { kind: 'message', text: reply.content ?? '' };
    }

    // Фиксируем ход ассистента с tool_calls в истории.
    messages.push({
      role: 'assistant',
      content: reply.content,
      tool_calls: reply.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.argumentsJson },
      })),
    });

    // Первый WRITE-вызов → стоп и запрос подтверждения.
    const writeCall = reply.toolCalls.find((tc) => isWriteTool(tc.name));
    if (writeCall) {
      const tool = getTool(writeCall.name);
      const args = safeParseArgs(writeCall.argumentsJson);
      return {
        kind: 'confirm',
        text: reply.content,
        pendingAction: {
          tool: writeCall.name,
          args,
          preview: tool?.preview
            ? tool.preview(args)
            : `${writeCall.name}(${JSON.stringify(args)})`,
        },
      };
    }

    // Все вызовы READ — выполняем и отдаём результаты модели.
    for (const tc of reply.toolCalls) {
      const tool = getTool(tc.name);
      const args = safeParseArgs(tc.argumentsJson);
      let content: string;
      if (!tool) {
        content = JSON.stringify({ error: `Неизвестный инструмент: ${tc.name}` });
      } else {
        try {
          // PII-1: имя/контакты клиента из БД НЕ уходят во внешний LLM (z.ai/КНР).
          content = JSON.stringify(redactClientPii(await tool.run(caller, args, toolCtx)));
        } catch (err) {
          content = JSON.stringify({
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      messages.push({ role: 'tool', tool_call_id: tc.id, name: tc.name, content });
    }
  }

  return {
    kind: 'message',
    text: 'Не удалось завершить задачу за отведённое число шагов. Уточните запрос.',
  };
}
