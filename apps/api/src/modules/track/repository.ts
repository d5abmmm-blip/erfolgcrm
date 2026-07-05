/**
 * Repository публичного трека «как посылка» (фича №3).
 *
 * Единственная задача — по публичному токену найти заявку в пределах tenant (RLS)
 * и вернуть ТОЛЬКО технические поля для построения таймлайна. Никаких ПДн клиента
 * (ФИО/адрес/телефон), цен, фамилий инженеров, внутренних заметок — наружу не уходит.
 */
import { and, asc, eq, isNull } from 'drizzle-orm';
import { assets, tickets, ticketEvents, withTenantTx, type Db } from '@erfolg/db';

export interface TrackTicketRaw {
  status: string;
  ticketNumber: string;
  /** Модель техники клиента (его собственный аппарат) — без серийника. */
  deviceLabel: string | null;
  receivedAt: Date;
  closedAt: Date | null;
  cancelledAt: Date | null;
  /** Только ФАКТ ожидания запчасти. Свободный текст заметки наружу НЕ отдаём (внутренняя пометка). */
  waitingForPart: boolean;
  events: Array<{ type: string; createdAt: Date; payload: unknown }>;
}

/**
 * Найти заявку по публичному трек-токену в пределах tenant. Возвращает только
 * технические поля (без ПДн) + события смены статуса (для дат стадий).
 * null — токен неизвестен, отозван или заявка удалена (наружу — единый 404).
 */
export async function getTicketByTrackToken(
  db: Db,
  tenantId: string,
  token: string,
): Promise<TrackTicketRaw | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const [row] = await tx
      .select({
        id: tickets.id,
        status: tickets.status,
        ticketNumber: tickets.ticketNumber,
        deviceLabel: assets.model,
        receivedAt: tickets.receivedAt,
        closedAt: tickets.closedAt,
        cancelledAt: tickets.cancelledAt,
        waitingForPart: tickets.waitingForPart,
      })
      .from(tickets)
      .leftJoin(assets, eq(assets.id, tickets.assetId))
      .where(and(eq(tickets.publicTrackToken, token), isNull(tickets.deletedAt)))
      .limit(1);
    if (!row) return null;

    // Только смены статуса — из них строятся даты стадий (без прочих событий/ПДн).
    const events = await tx
      .select({
        type: ticketEvents.type,
        createdAt: ticketEvents.createdAt,
        payload: ticketEvents.payload,
      })
      .from(ticketEvents)
      .where(and(eq(ticketEvents.ticketId, row.id), eq(ticketEvents.type, 'status_change')))
      .orderBy(asc(ticketEvents.createdAt));

    const { id: _id, ...rest } = row;
    return { ...rest, events };
  });
}
