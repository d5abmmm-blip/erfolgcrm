#!/usr/bin/env node
/**
 * Smoke-тест прода/стейджа.
 *
 * Использование:
 *   API_URL=http://localhost:3030 TENANT=erfolg node scripts/smoke.mjs
 *
 * Опциональные ENV:
 *   DEV_LOGIN=username:password  → активирует чек логина (auth.login)
 *   SMOKE_TENANT_TOKEN=...       → активирует чек clients.list (cookie session_token)
 *
 * Exit code 0 если все PASS, 1 если хоть один FAIL.
 */
import process from 'node:process';

const API_URL = (process.env.API_URL ?? 'http://localhost:3030').replace(/\/$/, '');
const TENANT = process.env.TENANT ?? 'erfolg';

const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const GREY = '\x1b[90m';

const results = [];

function record(name, ok, latencyMs, info = '') {
  results.push({ name, ok, latencyMs, info });
  const tag = ok ? `${GREEN}[PASS]${RESET}` : `${RED}[FAIL]${RESET}`;
  const lat = `${GREY}(${latencyMs}ms)${RESET}`;
  const extra = info ? ` ${GREY}${info}${RESET}` : '';
  console.log(`${tag} ${name} ${lat}${extra}`);
}

async function timed(fn) {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { result, latencyMs: Date.now() - t0, error: null };
  } catch (err) {
    return { result: null, latencyMs: Date.now() - t0, error: err };
  }
}

async function check1_health() {
  const { result, latencyMs, error } = await timed(async () => {
    const r = await fetch(`${API_URL}/health`);
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    const body = await r.json();
    if (body.status !== 'ok') throw new Error(`body.status=${body.status}`);
    return body;
  });
  record('GET /health', !error, latencyMs, error ? String(error.message ?? error) : '');
  return !error;
}

async function check2_health_deep() {
  const { result, latencyMs, error } = await timed(async () => {
    const r = await fetch(`${API_URL}/health/deep`);
    const body = await r.json();
    if (r.status !== 200) throw new Error(`status=${r.status} body=${JSON.stringify(body.checks)}`);
    if (body.status !== 'ok') throw new Error(`body.status=${body.status}`);
    return body;
  });
  record('GET /health/deep', !error, latencyMs, error ? String(error.message ?? error) : '');
}

async function check3_login() {
  if (!process.env.DEV_LOGIN) {
    record('auth.login', true, 0, 'skipped (DEV_LOGIN not set)');
    return;
  }
  const [username, password] = process.env.DEV_LOGIN.split(':');
  const { result, latencyMs, error } = await timed(async () => {
    const r = await fetch(`${API_URL}/api/v1/trpc/auth.login?batch=1`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Tenant-Subdomain': TENANT },
      body: JSON.stringify({ '0': { json: { username, password } } }),
    });
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    return r.status;
  });
  record('auth.login', !error, latencyMs, error ? String(error.message ?? error) : '');
}

async function check4_trpc_health() {
  const { result, latencyMs, error } = await timed(async () => {
    const r = await fetch(`${API_URL}/api/v1/trpc/health`);
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    const body = await r.json();
    const status = body?.result?.data?.json?.status;
    if (status !== 'ok') throw new Error(`tRPC status=${status}`);
    return body;
  });
  record('GET tRPC health', !error, latencyMs, error ? String(error.message ?? error) : '');
}

async function check5_clients_list() {
  if (!process.env.SMOKE_TENANT_TOKEN) {
    record('clients.list', true, 0, 'skipped (SMOKE_TENANT_TOKEN not set)');
    return;
  }
  const { result, latencyMs, error } = await timed(async () => {
    const r = await fetch(`${API_URL}/api/v1/trpc/clients.list?batch=1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Tenant-Subdomain': TENANT,
        Cookie: `session_token=${process.env.SMOKE_TENANT_TOKEN}`,
      },
      body: JSON.stringify({ '0': { json: {} } }),
    });
    if (r.status !== 200) throw new Error(`status=${r.status}`);
    return r.status;
  });
  record('clients.list', !error, latencyMs, error ? String(error.message ?? error) : '');
}

(async () => {
  console.log(`${GREY}Smoke target: ${API_URL} (tenant=${TENANT})${RESET}\n`);
  const dbOk = await check1_health();
  await check2_health_deep();
  await check3_login();
  await check4_trpc_health();
  await check5_clients_list();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
