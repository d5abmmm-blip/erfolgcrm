/**
 * Юнит-тест env-fallback конфигурации LLM (llmConfigFromEnv) — без БД.
 * Проверяет разбор LLM_*, нормализацию протокола и обрезку хвостовых слэшей.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  llmConfigFromEnv,
  resolveRuntimeConfig,
  type LlmConfigRow,
} from '../modules/ai-assistant/config';
import type { LlmRuntimeConfig } from '../modules/ai-assistant/llm';

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

describe('resolveRuntimeConfig — приоритет явного выключения над env-фолбэком', () => {
  const envCfg: LlmRuntimeConfig = {
    apiStyle: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic',
    apiKey: 'env-secret',
    model: 'glm-4.6',
  };
  const fullRow = (over: Partial<LlmConfigRow> = {}): LlmConfigRow => ({
    enabled: true,
    apiStyle: 'openai',
    baseUrl: 'https://db-base/v1',
    model: 'db-model',
    customInstructions: 'регламент СЦ',
    assistantMode: 'read_only',
    apiKey: 'db-secret',
    ...over,
  });

  it('строка enabled=false + env задан → null (ассистент реально выключен, env не поднимается)', () => {
    const row = fullRow({ enabled: false });
    expect(resolveRuntimeConfig(row, envCfg)).toBeNull();
  });

  it('строки в БД нет + env задан → конфиг из env (первичная настройка прода)', () => {
    expect(resolveRuntimeConfig(null, envCfg)).toEqual(envCfg);
  });

  it('строка enabled=true и полная → конфиг из БД с mode и инструкцией', () => {
    const cfg = resolveRuntimeConfig(fullRow(), envCfg);
    expect(cfg).toMatchObject({
      apiStyle: 'openai',
      baseUrl: 'https://db-base/v1',
      apiKey: 'db-secret',
      model: 'db-model',
      customInstructions: 'регламент СЦ',
      mode: 'read_only',
    });
  });

  it('строка enabled=true, но без ключа (ключ в env) → env-конфиг с наложенными mode/инструкцией из БД', () => {
    const row = fullRow({ apiKey: null });
    const cfg = resolveRuntimeConfig(row, envCfg);
    // ключ/база/модель — из env, а режим и памятка — из БД (read_only не деградирует в full)
    expect(cfg).toEqual({
      ...envCfg,
      customInstructions: 'регламент СЦ',
      mode: 'read_only',
    });
  });

  it('строка enabled=false + env НЕ задан → null', () => {
    expect(resolveRuntimeConfig(fullRow({ enabled: false }), null)).toBeNull();
  });

  it('строки нет + env НЕ задан → null (ассистент нигде не настроен)', () => {
    expect(resolveRuntimeConfig(null, null)).toBeNull();
  });
});
