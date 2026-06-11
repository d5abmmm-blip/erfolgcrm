/**
 * Stage 10'.C — TOTP / recovery-codes helpers.
 *
 * - generateTotpSecret() → otplib base32 secret (рекомендуется 20+ байт энтропии).
 * - buildOtpauthUrl()    → otpauth://totp/{issuer}:{username}?secret=...&issuer=...
 * - verifyTotp()         → проверка 6-значного кода с окном ±30 секунд.
 * - generateRecoveryCodes() → 10 кодов в формате XXXX-XXXX-XXXX (base32, без 0/1/I/O).
 * - hashRecoveryCode()   → argon2id (тот же, что и пароли).
 * - verifyRecoveryCode() → находит совпадение и возвращает индекс одноразового хеша.
 *
 * Recovery-коды показываются ОДИН раз при включении/регенерации, в БД хранятся
 * только argon2-хеши.
 *
 * otplib v13 functional API: импортируем generateSecret/generateURI/verifySync.
 */
import { generateSecret, generateURI, verifySync } from 'otplib';
import { hash, verify } from 'argon2';
import { randomBytes } from 'node:crypto';

const ISSUER = 'Erfolg';
const PERIOD_SECONDS = 30;
// ±1 шаг (всего ~ ±30 сек) — рассинхрон часов клиента/сервера.
const TOLERANCE: [number, number] = [PERIOD_SECONDS, PERIOD_SECONDS];

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // без 0/1/I/O
const RECOVERY_GROUP_LEN = 4;
const RECOVERY_GROUPS = 3;
const RECOVERY_TOTAL = 10;

export function generateTotpSecret(): string {
  return generateSecret({ length: 20 });
}

export function buildOtpauthUrl(secret: string, username: string): string {
  return generateURI({
    secret,
    label: username,
    issuer: ISSUER,
    strategy: 'totp',
    digits: 6,
    period: PERIOD_SECONDS,
  });
}

export function verifyTotp(secret: string, token: string): boolean {
  const cleaned = token.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return false;
  try {
    const result = verifySync({
      secret,
      token: cleaned,
      strategy: 'totp',
      period: PERIOD_SECONDS,
      digits: 6,
      epochTolerance: TOLERANCE,
    });
    return result.valid === true;
  } catch {
    return false;
  }
}

function pickAlphabetChar(byte: number): string {
  return RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length]!;
}

function generateRecoveryCode(): string {
  const totalChars = RECOVERY_GROUP_LEN * RECOVERY_GROUPS;
  const buf = randomBytes(totalChars);
  const groups: string[] = [];
  for (let g = 0; g < RECOVERY_GROUPS; g++) {
    let chunk = '';
    for (let i = 0; i < RECOVERY_GROUP_LEN; i++) {
      chunk += pickAlphabetChar(buf[g * RECOVERY_GROUP_LEN + i]!);
    }
    groups.push(chunk);
  }
  return groups.join('-');
}

export function generateRecoveryCodes(count = RECOVERY_TOTAL): string[] {
  const codes: string[] = [];
  while (codes.length < count) {
    const code = generateRecoveryCode();
    if (!codes.includes(code)) codes.push(code);
  }
  return codes;
}

export function normalizeRecoveryCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/\s+/g, '');
}

export function looksLikeRecoveryCode(raw: string): boolean {
  const cleaned = normalizeRecoveryCode(raw);
  return /^[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(cleaned);
}

export async function hashRecoveryCode(code: string): Promise<string> {
  return hash(normalizeRecoveryCode(code));
}

export async function hashRecoveryCodes(codes: string[]): Promise<string[]> {
  return Promise.all(codes.map((c) => hashRecoveryCode(c)));
}

/**
 * Проверяет код против списка хешей. При попадании возвращает индекс
 * (вызывающий должен удалить хеш для одноразовости). null = не совпало.
 */
export async function verifyRecoveryCode(
  code: string,
  hashes: string[],
): Promise<number | null> {
  const cleaned = normalizeRecoveryCode(code);
  for (let i = 0; i < hashes.length; i++) {
    const h = hashes[i];
    if (!h) continue;
    try {
       
      if (await verify(h, cleaned)) return i;
    } catch {
      // ignore malformed hash
    }
  }
  return null;
}
