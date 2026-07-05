/**
 * Service публичного трека «как посылка» (фича №3).
 *
 * Строит PII-free DTO: № заявки, модель техники, название сервиса и таймлайн стадий
 * (через общий buildTrackTimeline из @erfolg/shared — один источник правды с кабинетом).
 */
import { buildTrackTimeline, type TicketStatus, type TrackTimeline } from '@erfolg/shared';
import type { Db } from '@erfolg/db';
import { getTicketByTrackToken } from './repository';

export interface PublicTrackDto {
  ticketNumber: string;
  deviceLabel: string | null;
  /** Название сервисного центра (собственное имя тенанта) — для шапки. */
  companyName: string;
  timeline: TrackTimeline;
}

export async function trackByTokenQuery(
  db: Db,
  tenantId: string,
  companyName: string,
  token: string,
): Promise<PublicTrackDto | null> {
  const raw = await getTicketByTrackToken(db, tenantId, token);
  if (!raw) return null;

  const timeline = buildTrackTimeline({
    status: raw.status as TicketStatus,
    receivedAt: raw.receivedAt,
    closedAt: raw.closedAt,
    cancelledAt: raw.cancelledAt,
    waitingForPart: raw.waitingForPart,
    events: raw.events,
  });

  return {
    ticketNumber: raw.ticketNumber,
    deviceLabel: raw.deviceLabel,
    companyName,
    timeline,
  };
}
