-- База знаний (kb_articles).
--
-- Бизнес-цель: инженер открывает карточку тикета или асcета и видит
--   1) прошлые ремонты этой техники (через assets/tickets — уже есть в API);
--   2) кустарную «вики» статей про модель/класс техники
--      (например «Калибровка тонометра XYZ — пошагово»).
--
-- Принципиально без AI — обычный полнотекстовый поиск через pg_trgm.
-- Дешевле в эксплуатации (нет внешних API), приватнее (ничего не уходит в OpenAI),
-- быстрее (50ms вместо 5s).
--
-- Структура:
--   title                — короткий заголовок (показывается в списке/блоке «Похожие»)
--   body                 — markdown-тело (рендерится на фронте)
--   attached_asset_ids   — конкретные единицы техники, к которым статья привязана
--                          (опц. — например, статья про прошлый сложный ремонт именно ЭТОГО ИВЛ)
--   asset_models         — модели техники, к которым статья применима
--                          (например, ["Drager Savina 300", "Drager Carina"])
--   tags                 — свободный список тэгов («калибровка», «ИВЛ», «термопаста»)
--   archived_at          — soft archive (не показываем в списке/поиске, но видно при includeArchived)
--
-- Поиск:
--   trigram-индекс по lower(title || ' ' || body) — pg_trgm считает similarity
--   между запросом и текстом. Использование: ORDER BY similarity(...) DESC.
--   Точные совпадения по asset_models и tags — через GIN-индексы.

CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint

CREATE TABLE "kb_articles" (
  "id"                    uuid PRIMARY KEY NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id"             uuid NOT NULL,
  "title"                 varchar(200) NOT NULL,
  "body"                  text NOT NULL DEFAULT '',
  "attached_asset_ids"    uuid[] NOT NULL DEFAULT '{}',
  "asset_models"          text[] NOT NULL DEFAULT '{}',
  "tags"                  text[] NOT NULL DEFAULT '{}',
  "created_by_user_id"    uuid,
  "archived_at"           timestamptz,
  "created_at"            timestamptz NOT NULL DEFAULT now(),
  "updated_at"            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "kb_articles_user_fk"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id"),
  CONSTRAINT "kb_articles_title_check" CHECK (char_length(trim(title)) > 0)
);--> statement-breakpoint

-- Индекс под list (фильтр по tenant + сортировка/фильтр по archived_at).
CREATE INDEX "kb_articles_tenant_archived_idx"
  ON "kb_articles" ("tenant_id", "archived_at");--> statement-breakpoint

-- pg_trgm для нечёткого полнотекстового поиска по заголовку + телу.
-- Хранится functional-индекс (immutable expression) — обновляется автоматически.
CREATE INDEX "kb_articles_search_trgm_idx"
  ON "kb_articles"
  USING gin ((lower(title || ' ' || body)) gin_trgm_ops);--> statement-breakpoint

-- Точные совпадения по тэгам/моделям — GIN-индексы для @> и && операторов.
CREATE INDEX "kb_articles_tags_idx"
  ON "kb_articles"
  USING gin ("tags");--> statement-breakpoint

CREATE INDEX "kb_articles_asset_models_idx"
  ON "kb_articles"
  USING gin ("asset_models");--> statement-breakpoint

CREATE INDEX "kb_articles_attached_assets_idx"
  ON "kb_articles"
  USING gin ("attached_asset_ids");
