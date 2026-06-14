-- Раздел «Почта», Этап A.
-- email_configs — реквизиты общего ящика компании (SMTP + IMAP-заготовка) на tenant.
--   Пароли шифруются (bytea, pgcrypto), как остальные ПДн.
-- email_messages — журнал писем (исходящие сейчас; входящие — Этап B). Тема/тело/адреса
--   шифруются. Сами вложения не храним — только метаданные.
--
-- RLS включается отдельно через 0042_enable_rls_email.sql (setup-rls.ts).

CREATE TABLE "email_configs" (
  "tenant_id" uuid PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT false NOT NULL,
  "from_name" varchar(200),
  "from_email" varchar(320),
  "smtp_host" varchar(255),
  "smtp_port" integer,
  "smtp_secure" boolean DEFAULT true NOT NULL,
  "smtp_user" varchar(320),
  "smtp_password_encrypted" bytea,
  "imap_host" varchar(255),
  "imap_port" integer,
  "imap_secure" boolean DEFAULT true NOT NULL,
  "imap_user" varchar(320),
  "imap_password_encrypted" bytea,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE TABLE "email_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "direction" varchar(8) DEFAULT 'out' NOT NULL,
  "status" varchar(16) NOT NULL,
  "to_addr_encrypted" bytea,
  "from_addr_encrypted" bytea,
  "subject_encrypted" bytea,
  "body_text_encrypted" bytea,
  "body_html_encrypted" bytea,
  "message_id" varchar(512),
  "related_ticket_id" uuid,
  "related_client_id" uuid,
  "attachment_name" varchar(255),
  "attachment_kind" varchar(32),
  "error" text,
  "sent_by_user_id" uuid,
  "sent_at" timestamp with time zone,
  "received_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone,
  CONSTRAINT "email_messages_direction_chk" CHECK (direction IN ('out','in')),
  CONSTRAINT "email_messages_status_chk" CHECK (status IN ('sent','skipped','failed','received'))
);--> statement-breakpoint

CREATE INDEX "email_messages_tenant_created_idx"
  ON "email_messages" USING btree ("tenant_id", "created_at" DESC);
