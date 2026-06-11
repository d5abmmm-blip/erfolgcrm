/**
 * Brand colors and fallback Эрфольг requisites for PDF templates.
 * The fallback is used by callers that need defaults; templates themselves
 * always read tenant data from the input.
 */

export const BRAND_PRIMARY = '#29ABE2';
export const BRAND_ACCENT = '#F26522';
export const BRAND_GREY = '#666666';
export const BRAND_LIGHT_GREY = '#DDDDDD';

/**
 * Реальные реквизиты ООО Эрфольг (memory/project_real_documents.md).
 * Используется в PDF до появления tRPC endpoint'а tenant.settings.
 */
export const ERFOLG_FALLBACK = {
  legalName: 'Общество с ограниченной ответственностью «Эрфольг»',
  displayName: 'ERFOLG',
  slogan: 'Техническое обслуживание и ремонт медицинской техники',
  inn: '2014006736',
  kpp: '201401001',
  ogrn: null,
  legalAddress: '364031, Чеченская Республика, г. Грозный, ул. Мичурина, двлд 98',
  phone: '8 (928) 895-70-70',
  email: 'erfolgmt@mail.ru',
  bankName: 'ЧЕЧЕНСКИЙ РФ АО «РОССЕЛЬХОЗБАНК», г. Грозный',
  bankAccount: '40702810734000003523',
  correspondentAccount: '30101810600000000719',
  bik: '049690719',
  licenseSeries: 'ФС-99-04',
  licenseNumber: '000295',
  licenseDate: '2013-08-21',
  licenseAuthority: 'Росздравнадзор',
  director: 'Хаджиев Тимур Рамзанович',
} as const;
