/**
 * Экраны не врут, когда нет связи.
 *
 * ГОЧА, из-за которой это вообще возможно: при потере связи react-query НЕ
 * роняет запрос с ошибкой, а СТАВИТ ЕГО НА ПАУЗУ. `error` остаётся пустым
 * навсегда, и экран, который смотрит только на `error`, ведёт себя ровно так,
 * как при пустом ответе:
 *
 *   склад        → «Ничего не найдено» (а на складе всё на месте);
 *   журнал работ → «Заявка не найдена» (а заявка есть).
 *
 * Инженер в подвале верит экрану и идёт разбираться с несуществующей бедой.
 * Правильный образец давно есть в очереди и карточке заявки — там ветка
 * привязана к `fetchStatus === 'paused'`, а не к `error`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { type ReactElement } from 'react';
import { trpc } from '../lib/trpc';
import { MobileInventoryPage } from '../pages/mobile/MobileInventoryPage';
import { MobileWorkLogPage } from '../pages/mobile/MobileWorkLogPage';

/** Связи нет: запросы не падают, а замирают — как в реальном офлайне. */
function renderOffline(ui: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: () => new Promise(() => undefined), // ответа не будет никогда
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
});

afterEach(() => {
  cleanup();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
});

describe('склад без связи', () => {
  it('говорит про связь, а не «Ничего не найдено»', async () => {
    renderOffline(<MobileInventoryPage />);

    expect(await screen.findByText('Не удалось загрузить остатки склада')).toBeTruthy();
    expect(screen.queryByText('Ничего не найдено')).toBeNull();
  });
});

describe('журнал работ без связи', () => {
  it('говорит про связь, а не «Заявка не найдена»', async () => {
    window.history.pushState({}, '', '/m/tickets/ffffffff-0000-4000-8000-000000000001/work-log');

    renderOffline(<MobileWorkLogPage />);

    expect(await screen.findByText('Не удалось загрузить заявку')).toBeTruthy();
    expect(screen.queryByText('Заявка не найдена')).toBeNull();
  });
});

/**
 * Профиль. В аудите он назван «пустым белым экраном», но добраться до этого
 * состояния в приложении нельзя: App.tsx рисует мобильную оболочку только
 * когда сессия уже есть, а профиль читает ту же самую сессию из кэша.
 * Это защита от белого экрана, а не починка живой беды — но `return null`
 * в любом случае худшее, что можно показать человеку.
 */
describe('профиль без сессии', () => {
  it('не оставляет белый экран', async () => {
    const { MobileProfilePage } = await import('../pages/mobile/MobileProfilePage');
    const { container } = renderOffline(<MobileProfilePage />);

    await screen.findByText(/Не удалось загрузить|Загрузка/);
    expect(container.textContent).not.toBe('');
  });
});
