/**
 * LLM-адаптер для AI-ассистента CRM.
 *
 * Провайдеро-НЕЗАВИСИМЫЙ: общается по OpenAI-совместимому протоколу
 * (POST {base}/chat/completions с function-calling / tools). Подходят OpenRouter
 * (DeepSeek / Qwen / GPT-* и др.), локальные Ollama / vLLM. Модель в код не зашита —
 * задаётся через env:
 *   LLM_BASE_URL  — напр. https://openrouter.ai/api/v1
 *   LLM_API_KEY   — ключ провайдера (пользователь добавляет сам)
 *   LLM_MODEL     — напр. deepseek/deepseek-chat
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

interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** true, если заданы все обязательные переменные LLM_*. */
export function llmConfigured(): boolean {
  return Boolean(
    process.env.LLM_BASE_URL?.trim() &&
      process.env.LLM_API_KEY?.trim() &&
      process.env.LLM_MODEL?.trim(),
  );
}

function getConfig(): LlmConfig {
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  const apiKey = process.env.LLM_API_KEY?.trim();
  const model = process.env.LLM_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) {
    throw new Error(
      'AI-ассистент не настроен: задайте LLM_BASE_URL, LLM_API_KEY и LLM_MODEL в .env и перезапустите API.',
    );
  }
  // Убираем хвостовые слэши, чтобы корректно склеить с /chat/completions.
  return { baseUrl: baseUrl.replace(/\/+$/, ''), apiKey, model };
}

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

/**
 * Один вызов модели. Возвращает текст ответа и/или запрошенные вызовы инструментов.
 * Бросает понятную ошибку при сетевом сбое / HTTP-ошибке провайдера.
 */
export async function callLlm(
  messages: LlmMessage[],
  tools: LlmFunctionTool[],
): Promise<LlmReply> {
  const cfg = getConfig();

  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
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
    });
  } catch (err) {
    throw new Error(
      `Не удалось связаться с LLM (${cfg.baseUrl}): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`LLM вернул ошибку HTTP ${res.status}: ${text.slice(0, 500)}`);
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
