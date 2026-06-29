-- Каталог моделей техники (asset_models) — справочник типов аппаратов,
-- не привязанный к клиенту. Заполняется один раз и переиспользуется при
-- заведении единицы техники / создании заявки. Серийный/инвентарный номер
-- по-прежнему хранится на конкретном экземпляре (assets).
--
-- Тип med_device_risk_class уже создан ранее (0002_clients_assets.sql).
-- RLS включается отдельно через 0058_enable_rls_asset_models.sql (setup-rls.ts).

CREATE TABLE IF NOT EXISTS "asset_models" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "manufacturer" varchar(200),
  "model" varchar(200) NOT NULL,
  "risk_class" "med_device_risk_class",
  "required_attestation_category" varchar(100),
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "asset_models_tenant_model_idx"
  ON "asset_models" ("tenant_id", "model");

-- Ссылка единицы техники на модель из каталога (необязательная).
ALTER TABLE "assets" ADD COLUMN IF NOT EXISTS "asset_model_id" uuid;

CREATE INDEX IF NOT EXISTS "assets_tenant_model_ref_idx"
  ON "assets" ("tenant_id", "asset_model_id");
