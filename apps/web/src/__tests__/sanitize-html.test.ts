/**
 * sanitizeEmailHtml (раздел «Почта», Этап 5 — безопасный показ HTML):
 * вырезает скрипты/обработчики/javascript:-ссылки/inline-стили, сохраняет базовое форматирование,
 * внешним ссылкам добавляет target=_blank + rel=noopener.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeEmailHtml } from '../lib/sanitize-html';

describe('sanitizeEmailHtml', () => {
  it('вырезает <script>', () => {
    const out = sanitizeEmailHtml('<p>привет</p><script>alert(1)</script>');
    expect(out).toContain('привет');
    expect(out).not.toContain('<script');
    expect(out).not.toContain('alert(1)');
  });

  it('убирает обработчики on* (onerror)', () => {
    const out = sanitizeEmailHtml('<img src="x" onerror="alert(1)">');
    expect(out).not.toContain('onerror');
    expect(out).not.toContain('alert(1)');
  });

  it('убирает javascript:-ссылки', () => {
    const out = sanitizeEmailHtml('<a href="javascript:alert(1)">клик</a>');
    expect(out).not.toContain('javascript:');
    expect(out).toContain('клик');
  });

  it('сохраняет базовое форматирование и адрес ссылки', () => {
    const out = sanitizeEmailHtml(
      '<p><b>жирный</b> и <a href="https://erfolgmt.ru">ссылка</a></p>',
    );
    expect(out).toContain('<b>жирный</b>');
    expect(out).toContain('href="https://erfolgmt.ru"');
  });

  it('внешним ссылкам добавляет target=_blank и rel=noopener', () => {
    const out = sanitizeEmailHtml('<a href="https://erfolgmt.ru">x</a>');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('вырезает <style> и inline-стили (защита от наложения на интерфейс)', () => {
    const out = sanitizeEmailHtml(
      '<style>body{display:none}</style><p style="position:fixed">текст</p>',
    );
    expect(out).not.toContain('<style');
    expect(out).not.toContain('position:fixed');
    expect(out).toContain('текст');
  });
});
