/**
 * Vitest setup для apps/web. Подменяем IndexedDB на fake-indexeddb,
 * чтобы тесты offline-очереди работали в jsdom без реального браузера.
 */
import 'fake-indexeddb/auto';

/**
 * jsdom не умеет `Blob.arrayBuffer()` — метод есть во всех браузерах с 2019
 * года (Chrome 76, Firefox 69, Safari 14), но не в этой заглушке. Без него
 * не проверить очередь фото, которая кладёт в память телефона сами байты.
 */
/**
 * jsdom не реализует `URL.createObjectURL` — превью неотправленных фото на неё
 * опираются. Отдаём заглушку: содержимое картинки в тестах не проверяем,
 * важно, что плитка рисуется и ссылка потом отзывается.
 */
if (typeof URL !== 'undefined' && typeof URL.createObjectURL !== 'function') {
  let n = 0;
  URL.createObjectURL = () => `blob:test/${++n}`;
  URL.revokeObjectURL = () => undefined;
}

if (typeof Blob !== 'undefined' && typeof Blob.prototype.arrayBuffer !== 'function') {
  Blob.prototype.arrayBuffer = function arrayBuffer(this: Blob): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as ArrayBuffer);
      reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
      reader.readAsArrayBuffer(this);
    });
  };
}
