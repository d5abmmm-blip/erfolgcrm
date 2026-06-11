-- Этап 6.B: контракты с клиентами + опциональная привязка заявки к контракту.
--
-- Бизнес-модель:
--   • service   — рамочный сервисный договор (на парк техники, на год). Заявки ссылаются на него
--                 через tickets.contract_id. Для бюджетных юрлиц обязателен (по 44-ФЗ).
--   • one_time  — разовый договор под одну заявку.
--
-- terms_json: jsonb со срочными параметрами договора (см. ContractTerms в schema/contracts.ts).
--   Хранится в БД free-form чтобы не плодить колонки под каждый параметр; типизируется на уровне DTO.
--
-- signed_pdf_object_key — указывает на attachments.object_key подписанного скана. Соответствующая
--   запись в attachments имеет kind='contract_signed', reference_type='contract', reference_id=contract.id.
--
-- RLS включается отдельно через 0011_enable_rls_stage6_contracts.sql (запускается setup-rls.ts).

CREATE TYPE "public"."contract_type" AS ENUM('service', 'one_time');--> statement-breakpoint
CREATE TYPE "public"."contract_status" AS ENUM('draft', 'active', 'expired', 'terminated');--> statement-breakpoint

CREATE TABLE "contracts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "client_id" uuid NOT NULL,
  "contract_number" varchar(50) NOT NULL,
  "contract_date" date NOT NULL,
  "type" "contract_type" NOT NULL DEFAULT 'service',
  "vat_rate" "vat_rate" NOT NULL DEFAULT '5',
  "status" "contract_status" NOT NULL DEFAULT 'active',
  "valid_from" date,
  "valid_until" date,
  "terms_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "signed_pdf_object_key" varchar(500),
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "contracts_validity_range" CHECK (
    "valid_from" IS NULL OR "valid_until" IS NULL OR "valid_until" >= "valid_from"
  )
);--> statement-breakpoint

-- Уникальный номер per tenant среди живых.
CREATE UNIQUE INDEX "contracts_tenant_number_uniq"
  ON "contracts" USING btree ("tenant_id", "contract_number")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "contracts_tenant_client_idx"
  ON "contracts" USING btree ("tenant_id", "client_id")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

CREATE INDEX "contracts_tenant_status_idx"
  ON "contracts" USING btree ("tenant_id", "status")
  WHERE "deleted_at" IS NULL;--> statement-breakpoint

ALTER TABLE "contracts" ADD CONSTRAINT "contracts_client_id_fkey"
  FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE RESTRICT;--> statement-breakpoint

-- Привязка заявки к контракту (опциональная; обязательность для бюджетников проверяется на уровне сервиса).
ALTER TABLE "tickets" ADD COLUMN "contract_id" uuid;--> statement-breakpoint

ALTER TABLE "tickets" ADD CONSTRAINT "tickets_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "contracts"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX "tickets_tenant_contract_idx"
  ON "tickets" USING btree ("tenant_id", "contract_id")
  WHERE "contract_id" IS NOT NULL;
