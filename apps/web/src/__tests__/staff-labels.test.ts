/**
 * Подписи раздела «Сотрудники».
 *
 * Русские окончания по числу — вещь, которую легко сделать «3 заявка» и не заметить
 * годами: на экране это выглядит мелочью, а читается как небрежность во всём разделе.
 *
 * Отдельно держим loadLevel: это сознательно ГРУБАЯ шкала. На нынешних объёмах
 * (десятки заявок на всю компанию) процент от одного закрытого дела даёт «100 %» и
 * делает случайного человека лучшим в компании — три ступени честнее точной цифры,
 * которой пока нет.
 */
import { describe, it, expect } from 'vitest';
import {
  AWAY_LABELS,
  ROLE_LABELS_RU,
  awayText,
  formatAwayRange,
  loadLevel,
  openTicketsPhrase,
  pluralRu,
  ticketStatusRu,
  ticketsWord,
} from '../lib/staff';

describe('русские окончания по числу', () => {
  it('единственное число только у 1, 21, 31 — но не у 11', () => {
    expect(ticketsWord(1)).toBe('заявка');
    expect(ticketsWord(21)).toBe('заявка');
    expect(ticketsWord(31)).toBe('заявка');
    expect(ticketsWord(11)).toBe('заявок');
  });

  it('«заявки» у 2–4 и 22–24, но не у 12–14', () => {
    expect(ticketsWord(2)).toBe('заявки');
    expect(ticketsWord(4)).toBe('заявки');
    expect(ticketsWord(23)).toBe('заявки');
    expect(ticketsWord(12)).toBe('заявок');
    expect(ticketsWord(14)).toBe('заявок');
  });

  it('«заявок» у 0, 5–20 и круглых', () => {
    expect(ticketsWord(0)).toBe('заявок');
    expect(ticketsWord(5)).toBe('заявок');
    expect(ticketsWord(100)).toBe('заявок');
  });

  it('pluralRu работает и с другими словами', () => {
    expect(pluralRu(1, 'сотрудник', 'сотрудника', 'сотрудников')).toBe('сотрудник');
    expect(pluralRu(3, 'сотрудник', 'сотрудника', 'сотрудников')).toBe('сотрудника');
    expect(pluralRu(7, 'сотрудник', 'сотрудника', 'сотрудников')).toBe('сотрудников');
  });
});

describe('фраза про незакрытые заявки', () => {
  // Ровно эта ошибка вылезла при первой живой проверке карточки: «Ещё 1 незакрытых
  // заявок». Прилагательное обязано склоняться вместе с существительным.
  it('прилагательное согласовано с числом', () => {
    expect(openTicketsPhrase(1)).toBe('1 незакрытая заявка');
    expect(openTicketsPhrase(2)).toBe('2 незакрытые заявки');
    expect(openTicketsPhrase(5)).toBe('5 незакрытых заявок');
    expect(openTicketsPhrase(11)).toBe('11 незакрытых заявок');
    expect(openTicketsPhrase(21)).toBe('21 незакрытая заявка');
  });
});

describe('подпись об отсутствующих', () => {
  it('ноль — отдельная честная фраза, а не «отсутствуют 0 сотрудников»', () => {
    expect(awayText(0)).toBe('Сегодня отсутствующих нет.');
  });

  it('один и несколько согласованы по числу', () => {
    expect(awayText(1)).toBe('Сегодня отсутствует 1 сотрудник.');
    expect(awayText(2)).toBe('Сегодня отсутствуют 2 сотрудника.');
    expect(awayText(5)).toBe('Сегодня отсутствуют 5 сотрудников.');
  });
});

describe('грубая шкала загрузки', () => {
  it('ноль заявок — свободен', () => {
    expect(loadLevel(0)).toBe('свободен');
  });

  it('до трёх — умеренно, дальше — загружен', () => {
    expect(loadLevel(1)).toBe('умеренно');
    expect(loadLevel(3)).toBe('умеренно');
    expect(loadLevel(4)).toBe('загружен');
    expect(loadLevel(40)).toBe('загружен');
  });
});

describe('перевод статусов и дат', () => {
  it('статусы заявок по-русски, неизвестный отдаётся как есть', () => {
    expect(ticketStatusRu('in_progress')).toBe('В работе');
    expect(ticketStatusRu('act_pending')).toBe('Ждёт акта');
    expect(ticketStatusRu('невиданный_статус')).toBe('невиданный_статус');
  });

  it('интервал в один день не превращается в «20 авг — 20 авг»', () => {
    expect(formatAwayRange('2026-08-20', '2026-08-20')).toBe('20 авг.');
    expect(formatAwayRange('2026-08-20', '2026-08-25')).toContain('—');
  });

  it('справочники подписей заполнены целиком', () => {
    expect(Object.keys(ROLE_LABELS_RU)).toHaveLength(3);
    expect(Object.keys(AWAY_LABELS)).toHaveLength(3);
    expect(ROLE_LABELS_RU.dispatcher).toBe('Менеджер');
  });
});
