/**
 * Настройки ИИ не врут о том, что применено.
 *
 * ЧТО СЛУЧИЛОСЬ У ВЛАДЕЛЬЦА (2026-08-08, на боевой CRM). Он переключал режим
 * ассистента и жал «Проверить связь» — и раз за разом получал «AI-ассистент не
 * настроен». Строка в базе при этом не менялась СОРОК ТРИ МИНУТЫ: `enabled`
 * так и оставался `false`.
 *
 * Причина не в нём. Карточки режима — крупные кнопки, которые при нажатии
 * подсвечиваются рамкой, то есть выглядят как применённые. Но они меняют
 * только состояние экрана: на сервер ничего не уходит, пока не нажать
 * «Сохранить». А «Проверить связь» спрашивает СОХРАНЁННЫЙ конфиг (сервер
 * читает его из базы) — то есть проверяет не то, что человек видит перед
 * собой, и молчит об этом. Замкнутый круг: переключил → проверил → «не
 * настроен» → переключил ещё раз.
 *
 * Поэтому здесь проверяется ровно две вещи:
 *   1. видно, что есть несохранённые изменения;
 *   2. «Проверить связь» в этот момент НЕ ходит на сервер, а говорит сначала
 *      сохранить — иначе ответ относится к другим настройкам.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { AiSettingsPage } from '../pages/AiSettingsPage';

/** Конфиг как на бою: ключ сохранён, но ассистент выключен. */
const SAVED_CONFIG = {
  enabled: false,
  apiStyle: 'anthropic' as const,
  baseUrl: 'https://api.z.ai/api/anthropic',
  model: 'glm-4.6',
  hasApiKey: true,
  customInstructions: null,
  mode: 'read_only' as const,
  usingEnvFallback: false,
  updatedAt: new Date('2026-08-08T00:13:27Z'),
};

function renderPage() {
  const calls: string[] = [];
  /**
   * Настоящий сервер после записи отдаёт НОВЫЕ значения (`setConfig` возвращает
   * свежий DTO). Заглушка, которая echo'ит старые, врёт: тогда «предупреждение
   * исчезло» происходит из-за таблички «Сохранено», а не потому, что правок
   * больше нет. Поймано живой проверкой в браузере.
   */
  let current: typeof SAVED_CONFIG = { ...SAVED_CONFIG };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const fetchImpl = vi.fn((url: unknown): Promise<Response> => {
    const address = String(url);
    calls.push(address);
    const answer = (payload: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify({ result: { data: { json: payload } } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    if (address.includes('getConfig')) return answer(current);
    if (address.includes('setConfig')) {
      current = { ...current, enabled: true, mode: 'full' as never };
      return answer(current);
    }
    if (address.includes('testConfig')) return answer({ ok: true, model: 'glm-4.6', reply: 'да' });
    if (address.includes('status')) return answer({ configured: false });
    return answer(null);
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
  return { calls };
}

const testedServer = (calls: string[]) => calls.filter((c) => c.includes('testConfig')).length;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('несохранённые настройки ИИ видно', () => {
  it('переключил режим — экран говорит, что изменения не сохранены', async () => {
    renderPage();
    await screen.findByText(/Режим работы/);

    fireEvent.click(screen.getByRole('button', { name: /Полный/ }));

    expect(await screen.findByText(/не сохранен/i)).toBeTruthy();
  });

  it('пока не сохранено — «Проверить связь» не ходит на сервер и говорит почему', async () => {
    const { calls } = renderPage();
    await screen.findByText(/Режим работы/);

    fireEvent.click(screen.getByRole('button', { name: /Полный/ }));
    fireEvent.click(screen.getByRole('button', { name: /Проверить связь/ }));

    // Главное: ответ относился бы к ДРУГИМ настройкам — тем, что в базе.
    expect(await screen.findByText(/Сначала сохраните/i)).toBeTruthy();
    expect(testedServer(calls)).toBe(0);
  });

  it('без правок проверка связи работает как раньше', async () => {
    const { calls } = renderPage();
    await screen.findByText(/Режим работы/);

    fireEvent.click(screen.getByRole('button', { name: /Проверить связь/ }));

    await waitFor(() => expect(testedServer(calls)).toBe(1));
  });

  it('сохранил — предупреждение ушло и проверка снова ходит на сервер', async () => {
    const { calls } = renderPage();
    await screen.findByText(/Режим работы/);
    fireEvent.click(screen.getByRole('button', { name: /Полный/ }));
    await screen.findByText(/не сохранен/i);

    fireEvent.click(screen.getByRole('button', { name: /^Сохранить$/ }));
    await waitFor(() => expect(screen.queryByText(/не сохранен/i)).toBeNull());

    // Проверять надо не только исчезновение таблички: она скрыта и пока висит
    // зелёное «Сохранено». Настоящий признак — что проверка снова РАБОТАЕТ.
    fireEvent.click(screen.getByRole('button', { name: /Проверить связь/ }));
    await waitFor(() => expect(testedServer(calls)).toBe(1));
    expect(screen.queryByText(/Сначала сохраните/i)).toBeNull();
  });
});
