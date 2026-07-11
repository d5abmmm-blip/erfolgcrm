/**
 * LLM-адаптер для AI-ассистента CRM.
 *
 * Поддерживает ДВА протокола (выбор через LLM_API_STYLE):
 *   - 'openai' (по умолчанию): POST {base}/chat/completions, function-calling/tools.
 *     Подходят OpenRouter (DeepSeek/Qwen/GPT-*), Ollama/vLLM.
 *   - 'anthropic': POST {base}/v1/messages (Messages API). Нужен для z.ai GLM
 *     Coding Plan (баланс живёт на Anthropic-эндпоинте, а не на /paas/v4).
 *
 * Конфиг (apiStyle/baseUrl/apiKey/model) в код не зашит и в этот модуль НЕ читается
 * из env напрямую — он передаётся в callLlm. Источник (БД tenant'а из Настроек или
 * переменные LLM_* как fallback) определяет config.ts (loadLlmRuntimeConfig).
 *
 * Внутреннее представление сообщений — OpenAI-образное (LlmMessage с tool_calls /
 * role:'tool'). Для anthropic оно транслируется в Messages API в callAnthropic.
 */

export interface LlmFunctionTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LlmToolCall {
  id: string;
  name: string;
  /** Сырые аргументы — JSON-строка от модели (парсится вызывающей стороной). */
  argumentsJson: string;
}

/**
 * Часть мультимодального сообщения (OpenAI-совместимый формат). Текст или картинка.
 * Картинки понимают только vision-модели (Qwen-VL, Gemini, GPT-4o и т.п.).
 */
export type LlmContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** Строка, либо массив частей (текст + картинки) для мультимодальных запросов. */
  content: string | null | LlmContentPart[];
  tool_calls?: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export interface LlmReply {
  content: string | null;
  toolCalls: LlmToolCall[];
}

export type ApiStyle = 'openai' | 'anthropic';

/** Режим ассистента: полный (с действиями) или только чтение (смотрит и советует). */
export type AssistantMode = 'read_only' | 'full';

/**
 * Параметры одного вызова: таймаут и число попыток. Нужны, чтобы НЕинтерактивные
 * пути (сводки/отчёты через phraseWithLlm) не ждали до 60с×3≈3 мин при тормозящем
 * провайдере, а быстро деградировали на детерминированные данные. Интерактивный чат
 * оставляет дефолт (модель + tools могут думать дольше). См. OPS-2 (аудит 2026-07-06).
 */
export interface LlmCallOpts {
  /** Таймаут одного сетевого запроса, мс (по умолчанию LLM_TIMEOUT_MS = 60000). */
  timeoutMs?: number;
  /** Максимум попыток при сетевом сбое/429/5xx (по умолчанию MAX_ATTEMPTS = 3). */
  maxAttempts?: number;
}

/** Рабочий конфиг подключения к LLM. Загружается из БД/env (см. config.ts). */
export interface LlmRuntimeConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  apiStyle: ApiStyle;
  /** Доп. инструкция-памятка от директора (регламенты СЦ) для системного промпта. */
  customInstructions?: string | null;
  /** Режим работы: 'full' (действия по запросу) | 'read_only' (только смотрит/советует). */
  mode?: AssistantMode;
}

/**
 * Один вызов модели. Конфиг (ключ/база/модель/протокол) передаётся явно — источник
 * (БД tenant'а или env) определяет вызывающая сторона (config.loadLlmRuntimeConfig).
 * Возвращает текст ответа и/или запрошенные вызовы инструментов. Бросает понятную
 * ошибку при сетевом сбое / HTTP-ошибке провайдера.
 */
export async function callLlm(
  messages: LlmMessage[],
  tools: LlmFunctionTool[],
  cfg: LlmRuntimeConfig,
  opts?: LlmCallOpts,
): Promise<LlmReply> {
  return cfg.apiStyle === 'anthropic'
    ? callAnthropic(cfg, messages, tools, opts)
    : callOpenAi(cfg, messages, tools, opts);
}

/* ───────────────────────────── сеть с ретраями ───────────────────────────── */

/** Таймаут одного сетевого запроса к LLM (модель + tools могут думать). */
const LLM_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 3;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Вырезает секрет из текста — на случай, если провайдер/прокси отразил ключ в ответе. */
function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('[REDACTED]') : text;
}

/**
 * fetch с ретраями. Провайдеры (в т.ч. z.ai) периодически сбрасывают соединение
 * (ECONNRESET) или отдают 429/5xx — это перемежающиеся сбои, а не реальная ошибка
 * запроса. Повторяем до MAX_ATTEMPTS с экспоненциальным бэкоффом, чтобы пользователь
 * не видел «fetch failed» из-за единичного сетевого блипа. 4xx (кроме 429) — реальные
 * ошибки (авторизация, валидация), их НЕ повторяем.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts?: LlmCallOpts,
): Promise<Response> {
  const timeoutMs = opts?.timeoutMs ?? LLM_TIMEOUT_MS;
  const maxAttempts = Math.max(1, opts?.maxAttempts ?? MAX_ATTEMPTS);
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      const retryableStatus = res.status === 429 || res.status >= 500;
      if (retryableStatus && attempt < maxAttempts - 1) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts - 1) {
        await sleep(400 * 2 ** attempt);
        continue;
      }
    }
  }
  throw lastErr;
}

/* ───────────────────────────── OpenAI-совместимый ───────────────────────────── */

interface ChatCompletionResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{
        id?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  error?: { message?: string };
}

async function callOpenAi(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  tools: LlmFunctionTool[],
  opts?: LlmCallOpts,
): Promise<LlmReply> {
  let res: Response;
  try {
    res = await fetchWithRetry(
      `${cfg.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.apiKey}`,
          // OpenRouter рекомендует (необязательно) идентифицировать приложение.
          'X-Title': 'ErfolgCRM',
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          tools: tools.length ? tools : undefined,
          tool_choice: tools.length ? 'auto' : undefined,
          temperature: 0.2,
        }),
      },
      opts,
    );
  } catch (err) {
    throw new Error(
      `Не удалось связаться с LLM (${cfg.baseUrl}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM вернул ошибку HTTP ${res.status}: ${redactSecret(text.slice(0, 500), cfg.apiKey)}`);
  }

  const data = (await res.json()) as ChatCompletionResponse;
  if (data.error?.message) {
    throw new Error(`LLM: ${data.error.message}`);
  }

  const msg = data.choices?.[0]?.message;
  const toolCalls: LlmToolCall[] = (msg?.tool_calls ?? [])
    .filter((tc): tc is { id?: string; function: { name: string; arguments?: string } } =>
      Boolean(tc.function?.name),
    )
    .map((tc, i) => ({
      id: tc.id ?? `call_${i}`,
      name: tc.function.name,
      argumentsJson: tc.function.arguments ?? '{}',
    }));

  return { content: msg?.content ?? null, toolCalls };
}

/* ───────────────────────── Anthropic Messages API ───────────────────────── */

type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: AnthropicBlock[];
}

interface AnthropicResponse {
  content?: Array<{
    type: string;
    text?: string;
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
  }>;
  error?: { message?: string };
}

/** Парсит data:image/...;base64,XXXX → { media_type, data } (или null). */
function parseDataUrl(url: string): { media_type: string; data: string } | null {
  const m = /^data:([^;]+);base64,(.*)$/s.exec(url);
  return m ? { media_type: m[1]!, data: m[2]! } : null;
}

/** Контент пользовательского хода (строка или части text/image) → блоки Anthropic. */
function userContentToBlocks(content: string | LlmContentPart[]): AnthropicBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }];
  const blocks: AnthropicBlock[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      blocks.push({ type: 'text', text: part.text });
      continue;
    }
    const parsed = parseDataUrl(part.image_url.url);
    if (parsed) {
      blocks.push({
        type: 'image',
        source: { type: 'base64', media_type: parsed.media_type, data: parsed.data },
      });
    }
  }
  return blocks;
}

/**
 * Транслирует наше OpenAI-образное представление в Anthropic Messages API:
 *  - role:'system' → top-level `system`;
 *  - assistant.tool_calls → блоки tool_use;
 *  - role:'tool' → user-сообщение с блоком tool_result;
 *  - картинки (image_url data-URL) → блоки image/base64.
 * Соседние сообщения одной роли сливаются (Anthropic ждёт чередования ролей).
 */
export function toAnthropic(
  messages: LlmMessage[],
  tools: LlmFunctionTool[],
): { system: string; messages: AnthropicMessage[]; tools: Array<{ name: string; description: string; input_schema: Record<string, unknown> }> } {
  const systemParts: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };

  for (const m of messages) {
    if (m.role === 'system') {
      if (typeof m.content === 'string') systemParts.push(m.content);
      continue;
    }
    if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.tool_call_id ?? '',
          content: typeof m.content === 'string' ? m.content : '',
        },
      ]);
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (typeof m.content === 'string' && m.content.trim()) {
        blocks.push({ type: 'text', text: m.content });
      }
      for (const tc of m.tool_calls ?? []) {
        let input: Record<string, unknown> = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}') as Record<string, unknown>;
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
      if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
      push('assistant', blocks);
      continue;
    }
    // role === 'user'
    const blocks = m.content == null ? [] : userContentToBlocks(m.content);
    if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
    push('user', blocks);
  }

  const anthropicTools = tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));

  return { system: systemParts.join('\n\n'), messages: out, tools: anthropicTools };
}

async function callAnthropic(
  cfg: LlmRuntimeConfig,
  messages: LlmMessage[],
  tools: LlmFunctionTool[],
  opts?: LlmCallOpts,
): Promise<LlmReply> {
  const { system, messages: amsgs, tools: atools } = toAnthropic(messages, tools);
  // base уже без хвостовых слэшей; путь Messages API — /v1/messages.
  const url = cfg.baseUrl.endsWith('/v1') ? `${cfg.baseUrl}/messages` : `${cfg.baseUrl}/v1/messages`;

  let res: Response;
  try {
    res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: cfg.model,
          max_tokens: 2048,
          temperature: 0.2,
          system: system || undefined,
          messages: amsgs,
          tools: atools.length ? atools : undefined,
        }),
      },
      opts,
    );
  } catch (err) {
    throw new Error(
      `Не удалось связаться с LLM (${url}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM вернул ошибку HTTP ${res.status}: ${redactSecret(text.slice(0, 500), cfg.apiKey)}`);
  }

  const data = (await res.json()) as AnthropicResponse;
  if (data.error?.message) {
    throw new Error(`LLM: ${data.error.message}`);
  }

  const textParts: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  for (const b of data.content ?? []) {
    if (b.type === 'text' && b.text) {
      textParts.push(b.text);
    } else if (b.type === 'tool_use' && b.name) {
      toolCalls.push({
        id: b.id ?? `call_${toolCalls.length}`,
        name: b.name,
        argumentsJson: JSON.stringify(b.input ?? {}),
      });
    }
  }

  return { content: textParts.length ? textParts.join('\n') : null, toolCalls };
}
