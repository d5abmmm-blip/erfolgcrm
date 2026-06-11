/**
 * Unit-тесты PII-маскирования (lib/mask.ts).
 * Без БД: чистая логика, нужна только для гарантии что edge-кейсы не падают.
 */
import { describe, it, expect } from 'vitest';
import { maskEmail, maskPhone, maskName } from '../lib/mask';

describe('maskEmail', () => {
  it('returns placeholder for null/undefined/empty', () => {
    expect(maskEmail(null)).toBe('<no-email>');
    expect(maskEmail(undefined)).toBe('<no-email>');
    expect(maskEmail('')).toBe('<no-email>');
  });

  it('masks short user (1 char) keeping first letter', () => {
    expect(maskEmail('a@b.ru')).toBe('a***@b.ru');
  });

  it('masks normal email keeping first 2 chars', () => {
    expect(maskEmail('director@erfolgcrm.ru')).toBe('di***@erfolgcrm.ru');
  });

  it('masks 2-char user keeping first letter only', () => {
    expect(maskEmail('ab@x.ru')).toBe('a***@x.ru');
  });

  it('returns *** when no @ separator', () => {
    expect(maskEmail('not-an-email')).toBe('***');
  });

  it('returns *** when @ at start', () => {
    expect(maskEmail('@example.com')).toBe('***');
  });
});

describe('maskPhone', () => {
  it('returns placeholder for null/undefined', () => {
    expect(maskPhone(null)).toBe('<no-phone>');
    expect(maskPhone(undefined)).toBe('<no-phone>');
  });

  it('masks Russian phone with +7 prefix', () => {
    expect(maskPhone('+7 (999) 123-45-67')).toBe('79***67');
  });

  it('masks plain digits', () => {
    expect(maskPhone('89991234567')).toBe('89***67');
  });

  it('returns *** for too-short input (<6 digits)', () => {
    expect(maskPhone('123')).toBe('***');
    expect(maskPhone('12345')).toBe('***');
  });
});

describe('maskName', () => {
  it('returns placeholder for null/undefined', () => {
    expect(maskName(null)).toBe('<no-name>');
    expect(maskName(undefined)).toBe('<no-name>');
  });

  it('reduces single name to initial', () => {
    expect(maskName('Иван')).toBe('И.');
  });

  it('reduces multi-part name to initials', () => {
    expect(maskName('Иванов Иван Иванович')).toBe('И. И. И.');
  });

  it('handles extra whitespace', () => {
    expect(maskName('  Петров   Пётр  ')).toBe('П. П.');
  });
});
