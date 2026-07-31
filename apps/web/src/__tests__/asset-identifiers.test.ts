import { describe, it, expect } from 'vitest';
import { assetIdentifierLine } from '../lib/asset-identifiers';

/**
 * Одна строка опознания аппарата на всех экранах: серийный + инвентарный.
 * Главный кейс — «военный»: серийника нет, есть только инвентарный, и раньше
 * инженер не видел вообще ничего.
 */
describe('assetIdentifierLine — как подписан аппарат', () => {
  it('есть только инвентарный → показываем его (кейс военных частей)', () => {
    expect(assetIdentifierLine({ serialNumber: null, inventoryNumber: 'ИНВ-4415' })).toBe(
      'инв. № ИНВ-4415',
    );
  });

  it('есть только серийный → показываем его (как было)', () => {
    expect(assetIdentifierLine({ serialNumber: 'ASGH-19-04471', inventoryNumber: null })).toBe(
      'S/N ASGH-19-04471',
    );
  });

  it('есть оба → показываем оба, серийный первым', () => {
    expect(
      assetIdentifierLine({ serialNumber: 'ASGH-19-04471', inventoryNumber: 'ИНВ-4415' }),
    ).toBe('S/N ASGH-19-04471 · инв. № ИНВ-4415');
  });

  it('нет ни одного → пустая строка (место на экране не занимаем)', () => {
    expect(assetIdentifierLine({ serialNumber: null, inventoryNumber: null })).toBe('');
  });

  it('пробелы и пустые строки считаются отсутствием номера', () => {
    // Импорт из WinServisePro и ручной ввод оставляют «   » вместо NULL.
    expect(assetIdentifierLine({ serialNumber: '   ', inventoryNumber: '' })).toBe('');
    expect(assetIdentifierLine({ serialNumber: ' ', inventoryNumber: ' ИНВ-7 ' })).toBe(
      'инв. № ИНВ-7',
    );
  });

  it('поля можно не передавать вовсе (undefined = нет номера)', () => {
    expect(assetIdentifierLine({})).toBe('');
    expect(assetIdentifierLine({ inventoryNumber: 'ИНВ-1' })).toBe('инв. № ИНВ-1');
  });
});
