/**
 * Repository leads. Все запросы под withTenantTx (RLS на leads FORCE).
 *
 * Жизненный цикл: create → update (статус/поля, score пересчитывается в сервисе) →
 * archive (soft delete) либо convertToClient (создаёт clients-запись + помечает лид won).
 *
 * estimatedValue хранится как numeric(14,2) (в БД — строка), в DTO отдаём числом.
 * Имя ответственного резолвится left join'ом на users.full_name.
 */
import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import { leads, users, withTenantTx, type Db } from '@erfolg/db';
import { ruIlike } from '../../lib/ru-search';
import { buildDisplayNameFromFio } from '../../lib/person-name';
import type { LeadLostReason, LeadSource, LeadStatus } from '@erfolg/shared';

export interface LeadDto {
  id: string;
  name: string;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  region: string | null;
  status: LeadStatus;
  source: LeadSource;
  estimatedValue: number;
  assignedUserId: string | null;
  assignedUserName: string | null;
  notes: string | null;
  nextAction: string | null;
  nextActionDate: string | null;
  score: number;
  lostReason: LeadLostReason | null;
  lostComment: string | null;
  convertedClientId: string | null;
  convertedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateLeadInput {
  name: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  region?: string | null;
  status?: LeadStatus;
  source?: LeadSource;
  estimatedValue?: number;
  assignedUserId?: string | null;
  notes?: string | null;
  nextAction?: string | null;
  nextActionDate?: string | null;
  lostReason?: LeadLostReason | null;
  lostComment?: string | null;
  /** Рассчитывается в сервисе через calculateLeadScore. */
  score: number;
}

export interface UpdateLeadPatch {
  name?: string;
  contactPerson?: string | null;
  phone?: string | null;
  email?: string | null;
  address?: string | null;
  region?: string | null;
  status?: LeadStatus;
  source?: LeadSource;
  estimatedValue?: number;
  assignedUserId?: string | null;
  notes?: string | null;
  nextAction?: string | null;
  nextActionDate?: string | null;
  lostReason?: LeadLostReason | null;
  lostComment?: string | null;
  /** Пересчитывается в сервисе. */
  score?: number;
}

export interface ListOpts {
  search?: string;
  status?: LeadStatus;
  assignedUserId?: string;
  page?: number;
}

export interface ConvertOpts {
  clientType: 'legal' | 'individual';
  inn?: string | null;
  kpp?: string | null;
  /**
   * ФИО физлица. Обязательно для clientType='individual' — проверяется в
   * convertLeadToClientCmd. Из lead.name не берём: там столь же часто лежит
   * «Заявка с сайта», а это поле уходит в зашифрованные ПДн, которым доверяют.
   */
  individualFullName?: string | null;
}

export interface FunnelStats {
  byStatus: Record<LeadStatus, { count: number; value: number }>;
  overallConversion: number;
  lostReasons: Record<string, number>;
  hottest: Array<{
    id: string;
    name: string;
    status: LeadStatus;
    score: number;
    estimatedValue: number;
  }>;
  total: number;
  totalPotential: number;
  wonRevenue: number;
}

const PAGE_SIZE = 25;

function rowToDto(row: typeof leads.$inferSelect, assignedUserName: string | null): LeadDto {
  return {
    id: row.id,
    name: row.name,
    contactPerson: row.contactPerson ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    region: row.region ?? null,
    status: row.status,
    source: row.source,
    estimatedValue: Number(row.estimatedValue),
    assignedUserId: row.assignedUserId ?? null,
    assignedUserName,
    notes: row.notes ?? null,
    nextAction: row.nextAction ?? null,
    nextActionDate: row.nextActionDate ?? null,
    score: row.score,
    lostReason: row.lostReason ?? null,
    lostComment: row.lostComment ?? null,
    convertedClientId: row.convertedClientId ?? null,
    convertedAt: row.convertedAt ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listLeads(
  db: Db,
  tenantId: string,
  opts: ListOpts = {},
): Promise<{ items: LeadDto[]; total: number }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const filters: SQL[] = [isNull(leads.deletedAt)];
    if (opts.status) filters.push(eq(leads.status, opts.status));
    if (opts.assignedUserId) filters.push(eq(leads.assignedUserId, opts.assignedUserId));
    if (opts.search) {
      const q = `%${opts.search.trim()}%`;
      filters.push(
        or(
          ruIlike(leads.name, q),
          ruIlike(leads.contactPerson, q),
          ruIlike(leads.phone, q),
          ruIlike(leads.email, q),
        ) as SQL,
      );
    }
    const where = and(...filters);
    const page = Math.max(1, opts.page ?? 1);
    const offset = (page - 1) * PAGE_SIZE;

    const rows = await tx
      .select({ lead: leads, assignedName: users.fullName })
      .from(leads)
      .leftJoin(users, eq(users.id, leads.assignedUserId))
      .where(where)
      .orderBy(desc(leads.score), desc(leads.createdAt))
      .limit(PAGE_SIZE)
      .offset(offset);

    const totalResult = await tx
      .select({ value: sql<number>`count(*)::int` })
      .from(leads)
      .where(where);

    return {
      items: rows.map((r) => rowToDto(r.lead, r.assignedName ?? null)),
      total: totalResult[0]?.value ?? 0,
    };
  });
}

export async function getLeadById(
  db: Db,
  tenantId: string,
  id: string,
): Promise<LeadDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ lead: leads, assignedName: users.fullName })
      .from(leads)
      .leftJoin(users, eq(users.id, leads.assignedUserId))
      .where(and(eq(leads.id, id), isNull(leads.deletedAt)))
      .limit(1);
    const first = rows[0];
    return first ? rowToDto(first.lead, first.assignedName ?? null) : null;
  });
}

export async function createLead(
  db: Db,
  tenantId: string,
  input: CreateLeadInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const inserted = await tx
      .insert(leads)
      .values({
        tenantId,
        name: input.name,
        contactPerson: input.contactPerson ?? null,
        phone: input.phone ?? null,
        email: input.email ?? null,
        address: input.address ?? null,
        region: input.region ?? null,
        status: input.status ?? 'new',
        source: input.source ?? 'other',
        estimatedValue: (input.estimatedValue ?? 0).toString(),
        assignedUserId: input.assignedUserId ?? null,
        notes: input.notes ?? null,
        nextAction: input.nextAction ?? null,
        nextActionDate: input.nextActionDate ?? null,
        score: input.score,
        lostReason: input.lostReason ?? null,
        lostComment: input.lostComment ?? null,
      })
      .returning({ id: leads.id });
    const row = inserted[0];
    if (!row) throw new Error('createLead: nothing returned');
    return row;
  });
}

export async function updateLead(
  db: Db,
  tenantId: string,
  id: string,
  patch: UpdateLeadPatch,
): Promise<LeadDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const set: Record<string, unknown> = {};
    if (patch.name !== undefined) set.name = patch.name;
    if (patch.contactPerson !== undefined) set.contactPerson = patch.contactPerson;
    if (patch.phone !== undefined) set.phone = patch.phone;
    if (patch.email !== undefined) set.email = patch.email;
    if (patch.address !== undefined) set.address = patch.address;
    if (patch.region !== undefined) set.region = patch.region;
    if (patch.status !== undefined) set.status = patch.status;
    if (patch.source !== undefined) set.source = patch.source;
    if (patch.estimatedValue !== undefined) set.estimatedValue = patch.estimatedValue.toString();
    if (patch.assignedUserId !== undefined) set.assignedUserId = patch.assignedUserId;
    if (patch.notes !== undefined) set.notes = patch.notes;
    if (patch.nextAction !== undefined) set.nextAction = patch.nextAction;
    if (patch.nextActionDate !== undefined) set.nextActionDate = patch.nextActionDate;
    if (patch.lostReason !== undefined) set.lostReason = patch.lostReason;
    if (patch.lostComment !== undefined) set.lostComment = patch.lostComment;
    if (patch.score !== undefined) set.score = patch.score;
    if (Object.keys(set).length === 0) {
      return getLeadById(db, tenantId, id);
    }
    const updated = await tx
      .update(leads)
      .set(set)
      .where(and(eq(leads.id, id), isNull(leads.deletedAt)))
      .returning({ id: leads.id });
    if (!updated[0]) return null;
    return getLeadById(db, tenantId, id);
  });
}

export async function archiveLead(db: Db, tenantId: string, id: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const updated = await tx
      .update(leads)
      .set({ deletedAt: sql`now()` })
      .where(and(eq(leads.id, id), isNull(leads.deletedAt)))
      .returning({ id: leads.id });
    return updated.length > 0;
  });
}

/**
 * Атомарно: создаёт клиента из лида + помечает лид как won/converted.
 *
 * Для юрлица копирует реквизиты (inn/kpp/телефон/email/адрес) — шифрование не нужно.
 * Для физлица телефон и адрес шифруются, ФИО берётся из opts (в lead.name лежит
 * произвольная строка вроде «Заявка с сайта», в ПДн ей не место).
 *
 * Раньше у физлица терялись телефон, адрес и email, а ФИО не заполнялось вовсе —
 * карточка выходила пустой, звонить было некуда. Инвариант «физлицо обязано
 * иметь ФИО» тоже обходился: конвертация зовёт репозиторий напрямую, минуя
 * clients/service.
 *
 * Возвращает null, если лид не найден, проигран или уже сконвертирован (идемпотентность).
 *
 * Клиент и отметка лида пишутся в ОДНОЙ транзакции — поэтому createClientCmd
 * отсюда звать нельзя: он открывает свою, и падение посередине оставило бы
 * клиента-сироту при неконвертированном лиде (а повторный клик создал бы второго).
 */
export async function convertLeadToClient(
  db: Db,
  tenantId: string,
  key: string,
  leadId: string,
  opts: ConvertOpts,
): Promise<{ clientId: string } | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select()
      .from(leads)
      .where(and(eq(leads.id, leadId), isNull(leads.deletedAt)))
      .limit(1);
    const lead = rows[0];
    if (!lead) return null;
    if (lead.status === 'lost' || lead.convertedClientId) return null;

    const isLegal = opts.clientType === 'legal';
    const fio = opts.individualFullName?.trim() || null;
    const displayName = isLegal ? lead.name : (buildDisplayNameFromFio(fio ?? '') || lead.name);

    const inserted = await tx.execute<{ id: string }>(sql`
      INSERT INTO clients (
        tenant_id, type, subtype, display_name,
        inn, kpp, legal_address, phone, email,
        full_name_encrypted, phone_encrypted, address_encrypted, status
      ) VALUES (
        ${tenantId}, ${opts.clientType}::client_type,
        ${isLegal ? 'commercial' : null}::client_subtype,
        ${displayName},
        ${isLegal ? (opts.inn ?? null) : null},
        ${isLegal ? (opts.kpp ?? null) : null},
        ${isLegal ? (lead.address ?? null) : null},
        ${isLegal ? (lead.phone ?? null) : null},
        -- email физлица кладём в общую колонку: отдельной зашифрованной для него
        -- в схеме нет, а терять адрес хуже.
        ${lead.email ?? null},
        ${!isLegal && fio ? sql`pgp_sym_encrypt(${fio}::text, ${key})` : sql`NULL`},
        ${!isLegal && lead.phone ? sql`pgp_sym_encrypt(${lead.phone}::text, ${key})` : sql`NULL`},
        ${!isLegal && lead.address ? sql`pgp_sym_encrypt(${lead.address}::text, ${key})` : sql`NULL`},
        'active'
      ) RETURNING id
    `);
    const client = (inserted as unknown as Array<{ id: string }>)[0];
    if (!client) throw new Error('convertLeadToClient: client insert returned nothing');

    await tx
      .update(leads)
      .set({
        status: 'won',
        score: 100,
        convertedClientId: client.id,
        convertedAt: new Date(),
      })
      .where(eq(leads.id, leadId));

    return { clientId: client.id };
  });
}

/** Аналитика воронки (перенос из v1 leadsRouter.funnelStats). Считается на сервере. */
export async function leadFunnelStats(db: Db, tenantId: string): Promise<FunnelStats> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: leads.id,
        name: leads.name,
        status: leads.status,
        estimatedValue: leads.estimatedValue,
        score: leads.score,
        lostReason: leads.lostReason,
      })
      .from(leads)
      .where(isNull(leads.deletedAt));

    const byStatus = {
      new: { count: 0, value: 0 },
      contacted: { count: 0, value: 0 },
      proposal: { count: 0, value: 0 },
      negotiation: { count: 0, value: 0 },
      won: { count: 0, value: 0 },
      lost: { count: 0, value: 0 },
    };

    const lostReasons: Record<string, number> = {};
    let totalPotential = 0;

    for (const row of rows) {
      const value = Number(row.estimatedValue);
      const bucket = byStatus[row.status];
      bucket.count += 1;
      bucket.value += value;
      if (row.status !== 'lost') totalPotential += value;
      if (row.status === 'lost' && row.lostReason) {
        lostReasons[row.lostReason] = (lostReasons[row.lostReason] ?? 0) + 1;
      }
    }

    const processed = rows.filter((r) => r.status !== 'new').length;
    const won = byStatus.won.count;
    const overallConversion = processed === 0 ? 0 : Math.round((won / processed) * 100);

    const hottest = rows
      .filter((r) => r.status !== 'won' && r.status !== 'lost')
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
      .map((r) => ({
        id: r.id,
        name: r.name,
        status: r.status,
        score: r.score,
        estimatedValue: Number(r.estimatedValue),
      }));

    return {
      byStatus,
      overallConversion,
      lostReasons,
      hottest,
      total: rows.length,
      totalPotential,
      wonRevenue: byStatus.won.value,
    } satisfies FunnelStats;
  });
}
