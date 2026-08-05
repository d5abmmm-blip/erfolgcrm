/**
 * Контакт клиента в мобильной заявке: позвонить и открыть адрес на карте
 * одним тапом. Данные приходят из tickets.documentClient — инженеру сервер
 * отдаёт их только по своим заявкам (ответственный или помощник).
 */

/** tel:-ссылка. Чистим форматирование, «8 XXX…» приводим к «+7XXX…». */
export function telHref(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let digits = phone.trim().replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) digits = `+${digits.slice(1).replace(/\D/g, '')}`;
  if (/^8\d{10}$/.test(digits)) digits = `+7${digits.slice(1)}`;
  // Обрывок из пары цифр — не телефон, звонить не по чему.
  if (digits.replace(/\D/g, '').length < 5) return null;
  return `tel:${digits}`;
}

/** Ссылка на Яндекс.Карты поиском по адресу (у заказчика вся география — РФ). */
export function mapsHref(address: string | null | undefined): string | null {
  const a = address?.trim();
  if (!a) return null;
  return `https://yandex.ru/maps/?text=${encodeURIComponent(a)}`;
}

/** Подпись контактного лица: «Иванов И.И. · главный инженер». */
export function contactLine(
  contactName: string | null | undefined,
  contactPosition: string | null | undefined,
): string | null {
  const name = contactName?.trim();
  const position = contactPosition?.trim();
  if (name && position) return `${name} · ${position}`;
  return name || position || null;
}
