/**
 * У заявки на экранах ОДИН срок — тот, который поставил человек.
 *
 * ЧТО БЫЛО. Сроков два, и оба показывались людям:
 *   • `deadline_at` — ручной, его ставит менеджер при приёме. По нему живут
 *     календарь, карточка сотрудника и мобильная очередь инженера;
 *   • `sla_target_at` — автоматический, считается от приоритета. По нему жили
 *     колонка «SLA» в списке заявок и подпись на карточке заявки.
 * Человек видел два разных «срока» по одной и той же заявке и не знал, какой
 * настоящий. Мобильная очередь и вовсе показывала то один, то другой —
 * `deadlineAt ?? slaTargetAt`, — то есть подпись меняла смысл от заявки к заявке.
 *
 * РЕШЕНИЕ ВЛАДЕЛЬЦА 2026-08-17: на экранах остаётся ручной срок. Автоматический
 * норматив живёт ТОЛЬКО в отчёте SLA — как мера качества работы, а не как
 * обещание клиенту. Ни одна цифра в самом отчёте от этого не меняется.
 *
 * Ниже — сторожа по исходнику: страницы тянут по десятку процедур, и
 * компонентные тесты здесь были бы дороже и хрупче самой проверки.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => readFileSync(resolve(here, p), 'utf8');

describe('на рабочих экранах показывается ручной срок', () => {
  it('в списке заявок колонка срока берёт deadlineAt', () => {
    const src = read('../pages/TicketsListPage.tsx');
    expect(src).toMatch(/deadline=\{t\.deadlineAt\}|target=\{t\.deadlineAt\}/);
    expect(src).not.toMatch(/target=\{t\.slaTargetAt\}/);
  });

  it('в карточке заявки подпись срока берёт deadlineAt', () => {
    const src = read('../pages/TicketCardPage.tsx');
    expect(src).not.toMatch(/SlaInline target=\{t\.slaTargetAt\}/);
    expect(src).toMatch(/DeadlineInline deadline=\{t\.deadlineAt\}/);
  });

  it('в мобильной очереди подпись больше не подменяется нормативом', () => {
    const src = read('../pages/mobile/MobileQueuePage.tsx');
    expect(src).not.toMatch(/t\.deadlineAt \?\? t\.slaTargetAt/);
    expect(src).not.toMatch(/t\.slaTargetAt \|\| t\.deadlineAt/);
  });

  it('слово SLA ушло из ПОДПИСЕЙ на рабочих экранах — оно осталось отчёту', () => {
    // Проверяем именно то, что видит человек: заголовок колонки и текст бейджа.
    // В комментариях слово остаётся — там объясняется, куда норматив делся.
    expect(read('../pages/TicketsListPage.tsx')).not.toMatch(/label: 'SLA'/);
    expect(read('../pages/TicketCardPage.tsx')).not.toMatch(/SLA просрочено|SLA через/);
  });
});

describe('отчёт SLA не тронут', () => {
  it('по-прежнему считает норматив — это мера качества работы', () => {
    const src = read('../pages/ReportsPage.tsx');
    expect(src).toMatch(/sla/i);
  });
});
