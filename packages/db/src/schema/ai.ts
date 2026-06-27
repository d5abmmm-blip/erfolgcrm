/**
 * Конфигурация AI-ассистента (LLM) на уровне tenant'а.
 *
 * llm_configs — реквизиты подключения к LLM-провайдеру (одна строка на tenant,
 *   модель — email_configs / onec_configs). Раньше задавались только через env
 *   (LLM_*); теперь директор может ввести их в Настройках. API-ключ — секрет,
 *   шифруется через pgcrypto (bytea), как пароли почты.
 *
 * apiStyle: 'openai' (POST {base}/chat/completions) | 'anthropic' (POST {base}/v1/messages,
 *   нужно для z.ai GLM Coding Plan).
 *
 * RLS включается отдельным *enable_rls*.sql (см. setup-rls.ts).
 */
import { boolean, pgTable, varchar } from 'drizzle-orm/pg-core';
import { encryptedText, tenantId, timestamps } from './_shared';

/** Реквизиты подключения к LLM. Одна строка на tenant. */
export const llmConfigs = pgTable('llm_configs', {
  tenantId: tenantId().primaryKey(),
  /** Включён ли ассистент. Если выключен — работаем как «не настроен». */
  enabled: boolean('enabled').notNull().default(false),
  /** Протокол: 'openai' | 'anthropic'. */
  apiStyle: varchar('api_style', { length: 16 }).notNull().default('anthropic'),
  /** База API, напр. https://api.z.ai/api/anthropic или https://openrouter.ai/api/v1. */
  baseUrl: varchar('base_url', { length: 500 }),
  /** Идентификатор модели, напр. glm-4.6 или deepseek/deepseek-chat. */
  model: varchar('model', { length: 120 }),
  /** API-ключ провайдера — зашифрован (bytea). */
  apiKeyEnc: encryptedText('api_key_encrypted'),
  ...timestamps,
});
