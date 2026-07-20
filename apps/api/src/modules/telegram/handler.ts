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
import { TRPCError } from '@trpc/server';
import { writeAudit } from '../../lib/audit';
import { logger } from '../../lib/logger';
import { getRedis } from '../../lib/redis';
import {
  answerCallbackQuery,
  editMessageText,
  sendMessage,
  type TgUpdate,
} from '../../lib/telegram-client';
import type { ResolvedTenant } from '../../lib/tenant';
import type { CmdCtx } from '../../trpc/helpers';
import { createTicket, type CreateTicketInput } from '../tickets/repository';
import {
  addTicketNoteCmd,
  engineerReactCmd,
  type EngineerReactAction,
} from '../tickets/service';
import { clearUnansweredCount } from '../../lib/nudge-state';
import {
  createClient as repoCreateClient,
  findIndividualClientIdByPhone,
} from '../clients/repository';
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
import {
  consumeLinkCode,
  findUserByChatId,
  linkChatToUser,
  LINK_PAYLOAD_PREFIX,
  type LinkedStaffUser,
} from './staff-link';

interface HandlerCtx {
  db: Db;
  tenant: ResolvedTenant;
  botToken: string;
  defaultDispatcherUserId: string | null;
}

/** Ожидание свободного текста после кнопки «Другое» — Redis, TTL 10 минут. */
const PENDING_NOTE_TTL_SEC = 10 * 60;
const pendingNoteKey = (tenantId: string, chatId: number) =>
  `erfolg:tg-note:${tenantId}:${chatId}`;

export async function handleUpdate(ctx: HandlerCtx, update: TgUpdate): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(ctx, update.callback_query);
    return;
  }
  const msg = update.message ?? update.edited_message;
  if (!msg || !msg.text) return; // photos, stickers и пр. — ignore (на будущих этапах)
  const chatId = msg.chat.id;
  const text = msg.text;

  // Deep-link привязки сотрудника: «/start link_<code>» — до всех остальных веток.
  if (text.startsWith(`/start ${LINK_PAYLOAD_PREFIX}`)) {
    await handleLinkStart(ctx, chatId, text.slice('/start '.length + LINK_PAYLOAD_PREFIX.length));
    return;
  }

  // Привязанный сотрудник: сначала проверяем, не ждём ли от него текст по кнопке «Другое»,
  // и не даём ему случайно провалиться в клиентскую анкету «оформить заявку».
  const staffUser = await findUserByChatId(ctx.db, ctx.tenant.id, chatId);
  if (staffUser) {
    const handled = await handleStaffMessage(ctx, staffUser, chatId, text);
    if (handled) return;
  }

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
  const state = await loadConversation(ctx.tenant.id, chatId);
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

  // 1. Клиент: сначала ищем существующего по телефону (иначе каждое обращение
  //    через бота плодило бы дубликат в картотеке), создаём только если не нашли.
  let clientId = await findIndividualClientIdByPhone(ctx.db, ctx.tenant.id, state.phone);
  if (!clientId) {
    const initials = makeInitials(state.fullName);
    ({ id: clientId } = await repoCreateClient(ctx.db, ctx.tenant.id, {
      type: 'individual',
      displayName: initials,
      individualFullName: state.fullName,
      individualPhone: state.phone,
      individualAddress: state.address,
    }));
  }

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

// ───────────── Сотрудники: привязка, кнопки, «Другое» ─────────────

/** Синтетический CmdCtx для команд, вызванных из Telegram (вместо tRPC-сессии). */
function staffCmdCtx(ctx: HandlerCtx, user: LinkedStaffUser): CmdCtx {
  return {
    db: ctx.db,
    tenant: ctx.tenant,
    session: {
      tenantId: ctx.tenant.id,
      userId: user.id,
      username: user.username,
      role: user.role,
      fullName: user.fullName,
      expiresAt: Date.now() + 60_000,
    },
    audit: { ip: 'telegram', userAgent: 'telegram-bot' },
  };
}

async function handleLinkStart(ctx: HandlerCtx, chatId: number, code: string): Promise<void> {
  const payload = await consumeLinkCode(code.trim());
  if (!payload || payload.tenantId !== ctx.tenant.id) {
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text: 'Ссылка привязки устарела или неверна. Попросите новую в СРМ (профиль → Telegram).',
    });
    return;
  }
  const linked = await linkChatToUser(ctx.db, ctx.tenant.id, payload.userId, chatId);
  if (!linked) {
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text: 'Не получилось привязать: сотрудник не найден. Попросите новую ссылку в СРМ.',
    });
    return;
  }
  await writeAudit(ctx.db, ctx.tenant.id, {
    userId: payload.userId,
    action: 'update',
    entityType: 'user',
    entityId: payload.userId,
    after: { telegramLinked: true },
    ip: 'telegram',
  });
  await sendMessage(ctx.botToken, {
    chat_id: chatId,
    text:
      `Готово, ${firstName(linked.fullName)}! Теперь я буду присылать сюда план на день ` +
      'и напоминания по вашим заявкам. Отвечать можно одной кнопкой — ничего печатать не нужно.',
  });
}

/**
 * Сообщение от привязанного сотрудника. Возвращает true, если обработали
 * (дальше в клиентскую анкету не проваливаемся).
 */
async function handleStaffMessage(
  ctx: HandlerCtx,
  user: LinkedStaffUser,
  chatId: number,
  text: string,
): Promise<boolean> {
  const redis = getRedis();
  const noteKey = pendingNoteKey(ctx.tenant.id, chatId);

  // Ждём свободный текст после кнопки «Другое»? Команды pending НЕ сжигают:
  // сначала GET, удаляем только когда текст фактически использован.
  if (!text.startsWith('/')) {
    const pendingRaw = await redis.get(noteKey);
    if (pendingRaw) {
      let pending: { ticketId: string; ticketNumber: string } | null = null;
      try {
        pending = JSON.parse(pendingRaw) as { ticketId: string; ticketNumber: string };
      } catch {
        pending = null;
      }
      await redis.del(noteKey);
      if (pending) {
        try {
          await addTicketNoteCmd(staffCmdCtx(ctx, user), pending.ticketId, text.slice(0, 2000));
          await clearUnansweredCount(ctx.tenant.id, pending.ticketId);
          await sendMessage(ctx.botToken, {
            chat_id: chatId,
            text: `Записал в журнал ${pending.ticketNumber}. Спасибо!`,
          });
        } catch (err: unknown) {
          logger.warn({ err, ticketId: pending.ticketId }, 'telegram pending note failed');
          await sendMessage(ctx.botToken, {
            chat_id: chatId,
            text: 'Не получилось сохранить заметку. Откройте заявку в СРМ и добавьте комментарий там.',
          });
        }
        return true;
      }
    }
  }

  // Сотруднику клиентская анкета не нужна — короткая справка вместо неё.
  if (text === '/start' || text === '/help' || text === '/помощь') {
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text:
        `${firstName(user.fullName)}, вы привязаны как сотрудник. Я сам пришлю утренний план, ` +
        'напоминания о выездах и вопросы по застрявшим заявкам — отвечать можно кнопками под сообщением.',
    });
    return true;
  }

  // Прочий текст сотрудника НИКОГДА не проваливается в клиентскую анкету —
  // иначе бот предложит инженеру «оформить заявку» и потеряет его ответ.
  await sendMessage(ctx.botToken, {
    chat_id: chatId,
    text:
      'Я записываю текст в журнал заявки только после кнопки «Другое — отвечу текстом» ' +
      'под напоминанием. Либо ответьте кнопкой, либо откройте заявку в СРМ.',
  });
  return true;
}

async function handleCallbackQuery(
  ctx: HandlerCtx,
  cq: NonNullable<TgUpdate['callback_query']>,
): Promise<void> {
  const answer = (text: string, alert = false) =>
    answerCallbackQuery(ctx.botToken, { callback_query_id: cq.id, text, show_alert: alert });

  const chatId = cq.message?.chat.id;
  const messageId = cq.message?.message_id;
  if (!chatId || !messageId) {
    await answer('Сообщение устарело — откройте СРМ.');
    return;
  }

  // Дедуп двойного тапа/ретрая Telegram: один callback_query.id обрабатываем один раз.
  const dedup = await getRedis().set(
    `erfolg:tg-cb:${ctx.tenant.id}:${cq.id}`,
    '1',
    'EX',
    300,
    'NX',
  );
  if (dedup === null) {
    await answer('Уже обработано.');
    return;
  }

  const parsed = parseReactCallback(cq.data ?? '');
  if (!parsed) {
    await answer('Неизвестная кнопка.');
    return;
  }

  const user = await findUserByChatId(ctx.db, ctx.tenant.id, chatId);
  if (!user) {
    await answer('Чат не привязан к сотруднику. Попросите ссылку привязки в СРМ.', true);
    return;
  }

  if (parsed.action === 'other') {
    // Просим короткий текст следующим сообщением; заявку запоминаем в Redis.
    let ticketNumber = parsed.ticketId;
    try {
      const cmdCtx = staffCmdCtx(ctx, user);
      const before = await getTicketNumber(cmdCtx, parsed.ticketId);
      if (before) ticketNumber = before;
    } catch {
      // не критично — используем id
    }
    await getRedis().set(
      pendingNoteKey(ctx.tenant.id, chatId),
      JSON.stringify({ ticketId: parsed.ticketId, ticketNumber }),
      'EX',
      PENDING_NOTE_TTL_SEC,
    );
    await answer('Жду короткий ответ текстом.');
    await sendMessage(ctx.botToken, {
      chat_id: chatId,
      text: `Напишите одним сообщением, что происходит с ${ticketNumber} — я сохраню это в журнал заявки.`,
    });
    return;
  }

  try {
    const result = await engineerReactCmd(staffCmdCtx(ctx, user), parsed.ticketId, parsed.action);
    await answer('Принято');
    const original = cq.message?.text ? `${cq.message.text}\n\n` : '';
    await editMessageText(ctx.botToken, {
      chat_id: chatId,
      message_id: messageId,
      text: `${original}✅ ${result.message}`,
    });
  } catch (err: unknown) {
    // Наружу отдаём только «ожидаемые» бизнес-тексты. INTERNAL и прочее —
    // общий ответ, чтобы сырые ошибки драйвера/стека не утекали в Telegram.
    if (err instanceof TRPCError && SAFE_CALLBACK_ERROR_CODES.has(err.code)) {
      await answer(err.message, true);
      return;
    }
    logger.error({ err, ticketId: parsed.ticketId }, 'telegram callback react failed');
    await answer('Не получилось применить. Откройте заявку в СРМ.', true);
  }
}

const SAFE_CALLBACK_ERROR_CODES = new Set([
  'BAD_REQUEST',
  'FORBIDDEN',
  'NOT_FOUND',
  'PRECONDITION_FAILED',
]);

function parseReactCallback(
  data: string,
): { ticketId: string; action: EngineerReactAction | 'other' } | null {
  // Формат: r:<iw|rd|pt|ot>:<ticketId>
  const m = /^r:(iw|rd|pt|ot):([0-9a-f-]{36})$/.exec(data);
  if (!m) return null;
  const map: Record<string, EngineerReactAction | 'other'> = {
    iw: 'inwork',
    rd: 'ready',
    pt: 'part',
    ot: 'other',
  };
  const action = map[m[1] ?? ''];
  const ticketId = m[2];
  if (!action || !ticketId) return null;
  return { ticketId, action };
}

async function getTicketNumber(cmdCtx: CmdCtx, ticketId: string): Promise<string | null> {
  const { getTicket } = await import('../tickets/repository');
  const t = await getTicket(cmdCtx.db, cmdCtx.tenant.id, ticketId);
  return t?.ticketNumber ?? null;
}

function firstName(fullName: string): string {
  // «Иванов Алексей Петрович» → «Алексей»; если только одно слово — оно и есть.
  const parts = fullName.trim().split(/\s+/);
  return parts[1] ?? parts[0] ?? '';
}
