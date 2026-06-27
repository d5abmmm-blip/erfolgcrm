/**
 * Тест устойчивости LLM-вызова к перемежающимся сетевым сбоям (ECONNRESET и т.п.).
 * Мокаем global.fetch; проверяем, что callLlm повторяет запрос и в итоге успешен,
 * а реальные 4xx-ошибки не ретраит.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { callLlm, type LlmRuntimeConfig } from '../modules/ai-assistant/llm';

const CFG: LlmRuntimeConfig = {
  apiStyle: 'anthropic',
  baseUrl: 'https://example.test/api/anthropic',
  apiKey: 'test-key',
  model: 'glm-4.6',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('callLlm — ретраи', () => {
  it('повторяет при сетевом сбое и в итоге отдаёт результат', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        if (calls < 3) throw new Error('fetch failed'); // имитация ECONNRESET
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: [{ type: 'text', text: 'готово' }] }),
        } as unknown as Response;
      }),
    );

    const r = await callLlm([{ role: 'user', content: 'привет' }], [], CFG);
    expect(calls).toBe(3);
    expect(r.content).toBe('готово');
  });

  it('не повторяет 4xx (реальная ошибка запроса)', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        return { ok: false, status: 400, text: async () => 'bad request' } as unknown as Response;
      }),
    );

    await expect(callLlm([{ role: 'user', content: 'привет' }], [], CFG)).rejects.toThrow(/400/);
    expect(calls).toBe(1);
  });

  it('сдаётся после исчерпания попыток и бросает понятную ошибку', async () => {
    let calls = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls++;
        throw new Error('fetch failed');
      }),
    );

    await expect(callLlm([{ role: 'user', content: 'привет' }], [], CFG)).rejects.toThrow(
      /Не удалось связаться с LLM/,
    );
    expect(calls).toBe(3);
  });
});
