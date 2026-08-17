/**
 * Разбор суммы в рублях, введённой человеком.
 *
 * ЗАЧЕМ. В пяти местах лежала своя копия `Number.parseFloat(v.trim().replace(',', '.'))`,
 * и все пять теряли разряды: parseFloat читает число до первого непонятного символа,
 * поэтому «120 000» превращалось в 120. В реестре трейд-ина цена продажи проходила
 * проверку «больше нуля» и молча сохранялась как 120 ₽ вместо 120 000 ₽ — человеку
 * при этом не показывалось ничего.
 *
 * Пробел как разделитель разрядов ставит и сам браузер, если сумму скопировали из
 * соседнего поля программы: там суммы печатаются через Intl с неразрывным пробелом.
 */
import { describe, it, expect } from 'vitest';
import { parseRubInput, parseRubToKopecks } from '../lib/money';

describe('parseRubInput', () => {
  it('понимает разряды через пробел — тот самый случай, когда 120 000 становилось 120', () => {
    expect(parseRubInput('120 000')).toBe(120000);
    // Неразрывный пробел: так печатает суммы Intl, и так они попадают в поле копипастой.
    expect(parseRubInput('120 000')).toBe(120000);
    // Узкий неразрывный пробел — им разделяет разряды часть браузеров.
    expect(parseRubInput('1 234 567')).toBe(1234567);
  });

  it('понимает запятую и точку как дробный разделитель', () => {
    expect(parseRubInput('1234,56')).toBe(1234.56);
    expect(parseRubInput('1234.56')).toBe(1234.56);
    expect(parseRubInput('1 234,56')).toBe(1234.56);
  });

  it('терпит рублёвый знак и лишние пробелы по краям', () => {
    expect(parseRubInput('  5 000 ₽ ')).toBe(5000);
    expect(parseRubInput('5000руб.')).toBe(5000);
  });

  it('возвращает null на том, чего не понял, — вместо тихого сохранения половины ввода', () => {
    expect(parseRubInput('')).toBeNull();
    expect(parseRubInput('   ')).toBeNull();
    expect(parseRubInput('сто тысяч')).toBeNull();
    expect(parseRubInput('12abc34')).toBeNull();
    expect(parseRubInput('1,2,3')).toBeNull();
    expect(parseRubInput('-')).toBeNull();
  });

  it('отрицательные суммы читает, отсекать их — дело вызывающего', () => {
    expect(parseRubInput('-500')).toBe(-500);
  });
});

describe('parseRubToKopecks', () => {
  it('переводит в копейки с округлением', () => {
    expect(parseRubToKopecks('120 000')).toBe(12000000);
    expect(parseRubToKopecks('1234,56')).toBe(123456);
    expect(parseRubToKopecks('0,005')).toBe(1);
  });

  it('непонятный ввод — null, а не ноль: ноль вызывающий примет за «не заполнено»', () => {
    expect(parseRubToKopecks('сто')).toBeNull();
    expect(parseRubToKopecks('')).toBeNull();
  });
});
