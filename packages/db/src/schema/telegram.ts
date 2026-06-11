/**
 * Этап 7-B: per-tenant конфиг Telegram-бота.
 *
 * Один tenant — один бот (или ни одного). Поэтому tenant_id — PRIMARY KEY.
 *
 * bot_token и webhook_secret шифруются через pgcrypto (per-tenant ключ; в dev — общий
 * PII_ENCRYPTION_KEY). Токен бота — это ровно то же, что токен от @BotFather, доступ к нему
 * = полный контроль над ботом, поэтому plain-text никогда не покидает БД.
 *
 * webhook_secret отправляется Telegram'ом в заголовке `X-Telegram-Bot-Api-Secret-Token`
 * при каждом update'е (см. setWebhook secret_token API). Используется для аутентификации входящих
 * запросов: если заголовок не совпадает — webhook reject.
 */
import { boolean, pgTable, uuid, varchar } from 'drizzle-orm/pg-core';
import { encryptedText, tenantId, timestamps } from './_shared';

export const telegramBotConfigs = pgTable('telegram_bot_configs', {
  tenantId: tenantId().primaryKey(),
  /** @BotFather token, зашифровано pgcrypto. */
  botTokenEncrypted: encryptedText('bot_token_encrypted').notNull(),
  /** Случайный 64-символьный hex; Telegram кладёт в X-Telegram-Bot-Api-Secret-Token. */
  webhookSecretEncrypted: encryptedText('webhook_secret_encrypted').notNull(),
  /** @username бота — для отображения в UI и проверок (например что setWebhook успешен). */
  botUsername: varchar('bot_username', { length: 64 }),
  /** Включён ли бот сейчас (для быстрого on/off без удаления токена). */
  enabled: boolean('enabled').notNull().default(true),
  /** Кому слать push при создании заявки из Telegram. NULL — всем диспетчерам тенанта. */
  defaultDispatcherUserId: uuid('default_dispatcher_user_id'),
  ...timestamps,
});
