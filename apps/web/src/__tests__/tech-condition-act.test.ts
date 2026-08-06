/**
 * buildTechConditionActDoc — структура акта технического состояния:
 *   • заголовок «АКТ ТЕХНИЧЕСКОГО СОСТОЯНИЯ № … от …» (номер по умолчанию = номер заявки);
 *   • блок владельца/оборудования (+ класс риска, повод осмотра);
 *   • «Результат технического осмотра» из diagnosis, «Рекомендации» из recommendation;
 *   • чек-лист годности к эксплуатации (4 пункта);
 *   • НЕТ таблицы работ/цен (это не смета);
 *   • печать без наряда: разделы пустые, без падения;
 *   • подписи «Осмотр произвёл» (инженер) и «С актом ознакомлен(а)».
 */
import { describe, it, expect } from 'vitest';
import {
  buildTechConditionActDoc,
  type PrintTechConditionActInput,
} from '../lib/pdf/tech-condition-act';

const base: PrintTechConditionActInput = {
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
    model: 'Savina 300',
    manufacturer: 'Drager',
    serialNumber: 'ASGH-19-04471',
    inventoryNumber: 'ИНВ-12',
    riskClass: '2b',
    commissionedAt: '2019-05-01',
  },
  ticket: {
    ticketNumber: 'T-183',
    receivedAt: '2026-05-29T09:00:00.000Z',
    repairType: 'paid',
    symptom: 'Не выходит на рабочий режим',
    barcode: '4600000067155',
  },
  workOrder: {
    vatRate: '5',
    worksAmountKopecks: 0,
    partsAmountKopecks: 0,
    expensesAmountKopecks: 0,
    totalAmountKopecks: 0,
    diagnosis: 'Датчик расхода даёт показания вне допуска.',
    repairDescription: 'Заменён датчик расхода.',
    recommendation: 'До замены датчика эксплуатация не рекомендована.',
    lines: [
      {
        lineType: 'work',
        name: 'Диагностика',
        unit: 'шт.',
        quantity: 1,
        unitPriceKopecks: 5000,
        amountKopecks: 5000,
      },
    ],
  },
};

function jsonOf(input: PrintTechConditionActInput): string {
  return JSON.stringify(buildTechConditionActDoc(input));
}

describe('buildTechConditionActDoc', () => {
  it('заголовок: номер по умолчанию = номер заявки, дата = receivedAt', () => {
    expect(jsonOf(base)).toContain('АКТ ТЕХНИЧЕСКОГО СОСТОЯНИЯ № T-183 от 29.05.2026');
  });

  it('actNumber и issuedAt переопределяют номер и дату', () => {
    const json = jsonOf({ ...base, actNumber: '77', issuedAt: '2026-06-01T00:00:00.000Z' });
    expect(json).toContain('АКТ ТЕХНИЧЕСКОГО СОСТОЯНИЯ № 77 от 01.06.2026');
  });

  it('блок владельца: оборудование, класс риска, повод осмотра', () => {
    const json = jsonOf(base);
    expect(json).toContain('Владелец оборудования:');
    expect(json).toContain('ГБУ «РДКБ им. Е.П. Глинки»');
    expect(json).toContain('Drager; Savina 300; S/N: ASGH-19-04471');
    expect(json).toContain('Класс риска:');
    expect(json).toContain('Класс 2b');
    expect(json).toContain('Повод осмотра:');
    expect(json).toContain('Не выходит на рабочий режим');
  });

  it('осмотр и рекомендации берутся из наряда', () => {
    const json = jsonOf(base);
    expect(json).toContain('Результат технического осмотра:');
    expect(json).toContain('Датчик расхода даёт показания вне допуска.');
    expect(json).toContain('Рекомендации:');
    expect(json).toContain('До замены датчика эксплуатация не рекомендована.');
  });

  it('чек-лист годности: все 4 пункта', () => {
    const json = jsonOf(base);
    expect(json).toContain('Заключение о техническом состоянии:');
    expect(json).toContain('Исправно, годно к эксплуатации');
    expect(json).toContain('Годно к эксплуатации с ограничениями');
    expect(json).toContain('Неисправно, требуется ремонт');
    expect(json).toContain('Рекомендовано к списанию');
  });

  it('это НЕ смета: нет таблицы работ/цен и ИТОГО', () => {
    const json = jsonOf(base);
    expect(json).not.toContain('Наименование работ и комплектующих');
    expect(json).not.toContain('ИТОГО');
  });

  it('подписи: «Осмотр произвёл» (инженер) и «С актом ознакомлен(а)»', () => {
    const json = jsonOf(base);
    expect(json).toContain('Осмотр произвёл:');
    expect(json).toContain('инженер');
    expect(json).toContain('С актом ознакомлен(а):');
    expect(json).toContain('М.П.');
  });

  it('исполнитель: executorName имеет приоритет над директором', () => {
    expect(jsonOf({ ...base, executorName: 'Алероев А. А.' })).toContain('Алероев А. А.');
    expect(jsonOf(base)).toContain('Хаджиев Т. Р.');
  });

  it('без наряда: заголовок и чек-лист есть, осмотр/рекомендации пустые, без падения', () => {
    const json = jsonOf({ ...base, workOrder: null });
    expect(json).toContain('АКТ ТЕХНИЧЕСКОГО СОСТОЯНИЯ');
    expect(json).toContain('Результат технического осмотра:');
    expect(json).toContain('Рекомендовано к списанию');
    // текста осмотра из наряда быть не должно — печатается пустой бланк
    expect(json).not.toContain('Датчик расхода даёт показания вне допуска.');
  });
});
