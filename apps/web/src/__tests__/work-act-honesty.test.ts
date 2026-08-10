/**
 * «Оборудование передано Заказчику в исправном состоянии» — фактическое
 * утверждение в подписываемом акте. Печатать его можно только когда данные
 * наряда его подтверждают: ремонт описан, а заключение не отправляет технику
 * в списание. Иначе в «Пакете документов» акт работ утверждал исправность
 * прямо рядом с дефектным актом «Рекомендовано к списанию».
 *
 * Нейтральная формула «Стороны претензий … не имеют» остаётся всегда —
 * она про объём и качество работ, а не про состояние техники.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkActDoc } from '../lib/pdf/work-act';
import type { BuildWorkActInput } from '../lib/pdf/work-act';

const HEALTHY = 'Оборудование передано Заказчику в исправном состоянии.';
const NO_CLAIMS = 'Стороны претензий по объёму, качеству и срокам выполнения работ не имеют.';

const base: BuildWorkActInput = {
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
    displayName: 'ГБУ «Наурская ЦРБ»',
    inn: '2008000077',
    kpp: null,
    ogrn: null,
    legalAddress: null,
    phone: null,
    contactName: 'Сайдов Р. Л.',
    contactPosition: 'Инженер',
  },
  asset: {
    model: 'Savina 300',
    manufacturer: 'Drager',
    serialNumber: 'ASGH-19-04471',
    inventoryNumber: null,
    riskClass: '2b',
    commissionedAt: null,
  },
  ticket: {
    ticketNumber: 'T-2026-000001',
    receivedAt: '2026-05-29T09:00:00.000Z',
    repairType: 'paid',
    symptom: 'Не включается',
    barcode: '4600000067155',
  },
  workOrder: {
    vatRate: '5',
    worksAmountKopecks: 10_000,
    partsAmountKopecks: 0,
    expensesAmountKopecks: 0,
    totalAmountKopecks: 10_000,
    diagnosis: 'Выход из строя платы управления.',
    repairDescription: 'Заменена плата управления, проведена калибровка.',
    recommendation: null,
    lines: [
      {
        lineType: 'work',
        name: 'Диагностика',
        unit: 'шт.',
        quantity: 1,
        unitPriceKopecks: 10_000,
        amountKopecks: 10_000,
      },
    ],
  },
};

function jsonOf(input: BuildWorkActInput): string {
  return JSON.stringify(buildWorkActDoc(input));
}

function withWorkOrder(patch: Partial<BuildWorkActInput['workOrder']>): BuildWorkActInput {
  return { ...base, workOrder: { ...base.workOrder, ...patch } };
}

describe('акт работ не утверждает исправность, когда данные её не подтверждают', () => {
  it('ремонт описан, списания нет — фраза об исправности печатается', () => {
    const json = jsonOf(base);
    expect(json).toContain(HEALTHY);
    expect(json).toContain(NO_CLAIMS);
  });

  it('заключение «Рекомендовано к списанию» — исправность НЕ утверждается', () => {
    const json = jsonOf(withWorkOrder({ recommendation: 'Рекомендовано к списанию.' }));
    expect(json).not.toContain(HEALTHY);
    // Нейтральная формула про работы остаётся: претензий к работам нет.
    expect(json).toContain(NO_CLAIMS);
  });

  it('регистр не спасает: «СПИСАНИЕ» в заключении тоже гасит фразу', () => {
    const json = jsonOf(
      withWorkOrder({ recommendation: 'ДАЛЬНЕЙШАЯ ЭКСПЛУАТАЦИЯ НЕЦЕЛЕСООБРАЗНА, СПИСАНИЕ' }),
    );
    expect(json).not.toContain(HEALTHY);
  });

  it('ремонт не описан (только диагностика) — исправность НЕ утверждается', () => {
    const json = jsonOf(withWorkOrder({ repairDescription: null }));
    expect(json).not.toContain(HEALTHY);
    expect(json).toContain(NO_CLAIMS);
  });

  it('описание ремонта из одних пробелов — это не ремонт', () => {
    const json = jsonOf(withWorkOrder({ repairDescription: '   ' }));
    expect(json).not.toContain(HEALTHY);
  });

  it('обычная рекомендация (не списание) фразу не гасит', () => {
    const json = jsonOf(
      withWorkOrder({ recommendation: 'Рекомендуется замена фильтров раз в 6 месяцев.' }),
    );
    expect(json).toContain(HEALTHY);
  });
});
