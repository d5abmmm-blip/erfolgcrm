/**
 * Repository слой для clients/contacts. Чистые DB-функции без бизнес-логики.
 *
 * Все запросы открывают withTenantTx (RLS включён на clients/contacts).
 * Для PII-полей используются pgcrypto helper-функции из @erfolg/db.
 *
 * Репозиторий НИКОГДА не возвращает сырые *_encrypted bytea — только decrypted DTO.
 */
import { and, asc, count, desc, eq, or, sql, type SQL } from 'drizzle-orm';
import { ruIlike } from '../../lib/ru-search';
import {
  assets,
  clients,
  contacts,
  decryptSql,
  withTenantTx,
  type Db,
} from '@erfolg/db';

export interface ContactDto {
  id: string;
  fullName: string | null;
  phone: string | null;
  email: string | null;
  position: string | null;
  isPrimary: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ClientListItem {
  id: string;
  type: 'legal' | 'individual';
  subtype: 'commercial' | 'budget' | null;
  displayName: string;
  inn: string | null;
  phone: string | null; // legal phone (plain) or NULL for individuals
  status: 'active' | 'archived';
  assetsCount: number;
  createdAt: Date;
}

export interface ClientDetailDto extends Omit<ClientListItem, 'assetsCount'> {
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  email: string | null;
  treasuryAccount: string | null;
  eksAccount: string | null;
  personalAccount: string | null;
  /** Decrypted ФИО физлица — присутствует только при type='individual' */
  individualFullName: string | null;
  individualPhone: string | null;
  individualAddress: string | null;
  notes: string | null;
  defaultContactId: string | null;
  contacts: ContactDto[];
  assetsCount: number;
}

export interface CreateClientInput {
  type: 'legal' | 'individual';
  subtype?: 'commercial' | 'budget' | null;
  displayName: string;
  inn?: string | null;
  kpp?: string | null;
  ogrn?: string | null;
  legalAddress?: string | null;
  phone?: string | null;
  email?: string | null;
  treasuryAccount?: string | null;
  eksAccount?: string | null;
  personalAccount?: string | null;
  individualFullName?: string | null;
  individualPhone?: string | null;
  individualAddress?: string | null;
  notes?: string | null;
}

export type UpdateClientInput = Partial<CreateClientInput>;

export interface CreateContactInput {
  clientId: string;
  fullName: string;
  phone: string;
  email?: string | null;
  position?: string | null;
  isPrimary?: boolean;
}

export interface UpdateContactInput {
  fullName?: string;
  phone?: string;
  email?: string | null;
  position?: string | null;
  isPrimary?: boolean;
}

const PAGE_SIZE_DEFAULT = 25;

export async function listClients(
  db: Db,
  tenantId: string,
  opts: {
    search?: string;
    status?: 'active' | 'archived';
    page?: number;
  } = {},
): Promise<{ items: ClientListItem[]; total: number }> {
  const page = Math.max(1, opts.page ?? 1);
  const offset = (page - 1) * PAGE_SIZE_DEFAULT;

  const filters: SQL[] = [];
  if (opts.status) filters.push(eq(clients.status, opts.status));
  else filters.push(eq(clients.status, 'active'));
  if (opts.search) {
    const q = `%${opts.search.trim()}%`;
    filters.push(
      or(ruIlike(clients.displayName, q), ruIlike(clients.inn, q)) as SQL,
    );
  }
  const whereClause = filters.length ? and(...filters) : undefined;

  return withTenantTx(db, tenantId, async (tx) => {
    const items = await tx
      .select({
        id: clients.id,
        type: clients.type,
        subtype: clients.subtype,
        displayName: clients.displayName,
        inn: clients.inn,
        phone: clients.phone,
        status: clients.status,
        createdAt: clients.createdAt,
        assetsCount:
          sql<number>`(SELECT COUNT(*)::int FROM ${assets} a WHERE a.owner_client_id = ${clients.id} AND a.deleted_at IS NULL)`.as(
            'assets_count',
          ),
      })
      .from(clients)
      .where(whereClause)
      .orderBy(desc(clients.createdAt))
      .limit(PAGE_SIZE_DEFAULT)
      .offset(offset);

    const totalRow = await tx
      .select({ value: count() })
      .from(clients)
      .where(whereClause);

    return {
      items: items.map((r) => ({
        id: r.id,
        type: r.type,
        subtype: r.subtype,
        displayName: r.displayName,
        inn: r.inn,
        phone: r.phone,
        status: r.status,
        assetsCount: Number(r.assetsCount ?? 0),
        createdAt: r.createdAt,
      })),
      total: Number(totalRow[0]?.value ?? 0),
    };
  });
}

export async function getClient(
  db: Db,
  tenantId: string,
  key: string,
  id: string,
): Promise<ClientDetailDto | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: clients.id,
        type: clients.type,
        subtype: clients.subtype,
        displayName: clients.displayName,
        inn: clients.inn,
        kpp: clients.kpp,
        ogrn: clients.ogrn,
        legalAddress: clients.legalAddress,
        phone: clients.phone,
        email: clients.email,
        treasuryAccount: clients.treasuryAccount,
        eksAccount: clients.eksAccount,
        personalAccount: clients.personalAccount,
        individualFullName: decryptSql(clients.fullNameEncrypted, key).as('full_name_dec'),
        individualPhone: decryptSql(clients.phoneEncrypted, key).as('phone_dec'),
        individualAddress: decryptSql(clients.addressEncrypted, key).as('address_dec'),
        notes: clients.notes,
        defaultContactId: clients.defaultContactId,
        status: clients.status,
        createdAt: clients.createdAt,
      })
      .from(clients)
      .where(eq(clients.id, id))
      .limit(1);

    const c = rows[0];
    if (!c) return null;

    const contactRows = await tx
      .select({
        id: contacts.id,
        fullName: decryptSql(contacts.fullNameEncrypted, key).as('full_name_dec'),
        phone: decryptSql(contacts.phoneEncrypted, key).as('phone_dec'),
        email: contacts.email,
        position: contacts.position,
        isPrimary: contacts.isPrimary,
        createdAt: contacts.createdAt,
        updatedAt: contacts.updatedAt,
      })
      .from(contacts)
      .where(eq(contacts.clientId, id))
      .orderBy(desc(contacts.isPrimary), asc(contacts.createdAt));

    const totalAssets = await tx
      .select({ value: count() })
      .from(assets)
      .where(eq(assets.ownerClientId, id));

    return {
      id: c.id,
      type: c.type,
      subtype: c.subtype,
      displayName: c.displayName,
      inn: c.inn,
      kpp: c.kpp,
      ogrn: c.ogrn,
      legalAddress: c.legalAddress,
      phone: c.phone,
      email: c.email,
      treasuryAccount: c.treasuryAccount,
      eksAccount: c.eksAccount,
      personalAccount: c.personalAccount,
      individualFullName: (c.individualFullName as string) ?? null,
      individualPhone: (c.individualPhone as string) ?? null,
      individualAddress: (c.individualAddress as string) ?? null,
      notes: c.notes,
      defaultContactId: c.defaultContactId,
      status: c.status,
      contacts: contactRows.map((r) => ({
        id: r.id,
        fullName: (r.fullName as string) ?? null,
        phone: (r.phone as string) ?? null,
        email: r.email,
        position: r.position,
        isPrimary: r.isPrimary,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      })),
      assetsCount: Number(totalAssets[0]?.value ?? 0),
      createdAt: c.createdAt,
    };
  });
}

export async function searchClients(
  db: Db,
  tenantId: string,
  q: string,
): Promise<Array<{ id: string; displayName: string; inn: string | null; type: 'legal' | 'individual' }>> {
  const query = `%${q.trim()}%`;
  return withTenantTx(db, tenantId, async (tx) => {
    return tx
      .select({
        id: clients.id,
        displayName: clients.displayName,
        inn: clients.inn,
        type: clients.type,
      })
      .from(clients)
      .where(
        and(
          eq(clients.status, 'active'),
          or(ruIlike(clients.displayName, query), ruIlike(clients.inn, query)),
        ),
      )
      .orderBy(asc(clients.displayName))
      .limit(10);
  });
}

/**
 * Поиск существующего физлица по телефону — защита от дубликатов при
 * самообслуживании (Telegram-бот): один человек, обратившийся трижды,
 * должен оставаться ОДНИМ клиентом в картотеке.
 *
 * Телефон хранится зашифрованным (152-ФЗ), поэтому сравниваем
 * расшифрованное значение по последним 10 цифрам — так «+7 928 …» и
 * «8928…» считаются одним номером. Физлиц немного, sequential scan ок.
 */
export async function findIndividualClientIdByPhone(
  db: Db,
  tenantId: string,
  key: string,
  phone: string,
): Promise<string | null> {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 6) return null;
  const tail = digits.slice(-10);
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx.execute<{ id: string }>(sql`
      SELECT id FROM clients
      WHERE type = 'individual'
        AND status = 'active'
        AND phone_encrypted IS NOT NULL
        AND RIGHT(regexp_replace(${decryptSql(clients.phoneEncrypted, key)}, '\\D', '', 'g'), 10) = ${tail}
      ORDER BY created_at
      LIMIT 1
    `);
    const arr = rows as unknown as Array<{ id: string }>;
    return arr[0]?.id ?? null;
  });
}

export async function createClient(
  db: Db,
  tenantId: string,
  key: string,
  input: CreateClientInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO clients (
        tenant_id, type, subtype, display_name,
        inn, kpp, ogrn, legal_address, phone, email,
        treasury_account, eks_account, personal_account,
        full_name_encrypted, phone_encrypted, address_encrypted,
        notes, status
      ) VALUES (
        ${tenantId}, ${input.type}::client_type,
        ${input.subtype ?? null}::client_subtype,
        ${input.displayName},
        ${input.inn ?? null}, ${input.kpp ?? null}, ${input.ogrn ?? null},
        ${input.legalAddress ?? null}, ${input.phone ?? null}, ${input.email ?? null},
        ${input.treasuryAccount ?? null}, ${input.eksAccount ?? null}, ${input.personalAccount ?? null},
        ${input.individualFullName ? sql`pgp_sym_encrypt(${input.individualFullName}::text, ${key})` : sql`NULL`},
        ${input.individualPhone ? sql`pgp_sym_encrypt(${input.individualPhone}::text, ${key})` : sql`NULL`},
        ${input.individualAddress ? sql`pgp_sym_encrypt(${input.individualAddress}::text, ${key})` : sql`NULL`},
        ${input.notes ?? null}, 'active'
      ) RETURNING id
    `);
    const newId = (result as unknown as Array<{ id: string }>)[0]?.id;
    if (!newId) throw new Error('createClient: insert returned nothing');
    return { id: newId };
  });
}

export async function updateClient(
  db: Db,
  tenantId: string,
  key: string,
  id: string,
  patch: UpdateClientInput,
): Promise<{ updatedFields: string[] }> {
  return withTenantTx(db, tenantId, async (tx) => {
    const setClauses: SQL[] = [];
    if (patch.displayName !== undefined) setClauses.push(sql`display_name = ${patch.displayName}`);
    if (patch.subtype !== undefined) setClauses.push(sql`subtype = ${patch.subtype}::client_subtype`);
    if (patch.inn !== undefined) setClauses.push(sql`inn = ${patch.inn}`);
    if (patch.kpp !== undefined) setClauses.push(sql`kpp = ${patch.kpp}`);
    if (patch.ogrn !== undefined) setClauses.push(sql`ogrn = ${patch.ogrn}`);
    if (patch.legalAddress !== undefined) setClauses.push(sql`legal_address = ${patch.legalAddress}`);
    if (patch.phone !== undefined) setClauses.push(sql`phone = ${patch.phone}`);
    if (patch.email !== undefined) setClauses.push(sql`email = ${patch.email}`);
    if (patch.treasuryAccount !== undefined) setClauses.push(sql`treasury_account = ${patch.treasuryAccount}`);
    if (patch.eksAccount !== undefined) setClauses.push(sql`eks_account = ${patch.eksAccount}`);
    if (patch.personalAccount !== undefined) setClauses.push(sql`personal_account = ${patch.personalAccount}`);
    if (patch.notes !== undefined) setClauses.push(sql`notes = ${patch.notes}`);
    if (patch.individualFullName !== undefined) {
      setClauses.push(
        patch.individualFullName == null
          ? sql`full_name_encrypted = NULL`
          : sql`full_name_encrypted = pgp_sym_encrypt(${patch.individualFullName}::text, ${key})`,
      );
    }
    if (patch.individualPhone !== undefined) {
      setClauses.push(
        patch.individualPhone == null
          ? sql`phone_encrypted = NULL`
          : sql`phone_encrypted = pgp_sym_encrypt(${patch.individualPhone}::text, ${key})`,
      );
    }
    if (patch.individualAddress !== undefined) {
      setClauses.push(
        patch.individualAddress == null
          ? sql`address_encrypted = NULL`
          : sql`address_encrypted = pgp_sym_encrypt(${patch.individualAddress}::text, ${key})`,
      );
    }
    if (setClauses.length === 0) return { updatedFields: [] };
    setClauses.push(sql`updated_at = now()`);
    await tx.execute(sql`UPDATE clients SET ${sql.join(setClauses, sql`, `)} WHERE id = ${id}`);
    return { updatedFields: Object.keys(patch) };
  });
}

export async function archiveClient(
  db: Db,
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(clients)
      .set({ status: 'archived', deletedAt: new Date() })
      .where(eq(clients.id, id));
  });
}

export async function createContact(
  db: Db,
  tenantId: string,
  key: string,
  input: CreateContactInput,
): Promise<{ id: string }> {
  return withTenantTx(db, tenantId, async (tx) => {
    if (input.isPrimary) {
      await tx
        .update(contacts)
        .set({ isPrimary: false })
        .where(and(eq(contacts.clientId, input.clientId), eq(contacts.isPrimary, true)));
    }
    const result = await tx.execute<{ id: string }>(sql`
      INSERT INTO contacts (
        tenant_id, client_id, full_name_encrypted, phone_encrypted,
        email, position, is_primary
      ) VALUES (
        ${tenantId}, ${input.clientId},
        pgp_sym_encrypt(${input.fullName}::text, ${key}),
        pgp_sym_encrypt(${input.phone}::text, ${key}),
        ${input.email ?? null}, ${input.position ?? null}, ${input.isPrimary ?? false}
      ) RETURNING id
    `);
    const newId = (result as unknown as Array<{ id: string }>)[0]?.id;
    if (!newId) throw new Error('createContact: insert returned nothing');
    return { id: newId };
  });
}

export async function updateContact(
  db: Db,
  tenantId: string,
  key: string,
  id: string,
  patch: UpdateContactInput,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    if (patch.isPrimary === true) {
      const existing = await tx
        .select({ clientId: contacts.clientId })
        .from(contacts)
        .where(eq(contacts.id, id))
        .limit(1);
      const cid = existing[0]?.clientId;
      if (cid) {
        await tx
          .update(contacts)
          .set({ isPrimary: false })
          .where(and(eq(contacts.clientId, cid), eq(contacts.isPrimary, true)));
      }
    }

    const setClauses: SQL[] = [];
    if (patch.fullName !== undefined)
      setClauses.push(sql`full_name_encrypted = pgp_sym_encrypt(${patch.fullName}::text, ${key})`);
    if (patch.phone !== undefined)
      setClauses.push(sql`phone_encrypted = pgp_sym_encrypt(${patch.phone}::text, ${key})`);
    if (patch.email !== undefined) setClauses.push(sql`email = ${patch.email}`);
    if (patch.position !== undefined) setClauses.push(sql`position = ${patch.position}`);
    if (patch.isPrimary !== undefined) setClauses.push(sql`is_primary = ${patch.isPrimary}`);
    if (setClauses.length === 0) return;
    setClauses.push(sql`updated_at = now()`);
    await tx.execute(sql`UPDATE contacts SET ${sql.join(setClauses, sql`, `)} WHERE id = ${id}`);
  });
}

export async function deleteContact(
  db: Db,
  tenantId: string,
  id: string,
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.delete(contacts).where(eq(contacts.id, id));
  });
}
