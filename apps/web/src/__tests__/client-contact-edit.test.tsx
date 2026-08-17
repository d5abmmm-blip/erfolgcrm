/**
 * Контактные лица клиента: завести, поправить, удалить.
 *
 * ЧТО БЫЛО. Сервер с самого начала умеет все три действия — `clients.addContact`,
 * `clients.updateContact` (менеджер и директор) и `clients.deleteContact`
 * (только директор, действие необратимо). Экран звал ровно одно из трёх:
 * добавить. Опечатку в телефоне контактного лица исправить было НЕЧЕМ — ни
 * поправить, ни убрать, — а на бою у 665 клиентов это единственный способ
 * дозвониться до заказчика.
 *
 * ПОЧЕМУ ОТДЕЛЬНЫЙ КОМПОНЕНТ. Карточка клиента сидит на маршруте
 * `/clients/:id`; чтобы отрисовать её целиком, тесту пришлось бы поднимать
 * роутер и десяток чужих запросов. Секция контактов ни от того, ни от другого
 * не зависит — она получает список пропсом и умеет только свои три мутации.
 *
 * ПРО «ЗАШИФРОВАНО». В подсказках полей стояло «ФИО (зашифрованное)» —
 * наследство снятого шифрования ПДн: `client_contacts.full_name` и `.phone`
 * давно обычные колонки. Сторож ниже держит подсказки честными.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import { trpc } from '../lib/trpc';
import { MUTATION_DEFAULTS, QUERY_DEFAULTS } from '../lib/query-defaults';
import { ClientContacts } from '../components/ClientContacts';

const CLIENT_ID = 'ffffffff-0000-4000-8000-0000000000c1';

const CONTACT = {
  id: 'ffffffff-0000-4000-8000-0000000000c2',
  fullName: 'Иванов Иван Иванович',
  phone: '+7 928 111-22-33',
  email: 'ivanov@example.ru',
  position: 'главный инженер',
  isPrimary: true,
};

/** Что экран отправил на сервер: путь процедуры и тело запроса. */
let calls: { path: string; body: string }[] = [];

/** Первый ушедший запрос; падает внятно, если экран не отправил ничего. */
function firstCall(): { path: string; body: string } {
  const c = calls[0];
  if (!c) throw new Error('экран не отправил ни одного запроса');
  return c;
}

function renderContacts(opts?: { canDelete?: boolean; contacts?: (typeof CONTACT)[] }) {
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
          calls.push({
            path: url.split('/trpc/')[1]?.split('?')[0] ?? url,
            body: String(init?.body ?? ''),
          });
          return Promise.resolve(
            new Response(JSON.stringify([{ result: { data: { json: null } } }]), {
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
        <ClientContacts
          clientId={CLIENT_ID}
          contacts={opts?.contacts ?? [CONTACT]}
          canDelete={opts?.canDelete ?? true}
        />
      </QueryClientProvider>
    </trpc.Provider>,
  );
}

beforeEach(() => {
  calls = [];
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('правка контакта', () => {
  it('кнопка «Изменить» открывает форму с тем, что уже записано', async () => {
    renderContacts();

    fireEvent.click(screen.getByRole('button', { name: /Изменить контакт/ }));

    expect(await screen.findByDisplayValue('Иванов Иван Иванович')).toBeTruthy();
    expect(screen.getByDisplayValue('+7 928 111-22-33')).toBeTruthy();
    expect(screen.getByDisplayValue('главный инженер')).toBeTruthy();
  });

  it('исправленный телефон уходит на сервер как clients.updateContact', async () => {
    renderContacts();

    fireEvent.click(screen.getByRole('button', { name: /Изменить контакт/ }));
    const phone = await screen.findByDisplayValue('+7 928 111-22-33');
    fireEvent.change(phone, { target: { value: '+7 928 444-55-66' } });
    fireEvent.click(screen.getByRole('button', { name: /^Сохранить$/ }));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(firstCall().path).toBe('clients.updateContact');
    expect(firstCall().body).toContain('+7 928 444-55-66');
    expect(firstCall().body).toContain(CONTACT.id);
  });

  it('пустое ФИО на сервер не уходит — сервер его всё равно не примет', async () => {
    renderContacts();

    fireEvent.click(screen.getByRole('button', { name: /Изменить контакт/ }));
    const name = await screen.findByDisplayValue('Иванов Иван Иванович');
    fireEvent.change(name, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /^Сохранить$/ }));

    await waitFor(() => expect(screen.getByText(/Введите ФИО/)).toBeTruthy());
    expect(calls).toEqual([]);
  });
});

describe('удаление контакта', () => {
  it('по нажатию спрашивает и до ответа ничего не удаляет', async () => {
    renderContacts();

    fireEvent.click(screen.getByRole('button', { name: /Удалить контакт/ }));

    expect(await screen.findByText(/Удалить контактное лицо/)).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('подтвердил — уходит clients.deleteContact', async () => {
    renderContacts();

    fireEvent.click(screen.getByRole('button', { name: /Удалить контакт/ }));
    fireEvent.click(await screen.findByRole('button', { name: /^Удалить$/ }));

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(firstCall().path).toBe('clients.deleteContact');
    expect(firstCall().body).toContain(CONTACT.id);
  });

  it('менеджеру корзинки нет — удалять разрешено только директору', () => {
    renderContacts({ canDelete: false });

    expect(screen.queryByRole('button', { name: /Удалить контакт/ })).toBeNull();
    // Править менеджеру можно: updateContact — staffProcedure.
    expect(screen.getByRole('button', { name: /Изменить контакт/ })).toBeTruthy();
  });
});

describe('подсказки полей', () => {
  it('не обещают шифрования — ПДн контактов лежат обычными колонками', async () => {
    renderContacts({ contacts: [] });

    fireEvent.click(screen.getByRole('button', { name: /Добавить контакт/ }));
    await screen.findByPlaceholderText(/ФИО/);

    for (const el of Array.from(document.querySelectorAll('input'))) {
      expect(el.getAttribute('placeholder') ?? '').not.toMatch(/шифр/i);
    }
  });
});
