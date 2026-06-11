/**
 * Обработчик входящих Telegram update'ов.
 *
 * Принципы:
 *   - Один update обрабатывается синхронно: парсим → грузим/обновляем conversation state →
 *     отвечаем пользователю → если все 4 уточнения заполнены, создаём клиента+заявку → пушим диспетчеру.
 *   - Все DB-операции в рамках tenant'а (RLS).
 *   - userId в createTicket = null (бот не пользователь).
 */
import type { Db } from '@erfolg/db';
import { eq } from 'drizzle-orm';
import { users, withTenantTx } from '@erfolg/db';
import { writeAudit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { sendMessage, type TgUpdate } from '../../lib/telegram-client';
import { createTicket, type CreateTicketInput } from '../tickets/repository';
import { createClient as repoCreateClient } from '../clients/repository';
import { getTenantEncryptionKey } from '@erfolg/db';
import { enqueuePushToUser } from '../notifications';
import {
  applyAnswer,
  clearConversation,
  loadConversation,
  nextStep,
  saveConversation,
  STEP_PROMPTS,
  type ConversationState,
} from './conversation';

interface HandlerCtx {
  db: Db;
  tenant: { id: string; subdomain: string; kmsKeyId: string | null };
  botToken: string;
  defaultDispatcherUserId: string | null;
}

export async function handleUpdate(ctx: HandlerCtx, update: TgUpdate): Promise<void> {
  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.text) return; // photos, stickers и пр. — ignore (на будущих этапах)
  const chatId = msg.chat.id;
  const text = msg.text;

  // /start или /заявка — сброс state и начало диалога.
  if (text === '/start' || text === '/заявка' || text === '/zayavka' || text === '/zayavka@erfolg_bot') {
    const state: ConversationState = { step: 'ASK_NAME', startedAt: Date.now() };
    await saveConversation(ctx.tenant.id, chatId, state);
    await sendMessage(ctx.botToken, { chat_id: chatId, text: STEP_PROMPTS.ASK_NAME });
    return;
  }

  if (text === '/help' || text === '/помощь') {
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text: 'Команды:\n/start — оформить заявку на ремонт\n/help — эта справка',
    });
    return;
  }

  // Если нет state — подсказываем команду.
  let state = await loadConversation(ctx.tenant.id, chatId);
  if (!state || state.step === 'IDLE' || state.step === 'DONE') {
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text: 'Чтобы оформить заявку, отправьте /start',
    });
    return;
  }

  // Применяем ответ к текущему шагу.
  const accepted = applyAnswer(state, text);
  if (!accepted) {
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text: 'Пожалуйста, ответьте подробнее.\n\n' + STEP_PROMPTS[state.step],
    });
    return;
  }

  state.step = nextStep(state.step);
  await saveConversation(ctx.tenant.id, chatId, state);

  if (state.step !== 'DONE') {
    await sendMessage(ctx.botToken, { chat_id: chatId, text: STEP_PROMPTS[state.step] });
    return;
  }

  // DONE — создаём клиента + заявку + push.
  try {
    const result = await createTicketFromConversation(ctx, state);
    await clearConversation(ctx.tenant.id, chatId);
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text: `Спасибо, заявка №${result.ticketNumber} принята! Наш специалист свяжется с вами в ближайшее время.`,
    });
  } catch (err: unknown) {
    logger.error({ err, tenantId: ctx.tenant.id, chatId }, 'failed to create ticket from telegram');
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text: 'Извините, не получилось зарегистрировать заявку. Попробуйте позже или позвоните по телефону.',
    });
  }
}

async function createTicketFromConversation(
  ctx: HandlerCtx,
  state: ConversationState,
): Promise<{ ticketId: string; ticketNumber: string }> {
  if (!state.fullName || !state.phone || !state.symptom || !state.address) {
    throw new Error('createTicketFromConversation: incomplete state');
  }

  // 1. Клиент: создаём individual с зашифрованными ПДн.
  const key = getTenantEncryptionKey({ id: ctx.tenant.id, kmsKeyId: ctx.tenant.kmsKeyId });
  const initials = makeInitials(state.fullName);
  const { id: clientId } = await repoCreateClient(ctx.db, ctx.tenant.id, key, {
    type: 'individual',
    displayName: initials,
    individualFullName: state.fullName,
    individualPhone: state.phone,
    individualAddress: state.address,
  });

  // 2. Заявка с source='telegram'.
  const ticketInput: CreateTicketInput = {
    clientId,
    source: 'telegram',
    intakeMethod: 'brought_in',
    repairType: 'paid',
    priority: 'normal',
    symptom: `${state.symptom}\n\nКонтакт из Telegram: ${state.phone}`,
  };
  const ticket = await createTicket(ctx.db, ctx.tenant.id, null, ticketInput);

  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: null,
    action: 'create',
    entityType: 'ticket',
    entityId: ticket.id,
    after: {
      ticketNumber: ticket.ticketNumber,
      source: 'telegram',
    },
    ip: 'telegram',
  });

  // 3. Push диспетчеру.
  await pushToDispatchers(ctx, ticket);

  return { ticketId: ticket.id, ticketNumber: ticket.ticketNumber };
}

async function pushToDispatchers(
  ctx: HandlerCtx,
  ticket: { id: string; ticketNumber: string },
): Promise<void> {
  const targets = await dispatcherTargets(ctx);
  await Promise.all(
    targets.map((userId) =>
      enqueuePushToUser({
        tenantId: ctx.tenant.id,
        userId,
        payload: {
          title: `Новая заявка из Telegram ${ticket.ticketNumber}`,
          body: 'Клиент оформил заявку через бота. Откройте, чтобы посмотреть детали.',
          url: `/tickets/${ticket.id}`,
          tag: `tg-ticket-${ticket.id}`,
          data: { ticketId: ticket.id, source: 'telegram' },
        },
      }).catch(() => undefined),
    ),
  );
}

async function dispatcherTargets(ctx: HandlerCtx): Promise<string[]> {
  if (ctx.defaultDispatcherUserId) return [ctx.defaultDispatcherUserId];
  return withTenantTx(ctx.db, ctx.tenant.id, async (tx) => {
    const rows = await tx
      .select({ id: users.id })
      .from(users)
      .where(eq(users.role, 'dispatcher'));
    return rows.map((r) => r.id);
  });
}

function makeInitials(fullName: string): string {
  // «Иванов Иван Иванович» → «Иванов И.И.»; если одна часть — берём первое слово.
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 0) return 'Telegram-клиент';
  const last = parts[0] ?? '';
  const inits = parts
    .slice(1)
    .map((p) => (p[0] ? `${p[0]}.` : ''))
    .join('');
  return (last + (inits ? ` ${inits}` : '')).slice(0, 200);
}
