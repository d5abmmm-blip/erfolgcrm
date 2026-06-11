-- Stage 10'.I — Аттестация инженеров.
--
-- engineer_attestations — выданные допуски инженерам по типам медтехники.
-- При назначении инженера на заявку с asset.required_attestation_category
-- проверяем наличие действующей аттестации (см. tickets/service.ts).
--
-- Категории — словарь в коде (modules/attestations/categories.ts), в БД храним
-- свободный varchar (на случай редких категорий вне словаря).
--
-- ALTER TABLE assets ADD required_attestation_category — необязательное требование
-- для обслуживания. NULL ⇒ проверка не выполняется.

CREATE TABLE "engineer_attestations" (
  "id"                          uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"                   uuid NOT NULL,
  "engineer_id"                 uuid NOT NULL,
  "category"                    varchar(100) NOT NULL,
  "issued_by"                   varchar(300),
  "certificate_number"          varchar(100),
  "issued_at"                   date NOT NULL,
  "valid_until"                 date,
  "document_attachment_id"      uuid,
  "notes"                       text,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now(),
  "deleted_at"                  timestamptz,
  CONSTRAINT "engineer_attestations_engineer_fk"
    FOREIGN KEY ("engineer_id") REFERENCES "users"("id") ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX "engineer_attestations_tenant_engineer_idx"
  ON "engineer_attestations" ("tenant_id", "engineer_id");--> statement-breakpoint

CREATE INDEX "engineer_attestations_tenant_category_idx"
  ON "engineer_attestations" ("tenant_id", "category");--> statement-breakpoint

ALTER TABLE "assets"
  ADD COLUMN IF NOT EXISTS "required_attestation_category" varchar(100);
