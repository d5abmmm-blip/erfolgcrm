/**
 * «Работы выполнили: …» в акте выполненных работ.
 *
 * Третий шаг из трёх, которые просил владелец по нескольким инженерам на заявку:
 * когда на технику выезжают вдвоём, в акте должно быть видно обоих.
 *
 * ⚠️ ГРАНИЦА, которую тесты и сторожат: это СПРАВОЧНАЯ строка, а не юридическая.
 * «Исполнитель» по акту — организация, подпись ставит директор. Фамилии инженеров
 * туда не подставляются и не должны: акт заключается между двумя юрлицами.
 */
import { describe, it, expect } from 'vitest';
import { buildWorkActDoc } from '../lib/pdf/work-act';
import type { BuildWorkActInput } from '../lib/pdf/work-act';
import type { WorkOrderLine } from '../lib/pdf/shared';

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
    diagnosis: null,
    repairDescription: null,
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

/** Наряд, где работы выполняли двое. */
function withTwoPerformers(): BuildWorkActInput {
  return {
    ...base,
    workOrder: {
      ...base.workOrder,
      lines: [
        { ...base.workOrder.lines[0]!, engineerName: 'Зукаев М. М.' },
        {
          lineType: 'work',
          name: 'Замена платы',
          unit: 'шт.',
          quantity: 1,
          unitPriceKopecks: 20_000,
          amountKopecks: 20_000,
          engineerName: 'Алероев А. А.',
        },
      ],
    },
  };
}

describe('в акте видно всех, кто работал', () => {
  it('двое исполнителей — перечислены оба', () => {
    const json = jsonOf(withTwoPerformers());
    expect(json).toContain('Работы выполнили:');
    expect(json).toContain('Зукаев М. М.');
    expect(json).toContain('Алероев А. А.');
  });

  it('один исполнитель — заголовок в единственном числе', () => {
    const one = withTwoPerformers();
    one.workOrder.lines = [one.workOrder.lines[0]!];
    const json = jsonOf(one);
    expect(json).toContain('Работы выполнил:');
    expect(json).not.toContain('Работы выполнили:');
  });

  it('один человек на двух строках не двоится', () => {
    const same = withTwoPerformers();
    same.workOrder.lines = same.workOrder.lines.map((l: WorkOrderLine) => ({
      ...l,
      engineerName: 'Зукаев М. М.',
    }));
    const json = jsonOf(same);
    expect(json.split('Зукаев М. М.').length - 1).toBe(1);
  });
});

describe('акт без исполнителей выглядит как раньше', () => {
  it('инженеры в строках не заданы — блока нет вовсе', () => {
    const json = jsonOf(base);
    expect(json).not.toContain('Работы выполнил');
  });

  it('инженер стоит только у ЗАПЧАСТИ — в блок не попадает', () => {
    // Зарплата и участие считаются по работам; запчасть выдал кладовщик, а не «выполнил».
    const partOnly: BuildWorkActInput = {
      ...base,
      workOrder: {
        ...base.workOrder,
        lines: [
          {
            lineType: 'part',
            name: 'Плата управления',
            unit: 'шт.',
            quantity: 1,
            unitPriceKopecks: 50_000,
            amountKopecks: 50_000,
            engineerName: 'Зукаев М. М.',
          },
        ],
      },
    };
    expect(jsonOf(partOnly)).not.toContain('Работы выполнил');
  });
});

describe('ГРАНИЦА: юридическая часть акта не тронута', () => {
  it('«Исполнитель» остаётся организацией, подпись — директора', () => {
    const json = jsonOf(withTwoPerformers());
    expect(json).toContain('Исполнитель');
    expect(json).toContain('ООО «Эрфольг»');
    expect(json).toContain('Хаджиев Т. Р.');
  });
});

describe('дата акта', () => {
  it('по умолчанию — день составления, не дата приёмки', () => {
    // Акт, напечатанный через месяц после приёмки, раньше датировался задним
    // числом (receivedAt). Дата документа = день, когда его составили.
    const today = new Date().toLocaleDateString('ru-RU');
    const json = jsonOf(withTwoPerformers());
    expect(json).toContain(`от ${today}`);
    expect(json).not.toContain('от 29.05.2026');
  });

  it('переданный issuedAt переопределяет', () => {
    const json = JSON.stringify(
      buildWorkActDoc({ ...withTwoPerformers(), issuedAt: '2026-06-01T00:00:00.000Z' }),
    );
    expect(json).toContain('от 01.06.2026');
  });
});
