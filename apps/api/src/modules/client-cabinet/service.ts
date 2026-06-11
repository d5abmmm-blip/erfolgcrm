/**
 * Бизнес-логика для кабинета клиента: единственная мутация — создание заявки.
 *
 * Используем уже существующий tickets/repository.createTicket чтобы переиспользовать
 * логику нумерации и генерации barcode. source = 'web_form' (есть в enum) +
 * пометка в notes/контексте, что заявка пришла из кабинета.
 */
import { eq, and, isNull } from 'drizzle-orm';
import { assets, withTenantTx, type Db } from '@erfolg/db';
import { createTicket } from '../tickets/repository';

export async function getMyAssetForCreateTicket(
  db: Db,
  tenantId: string,
  clientId: string,
  assetId: string,
): Promise<{ id: string; ownerClientId: string } | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: assets.id, ownerClientId: assets.ownerClientId })
      .from(assets)
      .where(
        and(
          eq(assets.id, assetId),
          eq(assets.ownerClientId, clientId),
          isNull(assets.deletedAt),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  });
}

export interface CreateTicketFromCabinetInput {
  tenantId: string;
  clientId: string;
  assetId: string;
  summary: string;
  contactPhone: string | null;
}

export async function createTicketFromCabinet(
  db: Db,
  input: CreateTicketFromCabinetInput,
): Promise<{ id: string; ticketNumber: string; barcode: string }> {
  const symptom = input.contactPhone
    ? `${input.summary}\n\nКонтактный телефон заявителя: ${input.contactPhone}`
    : input.summary;
  return createTicket(db, input.tenantId, null, {
    clientId: input.clientId,
    assetId: input.assetId,
    source: 'web_form',
    intakeMethod: 'brought_in',
    repairType: 'paid',
    priority: 'normal',
    symptom,
    notes: 'Заявка создана через кабинет клиента',
  });
}
