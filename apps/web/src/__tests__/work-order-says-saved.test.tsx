/**
 * Наряд говорит инженеру, что работа записана.
 *
 * ЖАЛОБА ВЛАДЕЛЬЦА: «когда они что-то записывают, нет кнопки сохранить, что
 * приводит к дискомфорту».
 *
 * Что нашлось под этой жалобой: кнопки нет намеренно — наряд пишет по уходу
 * курсора из поля. Но при УДАЧНОМ сохранении он не показывал НИЧЕГО:
 * `showToast('ok', …)` в редакторе не вызывался ни разу, только «очередь»
 * и «ошибка». То есть тишина означала успех, а читалась как провал — тем
 * более что на соседнем экране за комментарий инженер получает зелёное
 * «Комментарий добавлен».
 *
 * У WorkOrderEditor до этого не было НИ ОДНОГО теста — самый денежный экран
 * приложения был не покрыт.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { saveMarkFromResult, saveMarkLabel } from '../lib/save-state';
import { WorkOrderEditor } from '../components/WorkOrderEditor';
import { clearAll } from '../lib/offline/queue';
import { setCurrentUserId } from '../lib/offline/current-user';

const TICKET = 'ffffffff-0000-4000-8000-00000000aaaa';

const WORK_ORDER = {
  id: 'wo-1',
  orderNumber: 'WO-1',
  ticketId: TICKET,
  vatRate: '20' as const,
  diagnosis: null,
  repairDescription: null,
  recommendation: null,
  worksAmountKopecks: '0',
  partsAmountKopecks: '0',
  expensesAmountKopecks: '0',
  vatAmountKopecks: '0',
  totalAmountKopecks: '0',
  lines: [],
};

/**
 * Живой сервер-заглушка.
 *
 * Отвечать одним и тем же на все запросы нельзя: после записи экран
 * перечитывает и наряд, и список инженеров. Заглушка «на всё одинаково»
 * ломает их, компонент падает — и тест «не находит» отметку по совсем
 * другой причине. Поймано пробой: `(engineersQ.data ?? []).filter is not
 * a function`.
 */
function serverOk() {
  return (url: unknown, init?: { method?: string }): Promise<Response> => {
    const address = String(url);
    const isWrite = (init?.method ?? 'GET').toUpperCase() === 'POST';
    const payload = isWrite ? { ok: true } : address.includes('getByTicket') ? WORK_ORDER : [];
    return Promise.resolve(
      new Response(JSON.stringify([{ result: { data: { json: payload } } }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
}

/** Клиент приложения: те же настройки, что в main.tsx — иначе проверим не то приложение. */
function renderEditor(fetchImpl?: (url: unknown, init?: { method?: string }) => Promise<Response>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  queryClient.setQueryData(
    [['workOrders', 'getByTicket'], { input: { ticketId: TICKET }, type: 'query' }],
    WORK_ORDER,
  );
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: fetchImpl ?? (() => Promise.reject(new TypeError('Failed to fetch'))),
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <WorkOrderEditor ticketId={TICKET} ticketNumber="WSP-777" canEdit canEditVat={false} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId('engineer-A');
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
});

afterEach(async () => {
  cleanup();
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  setCurrentUserId(null);
  await clearAll();
});

describe('подписи состояния честны и различимы', () => {
  it('успех и очередь названы РАЗНЫМИ словами', () => {
    const saved = saveMarkLabel('saved');
    const queued = saveMarkLabel('queued');
    expect(saved?.text).toBe('записано');
    // «Сохранено» про очередь писать нельзя: на сервере этого ещё нет.
    expect(queued?.text).toContain('ждёт связи');
    expect(queued?.text).not.toContain('охранено');
  });

  it('пока пишем — так и говорим', () => {
    expect(saveMarkLabel('saving')?.text).toBe('записываю…');
  });

  it('в покое подпись не мозолит глаза', () => {
    expect(saveMarkLabel('idle')).toBeNull();
  });

  it('исход отправки превращается в состояние', () => {
    expect(saveMarkFromResult('ok')).toBe('saved');
    expect(saveMarkFromResult('queued')).toBe('queued');
    // Ошибку показывает тост — зелёной или жёлтой отметке тут не место.
    expect(saveMarkFromResult('error')).toBe('idle');
  });
});

describe('кнопка, которой не было', () => {
  it('«Готово» есть на экране', async () => {
    renderEditor();
    expect(await screen.findByRole('button', { name: /Готово/ })).toBeTruthy();
  });

  /**
   * Кнопка НЕ заводит второй путь записи — она снимает курсор с поля, и
   * срабатывает та же самая обкатанная запись по уходу курсора. Иначе
   * появился бы второй вход в saveLine, а на «одна строка = одна запись»
   * держится защита наряда от дублей, то есть от задвоенных денег.
   */
  it('снимает курсор с поля — дальше работает обычная запись', async () => {
    renderEditor();
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    field.focus();
    expect(document.activeElement).toBe(field);

    fireEvent.click(await screen.findByRole('button', { name: /Готово/ }));

    await waitFor(() => expect(document.activeElement).not.toBe(field));
  });
});

describe('поле шапки наряда отвечает человеку', () => {
  it('без связи говорит «ждёт связи», а не молчит', async () => {
    renderEditor();
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: 'Пробой платы питания' } });
    fireEvent.blur(field);

    expect(await screen.findByText(/ждёт связи/)).toBeTruthy();
  });
});

describe('при удаче наряд говорит «записано»', () => {
  /**
   * Самое главное в этой правке. Раньше на успешном сохранении не появлялось
   * НИЧЕГО, и молчание читалось как «работа пропала».
   */
  it('после ухода курсора появляется зелёная отметка', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
    onlineManager.setOnline(true);

    renderEditor(serverOk());
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;

    fireEvent.change(field, { target: { value: 'Пробой платы питания' } });
    fireEvent.blur(field);

    expect(await screen.findByText('записано')).toBeTruthy();
  });

  it('и эта отметка не путается с очередью', async () => {
    Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
    onlineManager.setOnline(true);

    renderEditor(serverOk());
    const field = (await screen.findAllByRole('textbox'))[0] as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Готово' } });
    fireEvent.blur(field);

    await screen.findByText('записано');
    expect(screen.queryByText(/ждёт связи/)).toBeNull();
  });
});
