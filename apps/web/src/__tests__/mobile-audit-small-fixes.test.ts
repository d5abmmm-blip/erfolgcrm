/**
 * Мелочи из аудита кабинета, которые по отдельности не страшны,
 * а вместе делают приложение неаккуратным.
 */
import { describe, expect, it } from 'vitest';
import { newAssignmentIds, readSeenIds, seenStorageKey, shownOfTotal } from '../lib/queue-badge';
import { isTicketOverdue } from '../lib/deadline';
import { mobileHeaderTitle } from '../lib/nav';

describe('«Назначено новых» считает заявки, а не их количество', () => {
  /**
   * Исходная беда: сравнивались ЧИСЛА. Инженер закрыл одну заявку, ему тут же
   * назначили другую — активных по-прежнему 7, разница ноль, плашка молчит.
   * Про новую заявку он узнавал случайно.
   */
  it('закрыл одну, назначили одну — новая всё равно видна', () => {
    const seen = ['a', 'b', 'c'];
    const active = ['b', 'c', 'НОВАЯ'];
    expect(newAssignmentIds(active, seen)).toEqual(['НОВАЯ']);
  });

  it('ничего не изменилось — плашки нет', () => {
    expect(newAssignmentIds(['a', 'b'], ['a', 'b'])).toEqual([]);
  });

  it('первый заход молчит — человек просто открыл приложение', () => {
    expect(newAssignmentIds(['a', 'b', 'c'], null)).toEqual([]);
  });

  it('только закрыл — новых нет', () => {
    expect(newAssignmentIds(['a'], ['a', 'b', 'c'])).toEqual([]);
  });

  it('отметка читается и переживает мусор', () => {
    expect(readSeenIds(JSON.stringify(['a', 'b']))).toEqual(['a', 'b']);
    expect(readSeenIds(null)).toBeNull();
    expect(readSeenIds('')).toBeNull();
    expect(readSeenIds('не json')).toBeNull();
    expect(readSeenIds('{"a":1}')).toBeNull();
    expect(readSeenIds('[1,2]')).toBeNull(); // не строки
  });

  it('ключ отделён от старого — там лежало число, а не список', () => {
    expect(seenStorageKey('eng-1')).toBe('m-queue-seen-ids-eng-1');
  });

  it('подпись «показано N из M» не тронута', () => {
    expect(shownOfTotal(50, 480)).toBe('Показано 50 из 480');
    expect(shownOfTotal(50, 50)).toBeNull();
  });
});

describe('просрочка не светится на неактуальных заявках', () => {
  const past = '2020-01-01T00:00:00.000Z';
  const now = new Date('2026-08-07T12:00:00.000Z').getTime();

  it('открытая просроченная — красная, как и была', () => {
    expect(isTicketOverdue('in_progress', past, now)).toBe(true);
  });

  it('закрытая — нет', () => {
    expect(isTicketOverdue('closed', past, now)).toBe(false);
  });

  /** Ровно находка: на вкладке «Все» отменённая заявка светилась «просрочено». */
  it('отменённая — нет', () => {
    expect(isTicketOverdue('cancelled', past, now)).toBe(false);
  });

  it('без срока — нет', () => {
    expect(isTicketOverdue('in_progress', null, now)).toBe(false);
  });

  it('срок ещё не наступил — нет', () => {
    expect(isTicketOverdue('in_progress', '2027-01-01T00:00:00.000Z', now)).toBe(false);
  });
});

describe('заголовок шапки называет то, что на экране', () => {
  /**
   * Было: на карточке заявки в шапке стояло «Очередь» — первая же запись
   * навигации матчит `/m/tickets`, а ветка с «Заявка» была недостижима.
   */
  it('карточка заявки — «Заявка»', () => {
    expect(mobileHeaderTitle('/m/tickets/abc')).toBe('Заявка');
  });

  it('журнал работ — «Журнал работ»', () => {
    expect(mobileHeaderTitle('/m/tickets/abc/work-log')).toBe('Журнал работ');
  });

  it('сама очередь — «Очередь»', () => {
    expect(mobileHeaderTitle('/m/queue')).toBe('Очередь');
  });

  it('остальные разделы — как в нижней навигации', () => {
    expect(mobileHeaderTitle('/m/tasks')).toBe('Задачи');
    expect(mobileHeaderTitle('/m/scan')).toBe('Сканер');
    expect(mobileHeaderTitle('/m/inventory')).toBe('Склад');
    expect(mobileHeaderTitle('/m/inventory/xyz')).toBe('Склад');
    expect(mobileHeaderTitle('/m/profile')).toBe('Профиль');
  });

  it('незнакомый адрес не оставляет шапку пустой', () => {
    expect(mobileHeaderTitle('/m/что-то')).toBe('ErfolgCRM');
  });
});
