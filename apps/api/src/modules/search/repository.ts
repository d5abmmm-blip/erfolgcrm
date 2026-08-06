/**
 * Глобальный поиск по 5 сущностям: tickets, clients, assets, invoices, contracts.
 *
 * Бизнес-цель — одна строка наверху → находит всё, без перехода в раздел.
 * Сейчас (v1) — простой ILIKE по нужным полям. Производительности достаточно
 * на типичные размеры данных одного сервисного центра (десятки тысяч строк max).
 *
 * Защита:
 *   • RLS гарантируется withTenantTx (вторая линия после tenant_id-фильтрации).
 *   • LIMIT 5 per type — даже под пустым ключом не уронит сервер.
 *   • Пустой/слишком короткий query → возвращаем пусто без удара по БД.
 *   • % и _ в pattern экранируем (иначе клиент может подставить wildcard).
 */
import { and, asc, desc, eq, isNull, or } from 'drizzle-orm';
import { ruIlike } from '../../lib/ru-search';
import { alias } from 'drizzle-orm/pg-core';
import { assets, clients, contracts, invoices, tickets, withTenantTx, type Db } from '@erfolg/db';

const LIMIT_PER_TYPE = 5;
const MIN_QUERY_LENGTH = 2;

export interface TicketHit {
  id: string;
  ticketNumber: string;
  status: string;
  clientName: string;
  createdAt: Date;
}

export interface ClientHit {
  id: string;
  displayName: string;
  type: 'legal' | 'individual';
  inn: string | null;
  /**
   * Архивных из выдачи НЕ убираем: список клиентов уже умеет их показывать
   * (вкладка «Архив»), а глобальный поиск — самый быстрый способ понять,
   * почему клиент не выбирается в новой заявке. Прятать значит отвечать
   * «не найдено» на существующего клиента. Вместо этого помечаем.
   */
  status: 'active' | 'archived';
}

export interface AssetHit {
  id: string;
  model: string;
  serialNumber: string | null;
  /** Ищем по нему давно (см. условие ниже), но до этого не показывали в выдаче. */
  inventoryNumber: string | null;
  ownerClientName: string | null;
}

export interface InvoiceHit {
  id: string;
  invoiceNumber: string;
  totalAmountKopecks: string;
  status: string;
}

export interface ContractHit {
  id: string;
  contractNumber: string;
  clientName: string | null;
  status: string;
}

export interface SearchResult {
  tickets: TicketHit[];
  clients: ClientHit[];
  assets: AssetHit[];
  invoices: InvoiceHit[];
  contracts: ContractHit[];
}

const EMPTY_RESULT: SearchResult = {
  tickets: [],
  clients: [],
  assets: [],
  invoices: [],
  contracts: [],
};

/** Экранируем wildcards: иначе клиент может «всё подходит» подставить. */
function escapeIlike(raw: string): string {
  return raw.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function buildPattern(query: string): string {
  return `%${escapeIlike(query)}%`;
}

async function searchTicketsHits(tenantId: string, pattern: string, db: Db): Promise<TicketHit[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: tickets.id,
        ticketNumber: tickets.ticketNumber,
        status: tickets.status,
        clientName: clients.displayName,
        createdAt: tickets.createdAt,
      })
      .from(tickets)
      .leftJoin(clients, eq(tickets.clientId, clients.id))
      .where(
        and(
          isNull(tickets.deletedAt),
          or(
            ruIlike(tickets.ticketNumber, pattern),
            ruIlike(tickets.symptom, pattern),
            ruIlike(tickets.barcode, pattern),
          ),
        ),
      )
      .orderBy(desc(tickets.createdAt))
      .limit(LIMIT_PER_TYPE);
    return rows.map((r) => ({ ...r, clientName: r.clientName ?? '' }));
  });
}

async function searchClientsHits(tenantId: string, pattern: string, db: Db): Promise<ClientHit[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    return tx
      .select({
        id: clients.id,
        displayName: clients.displayName,
        type: clients.type,
        inn: clients.inn,
        status: clients.status,
      })
      .from(clients)
      .where(
        or(
          ruIlike(clients.displayName, pattern),
          ruIlike(clients.inn, pattern),
          ruIlike(clients.email, pattern),
        ),
      )
      .orderBy(asc(clients.displayName))
      .limit(LIMIT_PER_TYPE);
  });
}

async function searchAssetsHits(tenantId: string, pattern: string, db: Db): Promise<AssetHit[]> {
  const ownerClient = alias(clients, 'owner_client');
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: assets.id,
        model: assets.model,
        serialNumber: assets.serialNumber,
        inventoryNumber: assets.inventoryNumber,
        ownerClientName: ownerClient.displayName,
      })
      .from(assets)
      .leftJoin(ownerClient, eq(ownerClient.id, assets.ownerClientId))
      .where(
        or(
          ruIlike(assets.model, pattern),
          ruIlike(assets.serialNumber, pattern),
          ruIlike(assets.inventoryNumber, pattern),
        ),
      )
      .orderBy(asc(assets.model))
      .limit(LIMIT_PER_TYPE);
    return rows.map((r) => ({
      ...r,
      ownerClientName: r.ownerClientName ?? null,
    }));
  });
}

async function searchInvoicesHits(
  tenantId: string,
  pattern: string,
  db: Db,
): Promise<InvoiceHit[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: invoices.id,
        invoiceNumber: invoices.invoiceNumber,
        totalAmountKopecks: invoices.totalAmountKopecks,
        status: invoices.status,
      })
      .from(invoices)
      .where(ruIlike(invoices.invoiceNumber, pattern))
      .orderBy(desc(invoices.createdAt))
      .limit(LIMIT_PER_TYPE);
    return rows.map((r) => ({
      ...r,
      totalAmountKopecks: r.totalAmountKopecks.toString(),
    }));
  });
}

async function searchContractsHits(
  tenantId: string,
  pattern: string,
  db: Db,
): Promise<ContractHit[]> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: contracts.id,
        contractNumber: contracts.contractNumber,
        clientName: clients.displayName,
        status: contracts.status,
      })
      .from(contracts)
      .leftJoin(clients, eq(contracts.clientId, clients.id))
      .where(ruIlike(contracts.contractNumber, pattern))
      .orderBy(desc(contracts.createdAt))
      .limit(LIMIT_PER_TYPE);
    return rows.map((r) => ({ ...r, clientName: r.clientName ?? null }));
  });
}

/**
 * Главная точка входа: параллельно поднимаем 5 запросов.
 * Если q короче MIN_QUERY_LENGTH — возвращаем пустой результат, не тратим БД.
 */
export async function searchEverything(
  db: Db,
  tenantId: string,
  rawQuery: string,
  role: 'director' | 'dispatcher' | 'engineer' = 'director',
): Promise<SearchResult> {
  const query = (rawQuery ?? '').trim();
  if (query.length < MIN_QUERY_LENGTH) return EMPTY_RESULT;
  const pattern = buildPattern(query);
  // Инженеру недоступны ПДн клиентов и денежные данные (разделы «Клиенты»/«Счета»/«Договоры»
  // — staffProcedure). Глобальный поиск для инженера ограничиваем заявками и техникой.
  const isStaff = role === 'director' || role === 'dispatcher';
  const [ticketsHits, clientsHits, assetsHits, invoicesHits, contractsHits] = await Promise.all([
    searchTicketsHits(tenantId, pattern, db),
    isStaff ? searchClientsHits(tenantId, pattern, db) : Promise.resolve<ClientHit[]>([]),
    searchAssetsHits(tenantId, pattern, db),
    isStaff ? searchInvoicesHits(tenantId, pattern, db) : Promise.resolve<InvoiceHit[]>([]),
    isStaff ? searchContractsHits(tenantId, pattern, db) : Promise.resolve<ContractHit[]>([]),
  ]);
  return {
    tickets: ticketsHits,
    clients: clientsHits,
    assets: assetsHits,
    invoices: invoicesHits,
    contracts: contractsHits,
  };
}

// Константы экспортируются для тестов и UI-валидации.
export { LIMIT_PER_TYPE, MIN_QUERY_LENGTH };
