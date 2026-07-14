import { describe, expect, it } from 'vitest';
import { SLA_HOURS_BY_PRIORITY, computeSlaTargetAt } from './index';

describe('SLA по приоритету', () => {
  it('часы заданы для всех приоритетов и убывают от low к urgent', () => {
    expect(SLA_HOURS_BY_PRIORITY.low).toBe(72);
    expect(SLA_HOURS_BY_PRIORITY.normal).toBe(24);
    expect(SLA_HOURS_BY_PRIORITY.high).toBe(8);
    expect(SLA_HOURS_BY_PRIORITY.urgent).toBe(4);
    // Чем срочнее — тем меньше срок.
    expect(SLA_HOURS_BY_PRIORITY.urgent).toBeLessThan(SLA_HOURS_BY_PRIORITY.high);
    expect(SLA_HOURS_BY_PRIORITY.high).toBeLessThan(SLA_HOURS_BY_PRIORITY.normal);
    expect(SLA_HOURS_BY_PRIORITY.normal).toBeLessThan(SLA_HOURS_BY_PRIORITY.low);
  });

  it('computeSlaTargetAt прибавляет к моменту приёма нужные часы', () => {
    const received = new Date('2026-07-14T10:00:00.000Z');
    expect(computeSlaTargetAt(received, 'urgent').toISOString()).toBe('2026-07-14T14:00:00.000Z');
    expect(computeSlaTargetAt(received, 'high').toISOString()).toBe('2026-07-14T18:00:00.000Z');
    expect(computeSlaTargetAt(received, 'normal').toISOString()).toBe('2026-07-15T10:00:00.000Z');
    expect(computeSlaTargetAt(received, 'low').toISOString()).toBe('2026-07-17T10:00:00.000Z');
  });

  it('не мутирует переданную дату', () => {
    const received = new Date('2026-07-14T10:00:00.000Z');
    computeSlaTargetAt(received, 'low');
    expect(received.toISOString()).toBe('2026-07-14T10:00:00.000Z');
  });
});
