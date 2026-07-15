/**
 * Runner для воспроизведения мутаций из outbox. Использует vanilla tRPC client
 * (без React-зависимости), чтобы можно было запускать sync из online-handler
 * или Service Worker message handler.
 *
 * Каждая kind-мутация явно мапится на свой proxy-вызов — чтобы TypeScript
 * не позволил «прокинуть» произвольную мутацию мимо разрешённых.
 */
import { createTRPCClient, httpBatchLink } from '@trpc/client';
import superjson from 'superjson';
import type { AppRouter } from '@erfolg/api';
import type { OutboxItem } from './queue';

const API_URL = (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:3030';

interface RunnerOpts {
  tenantSubdomain: string | null;
}

function makeClient(opts: RunnerOpts) {
  return createTRPCClient<AppRouter>({
    links: [
      httpBatchLink({
        url: `${API_URL}/api/v1/trpc`,
        transformer: superjson,
        fetch(url, init) {
          const headers = new Headers(init?.headers);
          if (opts.tenantSubdomain) {
            headers.set('X-Tenant-Subdomain', opts.tenantSubdomain);
          }
          return fetch(url, { ...init, headers, credentials: 'include' });
        },
      }),
    ],
  });
}

export async function runOutboxItem(item: OutboxItem): Promise<unknown> {
  const client = makeClient({ tenantSubdomain: item.tenantSubdomain });
  const p = item.payload as Record<string, unknown>;
  switch (item.kind) {
    case 'tickets.changeStatus':
      return client.tickets.changeStatus.mutate(p as never);
    case 'tickets.addNote':
      return client.tickets.addNote.mutate(p as never);
    case 'workOrders.upsertLine':
      return client.workOrders.upsertLine.mutate(p as never);
    case 'workOrders.deleteLine':
      return client.workOrders.deleteLine.mutate(p as never);
    case 'workOrders.updateHeader':
      return client.workOrders.updateHeader.mutate(p as never);
    case 'inventoryMovements.issueToWorkOrder':
      return client.inventoryMovements.issueToWorkOrder.mutate(p as never);
    case 'maintenance.recordPerformed':
      return client.maintenance.recordPerformed.mutate(p as never);
    case 'tickets.engineerReact':
      return client.tickets.engineerReact.mutate(p as never);
    case 'tasks.setDone':
      return client.tasks.setDone.mutate(p as never);
    default: {
      const exhaust: never = item.kind;
      throw new Error(`Unknown outbox kind: ${String(exhaust)}`);
    }
  }
}
