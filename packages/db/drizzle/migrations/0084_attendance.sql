-- Журнал учёта посещений (табель) — кто из сотрудников в какой день был на работе.
--
-- Записи заводятся руками в десктопной CRM: у инженеров на телефоне отметок
-- «пришёл/ушёл» нет. На зарплату таблица не влияет — ЗП считается по окладу,
-- бонусу и сделке, часов в формуле нет.
--
-- Инвариант: у сотрудника на день ровно одна отметка (уникальный индекс ниже).
-- Правка дня — UPDATE той же строки, поэтому «итого за месяц» однозначно.
DO $$ BEGIN
  CREATE TYPE "attendance_status" AS ENUM (
    'present',
    'day_off',
    'sick',
    'vacation',
    'business_trip',
    'absent',
    'unpaid_leave'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "attendance_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "work_date" date NOT NULL,
  "status" "attendance_status" NOT NULL,
  "arrived_at" time,
  "left_at" time,
  "note" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Один сотрудник — один день. На этот индекс опирается upsert.
CREATE UNIQUE INDEX IF NOT EXISTS "attendance_records_uniq"
  ON "attendance_records" USING btree ("tenant_id", "user_id", "work_date");--> statement-breakpoint

-- «Кто был на работе в этом месяце» — единственный запрос страницы и печати.
CREATE INDEX IF NOT EXISTS "attendance_records_tenant_date_idx"
  ON "attendance_records" USING btree ("tenant_id", "work_date");
