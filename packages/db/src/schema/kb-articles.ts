/**
 * База знаний (kb_articles).
 *
 * Назначение:
 *   - Менеджер/инженер ведёт «вики» по моделям техники и типовым операциям
 *     (например «Калибровка тонометра XYZ — пошагово»).
 *   - В карточке тикета и асcета показывается блок «Похожие случаи»:
 *     прошлые ремонты на этом asset (это уже есть в API через `tickets.list`)
 *     + статьи из этой таблицы по совпадению моделей/тэгов.
 *
 * Поиск:
 *   - pg_trgm GIN-индекс по lower(title || body) — нечёткий полнотекстовый.
 *     Опечатки тоже находятся (similarity < 1).
 *   - GIN-индексы по tags / asset_models / attached_asset_ids — для точных совпадений.
 *
 * Принципиально без AI/embeddings — обычный full-text search. Дешевле, проще,
 * приватнее (ничего не уходит наружу) и для 11 человек — достаточно.
 *
 * `attached_asset_ids` — конкретные единицы техники, к которым статья привязана
 * (например, статья про прошлый сложный ремонт именно ЭТОГО ИВЛ).
 * `asset_models` — модели (например ["Drager Savina 300"]) для применения к
 * новым асcетам той же модели в будущем.
 */
import {
  check,
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, tenantId, timestamps } from './_shared';

export const kbArticles = pgTable(
  'kb_articles',
  {
    id: pk(),
    tenantId: tenantId(),
    /** Заголовок статьи (показывается в списках и блоке «Похожие случаи»). */
    title: varchar('title', { length: 200 }).notNull(),
    /** Тело в Markdown. На фронте рендерится упрощённой подсветкой. */
    body: text('body').notNull().default(''),
    /**
     * Конкретные asset.id, к которым статья прикреплена явно.
     * Используется для случая «эта статья про вот эти конкретные единицы».
     * Не FK — массив, чтобы не плодить join-таблицу. RESTRICT при удалении asset
     * не работает (у массива нет FK), но это OK: id в массиве может «висеть»
     * как историческое упоминание, при rendering мы делаем LEFT JOIN.
     */
    attachedAssetIds: uuid('attached_asset_ids')
      .array()
      .notNull()
      .default(sql`'{}'::uuid[]`),
    /**
     * Модели техники (текст), для которых статья применима.
     * Например ["Drager Savina 300", "Drager Carina"].
     * Используется в searchSimilar — если у asset.model есть пересечение с asset_models.
     */
    assetModels: text('asset_models')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Свободные тэги: «калибровка», «термопаста», «ИВЛ», «гарантия». */
    tags: text('tags')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    /** Soft archive — не показываем в списке/поиске, но карточка остаётся. */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdByUserId: uuid('created_by_user_id'),
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
  },
  (t) => [
    index('kb_articles_tenant_archived_idx').on(t.tenantId, t.archivedAt),
    check('kb_articles_title_check', sql`char_length(trim(title)) > 0`),
  ],
);

export type KbArticleRow = typeof kbArticles.$inferSelect;
