/**
 * Локальный поиск по загруженной очереди инженера (до 500 заявок во «Все» —
 * без поиска оставался только скролл или сканер).
 */
import { describe, expect, it } from 'vitest';
import { filterQueue } from '../lib/queue-filter';

const items = [
  {
    ticketNumber: 'T-2026-000023',
    clientDisplayName: 'ГБУ «Республиканский онкологический диспансер»',
    assetModel: 'Секторный фазированный датчик M5Sc-D',
    assetSerialNumber: '5446812',
    assetInventoryNumber: null,
  },
  {
    ticketNumber: 'WSP-6790',
    clientDisplayName: 'ГБУ «РКБСМП им. У.И.Ханбиева»',
    assetModel: 'DC-7',
    assetSerialNumber: 'MX-2C004510',
    assetInventoryNumber: 'ИНВ-000123',
  },
];

describe('filterQueue', () => {
  it('пустой запрос возвращает всё как есть', () => {
    expect(filterQueue(items, '')).toHaveLength(2);
    expect(filterQueue(items, '   ')).toHaveLength(2);
  });

  it('ищет по номеру заявки без учёта регистра', () => {
    expect(filterQueue(items, 'wsp-6790')).toHaveLength(1);
    expect(filterQueue(items, 'wsp-6790')[0]?.ticketNumber).toBe('WSP-6790');
  });

  it('ищет по клиенту, модели, серийному и инвентарному', () => {
    expect(filterQueue(items, 'онкологический')).toHaveLength(1);
    expect(filterQueue(items, 'dc-7')).toHaveLength(1);
    expect(filterQueue(items, '5446812')).toHaveLength(1);
    expect(filterQueue(items, 'инв-000123')).toHaveLength(1);
  });

  it('ничего не нашлось — пустой список, null-поля не роняют', () => {
    expect(filterQueue(items, 'нет-такого')).toHaveLength(0);
  });
});
