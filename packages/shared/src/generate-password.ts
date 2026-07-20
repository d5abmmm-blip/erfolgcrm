/**
 * Генератор паролей для случаев, когда пароль назначает система, а не человек.
 *
 * Зачем понадобился: при переносе из старой базы всем 19 сотрудникам клали ОДИН
 * общий пароль, и он лежал в репозитории открытым текстом. Пока такие аккаунты
 * заблокированы, войти нельзя — но в момент активации у человека сразу появлялся
 * рабочий вход с общеизвестным паролем.
 *
 * Источник случайности — `crypto.getRandomValues` (Web Crypto). Он есть и в Node,
 * и в браузере, поэтому модуль безопасно лежит в общем пакете. Math.random здесь
 * недопустим: пароль защищает вход в боевую систему.
 */

/** Без 0/O/o и 1/l/I — пароль часто диктуют голосом или переписывают с экрана. */
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const GENERATED_PASSWORD_LENGTH = 14;

/**
 * Наибольшее кратное длине алфавита, помещающееся в байт. Байты выше него
 * отбрасываем — иначе первые символы алфавита выпадали бы чаще остальных.
 */
const UNBIASED_LIMIT = Math.floor(256 / ALPHABET.length) * ALPHABET.length;

export function generatePassword(length: number = GENERATED_PASSWORD_LENGTH): string {
  let out = '';
  while (out.length < length) {
    const bytes = new Uint8Array(length - out.length);
    crypto.getRandomValues(bytes);
    for (const b of bytes) {
      if (b >= UNBIASED_LIMIT) continue; // отбрасываем, чтобы не перекосить выбор
      out += ALPHABET[b % ALPHABET.length];
      if (out.length === length) break;
    }
  }
  return out;
}
