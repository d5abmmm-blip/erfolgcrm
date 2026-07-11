import { describe, expect, it } from 'vitest';
import {
  TRACK_STAGES,
  buildTrackTimeline,
  ticketStatusToTrackIndex,
  type TrackTimelineEventInput,
} from './index';

describe('ticketStatusToTrackIndex', () => {
  it('устаревшие estimate/approval показываются как «Диагностика» (стадия 1)', () => {
    expect(ticketStatusToTrackIndex('estimate')).toBe(1);
    expect(ticketStatusToTrackIndex('approval')).toBe(1);
  });

  it('маппит остальные статусы по порядку (5 стадий)', () => {
    expect(ticketStatusToTrackIndex('received')).toBe(0);
    expect(ticketStatusToTrackIndex('diagnostics')).toBe(1);
    expect(ticketStatusToTrackIndex('in_progress')).toBe(2);
    expect(ticketStatusToTrackIndex('act_pending')).toBe(3);
    expect(ticketStatusToTrackIndex('closed')).toBe(4);
  });

  it('cancelled → null', () => {
    expect(ticketStatusToTrackIndex('cancelled')).toBeNull();
  });
});

describe('buildTrackTimeline', () => {
  const received = new Date('2026-07-02T10:30:00Z');

  it('новая заявка (received): стадия 0 текущая, остальные — впереди', () => {
    const tl = buildTrackTimeline({ status: 'received', receivedAt: received });
    expect(tl.cancelled).toBe(false);
    expect(tl.currentIndex).toBe(0);
    expect(tl.stages).toHaveLength(TRACK_STAGES.length);
    expect(tl.stages).toHaveLength(5);
    expect(tl.stages[0]!.state).toBe('current');
    expect(tl.stages[0]!.at).toBe(received.toISOString());
    expect(tl.stages.slice(1).every((s) => s.state === 'upcoming')).toBe(true);
  });

  it('в ремонте (in_progress): пройденные стадии done с датами из событий, ремонт — current', () => {
    const events: TrackTimelineEventInput[] = [
      { type: 'created', createdAt: received, payload: {} },
      { type: 'status_change', createdAt: new Date('2026-07-02T14:10:00Z'), payload: { to: 'diagnostics' } },
      { type: 'status_change', createdAt: new Date('2026-07-03T11:20:00Z'), payload: { to: 'in_progress' } },
    ];
    const tl = buildTrackTimeline({ status: 'in_progress', receivedAt: received, events });
    expect(tl.currentIndex).toBe(2);
    expect(tl.stages.map((s) => s.state)).toEqual([
      'done', // received
      'done', // diagnostics
      'current', // repair
      'upcoming', // ready
      'upcoming', // issued
    ]);
    expect(tl.stages[1]!.at).toBe('2026-07-02T14:10:00.000Z');
    expect(tl.stages[2]!.at).toBe('2026-07-03T11:20:00.000Z');
  });

  it('устаревшие estimate/approval пишут дату в стадию «Диагностика» — берётся первое достижение', () => {
    const events: TrackTimelineEventInput[] = [
      { type: 'status_change', createdAt: new Date('2026-07-03T09:00:00Z'), payload: { to: 'estimate' } },
      { type: 'status_change', createdAt: new Date('2026-07-03T15:00:00Z'), payload: { to: 'approval' } },
    ];
    const tl = buildTrackTimeline({ status: 'approval', receivedAt: received, events });
    expect(tl.stages[1]!.at).toBe('2026-07-03T09:00:00.000Z');
  });

  it('закрытая заявка: все стадии done, «выдана» с датой закрытия', () => {
    const closedAt = new Date('2026-07-05T16:00:00Z');
    const tl = buildTrackTimeline({ status: 'closed', receivedAt: received, closedAt });
    expect(tl.stages.every((s) => s.state === 'done')).toBe(true);
    expect(tl.stages[4]!.at).toBe(closedAt.toISOString());
  });

  it('отменённая заявка: cancelled=true, currentIndex=−1, пройденные из событий — done', () => {
    const events: TrackTimelineEventInput[] = [
      { type: 'status_change', createdAt: new Date('2026-07-02T14:10:00Z'), payload: { to: 'diagnostics' } },
    ];
    const cancelledAt = new Date('2026-07-02T18:00:00Z');
    const tl = buildTrackTimeline({ status: 'cancelled', receivedAt: received, cancelledAt, events });
    expect(tl.cancelled).toBe(true);
    expect(tl.currentIndex).toBe(-1);
    expect(tl.cancelledAt).toBe(cancelledAt.toISOString());
    expect(tl.stages[0]!.state).toBe('done'); // received (есть receivedAt)
    expect(tl.stages[1]!.state).toBe('done'); // diagnostics (есть событие)
    expect(tl.stages[2]!.state).toBe('upcoming'); // repair не достигнут
  });

  it('«ждём запчасть»: наружу отдаётся только ФАКТ, без текста внутренней заметки', () => {
    const on = buildTrackTimeline({
      status: 'in_progress',
      receivedAt: received,
      waitingForPart: true,
    });
    expect(on.waitingForPart).toBe(true);
    // Внутренняя заметка (поставщик/цена/контакт) в клиентский таймлайн НЕ попадает.
    expect('waitingForPartNote' in on).toBe(false);

    const off = buildTrackTimeline({ status: 'in_progress', receivedAt: received });
    expect(off.waitingForPart).toBe(false);
  });

  it('откат статуса назад: стадия «впереди» не несёт прошедшую дату (at=null)', () => {
    // act_pending → in_progress («отозвать на доделку»): в истории есть событие to:act_pending,
    // но текущий статус in_progress. Стадия «Готово к выдаче» (ready) должна быть «впереди» БЕЗ даты.
    const events: TrackTimelineEventInput[] = [
      { type: 'status_change', createdAt: new Date('2026-07-03T11:00:00Z'), payload: { to: 'in_progress' } },
      { type: 'status_change', createdAt: new Date('2026-07-04T09:00:00Z'), payload: { to: 'act_pending' } },
    ];
    const tl = buildTrackTimeline({ status: 'in_progress', receivedAt: received, events });
    expect(tl.currentIndex).toBe(2); // repair
    expect(tl.stages[3]!.state).toBe('upcoming'); // ready
    expect(tl.stages[3]!.at).toBeNull(); // прошедшая дата act_pending НЕ показывается на будущей стадии
    expect(tl.stages[2]!.state).toBe('current');
  });

  it('reopen (closed→in_progress): «выдана» снова впереди и без даты закрытия', () => {
    const events: TrackTimelineEventInput[] = [
      { type: 'status_change', createdAt: new Date('2026-07-05T10:00:00Z'), payload: { to: 'act_pending' } },
      { type: 'status_change', createdAt: new Date('2026-07-05T16:00:00Z'), payload: { to: 'closed' } },
      { type: 'status_change', createdAt: new Date('2026-07-06T09:00:00Z'), payload: { to: 'in_progress' } },
    ];
    // closedAt в БД сброшен в null при reopen, но событие to:'closed' остаётся в истории.
    const tl = buildTrackTimeline({ status: 'in_progress', receivedAt: received, closedAt: null, events });
    expect(tl.stages[4]!.state).toBe('upcoming'); // issued
    expect(tl.stages[4]!.at).toBeNull();
    expect(tl.stages[3]!.at).toBeNull(); // ready тоже впереди
  });

  it('игнорирует мусорные/непонятные события и невалидные даты', () => {
    const events: TrackTimelineEventInput[] = [
      { type: 'note', createdAt: received, payload: { comment: 'привет' } },
      { type: 'status_change', createdAt: 'not-a-date', payload: { to: 'diagnostics' } },
      { type: 'status_change', createdAt: received, payload: { to: 12345 } },
    ];
    const tl = buildTrackTimeline({ status: 'received', receivedAt: received, events });
    expect(tl.stages[1]!.at).toBeNull(); // диагностика не проставилась (дата битая)
    expect(tl.currentIndex).toBe(0);
  });
});
