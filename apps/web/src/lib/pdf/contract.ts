/**
 * Builder for "Договор оказания услуг" / "Договор на ТО медтехники".
 *
 * Шаблон опирается на бланк ООО Эрфольг (memory/project_real_documents.md):
 *   - Стороны: Исполнитель (СЦ) + Заказчик (клиент).
 *   - Предмет, срок, гарантия, порядок оплаты, штрафы и пеня — из terms.
 *   - VAT-rate подписывается у общей цены (если known).
 *
 * Цвета и БК-блок переиспользуют branding.ts.
 */

import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import { BRAND_GREY, BRAND_LIGHT_GREY, BRAND_PRIMARY } from './branding';
import { formatDate, vatRateLabel, type TenantData, type ClientData, type VatRate } from './shared';

export interface ContractTerms {
  performanceDays?: number;
  warrantyMonths?: number;
  prepaymentPercent?: number;
  paymentDueDays?: number;
  performancePenaltyPercent?: number;
  paymentPenaltyDailyPercent?: number;
  notes?: string;
}

export interface ContractData {
  contractNumber: string;
  /** ISO date (YYYY-MM-DD). */
  contractDate: string;
  type: 'service' | 'one_time';
  vatRate: VatRate;
  status: 'draft' | 'active' | 'expired' | 'terminated';
  validFrom: string | null;
  validUntil: string | null;
  terms: ContractTerms;
  notes: string | null;
}

export interface PrintContractInput {
  tenant: TenantData;
  client: ClientData;
  contract: ContractData;
}

const TYPE_LABEL: Record<ContractData['type'], string> = {
  service: 'Договор сервисного обслуживания',
  one_time: 'Договор на разовое выполнение работ',
};

function header(input: PrintContractInput): Content {
  const c = input.contract;
  return {
    columns: [
      {
        width: '*',
        stack: [
          { text: TYPE_LABEL[c.type], bold: true, fontSize: 16, color: BRAND_PRIMARY },
          {
            text: `№ ${c.contractNumber} от ${formatDate(c.contractDate)}`,
            fontSize: 11,
            color: BRAND_GREY,
            margin: [0, 2, 0, 0],
          },
        ],
      },
      {
        width: 'auto',
        stack: [
          { text: input.tenant.displayName, alignment: 'right', bold: true, color: BRAND_PRIMARY, fontSize: 14 },
          input.tenant.slogan
            ? { text: input.tenant.slogan, alignment: 'right', fontSize: 9, color: BRAND_GREY }
            : { text: '', fontSize: 1 },
        ],
      },
    ],
  };
}

function partiesBlock(input: PrintContractInput): Content {
  const t = input.tenant;
  const c = input.client;
  const tenantInn = t.inn ?? '—';
  const tenantKpp = t.kpp ?? '—';
  const clientInn = c.inn ?? '—';
  const clientKpp = c.kpp ?? '—';
  return {
    margin: [0, 14, 0, 0],
    columns: [
      {
        width: '*',
        stack: [
          { text: 'Исполнитель:', bold: true, fontSize: 10 },
          { text: t.legalName, fontSize: 10, margin: [0, 2, 0, 0] },
          { text: `ИНН ${tenantInn} / КПП ${tenantKpp}`, fontSize: 9, color: BRAND_GREY },
          ...(t.legalAddress ? [{ text: t.legalAddress, fontSize: 9 }] : []),
          ...(t.licenseSeries && t.licenseNumber
            ? [
                {
                  text: `Лицензия ${t.licenseSeries} № ${t.licenseNumber} от ${formatDate(t.licenseDate)}`,
                  fontSize: 9,
                },
                ...(t.licenseAuthority ? [{ text: t.licenseAuthority, fontSize: 9 }] : []),
              ]
            : []),
        ],
      },
      {
        width: '*',
        stack: [
          { text: 'Заказчик:', bold: true, fontSize: 10 },
          { text: c.displayName, fontSize: 10, margin: [0, 2, 0, 0] },
          { text: `ИНН ${clientInn} / КПП ${clientKpp}`, fontSize: 9, color: BRAND_GREY },
          ...(c.legalAddress ? [{ text: c.legalAddress, fontSize: 9 }] : []),
        ],
      },
    ],
    columnGap: 18,
  };
}

function preambleBlock(input: PrintContractInput): Content {
  const t = input.tenant;
  const c = input.client;
  return {
    margin: [0, 18, 0, 0],
    text: [
      { text: t.legalName, bold: true },
      ', именуемое в дальнейшем «Исполнитель», в лице директора ',
      { text: t.director, bold: true },
      ', действующего на основании Устава, с одной стороны, и ',
      { text: c.displayName, bold: true },
      `, именуемое в дальнейшем «Заказчик»${c.contactName ? ', в лице ' : ''}`,
      ...(c.contactName
        ? [
            { text: c.contactName, bold: true },
            c.contactPosition ? ` (${c.contactPosition})` : '',
            ', ',
          ]
        : []),
      'с другой стороны, заключили настоящий договор о нижеследующем:',
    ],
    fontSize: 10,
    lineHeight: 1.25,
  };
}

function sectionHeading(text: string): Content {
  return {
    text,
    bold: true,
    fontSize: 11,
    color: BRAND_PRIMARY,
    margin: [0, 14, 0, 4],
  };
}

function subjectBlock(input: PrintContractInput): Content {
  const isService = input.contract.type === 'service';
  const subject = isService
    ? 'Исполнитель обязуется выполнять работы по техническому обслуживанию и ремонту медицинской техники Заказчика, а Заказчик обязуется принять и оплатить выполненные работы. Перечень обслуживаемой техники определяется заявками Заказчика на основании настоящего договора.'
    : 'Исполнитель обязуется выполнить работы по ремонту/обслуживанию медицинского оборудования Заказчика по согласованной заявке, а Заказчик — принять и оплатить выполненные работы.';
  return {
    margin: [0, 0, 0, 0],
    stack: [sectionHeading('1. Предмет договора'), { text: subject, fontSize: 10, lineHeight: 1.25 }],
  };
}

function termsBlock(input: PrintContractInput): Content {
  const t = input.contract.terms;
  const performance = t.performanceDays
    ? `Срок выполнения работ — не более ${t.performanceDays} ${plural(t.performanceDays, 'дня', 'дней', 'дней')} с момента подачи заявки.`
    : 'Срок выполнения работ согласовывается сторонами по каждой заявке.';
  const warranty = t.warrantyMonths
    ? `Исполнитель гарантирует качество выполненных работ в течение ${t.warrantyMonths} ${plural(t.warrantyMonths, 'месяца', 'месяцев', 'месяцев')} с даты подписания акта.`
    : 'Гарантия на работы предоставляется в соответствии с действующим законодательством.';
  return {
    stack: [
      sectionHeading('2. Сроки и гарантия'),
      { text: performance, fontSize: 10, lineHeight: 1.25, margin: [0, 0, 0, 4] },
      { text: warranty, fontSize: 10, lineHeight: 1.25 },
    ],
  };
}

function pricingBlock(input: PrintContractInput): Content {
  const t = input.contract.terms;
  const lines: string[] = [];
  lines.push(
    `Стоимость работ определяется на основании прейскуранта Исполнителя, действующего на дату подачи заявки. ${t.performancePenaltyPercent ? '' : ''}НДС: ${vatRateLabel(input.contract.vatRate)}.`,
  );
  if (t.prepaymentPercent !== undefined) {
    lines.push(
      `Заказчик производит предоплату в размере ${t.prepaymentPercent}% от стоимости работ по выставленному счёту.`,
    );
  }
  if (t.paymentDueDays !== undefined) {
    lines.push(
      `Окончательный расчёт производится в течение ${t.paymentDueDays} ${plural(
        t.paymentDueDays,
        'банковского дня',
        'банковских дней',
        'банковских дней',
      )} с даты подписания акта выполненных работ.`,
    );
  } else {
    lines.push('Окончательный расчёт производится по факту подписания акта выполненных работ.');
  }
  return {
    stack: [
      sectionHeading('3. Стоимость и порядок оплаты'),
      ...lines.map((l) => ({ text: l, fontSize: 10, lineHeight: 1.25, margin: [0, 0, 0, 4] as [number, number, number, number] })),
    ],
  };
}

function penaltiesBlock(input: PrintContractInput): Content | null {
  const t = input.contract.terms;
  if (!t.performancePenaltyPercent && !t.paymentPenaltyDailyPercent) return null;
  const lines: string[] = [];
  if (t.performancePenaltyPercent) {
    lines.push(
      `За нарушение срока выполнения работ Исполнитель уплачивает Заказчику штраф в размере ${t.performancePenaltyPercent}% от стоимости этапа.`,
    );
  }
  if (t.paymentPenaltyDailyPercent) {
    lines.push(
      `За просрочку оплаты Заказчик уплачивает Исполнителю пеню в размере ${t.paymentPenaltyDailyPercent}% от просроченной суммы за каждый день просрочки.`,
    );
  }
  return {
    stack: [
      sectionHeading('4. Ответственность сторон'),
      ...lines.map((l) => ({ text: l, fontSize: 10, lineHeight: 1.25, margin: [0, 0, 0, 4] as [number, number, number, number] })),
    ],
  };
}

function validityBlock(input: PrintContractInput): Content {
  const c = input.contract;
  const range =
    c.validFrom || c.validUntil
      ? `Договор действует ${c.validFrom ? `с ${formatDate(c.validFrom)}` : 'с момента подписания'}${
          c.validUntil ? ` по ${formatDate(c.validUntil)}` : ' до полного исполнения сторонами обязательств'
        }.`
      : 'Договор вступает в силу с момента подписания и действует до полного исполнения сторонами своих обязательств.';
  return {
    stack: [
      sectionHeading('5. Срок действия договора'),
      { text: range, fontSize: 10, lineHeight: 1.25 },
    ],
  };
}

function signaturesBlock(input: PrintContractInput): Content {
  const t = input.tenant;
  return {
    margin: [0, 28, 0, 0],
    columns: [
      {
        width: '*',
        stack: [
          { text: 'Исполнитель:', bold: true, fontSize: 10 },
          { text: t.legalName, fontSize: 10, margin: [0, 2, 0, 0] },
          { text: ' ', margin: [0, 16, 0, 0] },
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.5, lineColor: BRAND_LIGHT_GREY }] },
          { text: `${t.director} / ____________`, fontSize: 9, margin: [0, 4, 0, 0] },
          { text: 'М.П.', fontSize: 9, color: BRAND_GREY, margin: [0, 8, 0, 0] },
        ],
      },
      {
        width: '*',
        stack: [
          { text: 'Заказчик:', bold: true, fontSize: 10 },
          { text: input.client.displayName, fontSize: 10, margin: [0, 2, 0, 0] },
          { text: ' ', margin: [0, 16, 0, 0] },
          { canvas: [{ type: 'line', x1: 0, y1: 0, x2: 200, y2: 0, lineWidth: 0.5, lineColor: BRAND_LIGHT_GREY }] },
          { text: '____________ / ____________', fontSize: 9, margin: [0, 4, 0, 0] },
          { text: 'М.П.', fontSize: 9, color: BRAND_GREY, margin: [0, 8, 0, 0] },
        ],
      },
    ],
    columnGap: 24,
  };
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export function buildContractDoc(input: PrintContractInput): TDocumentDefinitions {
  const sections: Content[] = [
    header(input),
    partiesBlock(input),
    preambleBlock(input),
    subjectBlock(input),
    termsBlock(input),
    pricingBlock(input),
  ];
  const penalties = penaltiesBlock(input);
  if (penalties) sections.push(penalties);
  sections.push(validityBlock(input));
  sections.push(signaturesBlock(input));

  return {
    pageSize: 'A4',
    pageMargins: [40, 40, 40, 40],
    defaultStyle: { font: 'Roboto' },
    content: sections,
    footer: (currentPage, pageCount) => ({
      text: `Стр. ${currentPage} из ${pageCount}`,
      fontSize: 8,
      color: BRAND_GREY,
      alignment: 'right',
      margin: [0, 0, 40, 16],
    }),
  };
}
