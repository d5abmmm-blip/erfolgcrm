/**
 * Гарантия видна там, где по ней принимают решение.
 *
 * ЧТО БЫЛО. Реестр «Гарантии» есть в меню, у него полный сервер
 * (list / get / listByAsset / stats / create / update / archive) и своя
 * страница. Но `warranties.listByAsset` не звался НИГДЕ: ни на карточке
 * техники, ни в заявке. И там, и там показывалось только поле
 * `assets.warranty_until` — дата из карточки аппарата, которая к реестру
 * отношения не имеет и заполнена далеко не у всех.
 *
 * Почему это про деньги: гарантия решает, платный ремонт или бесплатный.
 * Менеджер, выставляющий счёт, о записи в реестре просто не узнавал.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: своего счёта дат. Действует гарантия или нет — решает
 * сервер (`statusSql`), экран только выбирает из присланного и подписывает.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { AssetWarranties } from '../components/AssetWarranties';
import { pickCoveringWarranty } from '../lib/warranty';

const ASSET_ID = 'ffffffff-0000-4000-8000-0000000000b1';

const FACTORY = {
  id: 'w-1',
  assetId: ASSET_ID,
  assetModel: 'Дефибриллятор',
  assetSerialNumber: 'DF-1',
  clientId: null,
  clientDisplayName: null,
  type: 'manufacturer' as const,
  status: 'expiring' as const,
  startDate: '2024-09-01',
  endDate: '2026-09-01',
  voided: false,
  coverageDescription: null,
  provider: 'Завод-изготовитель',
  contractNumber: null,
  notes: null,
  createdAt: new Date('2024-09-01T00:00:00Z'),
  updatedAt: new Date('2024-09-01T00:00:00Z'),
};

const EXTENDED = {
  ...FACTORY,
  id: 'w-2',
  type: 'extended' as const,
  status: 'active' as const,
  endDate: '2028-09-01',
  provider: 'ООО «Сервис-Плюс»',
};

const EXPIRED = { ...FACTORY, id: 'w-3', status: 'expired' as const, endDate: '2020-01-01' };

let answer: unknown[] = [];

function renderBlock(role: 'director' | 'engineer') {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: (input) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          const paths = (url.split('/trpc/')[1] ?? '').split('?')[0]?.split(',') ?? [];
          const payload = paths.map((p) => ({
            result: {
              data: superjson.serialize(p === 'warranties.listByAsset' ? answer : null),
            },
          }));
          return Promise.resolve(
            new Response(JSON.stringify(payload), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            }),
          );
        },
      }),
    ],
  });
  return render(
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <AssetWarranties assetId={ASSET_ID} canEdit={role === 'director'} />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

afterEach(cleanup);

describe('pickCoveringWarranty', () => {
  it('из нескольких действующих берёт ту, что кончается позже', () => {
    expect(pickCoveringWarranty([FACTORY, EXTENDED])?.id).toBe('w-2');
  });

  it('«заканчивается» тоже закрывает технику — ремонт ещё бесплатный', () => {
    expect(pickCoveringWarranty([FACTORY])?.id).toBe('w-1');
  });

  it('истёкшие и аннулированные не в счёт', () => {
    expect(pickCoveringWarranty([EXPIRED])).toBeNull();
    expect(pickCoveringWarranty([{ ...FACTORY, status: 'voided' as const }])).toBeNull();
    expect(pickCoveringWarranty([])).toBeNull();
  });
});

describe('блок гарантий на карточке техники', () => {
  it('показывает действующую гарантию с типом, сроком и поставщиком', async () => {
    answer = [FACTORY, EXTENDED];
    renderBlock('director');

    // «расширенная» видна дважды: в плашке «Техника на гарантии» и в списке.
    expect((await screen.findAllByText(/расширенная/)).length).toBeGreaterThan(1);
    expect(screen.getAllByText(/ООО «Сервис-Плюс»/).length).toBeGreaterThan(0);
    // Заводская тоже в списке — на карточке видно всё, что заведено.
    expect(screen.getByText(/заводская/)).toBeTruthy();
  });

  it('говорит прямо, что техника под гарантией', async () => {
    answer = [EXTENDED];
    renderBlock('director');

    expect(await screen.findByText(/Техника на гарантии/)).toBeTruthy();
  });

  it('всё истекло — не выдаёт это за действующую гарантию', async () => {
    answer = [EXPIRED];
    renderBlock('director');

    expect(await screen.findByText(/истекла/)).toBeTruthy();
    expect(screen.queryByText(/Техника на гарантии/)).toBeNull();
  });

  it('гарантий нет — так и написано, и есть куда завести', async () => {
    answer = [];
    renderBlock('director');

    expect(await screen.findByText(/Гарантий на эту технику не заведено/)).toBeTruthy();
    expect(screen.getByRole('link', { name: /Добавить гарантию/ })).toBeTruthy();
  });

  it('инженеру кнопки заведения нет — сервер её всё равно не примет', async () => {
    answer = [];
    renderBlock('engineer');

    await screen.findByText(/Гарантий на эту технику не заведено/);
    expect(screen.queryByRole('link', { name: /Добавить гарантию/ })).toBeNull();
  });
});
