#!/usr/bin/env node
/**
 * Генерирует безопасный 32-байтный ключ для PII_ENCRYPTION_KEY.
 *
 * Использование:
 *   node scripts/generate-pii-key.mjs
 *
 * Скопируй вывод в .env (или в секреты systemd / docker / vault).
 * НИКОГДА не коммить ключ в git и не используй один и тот же ключ
 * между dev/staging/prod.
 *
 * Что внутри:
 *   crypto.randomBytes(32) → 256 бит энтропии (CSPRNG из libsodium-уровня).
 *   base64 — компактнее hex и валиден в .env без экранирования.
 */
import { randomBytes } from 'node:crypto';

const key = randomBytes(32).toString('base64');

// Машинно-читаемая строка только в stdout (можно делать pipe).
process.stdout.write(`PII_ENCRYPTION_KEY=${key}\n`);

// Подсказка — в stderr, чтобы не мешала pipe в .env.
process.stderr.write(
  '\n[generate-pii-key] Сгенерирован новый PII_ENCRYPTION_KEY (32 байта, base64).\n' +
    '  - Скопируй строку выше в .env на проде (или в секреты systemd/docker).\n' +
    '  - Сохрани копию ключа в надёжном месте: после первой записи зашифрованных\n' +
    '    ПДн его потеря = потеря данных (расшифровать без ключа нельзя).\n' +
    '  - Для ротации ключа потребуется отдельная миграция-перешифровка (план Stage 6+).\n\n',
);
