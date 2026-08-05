/**
 * Контакт клиента в мобильной заявке: tel:-ссылка, карты, подпись контакта.
 * До правки телефона и адреса клиента в мобилке не было НИГДЕ — инженер
 * у аппарата не мог ни позвонить, ни построить маршрут.
 */
import { describe, expect, it } from 'vitest';
import { contactLine, mapsHref, telHref } from '../lib/client-contact';

describe('telHref', () => {
  it('чистит форматирование и даёт tel:', () => {
    expect(telHref('+7 (928) 123-45-67')).toBe('tel:+79281234567');
  });

  it('«8 XXX…» приводит к «+7XXX…»', () => {
    expect(telHref('8 (8712) 22-33-44')).toBe('tel:+78712223344');
  });

  it('обрывок и пустота — null, звонить не по чему', () => {
    expect(telHref('—')).toBeNull();
    expect(telHref('123')).toBeNull();
    expect(telHref('')).toBeNull();
    expect(telHref(null)).toBeNull();
  });

  it('городской без кода страны остаётся как есть (цифрами)', () => {
    expect(telHref('22-33-44')).toBe('tel:223344');
  });
});

describe('mapsHref', () => {
  it('кодирует адрес в ссылку Яндекс.Карт', () => {
    expect(mapsHref('г. Грозный, ул. Ленина, 1')).toBe(
      `https://yandex.ru/maps/?text=${encodeURIComponent('г. Грозный, ул. Ленина, 1')}`,
    );
  });

  it('пустой адрес — null', () => {
    expect(mapsHref('  ')).toBeNull();
    expect(mapsHref(null)).toBeNull();
  });
});

describe('contactLine', () => {
  it('имя и должность через точку', () => {
    expect(contactLine('Иванов И.И.', 'главный инженер')).toBe('Иванов И.И. · главный инженер');
  });

  it('что-то одно — без точки, ничего — null', () => {
    expect(contactLine('Иванов И.И.', null)).toBe('Иванов И.И.');
    expect(contactLine(null, 'главный инженер')).toBe('главный инженер');
    expect(contactLine(null, null)).toBeNull();
  });
});
