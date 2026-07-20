/**
 * Генератор паролей для системной выдачи (активация сотрудника).
 * Важно и то, что пароль стойкий, и то, что его можно продиктовать голосом.
 */
import { describe, expect, it } from 'vitest';
import { generatePassword, GENERATED_PASSWORD_LENGTH } from './generate-password';

describe('generatePassword', () => {
  it('по умолчанию — заданной длины, заведомо больше минимума в 8 символов', () => {
    expect(generatePassword()).toHaveLength(GENERATED_PASSWORD_LENGTH);
    expect(GENERATED_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });

  it('уважает переданную длину', () => {
    expect(generatePassword(20)).toHaveLength(20);
    expect(generatePassword(1)).toHaveLength(1);
  });

  it('не содержит символов, которые путают при переписывании (0 O o 1 l I)', () => {
    const all = Array.from({ length: 200 }, () => generatePassword()).join('');
    expect(all).not.toMatch(/[0O1lI]/);
  });

  it('только латиница и цифры — пароль можно ввести с любой раскладки', () => {
    expect(generatePassword(100)).toMatch(/^[a-zA-Z2-9]+$/);
  });

  it('каждый раз разный', () => {
    const set = new Set(Array.from({ length: 200 }, () => generatePassword()));
    expect(set.size).toBe(200);
  });

  it('использует весь алфавит — выборка не вырождена', () => {
    const chars = new Set(generatePassword(4000).split(''));
    // 55 символов в алфавите; на 4000 выборках должны встретиться почти все
    expect(chars.size).toBeGreaterThan(50);
  });
});
