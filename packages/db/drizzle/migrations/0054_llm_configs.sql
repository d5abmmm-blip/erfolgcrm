-- Конфигурация AI-ассистента (LLM) на уровне tenant'а (llm_configs).
-- Реквизиты подключения к LLM-провайдеру; раньше задавались только через env
-- (LLM_*), теперь директор вводит их в Настройках. API-ключ — секрет, шифруется
-- через pgcrypto (bytea), как пароли почты.
--
-- RLS включается отдельно через 0055_enable_rls_llm.sql (setup-rls.ts).

CREATE TABLE IF NOT EXISTS "llm_configs" (
  "tenant_id" uuid PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "api_style" varchar(16) DEFAULT 'anthropic' NOT NULL,
  "base_url" varchar(500),
  "model" varchar(120),
  "api_key_encrypted" bytea,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
