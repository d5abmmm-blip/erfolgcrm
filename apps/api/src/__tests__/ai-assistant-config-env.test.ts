/**
 * Юнит-тест env-fallback конфигурации LLM (llmConfigFromEnv) — без БД.
 * Проверяет разбор LLM_*, нормализацию протокола и обрезку хвостовых слэшей.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { llmConfigFromEnv } from '../modules/ai-assistant/config';

const KEYS = ['LLM_API_STYLE', 'LLM_BASE_URL', 'LLM_API_KEY', 'LLM_MODEL'] as const;
const clear = () => KEYS.forEach((k) => delete process.env[k]);

afterEach(clear);

describe('llmConfigFromEnv', () => {
  it('собирает конфиг из env и обрезает хвостовой слэш', () => {
    process.env.LLM_API_STYLE = 'anthropic';
    process.env.LLM_BASE_URL = 'https://api.z.ai/api/anthropic/';
    process.env.LLM_API_KEY = 'secret';
    process.env.LLM_MODEL = 'glm-4.6';
    expect(llmConfigFromEnv()).toEqual({
      apiStyle: 'anthropic',
      baseUrl: 'https://api.z.ai/api/anthropic',
      apiKey: 'secret',
      model: 'glm-4.6',
    });
  });

  it('по умолчанию протокол openai (обратная совместимость)', () => {
    process.env.LLM_BASE_URL = 'https://openrouter.ai/api/v1';
    process.env.LLM_API_KEY = 'k';
    process.env.LLM_MODEL = 'deepseek/deepseek-chat';
    expect(llmConfigFromEnv()?.apiStyle).toBe('openai');
  });

  it('возвращает null, если не заданы все обязательные переменные', () => {
    process.env.LLM_BASE_URL = 'https://x';
    process.env.LLM_API_KEY = 'k';
    // нет LLM_MODEL
    expect(llmConfigFromEnv()).toBeNull();
  });
});
