/**
 * tRPC клиент для веб-приложения.
 *
 * Multi-tenant: subdomain в Host обычно работает только если есть DNS-записи.
 * В dev мы передаём заголовок X-Tenant-Subdomain, который определяется тремя
 * способами в порядке приоритета:
 *   1. URL query ?tenant=xxx
 *   2. localStorage
 *   3. window.location.hostname (например, erfolg.localhost → "erfolg")
 *
 * В production субдомен резолвится через Host автоматически — заголовок не нужен.
 */
import { createTRPCReact } from '@trpc/react-query';
import { httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '@erfolg/api';

export const trpc = createTRPCReact<AppRouter>();

const TENANT_LS_KEY = 'erfolg-tenant-subdomain';

export function getTenantSubdomain(): string | null {
  if (typeof window === 'undefined') return null;

  // 1. Query
  const params = new URLSearchParams(window.location.search);
  const fromQuery = params.get('tenant');
  if (fromQuery) {
    localStorage.setItem(TENANT_LS_KEY, fromQuery);
    return fromQuery;
  }

  // 2. Hostname (acme.localhost / acme.erfolgcrm.ru)
  const host = window.location.hostname;
  const parts = host.split('.');
  if (parts.length >= 2) {
    const candidate = parts[0]?.toLowerCase();
    const reserved = new Set(['www', 'app', 'admin', 'api']);
    if (candidate && !reserved.has(candidate) && candidate !== 'localhost') {
      return candidate;
    }
  }

  // 3. localStorage fallback (для разработки на голом localhost)
  return localStorage.getItem(TENANT_LS_KEY);
}

export function setTenantSubdomain(subdomain: string) {
  localStorage.setItem(TENANT_LS_KEY, subdomain);
}

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3030';

export const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: `${API_URL}/api/v1/trpc`,
      transformer: superjson,
      fetch(url, options) {
        const tenant = getTenantSubdomain();
        const headers = new Headers(options?.headers);
        if (tenant) headers.set('X-Tenant-Subdomain', tenant);
        return fetch(url, { ...options, headers, credentials: 'include' });
      },
    }),
  ],
});
