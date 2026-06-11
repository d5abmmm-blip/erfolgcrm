/**
 * Repository roadmap_goals. Все запросы под withTenantTx (RLS FORCE).
 * Сортировка: год/квартал desc, приоритет (high первым), создание.
 */
import { and, asc, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import { roadmapGoals, withTenantTx, type Db } from '@erfolg/db';
import type { RoadmapCategory, RoadmapPriority, RoadmapQuarter } from '@erfolg/shared';

export interface RoadmapGoalDto {
  id: string;
  quarter: RoadmapQuarter;
  year: number;
  title: string;
  description: string | null;
  targetValue: number | null;
  currentValue: number | null;
  unit: string | null;
  category: RoadmapCategory;
  priority: RoadmapPriority;
  isDone: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateGoalInput {
  quarter: RoadmapQuarter;
  year: number;
  title: string;
  description?: string | null;
  targetValue?: number | null;
  currentValue?: number | null;
  unit?: string | null;
  category: RoadmapCategory;
  priority?: RoadmapPriority;
}

export interface UpdateGoalPatch {
  quarter?: RoadmapQuarter;
  year?: number;
  title?: string;
  description?: string | null;
  targetValue?: number | null;
  currentValue?: number | null;
  unit?: string | null;
  category?: RoadmapCategory;
  priority?: RoadmapPriority;
  isDone?: boolean;
}

function rowToDto(row: typeof roadmapGoals.$inferSelect): RoadmapGoalDto {
  return {
    id: row.id,
    quarter: row.quarter,
    year: row.year,
    title: row.title,
    description: row.description ?? null,
    targetValue: row.targetValue ?? null,
    currentValue: row.currentValue ?? null,
    unit: row.unit ?? null,
    category: row.category,
    priority: row.priority,
    isDone: row.isDone,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listGoals(
  db: Db,
  tenantId: string,
  opts: { year?: number } = {},
): Promise<RoadmapGoalDto[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [isNull(roadmapGoals.deletedAt)];
    if (opts.year) filters.push(eq(roadmapGoals.year, opts.year));
    const rows = await tx
      .select()
      .from(roadmapGoals)
      .where(and(...filters))
      .orderBy(
        desc(roadmapGoals.year),
        asc(roadmapGoals.quarter),
        sql`CASE ${roadmapGoals.priority} WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END`,
        asc(roadmapGoals.createdAt),
      );
    return rows.map(rowToDto);
  });
}

export async function createGoal(
  db: Db,
  tenantId: string,
  input: CreateGoalInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(roadmapGoals)
      .values({
        tenantId,
        quarter: input.quarter,
        year: input.year,
        title: input.title,
        description: input.description ?? null,
        targetValue: input.targetValue ?? null,
        currentValue: input.currentValue ?? null,
        unit: input.unit ?? null,
        category: input.category,
        priority: input.priority ?? 'medium',
      })
      .returning({ id: roadmapGoals.id });
    const row = inserted[0];
    if (!row) throw new Error('createGoal: nothing returned');
    return row;
  });
}

export async function updateGoal(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateGoalPatch,
): Promise<RoadmapGoalDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.quarter !== undefined) set.quarter = patch.quarter;
    if (patch.year !== undefined) set.year = patch.year;
    if (patch.title !== undefined) set.title = patch.title;
    if (patch.description !== undefined) set.description = patch.description;
    if (patch.targetValue !== undefined) set.targetValue = patch.targetValue;
    if (patch.currentValue !== undefined) set.currentValue = patch.currentValue;
    if (patch.unit !== undefined) set.unit = patch.unit;
    if (patch.category !== undefined) set.category = patch.category;
    if (patch.priority !== undefined) set.priority = patch.priority;
    if (patch.isDone !== undefined) set.isDone = patch.isDone;
    if (Object.keys(set).length === 0) {
      const rows = await tx
        .select()
        .from(roadmapGoals)
        .where(and(eq(roadmapGoals.id, id), isNull(roadmapGoals.deletedAt)))
        .limit(1);
      return rows[0] ? rowToDto(rows[0]) : null;
    }
    const updated = await tx
      .update(roadmapGoals)
      .set(set)
      .where(and(eq(roadmapGoals.id, id), isNull(roadmapGoals.deletedAt)))
      .returning();
    return updated[0] ? rowToDto(updated[0]) : null;
  });
}

export async function archiveGoal(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(roadmapGoals)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(roadmapGoals.id, id), isNull(roadmapGoals.deletedAt)))
      .returning({ id: roadmapGoals.id });
    return updated.length > 0;
  });
}
