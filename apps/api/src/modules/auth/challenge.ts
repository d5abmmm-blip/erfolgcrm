/**
 * Stage 10'.C — 2FA challenge token.
 *
 * После успешной проверки пароля, если у пользователя включена 2FA,
 * сервер выдаёт challengeToken (HMAC-подписанный JSON с userId+tenantId+jti+exp,
 * TTL=5мин). Клиент возвращает его вместе с TOTP/recovery-кодом в auth.verify2fa.
 *
 * Подпись через SESSION_SECRET (или PII_ENCRYPTION_KEY как fallback в dev),
 * чтобы привязать токен к этому инстансу.
 *
 * jti используется как ключ для in-memory rate-limit (5 попыток/мин).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 5 * 60 * 1000;

interface Payload {
  userId: string;
  tenantId: string;
  jti: string;
  exp: number;
}

function getSecret(): string {
  const candidate = process.env.SESSION_SECRET || process.env.PII_ENCRYPTION_KEY;
  if (!candidate) {
    // Тот же принцип, что у PII-ключа (packages/db/src/crypto.ts): в production
    // тихий fallback недопустим — подпись 2FA-токенов должна опираться на
    // настоящий секрет, иначе приложение не стартует.
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'SESSION_SECRET (или PII_ENCRYPTION_KEY) обязателен в production — без него 2FA-challenge не подписывается',
      );
    }
    return 'dev-only-2fa-challenge-secret';
  }
  return candidate;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const padded = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  return Buffer.from(padded, 'base64');
}

function sign(payloadB64: string): string {
  return b64url(createHmac('sha256', getSecret()).update(payloadB64).digest());
}

export function issueChallengeToken(userId: string, tenantId: string): {
  token: string;
  jti: string;
} {
  const jti = b64url(randomBytes(12));
  const payload: Payload = { userId, tenantId, jti, exp: Date.now() + TTL_MS };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = sign(payloadB64);
  return { token: `${payloadB64}.${sig}`, jti };
}

export function verifyChallengeToken(token: string): Payload | null {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.', 2);
  if (!payloadB64 || !sig) return null;
  const expected = sign(payloadB64);
  let sigBuf: Buffer;
  let expBuf: Buffer;
  try {
    sigBuf = fromB64url(sig);
    expBuf = fromB64url(expected);
  } catch {
    return null;
  }
  if (sigBuf.length !== expBuf.length) return null;
  if (!timingSafeEqual(sigBuf, expBuf)) return null;
  let parsed: Payload;
  try {
    parsed = JSON.parse(fromB64url(payloadB64).toString('utf8')) as Payload;
  } catch {
    return null;
  }
  if (
    typeof parsed.userId !== 'string' ||
    typeof parsed.tenantId !== 'string' ||
    typeof parsed.jti !== 'string' ||
    typeof parsed.exp !== 'number'
  ) {
    return null;
  }
  if (parsed.exp < Date.now()) return null;
  return parsed;
}

/**
 * Простой in-memory rate-limit на попытки verify2fa per challenge.jti.
 * single-instance ок (приложение не масштабируется горизонтально для 1 компании).
 */
const ATTEMPTS = new Map<string, { count: number; resetAt: number }>();
const MAX_ATTEMPTS = 5;
const WINDOW_MS = 60 * 1000;

export function checkAttempt(jti: string): boolean {
  const now = Date.now();
  const cur = ATTEMPTS.get(jti);
  if (!cur || cur.resetAt < now) {
    ATTEMPTS.set(jti, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (cur.count >= MAX_ATTEMPTS) return false;
  cur.count += 1;
  return true;
}

export function clearAttempts(jti: string): void {
  ATTEMPTS.delete(jti);
}

/** Тестовая утилита: полностью сбросить хранилище попыток. */
export function _resetAttemptsForTests(): void {
  ATTEMPTS.clear();
}
