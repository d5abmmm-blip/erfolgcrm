/**
 * Тексты ошибок загрузки фото.
 *
 * Инженер в поле видел «Failed to fetch» и «storage PUT 403» — по такому
 * сообщению непонятно, что делать: повторить, позвать администратора или
 * сниматься заново. Плюс сам файл после ошибки терялся: он жил только в
 * замыкании обработчика.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { humanUploadError } from '../components/PhotoUploader';

function setOnline(value: boolean) {
  Object.defineProperty(globalThis.navigator, 'onLine', { configurable: true, value });
}
afterEach(() => setOnline(true));

describe('человеческий текст ошибки загрузки фото', () => {
  it('обрыв связи объясняется по-человечески', () => {
    setOnline(true);
    expect(humanUploadError(new Error('Failed to fetch'))).toBe('Нет связи — фото не отправлено');
  });

  it('офлайн определяется даже при непонятной ошибке', () => {
    setOnline(false);
    expect(humanUploadError(new Error('что-то странное'))).toBe('Нет связи — фото не отправлено');
  });

  it('отказ хранилища по правам зовёт администратора', () => {
    setOnline(true);
    expect(humanUploadError(new Error('storage PUT 403'))).toContain('администратора');
  });

  it('сбой хранилища предлагает повторить', () => {
    setOnline(true);
    expect(humanUploadError(new Error('storage PUT 502'))).toContain('повторите');
  });

  it('прочие 4xx — файл не принят', () => {
    setOnline(true);
    expect(humanUploadError(new Error('storage PUT 413'))).toBe('Файл не принят хранилищем');
  });

  it('пустая ошибка не оставляет человека без текста', () => {
    setOnline(true);
    expect(humanUploadError(undefined)).toBe('Не удалось отправить фото');
    expect(humanUploadError({})).toBe('Не удалось отправить фото');
  });
});
