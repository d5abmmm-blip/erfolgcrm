import pino from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  // Не логируем потенциальные ПДн поля и секреты.
  // Глобы покрывают и camelCase (zod input/output) и snake_case (raw rows из postgres-js).
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      '*.password',
      '*.password_hash',
      '*.token',
      '*.secret',
      // PII (Этап 2)
      '*.fullName',
      '*.full_name',
      '*.fullNameEncrypted',
      '*.full_name_encrypted',
      '*.phone',
      '*.phoneEncrypted',
      '*.phone_encrypted',
      '*.address',
      '*.addressEncrypted',
      '*.address_encrypted',
      '*.individualFullName',
      '*.individualPhone',
      '*.individualAddress',
      // Те же поля именами КОЛОНОК: сырая строка из БД логируется в snake_case
      // (миграция 0078 — ПДн лежат открыто, промахнуться здесь дороже, чем раньше).
      '*.individual_full_name',
      '*.individual_phone',
      '*.individual_address',
      '*.email',
      // Ключ шифрования — никогда в логах
      '*.PII_ENCRYPTION_KEY',
      '*.encryptionKey',
      '*.tenantKey',
      // Ключи внешних провайдеров (LLM-ассистент и т.п.)
      '*.apiKey',
      '*.api_key',
      '*.api_key_encrypted',
      // Описательные тексты в заявках/нарядах: могут содержать жалобы пациента,
      // комментарий о состоянии техники и т.п. — не строго PII, но скрываем.
      '*.symptom',
      '*.cancelReason',
      '*.cancel_reason',
      '*.diagnosis',
      '*.repairDescription',
      '*.repair_description',
      '*.comment',
      // Этап 5: склад/финансы. Поставщики и партии — коммерческая тайна,
      // банковские/карточные данные — финансовая информация.
      '*.batchCode',
      '*.batch_code',
      '*.supplier',
      '*.bankAccount',
      '*.bank_account',
      '*.cardNumber',
      '*.card_number',
      // Этап 6: ключи S3 — не PII, но утечка в логах = подсказка для атаки
      // (presigned URLs содержат подпись и ограниченный TTL, но object_key
      // может раскрывать структуру bucket'а).
      '*.objectKey',
      '*.object_key',
      '*.presignedUrl',
      '*.presigned_url',
      '*.presignedGetUrl',
      '*.presigned_get_url',
    ],
    censor: '[REDACTED]',
  },
  transport: isDev
    ? {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss', ignore: 'pid,hostname' },
      }
    : undefined,
});
