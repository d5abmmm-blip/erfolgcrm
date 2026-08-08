/**
 * Выбор ИИ-провайдера и модели списком, а не руками.
 *
 * ЗАПРОС ВЛАДЕЛЬЦА 2026-08-08: «сделай выбор с выпадающим меню из разных ИИ,
 * чтобы я мог подключать разные модели».
 *
 * ЧТО БЫЛО. Два поля свободного ввода — «Базовый URL» и «Модель» — и один
 * переключатель «Тип API» на два значения. Правильную пару надо было знать
 * наизусть, и ошибиться было проще, чем попасть: владелец вписал адрес
 * OpenRouter при типе Anthropic, и запрос ушёл на `…/api/v1/v1/messages`
 * (404). А слаг `z-ai/glm-4.6` — это формат OpenRouter, у самого z.ai модель
 * называется `glm-4.6`; перепутать их не стоило почти ничего.
 *
 * ЧТО ДОЛЖНО БЫТЬ. Выбрал провайдера — адрес и тип API подставились сами;
 * модель выбирается из списка того же провайдера. Свободный ввод никуда не
 * делся: «Своё подключение» оставляет оба поля пустыми и ручными, иначе
 * нельзя будет подключить то, чего нет в списке.
 *
 * ОТДЕЛЬНО ВАЖНО: уже сохранённая настройка не должна затираться при
 * открытии страницы — если адрес не из списка, показываем «Своё подключение»
 * с теми значениями, что есть.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { AiSettingsPage } from '../pages/AiSettingsPage';
import { AI_PROVIDERS, providerByBaseUrl } from '../lib/ai-providers';

function config(over: Partial<Record<string, unknown>> = {}) {
  return {
    enabled: true,
    apiStyle: 'anthropic' as const,
    baseUrl: 'https://api.z.ai/api/anthropic',
    model: 'glm-4.6',
    hasApiKey: true,
    customInstructions: null,
    mode: 'full' as const,
    usingEnvFallback: false,
    updatedAt: new Date('2026-08-08T00:13:27Z'),
    ...over,
  };
}

function renderPage(saved = config()) {
  const sent: unknown[] = [];
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const fetchImpl = vi.fn(async (url: unknown, init?: RequestInit): Promise<Response> => {
    const address = String(url);
    if (address.includes('setConfig') && init?.body) sent.push(JSON.parse(String(init.body)));
    const payload = address.includes('testConfig')
      ? { ok: true, model: saved.model, reply: 'да' }
      : saved;
    return new Response(JSON.stringify({ result: { data: { json: payload } } }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const client = trpc.createClient({
    links: [
      httpLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: fetchImpl,
      }),
    ],
  });
  render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AiSettingsPage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
  return { sent };
}

const providerSelect = () => screen.getByLabelText<HTMLSelectElement>('Провайдер');
const modelSelect = () => screen.getByLabelText<HTMLSelectElement>('Модель');
const addressField = () => screen.getByLabelText<HTMLInputElement>('Базовый URL');

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('провайдер выбирается списком', () => {
  it('в списке есть и заблокированные, и рабочие — с подписью', async () => {
    renderPage();
    await screen.findByText(/Провайдер и модель/);

    const labels = [...providerSelect().options].map((o) => o.textContent ?? '');
    expect(labels.some((l) => /z\.ai/i.test(l))).toBe(true);
    expect(labels.some((l) => /openrouter/i.test(l))).toBe(true);
    expect(labels.some((l) => /Своё подключение/i.test(l))).toBe(true);
  });

  it('выбрал провайдера — адрес и тип API подставились сами', async () => {
    renderPage();
    await screen.findByText(/Провайдер и модель/);

    fireEvent.change(providerSelect(), { target: { value: 'deepseek' } });

    const deepseek = AI_PROVIDERS.find((p) => p.id === 'deepseek')!;
    await waitFor(() => expect(addressField().value).toBe(deepseek.baseUrl));
    expect(modelSelect().value).toBe(deepseek.models[0]);
  });

  it('модель выбирается из списка своего провайдера', async () => {
    renderPage();
    await screen.findByText(/Провайдер и модель/);

    fireEvent.change(providerSelect(), { target: { value: 'openrouter' } });

    const openrouter = AI_PROVIDERS.find((p) => p.id === 'openrouter')!;
    await waitFor(() => {
      const values = [...modelSelect().options].map((o) => o.value);
      for (const m of openrouter.models) expect(values).toContain(m);
    });
  });

  it('«Своё подключение» оставляет адрес и модель ручными', async () => {
    renderPage();
    await screen.findByText(/Провайдер и модель/);

    fireEvent.change(providerSelect(), { target: { value: 'custom' } });
    fireEvent.change(addressField(), { target: { value: 'https://свой.сервер/v1' } });

    expect(addressField().value).toBe('https://свой.сервер/v1');
    // У «своего» модель тоже вписывается руками — списка моделей у него нет.
    expect(screen.getByLabelText<HTMLInputElement>('Модель').tagName).toBe('INPUT');
  });
});

describe('уже сохранённое не теряется', () => {
  it('известный адрес — провайдер выбран сам', async () => {
    renderPage(config({ baseUrl: 'https://api.z.ai/api/anthropic', model: 'glm-4.6' }));
    await screen.findByText(/Провайдер и модель/);

    await waitFor(() => expect(providerSelect().value).toBe('zai-anthropic'));
  });

  it('чужой адрес — «Своё подключение», значения на месте', async () => {
    renderPage(
      config({ baseUrl: 'https://llm.внутренний/v1', model: 'своя-модель', apiStyle: 'openai' }),
    );
    await screen.findByText(/Провайдер и модель/);

    await waitFor(() => expect(providerSelect().value).toBe('custom'));
    expect(addressField().value).toBe('https://llm.внутренний/v1');
    expect(screen.getByLabelText<HTMLInputElement>('Модель').value).toBe('своя-модель');
  });
});

describe('сопоставление адреса с провайдером', () => {
  it('узнаёт провайдера по адресу, не глядя на хвостовой слэш', () => {
    expect(providerByBaseUrl('https://api.z.ai/api/anthropic')?.id).toBe('zai-anthropic');
    expect(providerByBaseUrl('https://api.z.ai/api/anthropic/')?.id).toBe('zai-anthropic');
    expect(providerByBaseUrl('https://openrouter.ai/api/v1')?.id).toBe('openrouter');
  });

  it('незнакомый адрес — никакого провайдера, а не «первый попавшийся»', () => {
    expect(providerByBaseUrl('https://llm.внутренний/v1')).toBeUndefined();
    expect(providerByBaseUrl('')).toBeUndefined();
    expect(providerByBaseUrl(null)).toBeUndefined();
  });
});
