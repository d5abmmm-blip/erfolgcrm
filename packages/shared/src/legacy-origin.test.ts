/**
 * Признак «запись из старой системы».
 *
 * Проверяем ровно то, на чём он держится: версия идентификатора. Импорт выдаёт
 * версию 5, приложение — 4 или 7. Ошибка здесь стоила бы дорого: пометка «перенос»
 * на своей заявке заставит менеджера не доверять и остальным пометкам.
 */
import { describe, it, expect } from 'vitest';
import { isLegacyId, isLegacyNumber, LEGACY_LABEL, LEGACY_LABEL_SHORT } from './legacy-origin';

// Реальные формы идентификаторов: версия — 15-й символ строки.
const V5 = '3f2504e0-4f89-51d3-9a0c-0305e82c3301'; // так выглядит перенесённая запись
const V4 = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
const V7 = '018f3e4a-7c2b-7d1e-8f2a-1b2c3d4e5f60';

describe('признак переноса по идентификатору', () => {
  it('версия 5 — запись из старой системы', () => {
    expect(isLegacyId(V5)).toBe(true);
  });

  it('версии 4 и 7 — записи самой CRM', () => {
    expect(isLegacyId(V4)).toBe(false);
    expect(isLegacyId(V7)).toBe(false);
  });

  it('регистр букв в идентификаторе не важен для позиции версии', () => {
    expect(isLegacyId(V5.toUpperCase())).toBe(true);
    expect(isLegacyId(V4.toUpperCase())).toBe(false);
  });

  it('пусто и мусор — не помечаем: неизвестное происхождение не повод рисовать метку', () => {
    expect(isLegacyId(null)).toBe(false);
    expect(isLegacyId(undefined)).toBe(false);
    expect(isLegacyId('')).toBe(false);
    expect(isLegacyId('не-идентификатор')).toBe(false);
    expect(isLegacyId('123')).toBe(false);
  });
});

describe('признак переноса по номеру', () => {
  it('номера старой системы начинаются с WSP-', () => {
    expect(isLegacyNumber('WSP-1234')).toBe(true);
  });

  it('номера CRM — нет', () => {
    expect(isLegacyNumber('T-2026-000042')).toBe(false);
    expect(isLegacyNumber('WO-2026-000042')).toBe(false);
  });

  it('пусто — нет', () => {
    expect(isLegacyNumber(null)).toBe(false);
    expect(isLegacyNumber('')).toBe(false);
  });

  it('подстрока в середине не считается — только начало номера', () => {
    expect(isLegacyNumber('T-2026-WSP-1')).toBe(false);
  });
});

describe('подписи', () => {
  it('одно слово на весь интерфейс, чтобы не расползлось синонимами', () => {
    expect(LEGACY_LABEL).toBe('из старой системы');
    expect(LEGACY_LABEL_SHORT).toBe('перенос');
  });
});
