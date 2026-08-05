/**
 * Сканер: одна находка открывается сразу, несколько — выбор списком.
 * Раньше при нескольких совпадениях (ручной ввод серийника) молча
 * открывалась первая попавшаяся заявка.
 */
import { describe, expect, it } from 'vitest';
import { pickScanResult } from '../lib/scan-pick';

const m = (id: string) => ({
  id,
  ticketNumber: `T-${id}`,
  clientDisplayName: null,
  assetModel: null,
});

describe('pickScanResult', () => {
  it('ничего не нашли', () => {
    expect(pickScanResult([])).toEqual({ kind: 'none' });
  });

  it('одна заявка — открываем сразу', () => {
    expect(pickScanResult([m('a')])).toEqual({ kind: 'one', id: 'a' });
  });

  it('несколько — отдаём список на выбор', () => {
    const pick = pickScanResult([m('a'), m('b')]);
    expect(pick.kind).toBe('many');
    if (pick.kind === 'many') expect(pick.matches).toHaveLength(2);
  });
});
