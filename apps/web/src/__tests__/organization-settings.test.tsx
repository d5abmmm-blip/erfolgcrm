/**
 * Экран «Организация» — реквизиты, которые печатаются в документах.
 *
 * ЧТО БЫЛО. Наименование, ИНН/КПП, адрес, банк, лицензия и фамилия директора
 * жили в `apps/web/src/lib/pdf/branding.ts` — зашитой в код константой. Колонки
 * в `tenants` под них есть, заполнены сидом и не читались никем. Сменился банк
 * или директор — правится исходник и пересобирается сайт.
 *
 * ЧТО ПРОВЕРЯЕМ ЗДЕСЬ: экран показывает то, что лежит в базе; сохраняет только
 * то, что человек тронул; и не пускает на сервер заведомо неверный БИК — иначе
 * клиент не сможет заплатить по счёту, а узнает об этом через неделю.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { OrganizationSettingsPage } from '../pages/OrganizationSettingsPage';

const ORG = {
  displayName: 'ERFOLG',
  legalName: 'Общество с ограниченной ответственностью «Эрфольг»',
  slogan: 'Техническое обслуживание и ремонт медицинской техники',
  inn: '2014006736',
  kpp: '201401001',
  ogrn: null as string | null,
  legalAddress: '364031, Чеченская Республика, г. Грозный, ул. Мичурина, двлд 98',
  phone: '8 (928) 895-70-70',
  email: 'erfolgmt@mail.ru',
  bankName: 'ЧЕЧЕНСКИЙ РФ АО «РОССЕЛЬХОЗБАНК», г. Грозный',
  bankAccount: '40702810734000003523',
  correspondentAccount: '30101810600000000719',
  bik: '049690719',
  licenseSeries: 'ФС-99-04',
  licenseNumber: '000295',
  licenseDate: '2013-08-21',
  licenseAuthority: 'Росздравнадзор',
  directorName: null as string | null,
};

const ME = { user: { id: 'u-dir', role: 'director' }, tenant: { displayName: 'ERFOLG' } };

let sent: { path: string; body: string }[] = [];

function answerFor(path: string): unknown {
  if (path === 'settings.getOrganization') return ORG;
  if (path === 'auth.me') return ME;
  return ORG;
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { ...QUERY_DEFAULTS, retry: false }, mutations: MUTATION_DEFAULTS },
  });
  const client = trpc.createClient({
    links: [
      httpBatchLink({
        url: 'http://test.invalid/api/v1/trpc',
        transformer: superjson,
        fetch: (input, init) => {
          const url = typeof input === 'string' ? input : (input as Request).url;
          const paths = (url.split('/trpc/')[1] ?? '').split('?')[0]?.split(',') ?? [];
          for (const p of paths) sent.push({ path: p, body: String(init?.body ?? '') });
          const payload = paths.map((p) => ({
            result: { data: superjson.serialize(answerFor(p)) },
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
        <OrganizationSettingsPage />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

function saved(): { path: string; body: string } | undefined {
  return sent.find((s) => s.path === 'settings.updateOrganization');
}

beforeEach(() => {
  sent = [];
});
afterEach(cleanup);

describe('экран «Организация»', () => {
  it('показывает реквизиты из базы, а не из кода', async () => {
    renderPage();

    expect(await screen.findByDisplayValue('2014006736')).toBeTruthy();
    expect(screen.getByDisplayValue('049690719')).toBeTruthy();
    expect(screen.getByDisplayValue(/РОССЕЛЬХОЗБАНК/)).toBeTruthy();
    expect(screen.getByDisplayValue('2013-08-21')).toBeTruthy();
  });

  it('фамилию директора можно вписать и сохранить', async () => {
    renderPage();

    const director = await screen.findByLabelText(/Директор/);
    fireEvent.change(director, { target: { value: 'Хаджиев Тимур Рамзанович' } });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));

    await waitFor(() => expect(saved()).toBeTruthy());
    expect(saved()?.body).toContain('Хаджиев Тимур Рамзанович');
  });

  it('неверный БИК на сервер не уходит', async () => {
    renderPage();

    const bik = await screen.findByLabelText(/БИК/);
    fireEvent.change(bik, { target: { value: '123' } });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));

    await waitFor(() => expect(screen.getByText(/БИК — 9 цифр/)).toBeTruthy());
    expect(saved()).toBeUndefined();
  });

  it('ничего не тронули — «Сохранить» не даёт отправить пустую правку', async () => {
    renderPage();
    await screen.findByDisplayValue('2014006736');

    expect(screen.getByRole('button', { name: /Сохранить/ })).toHaveProperty('disabled', true);
  });

  it('пустое поле разрешено: у ИП нет КПП', async () => {
    renderPage();

    const kpp = await screen.findByLabelText(/КПП/);
    fireEvent.change(kpp, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Сохранить/ }));

    await waitFor(() => expect(saved()).toBeTruthy());
  });
});
