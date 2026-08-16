/**
 * Акт с телефона и акт с компьютера — один и тот же документ.
 *
 * ЧТО БЫЛО. Сборка данных для PDF скопирована в три экрана: карточку заявки,
 * мобильную карточку инженера и карточку счёта. Копии разъехались — десктоп клал в
 * строку `engineerName`, телефон нет. Акт выполненных работ, распечатанный
 * С ТЕЛЕФОНА, терял блок «Работы выполнил: …», добавленный как раз для случая,
 * когда на технику выезжают вдвоём.
 *
 * Один и тот же акт по одной и той же заявке выглядел по-разному в зависимости от
 * устройства — а этот документ подписывают.
 */
import { describe, it, expect } from 'vitest';
import { toPdfLines } from '../lib/pdf/lines';

/** Строки наряда, как их отдаёт сервер: суммы — строками. */
const SERVER_LINES = [
  {
    lineType: 'work',
    name: 'Замена платы управления',
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: '450000',
    amountKopecks: '450000',
    engineerName: 'Алероев А. А.',
  },
  {
    lineType: 'work',
    name: 'Калибровка',
    unit: 'шт',
    quantity: '2',
    unitPriceKopecks: '100000',
    amountKopecks: '200000',
    engineerName: 'Яхьяев М. С.',
  },
  {
    lineType: 'part',
    name: 'Плата управления',
    unit: 'шт',
    quantity: '1',
    unitPriceKopecks: '900000',
    amountKopecks: '900000',
    engineerName: null,
  },
];

describe('toPdfLines', () => {
  it('сохраняет фамилию исполнителя — она и терялась на телефоне', () => {
    const lines = toPdfLines(SERVER_LINES);
    expect(lines.map((l) => l.engineerName)).toEqual(['Алероев А. А.', 'Яхьяев М. С.', null]);
  });

  it('переводит суммы и количество из строк в числа', () => {
    const [first] = toPdfLines(SERVER_LINES);
    expect(first!.quantity).toBe(1);
    expect(first!.unitPriceKopecks).toBe(450000);
    expect(first!.amountKopecks).toBe(450000);
  });

  it('строка без исполнителя даёт null, а не пропавшее поле', () => {
    const lines = toPdfLines([{ ...SERVER_LINES[2]!, engineerName: undefined }]);
    expect(lines[0]).toHaveProperty('engineerName', null);
  });
});
