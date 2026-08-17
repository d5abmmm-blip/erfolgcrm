/**
 * Бланки печатают реквизиты из базы, а не из кода.
 *
 * ЧТО БЫЛО. Шесть печатных форм (счёт, договор, акт приёмки, акт выполненных
 * работ, дефектный акт, табель) подставляли константу `ERFOLG_FALLBACK` из
 * `lib/pdf/branding.ts`. В `TicketCardPage` рядом с ней стоял honest-комментарий
 * «TODO: брать из tenant settings когда появится trpc endpoint».
 *
 * 🔴 ГЛАВНОЕ, ЧТО СТЕРЕЖЁТ ЭТОТ ФАЙЛ — падение на встроенное значение ПО
 * КАЖДОМУ ПОЛЮ В ОТДЕЛЬНОСТИ. Подставь мы то, что лежит в базе, целиком —
 * любое незаполненное поле молча исчезло бы из документа: пустой ОГРН убрал бы
 * строку из договора, пустая фамилия директора оставила бы счёт без подписи.
 * Что именно заполнено на бою, мы не знаем и узнать, не читая боевую базу, не
 * можем, поэтому «пусто в базе» означает «печатаем как раньше».
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { resolvePrintTenant } from '../lib/organization';
import { ERFOLG_FALLBACK } from '../lib/pdf/branding';

const FULL = {
  displayName: 'МЕДСЕРВИС',
  legalName: 'ООО «Медсервис»',
  slogan: 'Ремонт медтехники',
  inn: '7700000000',
  kpp: '770001001',
  ogrn: '1234567890123',
  legalAddress: 'г. Москва, ул. Новая, 1',
  phone: '+7 495 000-00-00',
  email: 'info@medservice.ru',
  bankName: 'АО «Банк»',
  bankAccount: '40702810900000000001',
  correspondentAccount: '30101810400000000225',
  bik: '044525225',
  licenseSeries: 'ФС-77-01',
  licenseNumber: '000111',
  licenseDate: '2020-01-15',
  licenseAuthority: 'Росздравнадзор',
  directorName: 'Петров Пётр Петрович',
};

const EMPTY = {
  displayName: 'МЕДСЕРВИС',
  legalName: null,
  slogan: null,
  inn: null,
  kpp: null,
  ogrn: null,
  legalAddress: null,
  phone: null,
  email: null,
  bankName: null,
  bankAccount: null,
  correspondentAccount: null,
  bik: null,
  licenseSeries: null,
  licenseNumber: null,
  licenseDate: null,
  licenseAuthority: null,
  directorName: null,
};

describe('resolvePrintTenant', () => {
  it('заполненная база вытесняет встроенные значения', () => {
    const t = resolvePrintTenant(FULL);
    expect(t.legalName).toBe('ООО «Медсервис»');
    expect(t.inn).toBe('7700000000');
    expect(t.bik).toBe('044525225');
    expect(t.director).toBe('Петров Пётр Петрович');
    expect(t.licenseDate).toBe('2020-01-15');
  });

  it('пустое поле берёт прежнее встроенное — реквизит из бумаги не пропадает', () => {
    const t = resolvePrintTenant(EMPTY);
    expect(t.inn).toBe(ERFOLG_FALLBACK.inn);
    expect(t.bankAccount).toBe(ERFOLG_FALLBACK.bankAccount);
    expect(t.director).toBe(ERFOLG_FALLBACK.director);
    expect(t.legalName).toBe(ERFOLG_FALLBACK.legalName);
    // Своё непустое поле при этом остаётся своим.
    expect(t.displayName).toBe('МЕДСЕРВИС');
  });

  it('поле из пробелов — это «не заполнено», а не пробел в документе', () => {
    const t = resolvePrintTenant({ ...EMPTY, inn: '   ', directorName: '  ' });
    expect(t.inn).toBe(ERFOLG_FALLBACK.inn);
    expect(t.director).toBe(ERFOLG_FALLBACK.director);
  });

  it('данных нет вовсе (связь потеряна, запрос на паузе) — печатаем встроенные', () => {
    const t = resolvePrintTenant(undefined);
    expect(t.inn).toBe(ERFOLG_FALLBACK.inn);
    expect(t.director).toBe(ERFOLG_FALLBACK.director);
    expect(t.legalName).toBe(ERFOLG_FALLBACK.legalName);
  });
});

/**
 * Сторож по исходнику: страницы больше не подставляют константу в `tenant:`
 * напрямую. Проверяем именно так, а не отрисовкой, — каждая из этих страниц
 * тянет десяток процедур, и компонентный тест был бы дороже и хрупче самой
 * проверки (тот же приём, что у сторожа «на телефоне инженера нет рублей»).
 */
describe('страницы не подставляют реквизиты из кода', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const PAGES = [
    '../pages/TicketCardPage.tsx',
    '../pages/InvoiceCardPage.tsx',
    '../pages/ContractCardPage.tsx',
    '../pages/AttendancePage.tsx',
    '../pages/mobile/MobileTicketPage.tsx',
  ];

  for (const page of PAGES) {
    it(`${page.split('/').pop()} собирает шапку из useTenantRequisites`, () => {
      const src = readFileSync(resolve(here, page), 'utf8');
      expect(src).toContain('useTenantRequisites');
      // Ни `tenant: { ...ERFOLG_FALLBACK }`, ни `...ERFOLG_FALLBACK,` в сборке шапки.
      expect(src).not.toMatch(/tenant:\s*\{\s*\.\.\.ERFOLG_FALLBACK/);
      expect(src).not.toMatch(/^\s*\.\.\.ERFOLG_FALLBACK,\s*$/m);
    });
  }

  it('старого TODO про несуществующий эндпоинт больше нет', () => {
    const src = readFileSync(resolve(here, '../pages/TicketCardPage.tsx'), 'utf8');
    expect(src).not.toMatch(/TODO: брать из tenant settings/);
  });
});
