/**
 * Приём входящих писем по IMAP (Этап B).
 *
 * fetchInbox(tenantId): подключается к ящику компании (реквизиты из email_configs, пароль
 * расшифровывается), забирает новые письма (UID > сохранённого), парсит MIME (mailparser) и
 * складывает во входящие через insertEmailMessage (тема/тело/адрес шифруются). Привязывает
 * к клиенту (по e-mail отправителя) и к заявке (по номеру в теме). Состояние выборки
 * (последний UID) хранится в email_configs.
 *
 * Принудительно IPv4 — у mail.hosting.reg.ru есть AAAA, а на хостах без IPv6 это ENETUNREACH.
 */
import dns from 'node:dns';
import { ImapFlow } from 'imapflow';
import { simpleParser, type AddressObject } from 'mailparser';
import { and, eq, sql } from 'drizzle-orm';
import {
  clients,
  emailConfigs,
  emailMessages,
  getTenantEncryptionKey,
  tickets,
  withTenantTx,
  type Db,
} from '@erfolg/db';
import { decryptSql } from '@erfolg/db';
import { logger } from '../../lib/logger';
import { insertEmailMessage } from '../../lib/email-journal';
import { buildObjectKey, getObjectStorage } from '../../lib/object-storage';
import { insertEmailAttachment } from './repository';
import { computeThreadId, isSpamSubject, normalizeReferences } from './thread';

dns.setDefaultResultOrder('ipv4first');

/** На первом запуске берём не весь ящик, а последние N писем. */
const FIRST_RUN_LIMIT = 30;

/** Потолок одного вложения входящего письма — 25 МБ (защита от писем-бомб). */
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

interface ImapConnConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  lastUid: number;
}

/** Распарсенное вложение входящего письма (буфер для загрузки в object-storage). */
export interface ParsedAttachment {
  filename: string;
  content: Buffer;
  contentType: string;
  size: number;
}

export interface ParsedInbound {
  /** Отображаемый отправитель «Имя <addr>». */
  from: string | null;
  /** Голый e-mail отправителя (для привязки к клиенту). */
  fromAddress: string | null;
  to: string | null;
  subject: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  messageId: string | null;
  /** Этап C — заголовки треда. */
  inReplyTo: string | null;
  references: string | null;
  date: Date | null;
  attachmentName: string | null;
  attachmentCount: number;
  /** Этап C — реальные буферы вложений (загружаются в object-storage). */
  attachments: ParsedAttachment[];
}

export interface FetchResult {
  fetched: number;
  skipped?: string;
}

function addrText(a: AddressObject | AddressObject[] | undefined): string | null {
  if (!a) return null;
  const one = Array.isArray(a) ? a[0] : a;
  return one?.text ?? null;
}

function firstAddress(a: AddressObject | undefined): string | null {
  return a?.value?.[0]?.address ?? null;
}

/** Номер заявки из темы письма (формат T-YYYY-NNNNNN). */
export function parseTicketNumber(subject: string | null | undefined): string | null {
  if (!subject) return null;
  const m = subject.match(/\bT-\d{4}-\d{4,}\b/i);
  return m ? m[0].toUpperCase() : null;
}

async function getImapConfig(db: Db, tenantId: string, key: string): Promise<ImapConnConfig | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        enabled: emailConfigs.enabled,
        host: emailConfigs.imapHost,
        port: emailConfigs.imapPort,
        secure: emailConfigs.imapSecure,
        user: emailConfigs.imapUser,
        pass: decryptSql(emailConfigs.imapPasswordEnc, key).as('imap_pw'),
        lastUid: emailConfigs.imapLastUid,
      })
      .from(emailConfigs)
      .where(eq(emailConfigs.tenantId, tenantId))
      .limit(1);
    const r = rows[0];
    if (!r || !r.enabled || !r.host || !r.user) return null;
    const pass = (r.pass as string | null) ?? null;
    if (!pass) return null;
    return {
      host: r.host,
      port: r.port ?? 993,
      secure: r.secure,
      user: r.user,
      pass,
      lastUid: r.lastUid ?? 0,
    };
  });
}

async function setFetchState(db: Db, tenantId: string, lastUid: number): Promise<void> {
  await withTenantTx(db, tenantId, async (tx) => {
    await tx
      .update(emailConfigs)
      .set({ imapLastUid: lastUid, imapLastFetchAt: new Date() })
      .where(eq(emailConfigs.tenantId, tenantId));
  });
}

async function messageExists(db: Db, tenantId: string, messageId: string): Promise<boolean> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: emailMessages.id })
      .from(emailMessages)
      .where(eq(emailMessages.messageId, messageId))
      .limit(1);
    return rows.length > 0;
  });
}

async function findClientIdByEmail(db: Db, tenantId: string, email: string): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: clients.id })
      .from(clients)
      .where(and(eq(clients.status, 'active'), sql`lower(${clients.email}) = lower(${email})`))
      .limit(1);
    return rows[0]?.id ?? null;
  });
}

async function findTicketIdByNumber(db: Db, tenantId: string, ticketNumber: string): Promise<string | null> {
  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({ id: tickets.id })
      .from(tickets)
      .where(eq(tickets.ticketNumber, ticketNumber))
      .limit(1);
    return rows[0]?.id ?? null;
  });
}

/**
 * Сохраняет одно входящее письмо в журнал (с привязкой к клиенту/заявке).
 * Возвращает false, если письмо с таким messageId уже есть (дедуп). Тестируется напрямую.
 */
export async function storeInboundMessage(
  db: Db,
  tenantId: string,
  parsed: ParsedInbound,
): Promise<{ stored: boolean }> {
  if (parsed.messageId && (await messageExists(db, tenantId, parsed.messageId))) {
    return { stored: false };
  }
  const relatedClientId = parsed.fromAddress
    ? await findClientIdByEmail(db, tenantId, parsed.fromAddress)
    : null;
  const ticketNumber = parseTicketNumber(parsed.subject);
  const relatedTicketId = ticketNumber ? await findTicketIdByNumber(db, tenantId, ticketNumber) : null;

  const threadId = computeThreadId(parsed.inReplyTo, parsed.references, parsed.messageId);
  const isSpam = isSpamSubject(parsed.subject);

  const id = await insertEmailMessage(db, tenantId, {
    direction: 'in',
    status: 'received',
    to: parsed.to,
    from: parsed.from,
    subject: parsed.subject,
    bodyText: parsed.bodyText,
    bodyHtml: parsed.bodyHtml,
    messageId: parsed.messageId,
    inReplyTo: parsed.inReplyTo,
    references: parsed.references,
    threadId,
    isSpam,
    relatedClientId,
    relatedTicketId,
    attachmentName: parsed.attachmentName,
    attachmentKind: parsed.attachmentCount > 0 ? 'inbound' : null,
    receivedAt: parsed.date ?? new Date(),
  });

  // Вложения — в object-storage (best-effort): одно битое вложение не должно потерять
  // письмо или остальные вложения. Файл кладём в S3/local, метаданные — в email_attachments.
  if (id && parsed.attachments.length > 0) {
    const storage = getObjectStorage();
    for (const att of parsed.attachments) {
      try {
        const key = buildObjectKey({
          tenantId,
          kind: 'email_inbound',
          referenceType: 'email_message',
          referenceId: id,
          fileName: att.filename,
        });
        await storage.putBuffer(key, att.content, att.contentType);
        await insertEmailAttachment(db, tenantId, {
          messageId: id,
          objectKey: key,
          originalName: att.filename,
          mimeType: att.contentType,
          sizeBytes: att.size,
        });
      } catch (err) {
        logger.warn({ err, tenantId, filename: att.filename }, 'imap: attachment upload failed');
      }
    }
  }
  return { stored: true };
}

/** Разбор одного письма (MIME) и запись во входящие. Вынесено из цикла ради читаемости/вложенности. */
async function parseAndStore(
  db: Db,
  tenantId: string,
  source: Buffer,
  uid: number,
): Promise<boolean> {
  try {
    const p = await simpleParser(source);
    // Только вложения С именем файла (inline/cid-части без filename пропускаем).
    // Слишком большие (>25 МБ) отбрасываем, но письмо сохраняем.
    const attachments: ParsedAttachment[] = [];
    for (const a of p.attachments ?? []) {
      if (!a.filename) continue;
      const content = a.content;
      const size = a.size ?? content.length;
      if (size > MAX_ATTACHMENT_BYTES) {
        logger.warn({ uid, tenantId, filename: a.filename, size }, 'imap: attachment too large, skipped');
        continue;
      }
      attachments.push({
        filename: a.filename,
        content,
        contentType: a.contentType ?? 'application/octet-stream',
        size,
      });
    }
    const parsed: ParsedInbound = {
      from: p.from?.text ?? null,
      fromAddress: firstAddress(p.from),
      to: addrText(p.to),
      subject: p.subject ?? null,
      bodyText: p.text ?? null,
      bodyHtml: typeof p.html === 'string' ? p.html : null,
      messageId: p.messageId ?? null,
      inReplyTo: p.inReplyTo ?? null,
      references: normalizeReferences(p.references),
      date: p.date ?? null,
      attachmentName: p.attachments?.[0]?.filename ?? null,
      attachmentCount: p.attachments?.length ?? 0,
      attachments,
    };
    return (await storeInboundMessage(db, tenantId, parsed)).stored;
  } catch (err) {
    logger.warn({ err, uid, tenantId }, 'imap: parse/store failed for message');
    return false;
  }
}

/** Главная процедура приёма: коннект к IMAP, выборка новых писем, запись во входящие. */
export async function fetchInbox(db: Db, tenantId: string): Promise<FetchResult> {
  const key = getTenantEncryptionKey({ id: tenantId, kmsKeyId: null });
  const cfg = await getImapConfig(db, tenantId, key);
  if (!cfg) return { fetched: 0, skipped: 'imap-not-configured' };

  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
  });

  let fetched = 0;
  let maxUid = cfg.lastUid;

  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const exists = client.mailbox && typeof client.mailbox !== 'boolean' ? client.mailbox.exists : 0;
      if (!exists) return { fetched: 0 };

      // Первый запуск — последние N по номеру (seq); далее — только UID > сохранённого.
      const useUid = cfg.lastUid > 0;
      const range = useUid
        ? `${cfg.lastUid + 1}:*`
        : `${Math.max(1, exists - FIRST_RUN_LIMIT + 1)}:*`;

      for await (const msg of client.fetch(
        range,
        { uid: true, source: true },
        useUid ? { uid: true } : undefined,
      )) {
        // IMAP-квирк: диапазон N:* всегда возвращает последнее письмо, даже если N больше.
        if (msg.uid <= cfg.lastUid) continue;
        if (msg.uid > maxUid) maxUid = msg.uid;
        if (msg.source && (await parseAndStore(db, tenantId, msg.source, msg.uid))) fetched++;
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  if (maxUid > cfg.lastUid) await setFetchState(db, tenantId, maxUid);
  logger.info({ tenantId, fetched, maxUid }, 'imap: inbox fetched');
  return { fetched };
}
