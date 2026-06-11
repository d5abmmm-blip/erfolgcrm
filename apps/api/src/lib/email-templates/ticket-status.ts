/**
 * Email-шаблон уведомления клиента о смене статуса заявки.
 *
 * Бизнес-цель: убрать звонки «когда готово?» — клиент видит письмо при ключевых
 * переходах (received / diagnostics / estimate / in_progress / act_pending /
 * closed / cancelled). Транзитные статусы (approval) не озвучиваем, иначе письма
 * становятся шумом.
 *
 * Брендирование шапки — фирменные цвета ООО Эрфольг #29ABE2 / #F26522.
 */
import type { TicketStatus } from '@erfolg/shared';

const BRAND_PRIMARY = '#29ABE2';
const BRAND_ACCENT = '#F26522';

/** Какие статусы уведомляем клиента. См. бизнес-обоснование выше. */
const NOTIFY_STATUSES = new Set<TicketStatus>([
  'received',
  'diagnostics',
  'estimate',
  'in_progress',
  'act_pending',
  'closed',
  'cancelled',
]);

export function shouldNotifyClient(status: TicketStatus): boolean {
  return NOTIFY_STATUSES.has(status);
}

const STATUS_LABELS: Record<TicketStatus, string> = {
  received: 'Заявка принята',
  diagnostics: 'Приступили к диагностике',
  estimate: 'Готова смета — ждём согласования',
  approval: 'Согласование сметы',
  in_progress: 'Приступили к ремонту',
  act_pending: 'Готова к выдаче',
  closed: 'Заявка закрыта',
  cancelled: 'Заявка отменена',
};

export function statusLabel(status: TicketStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export interface RenderArgs {
  ticketNumber: string;
  newStatus: TicketStatus;
  clientDisplayName: string;
  assetModel: string | null;
  symptom: string | null;
  engineerFullName: string | null;
  cancelReason: string | null;
  tenantDisplayName: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildSubject(ticketNumber: string, newStatus: TicketStatus): string {
  return `Заявка №${ticketNumber} — ${statusLabel(newStatus)}`;
}

function buildPlainText(args: RenderArgs): string {
  const assetText = args.assetModel ? ` (${args.assetModel})` : '';
  const symptomLine = args.symptom ? `Диагноз/симптом: ${args.symptom}` : null;
  const engineerLine = `Назначенный инженер: ${args.engineerFullName ?? 'не назначен'}`;
  const cancelLine =
    args.newStatus === 'cancelled' && args.cancelReason
      ? `Причина отмены: ${args.cancelReason}`
      : null;
  return [
    `Здравствуйте, ${args.clientDisplayName}.`,
    ``,
    `Статус вашей заявки №${args.ticketNumber}${assetText} изменился на: ${statusLabel(args.newStatus)}.`,
    symptomLine,
    cancelLine,
    engineerLine,
    ``,
    `С уважением,`,
    args.tenantDisplayName,
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
}

function buildHtml(args: RenderArgs): string {
  const ticket = escapeHtml(args.ticketNumber);
  const client = escapeHtml(args.clientDisplayName);
  const status = escapeHtml(statusLabel(args.newStatus));
  const asset = args.assetModel ? escapeHtml(args.assetModel) : null;
  const symptom = args.symptom ? escapeHtml(args.symptom) : null;
  const engineer = args.engineerFullName ? escapeHtml(args.engineerFullName) : 'не назначен';
  const tenant = escapeHtml(args.tenantDisplayName);
  const cancelReason =
    args.newStatus === 'cancelled' && args.cancelReason ? escapeHtml(args.cancelReason) : null;

  const symptomBlock = symptom
    ? `<p style="margin:8px 0 0;color:#374151"><strong>Диагноз/симптом:</strong> ${symptom}</p>`
    : '';
  const cancelBlock = cancelReason
    ? `<p style="margin:8px 0 0;color:#b91c1c"><strong>Причина отмены:</strong> ${cancelReason}</p>`
    : '';
  const assetBlock = asset
    ? `<p style="margin:0 0 4px;color:#6b7280;font-size:13px">${asset}</p>`
    : '';

  return [
    `<!doctype html><html lang="ru"><body style="margin:0;background:#f3f4f6;font-family:Arial,Helvetica,sans-serif;color:#111827">`,
    `<div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">`,
    `<div style="background:${BRAND_PRIMARY};padding:16px 20px;color:#ffffff">`,
    `<div style="font-size:14px;letter-spacing:0.5px;opacity:0.85">${tenant}</div>`,
    `<div style="font-size:18px;font-weight:600;margin-top:2px">Заявка №${ticket}</div>`,
    `</div>`,
    `<div style="padding:20px">`,
    `<p style="margin:0 0 12px">Здравствуйте, ${client}.</p>`,
    assetBlock,
    `<p style="margin:0 0 8px">Статус вашей заявки изменился:</p>`,
    `<div style="display:inline-block;padding:8px 14px;background:${BRAND_ACCENT};color:#ffffff;border-radius:4px;font-weight:600">${status}</div>`,
    symptomBlock,
    cancelBlock,
    `<p style="margin:16px 0 0;color:#374151"><strong>Назначенный инженер:</strong> ${engineer}</p>`,
    `</div>`,
    `<div style="border-top:1px solid #e5e7eb;padding:12px 20px;color:#6b7280;font-size:12px">`,
    `С уважением,<br/>${tenant}`,
    `</div></div></body></html>`,
  ].join('');
}

export function renderTicketStatusEmail(args: RenderArgs): RenderedEmail {
  return {
    subject: buildSubject(args.ticketNumber, args.newStatus),
    text: buildPlainText(args),
    html: buildHtml(args),
  };
}
