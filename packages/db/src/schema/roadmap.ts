/**
 * Дорожная карта — внутренние цели компании по кварталам
 * (перенос из v1 project_2, таблица `roadmap_goals`).
 *
 * Цель: «выручка 5 млн за Q3 2026» — target/current/unit дают прогресс-бар,
 * isDone — ручная отметка завершения (прогресс может быть нелинейным).
 */
import { boolean, index, integer, pgEnum, pgTable, text, varchar } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { pk, tenantId, timestamps } from './_shared';

export const roadmapQuarterEnum = pgEnum('roadmap_quarter', ['Q1', 'Q2', 'Q3', 'Q4']);

export const roadmapCategoryEnum = pgEnum('roadmap_category', [
  'revenue',
  'clients',
  'processes',
  'team',
  'product',
]);

export const roadmapPriorityEnum = pgEnum('roadmap_priority', ['high', 'medium', 'low']);

export const roadmapGoals = pgTable(
  'roadmap_goals',
  {
    id: pk(),
    tenantId: tenantId(),

    quarter: roadmapQuarterEnum('quarter').notNull(),
    year: integer('year').notNull(),

    title: varchar('title', { length: 255 }).notNull(),
    description: text('description'),

    /** Числовая цель (например 5 000 000) и текущее значение; unit — «₽», «шт», «%». */
    targetValue: integer('target_value'),
    currentValue: integer('current_value'),
    unit: varchar('unit', { length: 32 }),

    category: roadmapCategoryEnum('category').notNull(),
    priority: roadmapPriorityEnum('priority').notNull().default('medium'),
    isDone: boolean('is_done').notNull().default(false),

    ...timestamps,
  },
  (t) => [
    index('roadmap_tenant_period_idx')
      .on(t.tenantId, t.year, t.quarter)
      .where(sql`deleted_at IS NULL`),
  ],
);
