/**
 * Юнит-тесты транслятора OpenAI-образных сообщений → Anthropic Messages API
 * (toAnthropic в llm.ts). Без сети — проверяем только форму запроса.
 */
import { describe, it, expect } from 'vitest';
import { toAnthropic } from '../modules/ai-assistant/llm';
import type { LlmFunctionTool, LlmMessage } from '../modules/ai-assistant/llm';

const tool: LlmFunctionTool = {
  type: 'function',
  function: {
    name: 'search_clients',
    description: 'Найти клиента',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
};

describe('toAnthropic', () => {
  it('system выносит в отдельное поле, а не в messages', () => {
    const { system, messages } = toAnthropic(
      [
        { role: 'system', content: 'Ты помощник' },
        { role: 'user', content: 'привет' },
      ],
      [],
    );
    expect(system).toBe('Ты помощник');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'user', content: [{ type: 'text', text: 'привет' }] });
  });

  it('конвертирует tool-определения в input_schema', () => {
    const { tools } = toAnthropic([{ role: 'user', content: 'x' }], [tool]);
    expect(tools[0]).toMatchObject({
      name: 'search_clients',
      input_schema: { type: 'object', properties: { q: { type: 'string' } } },
    });
  });

  it('assistant.tool_calls → блок tool_use, а role:tool → user tool_result', () => {
    const history: LlmMessage[] = [
      { role: 'user', content: 'найди клиента' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'search_clients', arguments: '{"q":"Ромашка"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', name: 'search_clients', content: '[{"id":"u1"}]' },
    ];
    const { messages } = toAnthropic(history, [tool]);
    // user(найди) | assistant(tool_use) | user(tool_result)
    expect(messages).toHaveLength(3);
    expect(messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'c1', name: 'search_clients', input: { q: 'Ромашка' } }],
    });
    expect(messages[2]).toMatchObject({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'c1', content: '[{"id":"u1"}]' }],
    });
  });

  it('картинку (image_url data-URL) превращает в блок image/base64', () => {
    const msg: LlmMessage = {
      role: 'user',
      content: [
        { type: 'text', text: 'что на фото?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,QUJD' } },
      ],
    };
    const { messages } = toAnthropic([msg], []);
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'что на фото?' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    ]);
  });

  it('сливает соседние сообщения одной роли (Anthropic ждёт чередования)', () => {
    const { messages } = toAnthropic(
      [
        { role: 'user', content: 'первое' },
        { role: 'user', content: 'второе' },
      ],
      [],
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.content).toEqual([
      { type: 'text', text: 'первое' },
      { type: 'text', text: 'второе' },
    ]);
  });
});
