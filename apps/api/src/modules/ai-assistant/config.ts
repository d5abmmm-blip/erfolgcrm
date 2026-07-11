/**
 * Конфигурация LLM на уровне tenant'а: чтение/запись в БД (llm_configs) + fallback
 * на переменные окружения (LLM_*), чтобы уже настроенный через env прод продолжал
 * работать, пока директор не введёт ключ в Настройках.
 *
 * API-ключ — секрет: хранится зашифрованным (pgcrypto), наружу (в DTO для UI) НЕ
 * отдаётся — только флаг hasApiKey. Запись write-only: пустой ключ = не менять.
 */
import { sql, eq } from 'drizzle-orm';
import {
  decryptSql,
  getTenantEncryptionKey,
  llmConfigs,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import type { ApiStyle, LlmRuntimeConfig } from './llm';

interface TenantKeyCtx {
  id: string;
  kmsKeyId: string | null;
}

/** Default — 'openai' (обратная совместимость с env); 'anthropic' только если задан явно. */
function normalizeStyle(v: string | null | undefined): ApiStyle {
  return v?.trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

/** Рантайм-конфиг из переменных окружения (LLM_*), или null если не заданы все обязательные. */
export function llmConfigFromEnv(): LlmRuntimeConfig | null {
  const baseUrl = process.env.LLM_BASE_URL?.trim();
  const apiKey = process.env.LLM_API_KEY?.trim();
  const model = process.env.LLM_MODEL?.trim();
  if (!baseUrl || !apiKey || !model) return null;
  return {
    apiStyle: normalizeStyle(process.env.LLM_API_STYLE),
    baseUrl: baseUrl.replace(/\/+$/, ''),
    apiKey,
    model,
  };
}

/**
 * Рабочий конфиг для вызова модели: сперва БД (если включён и заполнен), иначе env.
 * Возвращает null, если ассистент нигде не настроен.
 *
 * @internal Результат содержит РАСШИФРОВАННЫЙ apiKey. НЕ логировать, НЕ возвращать
 * клиенту, НЕ писать в аудит. Использовать только для немедленного вызова callLlm.
 */
export async function loadLlmRuntimeConfig(
  db: Db,
  tenant: TenantKeyCtx,
): Promise<LlmRuntimeConfig | null> {
  const key = getTenantEncryptionKey(tenant);
  const row = await withTenantTx(db, tenant.id, async (tx) => {
    const rows = await tx
      .select({
        enabled: llmConfigs.enabled,
        apiStyle: llmConfigs.apiStyle,
        baseUrl: llmConfigs.baseUrl,
        model: llmConfigs.model,
        customInstructions: llmConfigs.customInstructions,
        apiKey: decryptSql(llmConfigs.apiKeyEnc, key).as('api_key_dec'),
      })
      .from(llmConfigs)
      .where(eq(llmConfigs.tenantId, tenant.id))
      .limit(1);
    return rows[0] ?? null;
  });

  const apiKey = (row?.apiKey as string | null) ?? null;
  if (row?.enabled && row.baseUrl && row.model && apiKey) {
    return {
      apiStyle: normalizeStyle(row.apiStyle),
      baseUrl: row.baseUrl.replace(/\/+$/, ''),
      apiKey,
      model: row.model,
      customInstructions: row.customInstructions ?? null,
    };
  }
  // БД не настроена/выключена → пробуем env (текущий прод).
  return llmConfigFromEnv();
}

/** Конфиг для UI — БЕЗ ключа (только флаг hasApiKey) + признак работы из env. */
export interface LlmConfigDto {
  enabled: boolean;
  apiStyle: ApiStyle;
  baseUrl: string | null;
  model: string | null;
  hasApiKey: boolean;
  /** Инструкция-памятка для ассистента (не секрет — отдаётся в UI как есть). */
  customInstructions: string | null;
  /** true, если строки в БД нет/она неполна, но ассистент работает из env (LLM_*). */
  usingEnvFallback: boolean;
  updatedAt: Date | null;
}

export async function getLlmConfigDto(db: Db, tenant: TenantKeyCtx): Promise<LlmConfigDto> {
  const row = await withTenantTx(db, tenant.id, async (tx) => {
    const rows = await tx
      .select({
        enabled: llmConfigs.enabled,
        apiStyle: llmConfigs.apiStyle,
        baseUrl: llmConfigs.baseUrl,
        model: llmConfigs.model,
        customInstructions: llmConfigs.customInstructions,
        hasApiKey: sql<boolean>`${llmConfigs.apiKeyEnc} IS NOT NULL`.as('has_api_key'),
        updatedAt: llmConfigs.updatedAt,
      })
      .from(llmConfigs)
      .where(eq(llmConfigs.tenantId, tenant.id))
      .limit(1);
    return rows[0] ?? null;
  });

  const envCfg = llmConfigFromEnv();
  if (!row) {
    return {
      enabled: false,
      apiStyle: 'anthropic',
      baseUrl: null,
      model: null,
      hasApiKey: false,
      customInstructions: null,
      usingEnvFallback: envCfg != null,
      updatedAt: null,
    };
  }
  const dbComplete = row.enabled && Boolean(row.baseUrl) && Boolean(row.model) && row.hasApiKey;
  return {
    enabled: row.enabled,
    apiStyle: normalizeStyle(row.apiStyle),
    baseUrl: row.baseUrl,
    model: row.model,
    hasApiKey: Boolean(row.hasApiKey),
    customInstructions: row.customInstructions ?? null,
    usingEnvFallback: !dbComplete && envCfg != null,
    updatedAt: row.updatedAt,
  };
}

export interface UpsertLlmConfigInput {
  enabled: boolean;
  apiStyle: ApiStyle;
  baseUrl: string | null;
  model: string | null;
  /** Новый ключ. undefined/пусто — не менять (сохранить прежний). */
  apiKey?: string;
  /** Инструкция-памятка для ассистента (null — очистить). */
  customInstructions?: string | null;
}

/** Сохраняет конфиг. Ключ шифруется; пустой apiKey не затирает сохранённый (COALESCE). */
export async function upsertLlmConfig(
  db: Db,
  tenant: TenantKeyCtx,
  input: UpsertLlmConfigInput,
): Promise<void> {
  const key = getTenantEncryptionKey(tenant);
  const encKey = input.apiKey ? sql`pgp_sym_encrypt(${input.apiKey}::text, ${key})` : sql`NULL`;
  const instructions = input.customInstructions?.trim() || null;
  await withTenantTx(db, tenant.id, async (tx) => {
    await tx.execute(sql`
      INSERT INTO llm_configs (tenant_id, enabled, api_style, base_url, model, api_key_encrypted, custom_instructions, updated_at)
      VALUES (${tenant.id}, ${input.enabled}, ${input.apiStyle}, ${input.baseUrl ?? null}, ${input.model ?? null}, ${encKey}, ${instructions}, now())
      ON CONFLICT (tenant_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        api_style = EXCLUDED.api_style,
        base_url = EXCLUDED.base_url,
        model = EXCLUDED.model,
        api_key_encrypted = COALESCE(EXCLUDED.api_key_encrypted, llm_configs.api_key_encrypted),
        custom_instructions = EXCLUDED.custom_instructions,
        updated_at = now()
    `);
  });
}
