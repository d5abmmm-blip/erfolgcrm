/**
 * Применяет RLS-миграцию вручную (Drizzle не отслеживает RLS-политики).
 * Идемпотентен — можно запускать многократно.
 *
 * Запуск: pnpm --filter @erfolg/db tsx src/setup-rls.ts
 *
 * Block A (security hardening): RLS-миграции теперь подхватываются автоматически
 * по glob `*enable_rls*.sql`. Список таблиц с RLS-проверкой получаем из pg_class
 * (auto-discovery), а не из хардкод-списка — добавление новой таблицы с RLS
 * автоматически попадёт в проверку.
 */
import 'dotenv/config';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Маппинг RLS-файла → имя «триггерной» таблицы. Если триггерная таблица существует,
 * считаем что бизнес-таблицы Stage'а уже созданы и можно применять RLS.
 *
 * `null` означает безусловное применение (Stage 1 — таблицы создаются 0000_productive_mongu.sql,
 * который выполняется первым drizzle-kit'ом).
 */
const STAGE_TRIGGER_TABLE: Record<string, string | null> = {
  '0001_enable_rls.sql': null,
  '0004_enable_rls_stage2.sql': 'clients',
  '0006_enable_rls_stage3.sql': 'tickets',
  '0009_enable_rls_stage5.sql': 'inventory_items',
  '0010_enable_rls_stage6.sql': 'attachments',
  '0011_enable_rls_stage6_contracts.sql': 'contracts',
  '0013_enable_rls_stage7_push.sql': 'push_subscriptions',
  '0014_enable_rls_stage7_telegram.sql': 'telegram_bot_configs',
  '0015_enable_rls_stage8_invoices.sql': 'invoices',
  '0018_enable_rls_stage8_onec.sql': 'onec_exchange_log',
  '0019_enable_rls_stage9_payroll.sql': 'engineer_payout_rules',
  '0020_enable_rls_stage10f_metrology.sql': 'metrology_si_details',
  '0022_enable_rls_stage10g.sql': 'metrology_reminder_log',
  '0023_enable_rls_stage10i.sql': 'engineer_attestations',
  '0024_enable_rls_stage10h.sql': 'client_users',
  '0026_enable_rls_stage10j.sql': 'intake_checklists',
  '0029_enable_rls_stage11_templates.sql': 'ticket_templates',
  '0030_enable_rls_stage12_kb.sql': 'kb_articles',
  '0031_enable_rls_leads.sql': 'leads',
  '0032_enable_rls_warranties.sql': 'warranties',
  '0033_enable_rls_kp_versions.sql': 'ticket_kp_versions',
  '0034_enable_rls_trade_in.sql': 'trade_in_items',
  '0035_enable_rls_roadmap.sql': 'roadmap_goals',
  '0039_enable_rls_calendar_events.sql': 'calendar_events',
  '0042_enable_rls_email.sql': 'email_messages',
  '0044_enable_rls_email_attachments.sql': 'email_attachments',
  '0047_enable_rls_cash.sql': 'cash_accounts',
};

async function main() {
  // setup-rls работает как owner (нужны права создавать роли и политики)
  const url =
    process.env.DATABASE_OWNER_URL ??
    'postgresql://erfolg:dev_only_password@localhost:5432/erfolg_dev';
  console.info('Applying RLS to:', url.replace(/:[^@]+@/, ':***@'));
  const sql = postgres(url, { max: 1 });

  // Auto-discovery RLS-миграций: glob `*enable_rls*.sql` в папке миграций.
  // Эти файлы НЕ зарегистрированы в _journal.json — drizzle-kit migrate их не запускает.
  const migrationsDir = join(__dirname, '..', 'drizzle', 'migrations');
  const rlsFiles = readdirSync(migrationsDir)
    .filter((f) => /enable_rls.*\.sql$/.test(f))
    .sort(); // лексикографический порядок = порядок номеров миграций
  console.info(`Found ${rlsFiles.length} RLS migration(s):`);
  for (const f of rlsFiles) console.info(`  - ${f}`);

  // 1. Создаём role app_runtime БЕЗ superuser/bypassrls — это runtime-юзер приложения.
  //    Owner таблиц остаётся erfolg (миграции и seed). Приложение подключается под app_runtime,
  //    к которому RLS применяется (т.к. он не bypass).
  const runtimePass = process.env.APP_RUNTIME_PASSWORD ?? 'app_runtime_dev_only';
  const exists = await sql<Array<{ exists: boolean }>>`
    SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') AS exists
  `;
  if (!exists[0]?.exists) {
    await sql.unsafe(`CREATE ROLE app_runtime LOGIN PASSWORD '${runtimePass.replace(/'/g, "''")}' NOSUPERUSER NOBYPASSRLS NOCREATEROLE NOCREATEDB`);
    console.info('  + role app_runtime created');
  } else {
    await sql.unsafe(`ALTER ROLE app_runtime WITH PASSWORD '${runtimePass.replace(/'/g, "''")}' NOSUPERUSER NOBYPASSRLS`);
    console.info('  = role app_runtime updated (password reset)');
  }

  // 2. Гранты: app_runtime должен иметь доступ к схеме и таблицам
  await sql`GRANT USAGE ON SCHEMA public TO app_runtime`;
  await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runtime`;
  await sql`GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO app_runtime`;
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_runtime`;
  await sql`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE ON SEQUENCES TO app_runtime`;

  // 3. Дропаем существующие политики чтобы скрипт был идемпотентным.
  //    Удаляем только те политики, которые встречаются в pg_policies, иначе DROP IF EXISTS
  //    не падает. Не используем хардкод — выбираем все policy с именем `tenant_isolation_*`.
  const policies = await sql<Array<{ tablename: string; policyname: string }>>`
    SELECT tablename, policyname
      FROM pg_policies
     WHERE schemaname = 'public'
       AND policyname LIKE 'tenant_isolation_%'
  `;
  for (const p of policies) {
    await sql.unsafe(`DROP POLICY IF EXISTS ${p.policyname} ON ${p.tablename}`);
  }

  // 4. Применяем RLS-файлы. Для Stage > 1 проверяем что триггерная таблица существует.
  for (const file of rlsFiles) {
    const trigger = STAGE_TRIGGER_TABLE[file];
    if (trigger) {
      const tablesExist = await sql<Array<{ exists: boolean }>>`
        SELECT EXISTS(SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename=${trigger}) AS exists
      `;
      if (!tablesExist[0]?.exists) {
        console.info(`  ! ${file} skipped — trigger table "${trigger}" does not exist (run pnpm migrate first)`);
        continue;
      }
    }
    const fileSql = readFileSync(join(migrationsDir, file), 'utf-8');
    await sql.unsafe(fileSql);
    console.info(`  + ${file} applied`);
  }

  // 5. Проверяем что RLS включён — auto-discovery: берём ВСЕ таблицы из public,
  //    у которых relrowsecurity = true. Не нужно вручную вести IN-список.
  const result = await sql<Array<{ tablename: string; rls: boolean; force: boolean }>>`
    SELECT c.relname AS tablename,
           c.relrowsecurity AS rls,
           c.relforcerowsecurity AS force
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relrowsecurity = true
     ORDER BY c.relname
  `;

  console.info('\nRLS status (auto-discovered):');
  for (const r of result) {
    const marker = r.rls && r.force ? '✓' : '✗';
    console.info(`  ${marker} ${r.tablename.padEnd(28)} enabled=${r.rls} force=${r.force}`);
  }

  await sql.end();
  console.info('\nDone.');
}

main().catch((err) => {
  console.error('setup-rls failed:', err);
  process.exit(1);
});
