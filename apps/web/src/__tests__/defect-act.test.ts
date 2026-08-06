/**
 * buildDefectActDoc — структура дефектного акта:
 *   • заголовок «ДЕФЕКТНЫЙ АКТ № … от …» (номер по умолчанию = номер заявки);
 *   • блок владельца (название, телефон, адрес, оборудование, год ввода, причина);
 *   • разделы «Выполненные работы» и «Заключение о причинах неисправности»;
 *   • таблица позиций + ИТОГО; подписи сторон;
 *   • устойчивость к пустому наряду (рисуется пустая строка, без падения).
 */
import { describe, it, expect } from 'vitest';
import { buildDefectActDoc, type PrintDefectActInput } from '../lib/pdf/defect-act';

const base: PrintDefectActInput = {
  barcodeDataUrl: '',
  tenant: {
    legalName: 'ООО «Эрфольг»',
    displayName: 'ERFOLG',
    slogan: 'Ремонт медтехники',
    inn: '2014006736',
    kpp: '201401001',
    ogrn: null,
    legalAddress: 'г. Грозный, ул. Мичурина, 98',
    phone: '8 (928) 895-70-70',
    email: null,
    bankName: null,
    bankAccount: null,
    correspondentAccount: null,
    bik: null,
    licenseSeries: 'ФС-99-04',
    licenseNumber: '000295',
    licenseDate: '2013-08-21',
    licenseAuthority: 'Росздравнадзор',
    director: 'Хаджиев Т. Р.',
  },
  client: {
    displayName: 'ГБУ «РДКБ им. Е.П. Глинки»',
    inn: '2004000020',
    kpp: '201501001',
    ogrn: null,
    legalAddress: 'г. Грозный, ул. Бисултанова, E101',
    phone: '89635868066',
    contactName: 'Сайдов Р. Л.',
    contactPosition: 'Инженер',
  },
  asset: {
    model: 'Fabius plus',
    manufacturer: 'Drager',
    serialNumber: 'BA144',
    inventoryNumber: 'ИНВ-12',
    riskClass: '2b',
    commissionedAt: '2009-05-01',
  },
  ticket: {
    ticketNumber: 'T-183',
    receivedAt: '2026-05-29T09:00:00.000Z',
    repairType: 'paid',
    symptom: 'Не работает',
    barcode: '4600000067155',
  },
  workOrder: {
    vatRate: '5',
    worksAmountKopecks: 0,
    partsAmountKopecks: 0,
    expensesAmountKopecks: 0,
    totalAmountKopecks: 0,
    diagnosis: 'Выработан ресурс расходных материалов.',
    repairDescription: 'Требуется замена платы управления, ремкомплекта; настройка ПО.',
    recommendation: 'Ремонт сопоставим с базовой ценой изделия — рекомендовано к списанию.',
    lines: [
      {
        lineType: 'work',
        name: 'Диагностика',
        unit: 'шт.',
        quantity: 1,
        unitPriceKopecks: 0,
        amountKopecks: 0,
      },
    ],
  },
};

function jsonOf(input: PrintDefectActInput): string {
  return JSON.stringify(buildDefectActDoc(input));
}

describe('buildDefectActDoc', () => {
  it('заголовок: номер по умолчанию = номер заявки, дата = receivedAt', () => {
    const json = jsonOf(base);
    expect(json).toContain('ДЕФЕКТНЫЙ АКТ № T-183 от 29.05.2026');
  });

  it('actNumber и issuedAt переопределяют номер и дату', () => {
    const json = jsonOf({ ...base, actNumber: '183', issuedAt: '2026-06-01T00:00:00.000Z' });
    expect(json).toContain('ДЕФЕКТНЫЙ АКТ № 183 от 01.06.2026');
  });

  it('блок владельца: название, телефон, адрес, оборудование, год ввода, причина', () => {
    const json = jsonOf(base);
    expect(json).toContain('Владелец оборудования:');
    expect(json).toContain('ГБУ «РДКБ им. Е.П. Глинки»');
    expect(json).toContain('89635868066');
    expect(json).toContain('Drager; Fabius plus; S/N: BA144');
    expect(json).toContain('Год выпуска/ввода:');
    expect(json).toContain('2009');
    expect(json).toContain('Причина обращения:');
    expect(json).toContain('Не работает');
  });

  it('разделы работ и заключения берутся из наряда', () => {
    const json = jsonOf(base);
    expect(json).toContain('Выполненные работы:');
    expect(json).toContain('Требуется замена платы управления');
    expect(json).toContain('Заключение о причинах неисправности:');
    expect(json).toContain('рекомендовано к списанию');
  });

  it('таблица позиций + ИТОГО + подписи сторон', () => {
    const json = jsonOf(base);
    expect(json).toContain('Наименование работ и комплектующих');
    expect(json).toContain('Диагностика');
    expect(json).toContain('ИТОГО:');
    expect(json).toContain('С актом ознакомлен(а):');
    expect(json).toContain('Работу выполнил:');
  });

  it('пустой наряд: рисуется без падения, ИТОГО 0,00', () => {
    const json = jsonOf({
      ...base,
      workOrder: { ...base.workOrder, lines: [], totalAmountKopecks: 0 },
    });
    expect(json).toContain('ДЕФЕКТНЫЙ АКТ');
    expect(json).toContain('0,00');
  });

  it('исполнитель: executorName имеет приоритет над директором', () => {
    expect(jsonOf({ ...base, executorName: 'Алероев А. А.' })).toContain('Алероев А. А.');
    // без executorName — подставляется директор
    expect(jsonOf(base)).toContain('Хаджиев Т. Р.');
  });
});
