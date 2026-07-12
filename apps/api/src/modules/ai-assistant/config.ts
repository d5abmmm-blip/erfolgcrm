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
import type { ApiStyle, AssistantMode, LlmRuntimeConfig } from './llm';

interface TenantKeyCtx {
  id: string;
  kmsKeyId: string | null;
}

/** Default — 'openai' (обратная совместимость с env); 'anthropic' только если задан явно. */
function normalizeStyle(v: string | null | undefined): ApiStyle {
  return v?.trim().toLowerCase() === 'anthropic' ? 'anthropic' : 'openai';
}

/** Default — 'full' (текущее поведение); 'read_only' только если задан явно. */
function normalizeMode(v: string | null | undefined): AssistantMode {
  return v?.trim().toLowerCase() === 'read_only' ? 'read_only' : 'full';
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

/** Строка llm_configs (уже с расшифрованным ключом) для решения о рантайм-конфиге. */
export interface LlmConfigRow {
  enabled: boolean;
  apiStyle: string | null;
  baseUrl: string | null;
  model: string | null;
  customInstructions: string | null;
  assistantMode: string | null;
  /** Расшифрованный ключ или null, если в БД его нет. */
  apiKey: string | null;
}

/**
 * Решает, какой рантайм-конфиг использовать, по строке БД и env-фолбэку. Вынесено в
 * ЧИСТУЮ функцию (тестируется без БД). Ключевое правило безопасности:
 *
 *   ЯВНОЕ ВЫКЛЮЧЕНИЕ ПРИОРИТЕТНЕЕ ENV-ФОЛБЭКА. Если строка в БД есть и enabled=false —
 *   директор осознанно выключил ассистента в Настройках → возвращаем null и НЕ проваливаемся
 *   в env (иначе на проде с заданными LLM_* «Выключен» игнорировался бы, и запросы/ПДн
 *   продолжали бы уходить во внешний LLM).
 *
 * Env-фолбэк применяется только когда строки в БД нет вовсе, либо когда она enabled=true, но
 * неполна (ключ хранится в env, а не в БД). В последнем случае накладываем mode и инструкцию
 * из БД на env-конфиг — чтобы режим «только чтение» и памятка не терялись.
 */
export function resolveRuntimeConfig(
  row: LlmConfigRow | null,
  envCfg: LlmRuntimeConfig | null,
): LlmRuntimeConfig | null {
  // Явное выключение в Настройках — приоритетнее env-фолбэка.
  if (row && !row.enabled) return null;

  // БД включена и полностью заполнена → конфиг из БД.
  if (row?.enabled && row.baseUrl && row.model && row.apiKey) {
    return {
      apiStyle: normalizeStyle(row.apiStyle),
      baseUrl: row.baseUrl.replace(/\/+$/, ''),
      apiKey: row.apiKey,
      model: row.model,
      customInstructions: row.customInstructions ?? null,
      mode: normalizeMode(row.assistantMode),
    };
  }

  // Иначе — env-фолбэк (прод настроен через LLM_*). Если строка в БД есть (enabled=true,
  // но неполна), накладываем mode/инструкцию из БД, чтобы read_only и памятка не терялись.
  if (envCfg && row) {
    return {
      ...envCfg,
      customInstructions: row.customInstructions ?? null,
      mode: normalizeMode(row.assistantMode),
    };
  }
  return envCfg;
}

/**
 * Рабочий конфиг для вызова модели: сперва БД (если включён и заполнен), иначе env.
 * Возвращает null, если ассистент выключен директором или нигде не настроен.
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
        assistantMode: llmConfigs.assistantMode,
        apiKey: decryptSql(llmConfigs.apiKeyEnc, key).as('api_key_dec'),
      })
      .from(llmConfigs)
      .where(eq(llmConfigs.tenantId, tenant.id))
      .limit(1);
    return rows[0] ?? null;
  });

  const dbRow: LlmConfigRow | null = row
    ? {
        enabled: row.enabled,
        apiStyle: row.apiStyle,
        baseUrl: row.baseUrl,
        model: row.model,
        customInstructions: row.customInstructions,
        assistantMode: row.assistantMode,
        apiKey: (row.apiKey as string | null) ?? null,
      }
    : null;
  return resolveRuntimeConfig(dbRow, llmConfigFromEnv());
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
  /** Режим: 'full' | 'read_only'. */
  mode: AssistantMode;
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
        assistantMode: llmConfigs.assistantMode,
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
      mode: 'full',
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
    mode: normalizeMode(row.assistantMode),
    // Env-фолбэк «работает» только когда ассистент НЕ выключен явно (enabled=true), но
    // строка в БД неполна. При enabled=false ассистент выключен — из env он больше не поднимается.
    usingEnvFallback: row.enabled && !dbComplete && envCfg != null,
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
  /** Режим работы ассистента. */
  mode?: AssistantMode;
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
  const mode = normalizeMode(input.mode);
  await withTenantTx(db, tenant.id, async (tx) => {
    await tx.execute(sql`
      INSERT INTO llm_configs (tenant_id, enabled, api_style, base_url, model, api_key_encrypted, custom_instructions, assistant_mode, updated_at)
      VALUES (${tenant.id}, ${input.enabled}, ${input.apiStyle}, ${input.baseUrl ?? null}, ${input.model ?? null}, ${encKey}, ${instructions}, ${mode}, now())
      ON CONFLICT (tenant_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        api_style = EXCLUDED.api_style,
        base_url = EXCLUDED.base_url,
        model = EXCLUDED.model,
        api_key_encrypted = COALESCE(EXCLUDED.api_key_encrypted, llm_configs.api_key_encrypted),
        custom_instructions = EXCLUDED.custom_instructions,
        assistant_mode = EXCLUDED.assistant_mode,
        updated_at = now()
    `);
  });
}
