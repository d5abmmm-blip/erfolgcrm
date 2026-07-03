-- Кэш утренней AI-сводки: одна строка на (tenant, дата).
-- Пересобирается по запросу при первом открытии дашборда за день; далее отдаётся из
-- кэша — LLM повторно не дёргаем (экономия + не зависим от аптайма провайдера).
-- RLS включается отдельно (0064_enable_rls_ai_daily_summaries.sql, setup-rls.ts).

CREATE TABLE IF NOT EXISTS "ai_daily_summaries" (
  "tenant_id" uuid NOT NULL,
  "summary_date" date NOT NULL,
  "body_text" text NOT NULL,
  "generated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "ai_daily_summaries_pk" PRIMARY KEY ("tenant_id", "summary_date")
);
