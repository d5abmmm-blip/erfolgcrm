/**
 * Юнит-тесты разбора вложений AI-ассистента (extract.ts) — без БД и без LLM.
 * Проверяем маршрутизацию по типам: картинки → image, текст → text, прочее → unsupported.
 */
import { describe, it, expect } from 'vitest';
import { processAttachment, isImageMime } from '../modules/ai-assistant/extract';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');

describe('isImageMime', () => {
  it('распознаёт картинки и отвергает прочее', () => {
    expect(isImageMime('image/png')).toBe(true);
    expect(isImageMime('image/JPEG')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
    expect(isImageMime('text/plain')).toBe(false);
  });
});

describe('processAttachment', () => {
  it('картинку отдаёт как image с data-URL', async () => {
    const data = b64('fake-bytes');
    const r = await processAttachment({ name: 'photo.png', mimeType: 'image/png', dataBase64: data });
    expect(r.kind).toBe('image');
    if (r.kind === 'image') {
      expect(r.imageDataUrl).toBe(`data:image/png;base64,${data}`);
    }
  });

  it('текстовый файл извлекает как text', async () => {
    const r = await processAttachment({
      name: 'note.txt',
      mimeType: 'text/plain',
      dataBase64: b64('Договор №42 от 01.06.2026'),
    });
    expect(r.kind).toBe('text');
    if (r.kind === 'text') expect(r.text).toContain('Договор №42');
  });

  it('неизвестный формат помечает unsupported', async () => {
    const r = await processAttachment({
      name: 'archive.zip',
      mimeType: 'application/zip',
      dataBase64: b64('PK...'),
    });
    expect(r.kind).toBe('unsupported');
    if (r.kind === 'unsupported') expect(r.note).toMatch(/не поддерживается/i);
  });

  it('определяет тип по расширению, если MIME пустой/общий', async () => {
    const r = await processAttachment({
      name: 'reqs.txt',
      mimeType: 'application/octet-stream',
      dataBase64: b64('ИНН 7700000000'),
    });
    expect(r.kind).toBe('text');
  });
});
