/**
 * Stage 10'.C — 2FA repository helpers (encrypted TOTP secret + recovery hashes).
 *
 * Шифрование/дешифровка через pgcrypto тем же ключом, что и остальные ПДн
 * (см. packages/db/src/crypto.ts). Все операции под withTenantTx → RLS защищает.
 */
import { and, eq, isNull, sql } from 'drizzle-orm';
import {
  decryptSql,
  encryptSql,
  getTenantEncryptionKey,
  users,
  withTenantTx,
  type Db,
  type TenantKeyContext,
} from '@erfolg/db';

export interface TwoFactorState {
  enabled: boolean;
  enabledAt: Date | null;
  secretEnc: Buffer | null;
  recoveryHashes: string[];
}

export async function readTwoFactorState(
  db: Db,
  tenant: TenantKeyContext,
  userId: string,
): Promise<TwoFactorState | null> {
  const key = getTenantEncryptionKey(tenant);
  return withTenantTx(db, tenant.id, async (tx) => {
    const rows = await tx
      .select({
        enabledAt: users.totpEnabledAt,
        secretText: sql<string | null>`${decryptSql(users.totpSecretEnc, key)}`,
        recoveryHashes: users.recoveryCodesHashes,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      enabled: row.enabledAt !== null,
      enabledAt: row.enabledAt,
      // secretText вернётся как plain string — пакуем в Buffer для единого интерфейса.
      secretEnc: row.secretText ? Buffer.from(row.secretText, 'utf8') : null,
      recoveryHashes: Array.isArray(row.recoveryHashes) ? row.recoveryHashes : [],
    };
  });
}

/** Возвращает только plain TOTP-секрет (или null). */
export async function readTotpSecret(
  db: Db,
  tenant: TenantKeyContext,
  userId: string,
): Promise<{ secret: string | null; recoveryHashes: string[] } | null> {
  const key = getTenantEncryptionKey(tenant);
  return withTenantTx(db, tenant.id, async (tx) => {
    const rows = await tx
      .select({
        secretText: sql<string | null>`${decryptSql(users.totpSecretEnc, key)}`,
        recoveryHashes: users.recoveryCodesHashes,
        enabledAt: users.totpEnabledAt,
      })
      .from(users)
      .where(and(eq(users.id, userId), isNull(users.deletedAt)))
      .limit(1);
    const row = rows[0];
    if (!row || !row.enabledAt) return null;
    return {
      secret: row.secretText ?? null,
      recoveryHashes: Array.isArray(row.recoveryHashes) ? row.recoveryHashes : [],
    };
  });
}

export async function enableTwoFactor(
  db: Db,
  tenant: TenantKeyContext,
  userId: string,
  secret: string,
  recoveryHashes: string[],
): Promise<void> {
  const key = getTenantEncryptionKey(tenant);
  await withTenantTx(db, tenant.id, async (tx) => {
    await tx.execute(sql`
      UPDATE users
      SET totp_secret_enc = ${encryptSql(secret, key)},
          totp_enabled_at = now(),
          recovery_codes_hashes = ${JSON.stringify(recoveryHashes)}::jsonb,
          updated_at = now()
      WHERE id = ${userId}
    `);
  });
}

export async function replaceRecoveryHashes(
  db: Db,
  tenantId: string,
  userId: string,
  recoveryHashes: string[],
): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx.execute(sql`
      UPDATE users
      SET recovery_codes_hashes = ${JSON.stringify(recoveryHashes)}::jsonb,
          updated_at = now()
      WHERE id = ${userId}
    `);
  });
}

export async function disableTwoFactor(db: Db, tenantId: string, userId: string): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(users)
      .set({
        totpSecretEnc: null,
        totpEnabledAt: null,
        recoveryCodesHashes: null,
      })
      .where(eq(users.id, userId));
  });
}
