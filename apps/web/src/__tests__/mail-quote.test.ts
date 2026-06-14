import { describe, it, expect } from 'vitest';
import {
  buildReplyBody,
  buildForwardBody,
  buildReferences,
  replySubject,
  forwardSubject,
} from '../lib/mail-quote';

describe('buildReplyBody', () => {
  it('каждую строку тела цитирует префиксом «> » и добавляет атрибуцию с датой', () => {
    const out = buildReplyBody({
      from: 'client@example.com',
      date: new Date('2026-06-14T09:05:00'),
      bodyText: 'Первая строка\nВторая строка',
    });
    expect(out.startsWith('\n\n')).toBe(true);
    expect(out).toContain('14.06.2026 09:05, client@example.com писал(а):');
    expect(out).toContain('> Первая строка');
    expect(out).toContain('> Вторая строка');
  });

  it('пустые строки тоже цитируются (префикс на каждой строке)', () => {
    const out = buildReplyBody({ from: 'a@b.c', date: null, bodyText: 'один\n\nдва' });
    expect(out).toContain('> один\n> \n> два');
  });

  it('без даты — атрибуция без даты', () => {
    const out = buildReplyBody({ from: 'a@b.c', date: null, bodyText: 'x' });
    expect(out).toContain('a@b.c писал(а):');
    expect(out).not.toMatch(/\d{2}\.\d{2}\.\d{4}/);
  });

  it('пустое тело — цитировать нечего (после атрибуции пустая строка)', () => {
    const out = buildReplyBody({ from: 'a@b.c', date: null, bodyText: null });
    expect(out).toBe('\n\na@b.c писал(а):\n');
  });

  it('пустой from — подставляет «отправитель»', () => {
    const out = buildReplyBody({ from: null, date: null, bodyText: 'x' });
    expect(out).toContain('отправитель писал(а):');
  });
});

describe('buildForwardBody', () => {
  it('содержит заголовочный блок и исходное тело', () => {
    const out = buildForwardBody({
      from: 'a@b.c',
      to: 'me@erfolg.ru',
      date: new Date('2026-06-14T09:05:00'),
      subject: 'Тема письма',
      bodyText: 'Тело сообщения',
    });
    expect(out).toContain('---------- Пересланное сообщение ----------');
    expect(out).toContain('От: a@b.c');
    expect(out).toContain('Дата: 14.06.2026 09:05');
    expect(out).toContain('Кому: me@erfolg.ru');
    expect(out).toContain('Тема: Тема письма');
    expect(out).toContain('Тело сообщения');
  });

  it('пустые поля заменяются прочерками/заглушкой', () => {
    const out = buildForwardBody({ from: null, to: null, date: null, subject: null, bodyText: null });
    expect(out).toContain('От: —');
    expect(out).toContain('Дата: —');
    expect(out).toContain('Кому: —');
    expect(out).toContain('Тема: (без темы)');
  });
});

describe('buildReferences', () => {
  it('конкатенирует references родителя и его Message-ID', () => {
    expect(buildReferences('<a@x> <b@x>', '<c@x>')).toEqual(['<a@x>', '<b@x>', '<c@x>']);
  });

  it('дедуплицирует с сохранением порядка', () => {
    expect(buildReferences('<a@x> <b@x>', '<a@x>')).toEqual(['<a@x>', '<b@x>']);
  });

  it('убирает пустые/пробельные элементы', () => {
    expect(buildReferences('   ', '<c@x>')).toEqual(['<c@x>']);
    expect(buildReferences(null, null)).toEqual([]);
    expect(buildReferences('<a@x>', null)).toEqual(['<a@x>']);
  });

  it('разбивает по любому пробелу (переводы строк, табы)', () => {
    expect(buildReferences('<a@x>\n<b@x>\t<c@x>', '<d@x>')).toEqual([
      '<a@x>',
      '<b@x>',
      '<c@x>',
      '<d@x>',
    ]);
  });
});

describe('replySubject', () => {
  it('добавляет «Re: » к обычной теме', () => {
    expect(replySubject('Счёт')).toBe('Re: Счёт');
  });
  it('не удваивает «Re:» (регистронезависимо)', () => {
    expect(replySubject('Re: Счёт')).toBe('Re: Счёт');
    expect(replySubject('RE: Счёт')).toBe('RE: Счёт');
    expect(replySubject('re: Счёт')).toBe('re: Счёт');
  });
  it('пустая/нулевая тема → «Re:»', () => {
    expect(replySubject(null)).toBe('Re:');
    expect(replySubject('   ')).toBe('Re:');
  });
});

describe('forwardSubject', () => {
  it('добавляет «Fwd: » к обычной теме', () => {
    expect(forwardSubject('Счёт')).toBe('Fwd: Счёт');
  });
  it('не удваивает «Fwd:» (регистронезависимо)', () => {
    expect(forwardSubject('Fwd: Счёт')).toBe('Fwd: Счёт');
    expect(forwardSubject('FWD: Счёт')).toBe('FWD: Счёт');
  });
  it('пустая/нулевая тема → «Fwd:»', () => {
    expect(forwardSubject(null)).toBe('Fwd:');
  });
});
