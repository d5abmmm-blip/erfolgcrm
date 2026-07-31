/**
 * Ярлык на технику 58×40 мм — его клеит инженер прямо на аппарат.
 *
 * До правки на ярлыке печатались только производитель и серийник, поэтому у
 * «инвентарных» заказчиков (военные части, госбольницы) ярлык выходил без
 * единого номера — по нему аппарат не опознать.
 */
import { describe, it, expect } from 'vitest';
import { buildAssetLabelDoc } from '../lib/pdf/asset-label';

const base = {
  barcodeDataUrl: '',
  ticket: null,
  fallbackBarcode: '0d3f2c6a-1111-4444-8888-aaaabbbbcccc',
  tenantDisplayName: 'ERFOLG',
};

function jsonOf(asset: {
  model: string;
  manufacturer: string | null;
  serialNumber: string | null;
  inventoryNumber: string | null;
}): string {
  return JSON.stringify(
    buildAssetLabelDoc({ ...base, asset: { ...asset, riskClass: null, commissionedAt: null } }),
  );
}

describe('buildAssetLabelDoc — номера на ярлыке', () => {
  it('печатает инвентарный номер, когда серийника нет', () => {
    const json = jsonOf({
      model: 'Дефибриллятор ДКИ-Н-10',
      manufacturer: 'Аксион',
      serialNumber: null,
      inventoryNumber: 'ИНВ-4415',
    });
    expect(json).toContain('инв. ИНВ-4415');
  });

  it('печатает оба номера, когда есть оба', () => {
    const json = jsonOf({
      model: 'Автоклав',
      manufacturer: null,
      serialNumber: 'ASGH-19-04471',
      inventoryNumber: 'ИНВ-4415',
    });
    expect(json).toContain('s/n ASGH-19-04471');
    expect(json).toContain('инв. ИНВ-4415');
  });

  it('без номеров ярлык печатается как раньше, без падения', () => {
    const json = jsonOf({
      model: 'Отсасыватель',
      manufacturer: 'Армед',
      serialNumber: null,
      inventoryNumber: null,
    });
    expect(json).toContain('Отсасыватель');
    expect(json).toContain('Армед');
    expect(json).not.toContain('инв.');
  });
});
