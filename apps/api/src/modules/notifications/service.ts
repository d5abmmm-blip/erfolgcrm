/**
 * Service для notifications:
 *   - subscribe/unsubscribe ручки от UI;
 *   - enqueueAssignmentPush — продюсер job'а в push-send очередь.
 *
 * Сами POST'ы в FCM/Mozilla идут в воркере workers/push-send.ts.
 */
import { writeAudit } from '../../lib/audit';
import { getQueue, QUEUE_NAMES } from '../../lib/queue';
import type { PushPayload } from '../../lib/web-push';
import { getVapidPublicKey } from '../../lib/web-push';
import type { CmdCtx } from '../../trpc/helpers';
import { deleteByEndpoint, upsertSubscription } from './repository';

export interface SubscribeInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export async function subscribeCmd(
  ctx: CmdCtx,
  input: SubscribeInput,
): Promise<{ ok: true }> {
  await upsertSubscription(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    endpoint: input.endpoint,
    p256dh: input.p256dh,
    auth: input.auth,
    userAgent: ctx.audit.userAgent ?? null,
  });
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: ctx.session.userId,
    action: 'create',
    entityType: 'push_subscription',
    after: { endpoint: maskEndpoint(input.endpoint) },
    ip: ctx.audit.ip ?? null,
    userAgent: ctx.audit.userAgent ?? null,
  });
  return { ok: true };
}

export async function unsubscribeCmd(
  ctx: CmdCtx,
  endpoint: string,
): Promise<{ ok: boolean }> {
  const ok = await deleteByEndpoint(ctx.db, ctx.tenant.id, ctx.session.userId, endpoint);
  if (ok) {
    await writeAudit(ctx.db, ctx.tenant.id, {
      userId: ctx.session.userId,
      action: 'delete',
      entityType: 'push_subscription',
      after: { endpoint: maskEndpoint(endpoint) },
      ip: ctx.audit.ip ?? null,
      userAgent: ctx.audit.userAgent ?? null,
    });
  }
  return { ok };
}

export function getPublicKeyQuery(): { publicKey: string | null } {
  return { publicKey: getVapidPublicKey() };
}

export interface EnqueuePushInput {
  tenantId: string;
  userId: string;
  payload: PushPayload;
}

/** Продюсер: ставит job в push-send. Все активные подписки юзера получат. */
export async function enqueuePushToUser(input: EnqueuePushInput): Promise<void> {
  await getQueue<EnqueuePushInput>(QUEUE_NAMES.pushSend).add('send', input, {
    // Дедуп: одинаковый ticketId+userId за 30 секунд не должен залить пользователя.
    jobId:
      typeof input.payload.tag === 'string'
        ? `push:${input.tenantId}:${input.userId}:${input.payload.tag}`
        : undefined,
  });
}

/** Маскируем endpoint в логах: оставляем только последние 12 символов хеша. */
function maskEndpoint(endpoint: string): string {
  return endpoint.length > 16 ? `…${endpoint.slice(-12)}` : '…';
}
