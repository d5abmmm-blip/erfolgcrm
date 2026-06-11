-- Stage 10'.F — Метрология (поверки СИ).
--
-- metrology_si_details: singleton-расширение к assets для СИ.
--   PK = asset_id (один-к-одному). При создании/удалении синхронно
--   меняется assets.requires_metrology (см. metrology/repository.ts).
--
-- metrology_calibrations: журнал поверок СИ (passed/failed).
--   При insert обновляются last_calibration_at и next_calibration_at в metrology_si_details:
--     passed → next = max(performed_at + interval months, valid_until)
--     failed → next = today + 7 дней (повторная поверка)
--
-- 102-ФЗ "Об обеспечении единства измерений": СИ в медицине подлежат периодической поверке.
-- Все суммы — bigint в копейках (тут денег нет).

CREATE TYPE "metrology_calibration_result" AS ENUM ('passed', 'failed');--> statement-breakpoint

CREATE TABLE "metrology_si_details" (
  "asset_id"                      uuid PRIMARY KEY NOT NULL,
  "tenant_id"                     uuid NOT NULL,
  "type_name"                     varchar(200) NOT NULL,
  "pattern_registry_number"       varchar(50),
  "accuracy_class"                varchar(50),
  "measurement_range"             varchar(200),
  "calibration_interval_months"   smallint NOT NULL,
  "last_calibration_at"           date,
  "next_calibration_at"           date,
  "created_at"                    timestamptz NOT NULL DEFAULT now(),
  "updated_at"                    timestamptz NOT NULL DEFAULT now(),
  "deleted_at"                    timestamptz,
  CONSTRAINT "metrology_si_details_asset_id_fk"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE,
  CONSTRAINT "metrology_si_details_interval_positive"
    CHECK (calibration_interval_months > 0)
);--> statement-breakpoint

CREATE INDEX "metrology_si_details_tenant_next_idx"
  ON "metrology_si_details" ("tenant_id", "next_calibration_at");--> statement-breakpoint

CREATE TABLE "metrology_calibrations" (
  "id"                       uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"                uuid NOT NULL,
  "asset_id"                 uuid NOT NULL,
  "performed_at"             date NOT NULL,
  "valid_until"              date NOT NULL,
  "certificate_number"       varchar(100),
  "calibrator_org"           varchar(300),
  "result"                   metrology_calibration_result NOT NULL,
  "notes"                    text,
  "document_attachment_id"   uuid,
  "created_at"               timestamptz NOT NULL DEFAULT now(),
  "updated_at"               timestamptz NOT NULL DEFAULT now(),
  "deleted_at"               timestamptz,
  CONSTRAINT "metrology_calibrations_asset_id_fk"
    FOREIGN KEY ("asset_id") REFERENCES "assets"("id") ON DELETE CASCADE,
  CONSTRAINT "metrology_calibrations_valid_after_performed"
    CHECK (valid_until >= performed_at)
);--> statement-breakpoint

CREATE INDEX "metrology_calibrations_tenant_asset_idx"
  ON "metrology_calibrations" ("tenant_id", "asset_id", "performed_at" DESC);
