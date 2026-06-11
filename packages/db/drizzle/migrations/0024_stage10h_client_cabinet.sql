-- Stage 10'.H — Кабинет клиента (MVP).
--
-- Учётные записи клиентов (юр.лиц-заказчиков сервиса). Это ОТДЕЛЬНЫЙ namespace
-- от users (staff): директор/диспетчер/инженер ↔ users; контактные лица клиента
-- (главбух клиники, директор клиники, снабженец) ↔ client_users.
--
-- Один client_user принадлежит ровно одному client (FK on delete cascade).
-- Email — логин. Уникален case-insensitive в пределах tenant'а
-- (UNIQUE INDEX на lower(email) WHERE deleted_at IS NULL).
--
-- Сессии — отдельная таблица client_sessions, чтобы не путать с staff sessions
-- и независимо отзывать (cookie name = "client_session_token").
--
-- AuditLog оставляем общий (audit_logs), но userId в записях логин-неудач/мутаций
-- кабинета = NULL, а в context — { client_user_id, client_email }.

CREATE TABLE "client_users" (
  "id"              uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"       uuid NOT NULL,
  "client_id"       uuid NOT NULL,
  "email"           varchar(200) NOT NULL,
  "password_hash"   varchar(500) NOT NULL,
  "full_name"       varchar(200) NOT NULL,
  "position"        varchar(200),
  "phone"           varchar(50),
  "is_active"       boolean NOT NULL DEFAULT true,
  "last_login_at"   timestamptz,
  "last_login_ip"   varchar(45),
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  "updated_at"      timestamptz NOT NULL DEFAULT now(),
  "deleted_at"      timestamptz,
  CONSTRAINT "client_users_client_fk"
    FOREIGN KEY ("client_id") REFERENCES "clients"("id") ON DELETE CASCADE
);--> statement-breakpoint

-- Email уникален case-insensitive в пределах tenant'а среди живых
CREATE UNIQUE INDEX "client_users_tenant_email_lower_uniq"
  ON "client_users" ("tenant_id", lower("email"))
  WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE INDEX "client_users_tenant_client_idx"
  ON "client_users" ("tenant_id", "client_id")
  WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE TABLE "client_sessions" (
  "id"              uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"       uuid NOT NULL,
  "client_user_id"  uuid NOT NULL,
  "session_token"   varchar(64) NOT NULL UNIQUE,
  "ip"              varchar(45),
  "user_agent"      varchar(500),
  "expires_at"      timestamptz NOT NULL,
  "revoked_at"      timestamptz,
  "last_seen_at"    timestamptz NOT NULL DEFAULT now(),
  "created_at"      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "client_sessions_user_fk"
    FOREIGN KEY ("client_user_id") REFERENCES "client_users"("id") ON DELETE CASCADE
);--> statement-breakpoint

CREATE INDEX "client_sessions_token_idx"
  ON "client_sessions" ("session_token");--> statement-breakpoint

CREATE INDEX "client_sessions_tenant_user_idx"
  ON "client_sessions" ("tenant_id", "client_user_id");
