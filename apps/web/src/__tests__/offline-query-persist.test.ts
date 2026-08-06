/**
 * Офлайн-память данных: что кладём на диск, а что нет, и переживает ли это перезапуск.
 *
 * ЗАЧЕМ. react-query держал кэш только в оперативной памяти вкладки. Инженер
 * закрыл приложение (или система выгрузила PWA) — и в подвале больницы, где нет
 * связи, он видел не свою очередь, а экран входа. Теперь снимок кэша лежит
 * в IndexedDB и поднимается при старте.
 *
 * Самое опасное здесь — ПДн. На диск телефона попадает только то, что явно
 * перечислено; реквизиты клиента (`tickets.documentClient` — телефон и адрес)
 * не должны лечь туда НИКОГДА, даже если кто-то потом расширит список.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  lastSyncedAt,
  offlineDataAgeLabel,
  queryPathOf,
  shouldPersistQuery,
} from '../lib/offline/persisted-queries';
import {
  CACHE_MAX_AGE_MS,
  CACHE_MAX_ENTRIES,
  clearPersistedQueries,
  persistNow,
  readSnapshot,
  restorePersistedQueries,
  writeSnapshot,
} from '../lib/offline/query-persist';
import { getLastSyncAt } from '../lib/offline/last-sync';
import { resetOfflineMemory } from '../lib/offline/session-reset';

/** Ключ запроса в том виде, в каком его строит @trpc/react-query. */
function trpcKey(path: string, input?: unknown): unknown[] {
  return [path.split('.'), { input, type: 'query' }];
}

beforeEach(async () => {
  await clearPersistedQueries();
});

describe('shouldPersistQuery: что ложится на диск', () => {
  it('инженерные запросы — да', () => {
    for (const path of [
      'auth.me',
      'tickets.myList',
      'tickets.myTickets',
      'tickets.get',
      'tickets.myWeeklySchedule',
      'workOrders.getByTicket',
      'tasks.myList',
      'inventoryItems.list',
    ]) {
      expect(shouldPersistQuery(trpcKey(path)), path).toBe(true);
    }
  });

  // Главная защита: в documentClient лежат телефон и адрес клиента.
  it('реквизиты клиента (телефон, адрес) — НИКОГДА', () => {
    expect(shouldPersistQuery(trpcKey('tickets.documentClient'))).toBe(false);
    expect(shouldPersistQuery(trpcKey('clients.get'))).toBe(false);
    expect(shouldPersistQuery(trpcKey('clients.search'))).toBe(false);
  });

  it('ссылки на вложения — нет: они живут 15 минут и на диске протухнут', () => {
    expect(shouldPersistQuery(trpcKey('attachments.listByReference'))).toBe(false);
  });

  it('заработок инженера — нет: зарплате не место на диске телефона', () => {
    expect(shouldPersistQuery(trpcKey('payroll.myEarnings'))).toBe(false);
  });

  it('всё остальное — нет (список белый, а не чёрный)', () => {
    expect(shouldPersistQuery(trpcKey('tickets.list'))).toBe(false);
    expect(shouldPersistQuery(trpcKey('audit.list'))).toBe(false);
    expect(shouldPersistQuery(['что-то не от tRPC'])).toBe(false);
    expect(shouldPersistQuery([])).toBe(false);
  });

  it('queryPathOf понимает ключ tRPC и не спотыкается о чужой', () => {
    expect(queryPathOf(trpcKey('tickets.myList'))).toBe('tickets.myList');
    expect(queryPathOf(['plain-key'])).toBeNull();
    expect(queryPathOf([[1, 2]])).toBeNull();
  });
});

describe('lastSyncedAt: когда в последний раз была связь', () => {
  it('берёт самое свежее время среди сохраняемых запросов', () => {
    const at = lastSyncedAt([
      { queryKey: trpcKey('tickets.myList'), state: { dataUpdatedAt: 1000 } },
      { queryKey: trpcKey('tasks.myList'), state: { dataUpdatedAt: 5000 } },
      { queryKey: trpcKey('tickets.get'), state: { dataUpdatedAt: 3000 } },
    ]);
    expect(at).toBe(5000);
  });

  it('чужие запросы не считаются — иначе время соврёт', () => {
    const at = lastSyncedAt([
      { queryKey: trpcKey('tickets.myList'), state: { dataUpdatedAt: 1000 } },
      { queryKey: trpcKey('audit.list'), state: { dataUpdatedAt: 9000 } },
    ]);
    expect(at).toBe(1000);
  });

  it('пусто → null', () => {
    expect(lastSyncedAt([])).toBeNull();
  });
});

describe('offlineDataAgeLabel: человеческая подпись возраста', () => {
  const now = new Date('2026-08-07T14:40:00');

  it('сегодня — только время', () => {
    expect(offlineDataAgeLabel(new Date('2026-08-07T14:32:00').getTime(), now)).toBe(
      'данные от 14:32',
    );
  });

  it('вчера и раньше — с датой, чтобы не принять позавчерашнее за свежее', () => {
    expect(offlineDataAgeLabel(new Date('2026-08-05T09:05:00').getTime(), now)).toBe(
      'данные от 05.08, 09:05',
    );
  });

  it('данных не было вовсе → подписи нет', () => {
    expect(offlineDataAgeLabel(null, now)).toBeNull();
  });
});

describe('снимок кэша переживает перезапуск приложения', () => {
  /** Клиент с одним «загруженным» запросом очереди и одним — с ПДн. */
  function clientWithData(): QueryClient {
    const qc = new QueryClient();
    qc.setQueryData(trpcKey('tickets.myList', { pageSize: 50 }), {
      items: [{ id: 't-1', ticketNumber: 'WSP-1' }],
      total: 1,
    });
    qc.setQueryData(trpcKey('tickets.documentClient', { ticketId: 't-1' }), {
      displayName: 'ГБУ Больница',
      phone: '+7 999 000-00-00',
      legalAddress: 'г. Грозный, ул. Ленина, 1',
    });
    return qc;
  }

  it('сохранили → подняли в НОВОМ клиенте: очередь на месте', async () => {
    await persistNow(clientWithData());

    const fresh = new QueryClient();
    expect(await restorePersistedQueries(fresh)).toBe(true);
    expect(fresh.getQueryData(trpcKey('tickets.myList', { pageSize: 50 }))).toEqual({
      items: [{ id: 't-1', ticketNumber: 'WSP-1' }],
      total: 1,
    });
  });

  it('ПДн клиента на диск не попали', async () => {
    await persistNow(clientWithData());

    const snap = await readSnapshot();
    const paths = (snap?.state.queries ?? []).map((q) => queryPathOf(q.queryKey));
    expect(paths).toContain('tickets.myList');
    expect(paths).not.toContain('tickets.documentClient');

    const raw = JSON.stringify(snap);
    expect(raw).not.toContain('+7 999 000-00-00');
    expect(raw).not.toContain('ул. Ленина');
  });

  it('время последней связи известно сразу после подъёма', async () => {
    const qc = clientWithData();
    await persistNow(qc);
    await clearLastSync();

    const fresh = new QueryClient();
    await restorePersistedQueries(fresh);
    expect(getLastSyncAt()).not.toBeNull();
  });

  it('протухшее не поднимаем — иначе покажем недельной давности как своё', async () => {
    await persistNow(clientWithData());
    const snap = await readSnapshot();
    await writeSnapshot({
      ...snap!,
      state: {
        ...snap!.state,
        queries: snap!.state.queries.map((q) => ({
          ...q,
          state: { ...q.state, dataUpdatedAt: Date.now() - CACHE_MAX_AGE_MS - 1 },
        })),
      },
    });

    const fresh = new QueryClient();
    expect(await restorePersistedQueries(fresh)).toBe(false);
    expect(fresh.getQueryData(trpcKey('tickets.myList', { pageSize: 50 }))).toBeUndefined();
  });

  /**
   * Поймано живой проверкой, тесты этого не видели.
   *
   * Приложение запускается без связи: снимок поднялся, экран нарисовался — и
   * тут же каждый запрос уходит в сеть, которой нет, и падает. Раньше сразу
   * после этого записывался НОВЫЙ снимок — из одних успешных запросов, то есть
   * пустой. Офлайн-память самоуничтожалась после первого же запуска без связи:
   * второй показывал экран входа. Особенно больно с `auth.me` — без него
   * приложение вообще не считает инженера вошедшим.
   */
  it('упавший без связи запрос НЕ стирает уже сохранённое', async () => {
    const online = new QueryClient();
    online.setQueryData(trpcKey('auth.me'), { user: { id: 'u1', role: 'engineer' } });
    online.setQueryData(trpcKey('tickets.myList', { pageSize: 50 }), { items: [], total: 0 });
    await persistNow(online);

    // Запуск без связи: подняли снимок, запросы ушли в сеть и упали.
    const offline = new QueryClient();
    await restorePersistedQueries(offline);
    for (const key of [trpcKey('auth.me'), trpcKey('tickets.myList', { pageSize: 50 })]) {
      await offline
        .fetchQuery({
          queryKey: key,
          queryFn: () => Promise.reject(new TypeError('Failed to fetch')),
          retry: false,
        })
        .catch(() => undefined);
    }
    await persistNow(offline);

    // Следующий запуск, всё ещё без связи: сессия и очередь должны быть на месте.
    const next = new QueryClient();
    expect(await restorePersistedQueries(next)).toBe(true);
    expect(next.getQueryData(trpcKey('auth.me'))).toEqual({
      user: { id: 'u1', role: 'engineer' },
    });
    expect(next.getQueryData(trpcKey('tickets.myList', { pageSize: 50 }))).toEqual({
      items: [],
      total: 0,
    });
  });

  it('снимок не растёт бесконечно — держим только самое свежее', async () => {
    const qc = new QueryClient();
    for (let i = 0; i < CACHE_MAX_ENTRIES + 15; i++) {
      qc.setQueryData(trpcKey('tickets.get', { id: `t-${i}` }), { id: `t-${i}` });
    }
    await persistNow(qc);

    const snap = await readSnapshot();
    expect(snap!.state.queries.length).toBe(CACHE_MAX_ENTRIES);
  });

  it('снимок от другой версии полей не поднимаем', async () => {
    await persistNow(clientWithData());
    const snap = await readSnapshot();
    await writeSnapshot({ ...snap!, schemaVersion: snap!.schemaVersion + 1 });

    const fresh = new QueryClient();
    expect(await restorePersistedQueries(fresh)).toBe(false);
  });

  it('выход из аккаунта стирает снимок целиком', async () => {
    await persistNow(clientWithData());
    expect(await readSnapshot()).not.toBeUndefined();

    await clearPersistedQueries();
    expect(await readSnapshot()).toBeUndefined();

    const fresh = new QueryClient();
    expect(await restorePersistedQueries(fresh)).toBe(false);
  });

  /**
   * Запись снимка отложенная (раз в секунду). Если после выхода просто стереть
   * файл, отложенная запись через мгновение вернёт всё обратно — она возьмёт
   * данные из памяти вкладки, где ещё лежит очередь прошлого человека.
   */
  it('после выхода отложенная запись не возвращает данные прошлого человека', async () => {
    const qc = clientWithData();
    await persistNow(qc);

    await resetOfflineMemory(qc);
    await persistNow(qc); // сработал отложенный сохранятель

    const snap = await readSnapshot();
    expect(snap?.state.queries ?? []).toHaveLength(0);

    const fresh = new QueryClient();
    await restorePersistedQueries(fresh);
    expect(fresh.getQueryData(trpcKey('tickets.myList', { pageSize: 50 }))).toBeUndefined();
  });

  it('пустой кэш ничего не ломает', async () => {
    await persistNow(new QueryClient());
    const fresh = new QueryClient();
    await restorePersistedQueries(fresh);
    expect(fresh.getQueryCache().getAll()).toHaveLength(0);
  });
});

/** Сбросить «время последней связи», чтобы проверить, что его ставит именно подъём. */
async function clearLastSync(): Promise<void> {
  const { noteSync } = await import('../lib/offline/last-sync');
  noteSync(null);
}

afterEach(async () => {
  await clearPersistedQueries();
});
