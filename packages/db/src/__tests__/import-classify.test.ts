/**
 * Юнит-тесты классификации клиента при импорте WinServisePro.
 *
 * Главный кейс — IMP-1: физлицо с 12-значным личным ИНН НЕ должно уезжать в юрлица
 * (иначе его ФИО/адрес/телефон/ИНН попадут в открытые колонки мимо шифрования и инициалов).
 */
import { describe, it, expect } from 'vitest';
import { classifyClientType, initialsDisplayName } from '../import-winservice-classify';

describe('classifyClientType', () => {
  it('юрлицо по названию (ООО) → legal', () => {
    expect(
      classifyClientType({ name: 'ООО «Ромашка»', clientTypeOld: null, inn: null, root: null }),
    ).toBe('legal');
  });

  it('ИП по названию → legal (ловит LEGAL_RE даже без ИНН/CLIENTTYPE)', () => {
    expect(
      classifyClientType({ name: 'ИП Иванов И.И.', clientTypeOld: null, inn: null, root: null }),
    ).toBe('legal');
  });

  it('медучреждение по слову «больница» → legal', () => {
    expect(
      classifyClientType({
        name: 'Городская больница №3',
        clientTypeOld: null,
        inn: null,
        root: null,
      }),
    ).toBe('legal');
  });

  it('CLIENTTYPE=1 → legal даже при «голом» названии', () => {
    expect(
      classifyClientType({ name: 'Некое Название', clientTypeOld: 1, inn: null, root: null }),
    ).toBe('legal');
  });

  it('папка «Бюджетные» (root=4) → legal', () => {
    expect(
      classifyClientType({ name: 'Некое Название', clientTypeOld: null, inn: null, root: 4 }),
    ).toBe('legal');
  });

  it('10-значный ИНН (ИНН организации) → legal', () => {
    expect(
      classifyClientType({ name: 'Ромашка', clientTypeOld: null, inn: '7701234567', root: null }),
    ).toBe('legal');
  });

  // ── IMP-1: главный регресс-кейс ──
  it('IMP-1: физлицо с 12-значным личным ИНН и «голым» ФИО → individual (НЕ legal)', () => {
    expect(
      classifyClientType({
        name: 'Иванов Иван Иванович',
        clientTypeOld: 0,
        inn: '500100732259', // 12 цифр — личный ИНН (ПДн)
        root: null,
      }),
    ).toBe('individual');
  });

  // classifyClientType сам вычищает не-цифры перед подсчётом (на вход из main() приходит уже
  // clip(c.INN,12), но функция не полагается на чистоту строки и считает именно цифры).
  it('IMP-1: чистый 12-значный личный ИНН → individual', () => {
    expect(
      classifyClientType({ name: 'Петров Пётр', clientTypeOld: null, inn: '500100732259', root: null }),
    ).toBe('individual');
  });

  it('10-значный ИНН с разделителем → legal (граница по цифрам, а не по длине строки)', () => {
    expect(
      classifyClientType({ name: 'Ромашка', clientTypeOld: null, inn: '770-1234567', root: null }),
    ).toBe('legal');
  });

  it('«голое» ФИО без ИНН → individual', () => {
    expect(
      classifyClientType({ name: 'Сидоров Сидор', clientTypeOld: 0, inn: null, root: null }),
    ).toBe('individual');
  });

  it('папка «Частные» не перебивает название юрлица (ООО + любой root) → legal', () => {
    expect(
      classifyClientType({ name: 'ООО «Ромашка»', clientTypeOld: null, inn: null, root: 5 }),
    ).toBe('legal');
  });
});

describe('initialsDisplayName', () => {
  it('«Иванов Иван Иванович» → «Иванов И.И.»', () => {
    expect(initialsDisplayName('Иванов Иван Иванович')).toBe('Иванов И.И.');
  });

  it('только фамилия → как есть', () => {
    expect(initialsDisplayName('Иванов')).toBe('Иванов');
  });

  it('фамилия + имя → «Иванов И.»', () => {
    expect(initialsDisplayName('Иванов Иван')).toBe('Иванов И.');
  });

  it('лишние пробелы схлопываются', () => {
    expect(initialsDisplayName('  Иванов   Иван  Иванович ')).toBe('Иванов И.И.');
  });

  it('пустая строка → пустая (без падения)', () => {
    expect(initialsDisplayName('')).toBe('');
  });
});
