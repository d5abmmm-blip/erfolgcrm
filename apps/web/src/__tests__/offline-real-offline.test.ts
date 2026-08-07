/**
 * Очередь срабатывает при НАСТОЯЩЕМ офлайне, а не только при «сервер не отвечает».
 *
 * ГЛАВНАЯ ЛОВУШКА, из-за которой это не замечали ни разу. react-query при
 * `networkMode: 'online'` (значение по умолчанию) НЕ отправляет мутацию, когда
 * связи нет, — он СТАВИТ ЕЁ НА ПАУЗУ. Промис `mutateAsync` не отклоняется и не
 * выполняется: он висит вечно. А вся офлайн-очередь построена на том, что
 * `mutateAsync` УПАДЁТ и управление дойдёт до `catch`, где вызывается enqueue.
 *
 * Итог на телефоне инженера в подвале: он жмёт «Сохранить комментарий»,
 * кнопка крутится бесконечно, в очередь НИЧЕГО не кладётся, и при возврате
 * связи отправлять нечего.
 *
 * Почему это пережило все прошлые проверки: и тесты, и живые проверки гасили
 * СЕРВЕР, а сеть у машины оставалась. Тогда `navigator.onLine === true`,
 * react-query считает связь живой, запрос честно падает — и очередь работает.
 * Настоящий офлайн (радио выключено) ведёт себя иначе.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MutationObserver, QueryClient, onlineManager } from '@tanstack/react-query';
import { clearAll, count, listPending } from '../lib/offline/queue';
import { executeOrQueue } from '../lib/offline/executor';
import { setCurrentUserId } from '../lib/offline/current-user';
import { MUTATION_DEFAULTS } from '../lib/query-defaults';

/** Мутация, поднятая так же, как в приложении (см. main.tsx). */
function appMutation<P>(qc: QueryClient) {
  return new MutationObserver<unknown, Error, P>(qc, {
    ...MUTATION_DEFAULTS,
    mutationFn: () => Promise.reject(new TypeError('Failed to fetch')),
    retry: false,
  });
}

function goOffline() {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: false });
  onlineManager.setOnline(false);
}

beforeEach(async () => {
  await clearAll();
  setCurrentUserId('engineer-A');
});

afterEach(async () => {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value: true });
  onlineManager.setOnline(true);
  setCurrentUserId(null);
  await clearAll();
});

describe('инженер в подвале нажимает «сохранить»', () => {
  it('правка попадает в очередь, а не зависает навсегда', async () => {
    goOffline();
    const qc = new QueryClient();
    const m = appMutation<{ ticketId: string; comment: string }>(qc);

    const work = executeOrQueue(
      'tickets.addNote',
      { ticketId: 't1', comment: 'Заменил блок питания' },
      (p) => m.mutate(p),
      'erfolg',
    );

    // Полторы секунды — с большим запасом: настоящая отправка тут падает сразу.
    const result = await Promise.race([
      work,
      new Promise((r) => setTimeout(() => r({ status: 'ЗАВИСЛО' }), 1500)),
    ]);

    expect((result as { status: string }).status).toBe('queued');
    expect(await count()).toBe(1);
    expect((await listPending())[0]!.payload).toMatchObject({
      comment: 'Заменил блок питания',
    });
  });

  it('кнопка не остаётся крутиться: обещание завершается', async () => {
    goOffline();
    const qc = new QueryClient();
    const m = appMutation<{ id: string; isDone: boolean }>(qc);

    const settled = await Promise.race([
      executeOrQueue('tasks.setDone', { id: 'x', isDone: true }, (p) => m.mutate(p), 'erfolg').then(
        () => true,
      ),
      new Promise((r) => setTimeout(() => r(false), 1500)),
    ]);

    expect(settled).toBe(true);
  });
});

/**
 * Защита «чужая работа не уходит от чужого имени» была применена только
 * к правкам. У очереди фото автора не было вообще: инженер А ушёл, не
 * дождавшись связи, на том же телефоне вошёл Б — правки А честно оставались
 * ждать, а снимки А тут же уезжали на сервер под сессией Б и записывались
 * как загруженные Б.
 */
describe('фото тоже принадлежат автору', () => {
  it('снимок инженера А не уходит, когда вошёл Б', async () => {
    const { clearAllPhotos, countPendingPhotos, enqueuePhoto, listPendingPhotos } =
      await import('../lib/offline/photo-queue');
    const { sendPendingPhotos } = await import('../lib/offline/photo-sender');
    await clearAllPhotos();

    setCurrentUserId('engineer-A');
    await enqueuePhoto({
      kind: 'ticket_photo',
      referenceType: 'ticket',
      referenceId: 'ffffffff-0000-4000-8000-000000000001',
      file: new File([new Uint8Array(16)], 'а-снял.jpg', { type: 'image/jpeg' }),
      tenantSubdomain: 'erfolg',
    });
    expect((await listPendingPhotos())[0]!.userId).toBe('engineer-A');

    setCurrentUserId('engineer-B');
    const upload = vi.fn().mockResolvedValue(undefined);
    const r = await sendPendingPhotos(upload);

    expect(upload).not.toHaveBeenCalled();
    expect(r.skippedOther).toBe(1);
    expect(await countPendingPhotos()).toBe(1);

    setCurrentUserId('engineer-A');
    const back = await sendPendingPhotos(vi.fn().mockResolvedValue(undefined));
    expect(back.succeeded).toBe(1);
    await clearAllPhotos();
  });
});

/**
 * Автосинк крутился вхолостую: записи, которые больше НИКОГДА не уйдут
 * (отклонённые сервером или чужие), считались наравне с живыми, и условие
 * входа было истинно всегда. Каждый круг менял isSyncing туда-обратно,
 * перезапуская сам себя — телефон инженера молотил IndexedDB, пока экран
 * открыт.
 */
describe('счётчик очереди считает только то, что реально уйдёт', () => {
  it('отклонённые и чужие в «ожидает отправки» не попадают', async () => {
    const { enqueue, countSendable } = await import('../lib/offline/queue');
    setCurrentUserId('engineer-A');
    await enqueue('tickets.addNote', { ticketId: 't1', comment: 'живая' }, 'erfolg');

    const rejected = await enqueue(
      'tickets.addNote',
      { ticketId: 't2', comment: 'откл' },
      'erfolg',
    );
    const { update, listPending } = await import('../lib/offline/queue');
    const stuck = (await listPending()).find((i) => i.id === rejected.id)!;
    await update({ ...stuck, failedHard: true, lastError: 'Заявка закрыта' });

    setCurrentUserId('engineer-B');
    await enqueue('tickets.addNote', { ticketId: 't3', comment: 'от Б' }, 'erfolg');

    setCurrentUserId('engineer-A');
    // Всего в хранилище три, а уйти сейчас может только одна.
    expect(await count()).toBe(3);
    expect(await countSendable()).toBe(1);
  });
});
