CREATE TABLE IF NOT EXISTS "tasks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL,
  "title" varchar(300) NOT NULL,
  "notes" text,
  "due_date" date,
  "due_time" time,
  "assignee_user_id" uuid,
  "created_by_user_id" uuid,
  "is_done" boolean DEFAULT false NOT NULL,
  "done_at" timestamp with time zone,
  "done_by_user_id" uuid,
  "remind_at" timestamp with time zone,
  "reminded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tasks_tenant_due_idx"
  ON "tasks" USING btree ("tenant_id", "due_date")
  WHERE deleted_at IS NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "tasks_tenant_assignee_idx"
  ON "tasks" USING btree ("tenant_id", "assignee_user_id")
  WHERE deleted_at IS NULL;
