/**
 * Тесты хелпера публичного базового адреса (для трек-ссылок клиенту в письмах).
 *
 * Покрытие:
 *   • resolvePublicBaseUrl — берёт API_PUBLIC_URL, обрезает хвостовые слэши, null если пусто.
 *   • buildTrackUrl — собирает /track/<token>, null при ненастроенном адресе (деградация).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTrackUrl, resolvePublicBaseUrl } from '../lib/public-url';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolvePublicBaseUrl', () => {
  it('возвращает адрес без хвостового слэша', () => {
    vi.stubEnv('API_PUBLIC_URL', 'https://crm.erfolgmt.ru/');
    expect(resolvePublicBaseUrl()).toBe('https://crm.erfolgmt.ru');
  });

  it('возвращает адрес как есть, если слэша нет', () => {
    vi.stubEnv('API_PUBLIC_URL', 'https://crm.erfolgmt.ru');
    expect(resolvePublicBaseUrl()).toBe('https://crm.erfolgmt.ru');
  });

  it('null, если переменная пустая', () => {
    vi.stubEnv('API_PUBLIC_URL', '');
    expect(resolvePublicBaseUrl()).toBeNull();
  });

  it('null и триммит пробелы', () => {
    vi.stubEnv('API_PUBLIC_URL', '   ');
    expect(resolvePublicBaseUrl()).toBeNull();
  });
});

describe('buildTrackUrl', () => {
  it('собирает полный URL страницы трека', () => {
    vi.stubEnv('API_PUBLIC_URL', 'https://crm.erfolgmt.ru');
    expect(buildTrackUrl('8f2a3c1d-0000-4000-8000-000000000abc')).toBe(
      'https://crm.erfolgmt.ru/track/8f2a3c1d-0000-4000-8000-000000000abc',
    );
  });

  it('null, если базовый адрес не настроен (письмо уходит без ссылки)', () => {
    vi.stubEnv('API_PUBLIC_URL', '');
    expect(buildTrackUrl('any-token')).toBeNull();
  });
});
