/**
 * Проверка адреса перед отправкой письма.
 *
 * Поводом стал боевой случай: в поле почты клиента из старой системы приехали имена
 * и телефоны. Непустой мусор проходил проверку «не пусто», доезжал до nodemailer,
 * тот падал с `No recipients defined`, задача уходила в ретраи — 24 ошибки в логах
 * из пяти смен статуса за утро.
 *
 * Второй набор проверок здесь так же важен, как первый: регулярка НЕ должна
 * отбраковывать живые адреса, иначе письма просто перестанут уходить.
 */
import { describe, expect, it } from 'vitest';
import { isEmailAddress, normalizeEmailAddress } from '../lib/email-address';

describe('isEmailAddress — что НЕ адрес', () => {
  it('пустые значения', () => {
    expect(isEmailAddress(null)).toBe(false);
    expect(isEmailAddress(undefined)).toBe(false);
    expect(isEmailAddress('')).toBe(false);
    expect(isEmailAddress('   ')).toBe(false);
  });

  it('реальные значения из боевой базы: имена и телефоны вместо адреса', () => {
    // Форма взята с прода: 39 из 43 непустых значений были без «@».
    expect(isEmailAddress('Магомед')).toBe(false);
    expect(isEmailAddress('Анзор Хасанов')).toBe(false);
    expect(isEmailAddress('89640000000')).toBe(false);
    expect(isEmailAddress('Марат')).toBe(false);
  });

  it('обрывки, похожие на адрес, но неотправляемые', () => {
    expect(isEmailAddress('@')).toBe(false);
    expect(isEmailAddress('info@')).toBe(false);
    expect(isEmailAddress('@erfolgmt.ru')).toBe(false);
    expect(isEmailAddress('info@erfolgmt')).toBe(false); // без точки в домене
    expect(isEmailAddress('два адреса@a.ru b@b.ru')).toBe(false); // пробел внутри
  });
});

describe('isEmailAddress — что адрес (регрессия: не сломать живую почту)', () => {
  it('обычные адреса', () => {
    expect(isEmailAddress('info@erfolgmt.ru')).toBe(true);
    expect(isEmailAddress('a@b.co')).toBe(true);
    expect(isEmailAddress('ivan.petrov@mail.example.com')).toBe(true);
    expect(isEmailAddress('client+tag@gmail.com')).toBe(true);
    expect(isEmailAddress('under_score@sub.domain.ru')).toBe(true);
  });

  it('пробелы по краям не делают адрес плохим', () => {
    expect(isEmailAddress('  info@erfolgmt.ru  ')).toBe(true);
  });
});

describe('normalizeEmailAddress', () => {
  it('отдаёт подрезанный адрес', () => {
    expect(normalizeEmailAddress('  info@erfolgmt.ru ')).toBe('info@erfolgmt.ru');
  });

  it('на мусор отдаёт null, а не мусор', () => {
    expect(normalizeEmailAddress('Магомед')).toBeNull();
    expect(normalizeEmailAddress(null)).toBeNull();
    expect(normalizeEmailAddress('   ')).toBeNull();
  });
});
