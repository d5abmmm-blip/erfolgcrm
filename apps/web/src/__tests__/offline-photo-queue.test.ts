/**
 * Очередь фото: снимок переживает уход с экрана и перезапуск приложения.
 *
 * ЗАЧЕМ. Непринятое фото жило в состоянии React — то есть ровно пока открыт
 * экран. Инженер снял повреждение в подвале, нажал «назад» — фото нет.
 * Для выезда это главный носитель доказательств, и переснять его чаще всего
 * уже нельзя: аппарат собран, объект сдан.
 *
 * Текстовые правки такую очередь имеют давно (outbox), фото — нет: ссылка на
 * загрузку живёт 15 минут, поэтому в очередь надо класть сам ФАЙЛ и повторять
 * все три шага заново.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TRPCClientError } from '@trpc/client';
import type { AppRouter } from '@erfolg/api';
import {
  PHOTO_QUEUE_MAX_BYTES,
  clearAllPhotos,
  countPendingPhotos,
  enqueuePhoto,
  listPendingPhotos,
  pendingPhotoBytes,
  photoBlob,
  photoQueueFullMessage,
} from '../lib/offline/photo-queue';
import { sendPendingPhotos } from '../lib/offline/photo-sender';
import { setCurrentUserId } from '../lib/offline/current-user';

function file(name: string, bytes: number, type = 'image/jpeg'): File {
  return new File([new Uint8Array(bytes)], name, { type });
}

const TICKET = 'ffffffff-0000-4000-8000-000000000001';
const OTHER = 'ffffffff-0000-4000-8000-000000000002';

async function add(name: string, bytes = 1024, referenceId = TICKET) {
  return enqueuePhoto({
    kind: 'ticket_photo',
    referenceType: 'ticket',
    referenceId,
    file: file(name, bytes),
    tenantSubdomain: 'erfolg',
  });
}

beforeEach(async () => {
  await clearAllPhotos();
  setCurrentUserId(null);
});
afterEach(async () => {
  await clearAllPhotos();
  setCurrentUserId(null);
});

describe('фото кладётся в очередь и переживает перезапуск', () => {
  it('сохраняется вместе с самим файлом, а не одним именем', async () => {
    await add('повреждение.jpg', 2048);

    const [item] = await listPendingPhotos();
    expect(item!.fileName).toBe('повреждение.jpg');
    expect(item!.mimeType).toBe('image/jpeg');
    expect(item!.sizeBytes).toBe(2048);
    // Главное: рядом лежит содержимое, иначе отправлять будет нечего.
    expect(item!.bytes.byteLength).toBe(2048);
    expect(photoBlob(item!).type).toBe('image/jpeg');
  });

  it('можно спросить только по одной заявке — для галереи в карточке', async () => {
    await add('a.jpg', 100, TICKET);
    await add('b.jpg', 100, TICKET);
    await add('c.jpg', 100, OTHER);

    expect(await listPendingPhotos({ referenceType: 'ticket', referenceId: TICKET })).toHaveLength(
      2,
    );
    expect(await countPendingPhotos()).toBe(3);
  });

  it('порядок съёмки сохраняется', async () => {
    await add('первое.jpg');
    await new Promise((r) => setTimeout(r, 5));
    await add('второе.jpg');

    const names = (await listPendingPhotos()).map((p) => p.fileName);
    expect(names).toEqual(['первое.jpg', 'второе.jpg']);
  });
});

describe('предел памяти телефона', () => {
  it('переполнение отклоняется и НЕ трогает уже накопленное', async () => {
    await add('нужное.jpg', 1024);
    const before = await pendingPhotoBytes();

    await expect(add('огромное.jpg', PHOTO_QUEUE_MAX_BYTES)).rejects.toThrow();

    expect(await countPendingPhotos()).toBe(1);
    expect(await pendingPhotoBytes()).toBe(before);
  });

  it('сообщение о переполнении объясняет, что делать', async () => {
    const msg = photoQueueFullMessage(PHOTO_QUEUE_MAX_BYTES - 1024, 4096);
    expect(msg).toContain('МБ');
    expect(msg.toLowerCase()).toContain('связ');
  });
});

describe('отправка накопленных фото', () => {
  it('успех — фото уходит из очереди', async () => {
    await add('ok.jpg');
    const upload = vi.fn().mockResolvedValue(undefined);

    const r = await sendPendingPhotos(upload);

    expect(r).toMatchObject({ succeeded: 1, failedSoft: 0, failedHard: 0 });
    expect(await countPendingPhotos()).toBe(0);
    expect(upload).toHaveBeenCalledOnce();
  });

  it('нет связи — фото ОСТАЁТСЯ и будет повторено', async () => {
    await add('в-подвале.jpg');
    const upload = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const r = await sendPendingPhotos(upload);

    expect(r).toMatchObject({ succeeded: 0, failedSoft: 1, failedHard: 0 });
    const [item] = await listPendingPhotos();
    expect(item!.attempts).toBe(1);
    expect(item!.failedHard).toBeFalsy();
  });

  /**
   * Отказ по существу (хранилище не приняло файл) фото НЕ удаляет: удалить —
   * значит потерять единственный снимок. Оно остаётся в списке «не отправлено»
   * с причиной, но само больше не повторяется, чтобы не биться в стену при
   * каждом возврате связи.
   */
  it('отказ хранилища не стирает фото, но и не повторяется сам', async () => {
    await add('отклонённое.jpg');
    const upload = vi.fn().mockRejectedValue(new Error('storage PUT 403'));

    const first = await sendPendingPhotos(upload);
    expect(first).toMatchObject({ succeeded: 0, failedSoft: 0, failedHard: 1 });

    const [item] = await listPendingPhotos();
    expect(item!.failedHard).toBe(true);
    expect(item!.lastError).toContain('администратора');

    // Второй заход трогать его уже не должен.
    const second = await sendPendingPhotos(upload);
    expect(second).toMatchObject({ succeeded: 0, failedSoft: 0, failedHard: 0 });
    expect(upload).toHaveBeenCalledOnce();
    expect(await countPendingPhotos()).toBe(1);
  });

  it('снимок инженера А не уходит, пока неизвестно, кто за телефоном', async () => {
    // Запуск приложения: очередь из IndexedDB готова сразу, имя вошедшего
    // приходит с сервера позже. Отправлять в этот промежуток нельзя —
    // снимок записался бы на того, чья сессия окажется живой.
    setCurrentUserId('engineer-A');
    await add('чужое.jpg');

    setCurrentUserId(null);
    const upload = vi.fn().mockResolvedValue(undefined);
    const r = await sendPendingPhotos(upload);

    expect(upload).not.toHaveBeenCalled();
    expect(r.skippedOther).toBe(1);
    expect(await countPendingPhotos()).toBe(1);

    // Имя пришло — снимок уходит.
    setCurrentUserId('engineer-A');
    const r2 = await sendPendingPhotos(upload);
    expect(r2.succeeded).toBe(1);
    expect(await countPendingPhotos()).toBe(0);
  });

  it('бизнес-отказ сервера тоже не стирает файл', async () => {
    await add('квота.jpg');
    const trpcErr = new TRPCClientError<AppRouter>('Слишком большой файл', {
      result: {
        error: {
          code: -32600,
          message: 'PAYLOAD_TOO_LARGE',
          data: {
            code: 'PAYLOAD_TOO_LARGE',
            httpStatus: 413,
            path: 'attachments.createUploadUrl',
          },
        },
      },
    } as never);
    const upload = vi.fn().mockRejectedValue(trpcErr);

    const r = await sendPendingPhotos(upload);

    expect(r.failedHard).toBe(1);
    expect(await countPendingPhotos()).toBe(1);
  });

  it('смешанная пачка разбирается по одному', async () => {
    await add('1.jpg');
    await add('2.jpg');
    await add('3.jpg');
    let i = 0;
    const upload = vi.fn().mockImplementation(async () => {
      i++;
      if (i === 1) return;
      if (i === 2) throw new TypeError('Failed to fetch');
      throw new Error('storage PUT 403');
    });

    const r = await sendPendingPhotos(upload);

    expect(r).toMatchObject({ succeeded: 1, failedSoft: 1, failedHard: 1 });
    expect(await countPendingPhotos()).toBe(2);
  });
});
