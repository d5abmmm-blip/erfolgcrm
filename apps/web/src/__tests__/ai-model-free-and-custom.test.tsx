/**
 * Список моделей не запирает человека.
 *
 * ДВЕ МОИ НЕДОРАБОТКИ ИЗ ПРЕДЫДУЩЕГО PR (#116), обе вылезли у владельца сразу:
 *
 * 1. Список моделей z.ai устарел на глазах. Я зашил `glm-4.6 / 4.5 / 4.5-air`,
 *    а у провайдера уже вышли 4.7 и 5.x — в том числе **GLM-4.7-Flash,
 *    который бесплатный**. Владелец смотрел на их сайт и не находил в CRM
 *    ничего из увиденного.
 * 2. «Модель» стала жёстким списком — вписать своё стало НЕЛЬЗЯ, не
 *    переключившись на «Своё подключение», а оно чистит и адрес. То есть
 *    выпадающий список, задуманный как помощь, отнял возможность.
 *
 * Провайдеры выпускают модели чаще, чем мы деплоим. Поэтому в списке всегда
 * есть «Другая модель (вписать)» — она превращает поле во ввод и оставляет
 * адрес провайдера на месте.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { AiSettingsPage } from '../pages/AiSettingsPage';
import { AI_PROVIDERS, OTHER_MODEL } from '../lib/ai-providers';

const SAVED = {
  enabled: true,
  apiStyle: 'anthropic' as const,
  baseUrl: 'https://api.z.ai/api/anthropic',
  model: 'glm-4.7-flash',
  hasApiKey: true,
  customInstructions: null,
  mode: 'full' as const,
  usingEnvFallback: false,
  updatedAt: new Date('2026-08-08T02:07:14Z'),
};

function renderPage(saved = SAVED) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: vi.fn(
          async () =>
            new Response(JSON.stringify({ result: { data: { json: saved } } }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
        ),
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
}

const field = (label: string) => screen.getByLabelText<HTMLSelectElement & HTMLInputElement>(label);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('список моделей z.ai не отстаёт от провайдера', () => {
  it('бесплатная GLM-4.7-Flash есть и стоит первой', () => {
    const zai = AI_PROVIDERS.find((p) => p.id === 'zai-anthropic')!;
    expect(zai.models[0]).toBe('glm-4.7-flash');
    // Дешёвое и бесплатное — раньше в списке, дорогое — ниже: у владельца
    // «10 долларов на пробу», и флагман за $4.4 ему тут не нужен.
    expect(zai.models).toContain('glm-4.7');
    expect(zai.models).toContain('glm-4.6');
  });

  it('подпись провайдера называет бесплатную модель — иначе её не заметят', () => {
    const zai = AI_PROVIDERS.find((p) => p.id === 'zai-anthropic')!;
    expect(zai.hint).toMatch(/бесплатн/i);
  });
});

describe('«Другая модель» — можно вписать что угодно', () => {
  it('в списке моделей есть пункт «Другая»', async () => {
    renderPage();
    await screen.findByText(/Провайдер и модель/);

    const values = [...field('Модель').options].map((o) => o.value);
    expect(values).toContain(OTHER_MODEL);
  });

  it('выбрал «Другая» — поле стало вводом, адрес провайдера остался', async () => {
    renderPage();
    await screen.findByText(/Провайдер и модель/);

    fireEvent.change(field('Модель'), { target: { value: OTHER_MODEL } });

    await waitFor(() => expect(field('Модель').tagName).toBe('INPUT'));
    // Главное: не потеряли провайдера. Раньше вписать модель можно было
    // только через «Своё подключение», а оно стирало адрес.
    expect(field('Базовый URL').value).toBe('https://api.z.ai/api/anthropic');
    expect(field('Провайдер').value).toBe('zai-anthropic');
  });

  it('вписанное сохраняется как модель', async () => {
    renderPage();
    await screen.findByText(/Провайдер и модель/);
    fireEvent.change(field('Модель'), { target: { value: OTHER_MODEL } });
    await waitFor(() => expect(field('Модель').tagName).toBe('INPUT'));

    fireEvent.change(field('Модель'), { target: { value: 'glm-9-будущая' } });

    expect(field('Модель').value).toBe('glm-9-будущая');
  });

  it('сохранённая модель, которой нет в списке, показывается как есть', async () => {
    renderPage({ ...SAVED, model: 'glm-невиданная' });
    await screen.findByText(/Провайдер и модель/);

    // Не подменяем на «первую из списка» — это молча испортило бы настройку.
    await waitFor(() => expect(field('Модель').value).toBe('glm-невиданная'));
  });
});
