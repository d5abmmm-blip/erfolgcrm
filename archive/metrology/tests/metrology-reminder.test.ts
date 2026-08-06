/**
 * Stage 10'.G — тесты воркера metrology-reminder.
 *
 * Сценарии:
 *   1. Тенант с overdue + soon → диспетчер получает email с обоими блоками,
 *      письмо помечается в metrology_reminder_log.
 *   2. Повторный tick в тот же день → ничего не отправляется (анти-спам).
 *   3. Тенант без СИ → ноль писем без ошибок.
 *
 * sendMail замокан через __setTransporterForTesting.
 *
 * Изоляция: тест создаёт собственного диспетчера TEST10G-* с email,
 * чтобы не зависеть от параллельных users-crud тестов, которые могут
 * блокировать/менять seed-пользователей.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, like, or } from 'drizzle-orm';
import {
  assets,
  getDb,
  metrologyCalibrations,
  metrologyReminderLog,
  metrologySiDetails,
  users,
  withTenantTx,
} from '@erfolg/db';
import { ensureSeed } from './setup';
import { upsertSiDetails } from '../modules/metrology/repository';
import { __setTransporterForTesting } from '../lib/mailer';
import { processMetrologyReminderTickForTenant } from '../workers/metrology-reminder';

const USERNAME_PREFIX = 'test10g-';
const TYPE_PREFIX = 'TEST10G-';

let erfolgId = '';
let demoId = '';
const erfolgAssetIds: string[] = [];
let testRecipientEmail = '';
const savedStaffEmails = new Map<string, string>(); // userId → original email (для restore)

interface SentMail {
  to: string;
  subject: string;
  text: string;
  html: string;
}
const sent: SentMail[] = [];

const ONE_DAY = 24 * 60 * 60 * 1000;
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function todayIso(): string {
  return isoDate(new Date());
}
function isoOffset(days: number): string {
  return isoDate(new Date(Date.now() + days * ONE_DAY));
}

beforeAll(async () => {
  const seed = await ensureSeed();
  erfolgId = seed.erfolgId;
  demoId = seed.demoId;

  const rows = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx.select({ id: assets.id }).from(assets).limit(3),
  );
  for (const r of rows) erfolgAssetIds.push(r.id);
  if (erfolgAssetIds.length < 2) {
    throw new Error('seed missing assets for metrology-reminder tests');
  }

  // Создаём собственного диспетчера для теста — так не зависим от seed-пользователей,
  // которые могут параллельно меняться users-crud.test.ts.
  // Хеш пароля произвольный, мы не логинимся — нужен только row для FK на reminder_log.
  const uniqSuffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  testRecipientEmail = `${USERNAME_PREFIX}${uniqSuffix}@test10g.local`;
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.insert(users).values({
      tenantId: erfolgId,
      username: `${USERNAME_PREFIX}${uniqSuffix}`,
      email: testRecipientEmail,
      passwordHash: '$argon2id$v=19$m=65536,t=3,p=4$dGVzdA$dGVzdA',
      fullName: 'Тестовый диспетчер 10G',
      role: 'dispatcher',
      isActive: true,
    });
  });

  // Снимаем email у других активных директоров/диспетчеров на время теста,
  // чтобы они не получали письма и не делали тесты непредсказуемыми.
  // Сохраняем оригинальные значения для restore в afterAll.
  const staff = await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .select({ id: users.id, email: users.email, role: users.role })
      .from(users)
      .where(
        and(eq(users.isActive, true), or(eq(users.role, 'director'), eq(users.role, 'dispatcher'))),
      ),
  );
  for (const u of staff) {
    if (u.email === testRecipientEmail) continue;
    if (u.email !== null) {
      savedStaffEmails.set(u.id, u.email);
      await withTenantTx(getDb(), erfolgId, (tx) =>
        tx.update(users).set({ email: null }).where(eq(users.id, u.id)),
      );
    }
  }

  // Мокаем nodemailer transporter.
  __setTransporterForTesting({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sendMail: vi.fn(async (opts: any) => {
      sent.push({
        to: opts.to,
        subject: opts.subject,
        text: opts.text ?? '',
        html: opts.html ?? '',
      });
      return { messageId: `mock-${Date.now()}-${sent.length}` };
    }),
    close: () => undefined,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
});

afterAll(async () => {
  __setTransporterForTesting(null);
  // Восстанавливаем оригинальные email seed-пользователей.
  for (const [userId, originalEmail] of savedStaffEmails.entries()) {
    await withTenantTx(getDb(), erfolgId, (tx) =>
      tx.update(users).set({ email: originalEmail }).where(eq(users.id, userId)),
    );
  }
  // Удаляем тестового диспетчера и связанные с ним записи лога.
  await withTenantTx(getDb(), erfolgId, async (tx) => {
    await tx.delete(metrologyReminderLog).where(eq(metrologyReminderLog.sentOn, todayIso()));
    await tx.delete(users).where(like(users.username, `${USERNAME_PREFIX}%`));
  });
});

async function clearTestData(): Promise<void> {
  sent.length = 0;
  for (const tid of [erfolgId, demoId]) {
    await withTenantTx(getDb(), tid, async (tx) => {
      await tx
        .delete(metrologyCalibrations)
        .where(like(metrologyCalibrations.notes, `${TYPE_PREFIX}%`));
      await tx
        .delete(metrologySiDetails)
        .where(like(metrologySiDetails.typeName, `${TYPE_PREFIX}%`));
      // Сброс лога напоминаний на сегодня (мы в той же дате — иначе анти-спам всё заблокирует).
      await tx.delete(metrologyReminderLog).where(eq(metrologyReminderLog.sentOn, todayIso()));
      // Сброс requires_metrology у тестовых ассетов.
      for (const aid of erfolgAssetIds) {
        await tx.update(assets).set({ requiresMetrology: false }).where(eq(assets.id, aid));
      }
    });
  }
}

beforeEach(clearTestData);

async function setupSi(label: string, nextDateIso: string): Promise<string> {
  const aid = erfolgAssetIds.shift();
  if (!aid) throw new Error('out of test assets');
  erfolgAssetIds.push(aid);
  await upsertSiDetails(getDb(), erfolgId, aid, {
    typeName: `${TYPE_PREFIX}${label}`,
    calibrationIntervalMonths: 12,
  });
  await withTenantTx(getDb(), erfolgId, (tx) =>
    tx
      .update(metrologySiDetails)
      .set({ nextCalibrationAt: nextDateIso, lastCalibrationAt: isoOffset(-300) })
      .where(eq(metrologySiDetails.assetId, aid)),
  );
  return aid;
}

describe('metrology-reminder worker (10.G)', () => {
  it('генерирует письмо для директора с overdue + soon', async () => {
    await setupSi('OverDue', isoOffset(-2));
    await setupSi('Soon7', isoOffset(7));

    const stats = await processMetrologyReminderTickForTenant(erfolgId);

    expect(stats.overdue.length).toBeGreaterThanOrEqual(1);
    expect(stats.for7.length).toBeGreaterThanOrEqual(1);
    expect(stats.emailsSent).toBeGreaterThanOrEqual(1);
    // Минимум одно письмо нашему тестовому диспетчеру с обоими блоками.
    const mail = sent.find(
      (m) =>
        m.to === testRecipientEmail && m.text.includes('Просрочены') && m.text.includes('7 дней'),
    );
    expect(mail).toBeDefined();
    expect(mail!.subject).toMatch(/Метрология/);
    // Лог напоминаний должен иметь хотя бы одну запись на сегодня.
    const logRows = await withTenantTx(getDb(), erfolgId, (tx) =>
      tx
        .select({ id: metrologyReminderLog.id })
        .from(metrologyReminderLog)
        .where(
          and(
            eq(metrologyReminderLog.sentOn, todayIso()),
            eq(metrologyReminderLog.channel, 'email'),
          ),
        ),
    );
    expect(logRows.length).toBeGreaterThanOrEqual(1);
  });

  it('повторный тик в тот же день не дублирует email', async () => {
    await setupSi('Repeat', isoOffset(-1));

    const first = await processMetrologyReminderTickForTenant(erfolgId);
    expect(first.emailsSent).toBeGreaterThanOrEqual(1);
    const sentAfterFirst = sent.length;

    sent.length = 0;
    const second = await processMetrologyReminderTickForTenant(erfolgId);
    // Все получатели уже отмечены — emailsSent=0, emailsSkipped>=1.
    expect(second.emailsSent).toBe(0);
    expect(second.emailsSkipped).toBeGreaterThanOrEqual(1);
    expect(sent.length).toBe(0);
    // Sanity: первый тик что-то отправил.
    expect(sentAfterFirst).toBeGreaterThanOrEqual(1);
  });

  it('тенант без СИ — пусто без ошибок', async () => {
    // Не создаём ни одного СИ.
    const stats = await processMetrologyReminderTickForTenant(erfolgId);
    expect(stats.overdue.length).toBe(0);
    expect(stats.for7.length).toBe(0);
    expect(stats.for14.length).toBe(0);
    expect(stats.for30.length).toBe(0);
    expect(stats.emailsSent).toBe(0);
    expect(sent.length).toBe(0);
  });
});
