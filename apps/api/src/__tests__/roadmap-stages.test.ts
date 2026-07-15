/**
 * Тесты этапов цели дорожной карты (modules/roadmap — колонка stages jsonb):
 *   • цель создаётся с этапами, list их возвращает; без этапов → [];
 *   • update заменяет массив этапов (добавление подшага + отметка «сделано»).
 *
 * Год 2031 — не пересекается с dev-данными. Чистка по префиксу в afterAll.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { getDb, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import { createGoal, listGoals, updateGoal } from '../modules/roadmap/repository';

const TEST_PREFIX = 'TESTROADMAP-';
let erfolgId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
});

afterAll(async () => {
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.execute(sql`DELETE FROM roadmap_goals WHERE title LIKE ${TEST_PREFIX + '%'}`),
  );
});

describe('roadmap — этапы цели (stages)', () => {
  it('создаётся с этапами, list их возвращает; без этапов → []', async () => {
    const withStages = await createGoal(getDb(), erfolgId, {
      quarter: 'Q1',
      year: 2031,
      title: `${TEST_PREFIX}со-этапами`,
      category: 'processes',
      stages: [
        { id: 's1', title: 'Этап 1', done: false },
        { id: 's2', title: 'Этап 2', done: true },
      ],
    });
    const plain = await createGoal(getDb(), erfolgId, {
      quarter: 'Q1',
      year: 2031,
      title: `${TEST_PREFIX}без-этапов`,
      category: 'processes',
    });

    const goals = await listGoals(getDb(), erfolgId, { year: 2031 });
    const g1 = goals.find((g) => g.id === withStages.id);
    expect(g1?.stages).toHaveLength(2);
    expect(g1?.stages[1]).toMatchObject({ title: 'Этап 2', done: true });
    const g2 = goals.find((g) => g.id === plain.id);
    expect(g2?.stages).toEqual([]);
  });

  it('update заменяет массив этапов (добавление + отметка)', async () => {
    const { id } = await createGoal(getDb(), erfolgId, {
      quarter: 'Q2',
      year: 2031,
      title: `${TEST_PREFIX}обновление`,
      category: 'team',
      stages: [{ id: 'a', title: 'Первый', done: false }],
    });
    await updateGoal(getDb(), erfolgId, id, {
      stages: [
        { id: 'a', title: 'Первый', done: true },
        { id: 'b', title: 'Второй', done: false },
      ],
    });
    const goals = await listGoals(getDb(), erfolgId, { year: 2031 });
    const g = goals.find((x) => x.id === id);
    expect(g?.stages).toHaveLength(2);
    expect(g?.stages.filter((s) => s.done)).toHaveLength(1);
    expect(g?.stages[0]).toMatchObject({ id: 'a', done: true });
  });
});
