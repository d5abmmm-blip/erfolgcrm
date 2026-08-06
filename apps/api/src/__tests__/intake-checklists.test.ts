/**
 * Stage 10'.J — тесты модуля intake-checklists.
 *
 * Проверяем:
 *   1. createChecklistWithItems — успешно вставляет header + items, считает issues.
 *   2. listForTicket — возвращает intake + handover отдельно по kind, корректные счётчики.
 *   3. cross-tenant: чек-листы erfolg не видны из demo.
 *   4. softDelete: после soft-delete не возвращается в listForTicket / get.
 *   5. createChecklistWithItems с пустым items → ошибка.
 *   6. listTemplates / INTAKE_TEMPLATES — содержит general, ultrasound и др.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { like, or } from 'drizzle-orm';
import { getDb, intakeChecklistItems, intakeChecklists, tickets, withTenantTx } from '@erfolg/db';
import { ensureSeed } from './setup';
import {
  createChecklistWithItems,
  getChecklistWithItems,
  listForTicket,
  softDelete,
} from '../modules/intake-checklists/repository';
import { listTemplates, INTAKE_TEMPLATES } from '../modules/intake-checklists/templates';

const NOTE_PREFIX = 'TEST-CHECK-';

let erfolgId = '';
let demoId = '';
let erfolgTicketId = '';
let demoTicketId = '';

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  const [erfolgTicket] = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: tickets.id }).from(tickets).limit(1),
  );
  const [demoTicket] = await withTenantTx(getDb(), demoId, (tx) =>
    tx.select({ id: tickets.id }).from(tickets).limit(1),
  );
  if (!erfolgTicket || !demoTicket) {
    throw new Error('seed missing tickets for intake-checklists tests');
  }
  erfolgTicketId = erfolgTicket.id;
  demoTicketId = demoTicket.id;
});

async function clearTestData(): Promise<void> {
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      // Сначала items (FK на checklist).
      await tx
        .delete(intakeChecklistItems)
        .where(like(intakeChecklistItems.label, `${NOTE_PREFIX}%`));
      await tx
        .delete(intakeChecklists)
        .where(
          or(
            like(intakeChecklists.notes, `${NOTE_PREFIX}%`),
            like(intakeChecklists.clientSignatureName, `${NOTE_PREFIX}%`),
          ),
        );
    });
  }
}

beforeEach(clearTestData);

describe('createChecklistWithItems', () => {
  it('успешно создаёт checklist + items, считает issues', async () => {
    const row = await createChecklistWithItems(
      getDb(),
      erfolgId,
      erfolgTicketId,
      'intake',
      [
        { label: `${NOTE_PREFIX}Корпус`, status: 'ok' },
        { label: `${NOTE_PREFIX}Кабель`, status: 'issue', comment: 'Перетёрта изоляция' },
        { label: `${NOTE_PREFIX}Принтер`, status: 'na' },
      ],
      { notes: `${NOTE_PREFIX}smoke`, clientSignatureName: 'Иванов И.И.' },
    );
    expect(row.kind).toBe('intake');
    expect(row.itemsCount).toBe(3);
    expect(row.issuesCount).toBe(1);
    expect(row.items).toHaveLength(3);
    expect(row.items[0]!.orderIdx).toBe(0);
    expect(row.items[1]!.status).toBe('issue');
    expect(row.items[1]!.comment).toBe('Перетёрта изоляция');
  });

  it('пустой массив items → ошибка', async () => {
    await expect(
      createChecklistWithItems(getDb(), erfolgId, erfolgTicketId, 'intake', []),
    ).rejects.toThrow(/хотя бы один пункт/);
  });

  it('persist + getChecklistWithItems возвращает то же самое', async () => {
    const created = await createChecklistWithItems(
      getDb(),
      erfolgId,
      erfolgTicketId,
      'handover',
      [
        { label: `${NOTE_PREFIX}A`, status: 'ok' },
        { label: `${NOTE_PREFIX}B`, status: 'ok' },
      ],
      { notes: `${NOTE_PREFIX}persist` },
    );
    const fetched = await getChecklistWithItems(getDb(), erfolgId, created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.kind).toBe('handover');
    expect(fetched!.items).toHaveLength(2);
    expect(fetched!.items.map((i) => i.label)).toEqual([`${NOTE_PREFIX}A`, `${NOTE_PREFIX}B`]);
  });
});

describe('listForTicket', () => {
  it('возвращает intake + handover отдельно по kind', async () => {
    await createChecklistWithItems(
      getDb(),
      erfolgId,
      erfolgTicketId,
      'intake',
      [{ label: `${NOTE_PREFIX}I1`, status: 'ok' }],
      { notes: `${NOTE_PREFIX}intake` },
    );
    await createChecklistWithItems(
      getDb(),
      erfolgId,
      erfolgTicketId,
      'handover',
      [
        { label: `${NOTE_PREFIX}H1`, status: 'ok' },
        { label: `${NOTE_PREFIX}H2`, status: 'issue' },
      ],
      { notes: `${NOTE_PREFIX}handover` },
    );

    const list = await listForTicket(getDb(), erfolgId, erfolgTicketId);
    const tested = list.filter((r) => r.notes?.startsWith(NOTE_PREFIX));
    expect(tested).toHaveLength(2);
    const intake = tested.find((r) => r.kind === 'intake');
    const handover = tested.find((r) => r.kind === 'handover');
    expect(intake).toBeDefined();
    expect(handover).toBeDefined();
    expect(intake!.itemsCount).toBe(1);
    expect(handover!.itemsCount).toBe(2);
    expect(handover!.issuesCount).toBe(1);
  });
});

describe('softDelete', () => {
  it('после soft-delete checklist не возвращается из listForTicket и get', async () => {
    const created = await createChecklistWithItems(
      getDb(),
      erfolgId,
      erfolgTicketId,
      'intake',
      [{ label: `${NOTE_PREFIX}X`, status: 'ok' }],
      { notes: `${NOTE_PREFIX}delme` },
    );
    const ok = await softDelete(getDb(), erfolgId, created.id);
    expect(ok).toBe(true);

    const after = await getChecklistWithItems(getDb(), erfolgId, created.id);
    expect(after).toBeNull();

    const list = await listForTicket(getDb(), erfolgId, erfolgTicketId);
    expect(list.find((r) => r.id === created.id)).toBeUndefined();
  });
});

describe('cross-tenant isolation', () => {
  it('checklist erfolg не виден из demo', async () => {
    const created = await createChecklistWithItems(
      getDb(),
      erfolgId,
      erfolgTicketId,
      'intake',
      [{ label: `${NOTE_PREFIX}Secret`, status: 'ok' }],
      { notes: `${NOTE_PREFIX}xtenant` },
    );
    const fromDemo = await getChecklistWithItems(getDb(), demoId, created.id);
    expect(fromDemo).toBeNull();

    const listFromDemo = await listForTicket(getDb(), demoId, erfolgTicketId);
    expect(listFromDemo.find((r) => r.id === created.id)).toBeUndefined();
  });

  it('checklist demo не виден из erfolg', async () => {
    const created = await createChecklistWithItems(
      getDb(),
      demoId,
      demoTicketId,
      'handover',
      [{ label: `${NOTE_PREFIX}DemoOnly`, status: 'ok' }],
      { notes: `${NOTE_PREFIX}demo` },
    );
    const fromErfolg = await getChecklistWithItems(getDb(), erfolgId, created.id);
    expect(fromErfolg).toBeNull();
  });
});

describe('listTemplates', () => {
  it('содержит general и ultrasound, у каждого ≥3 пункта', () => {
    const tpls = listTemplates();
    const keys = tpls.map((t) => t.key);
    expect(keys).toContain('general');
    expect(keys).toContain('ultrasound');
    for (const t of tpls) {
      expect(t.items.length).toBeGreaterThanOrEqual(3);
    }
    expect(INTAKE_TEMPLATES.general.length).toBeGreaterThanOrEqual(5);
  });
});
