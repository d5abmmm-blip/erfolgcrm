/**
 * ИИ-разбор входящего письма для фичи «Заявка из письма».
 *
 *   - extractTicketDraftFromEmail: из темы+тела письма извлекает поля черновика заявки
 *     (техника, симптом, тип ремонта, приоритет) через tool-use. Деградирует до null,
 *     если LLM не настроен/сбой — тогда сервис соберёт черновик детерминированно
 *     (клиент — по адресу отправителя, симптом — из текста письма).
 *   - draftReplyText: короткий вежливый ответ клиенту (получили обращение, оформили
 *     заявку, инженер свяжется). Деградирует до null → сервис подставит шаблон.
 *
 * 152-ФЗ: по решению владельца текст письма уходит в ИИ КАК ЕСТЬ (как ИИ-ассистент с
 * вложениями). Личность клиента при этом определяется отдельно и детерминированно — по
 * адресу отправителя (см. service.draftTicketFromEmailQuery), а не через ИИ. В UI висит
 * явная плашка-предупреждение об отправке текста в ИИ.
 */
import type { RepairType, TicketPriority } from '@erfolg/shared';
import type { Db } from '@erfolg/db';
import type { ResolvedTenant } from '../../lib/tenant';
import { logger } from '../../lib/logger';
import { callLlm, type LlmFunctionTool } from '../ai-assistant/llm';
import { loadLlmRuntimeConfig } from '../ai-assistant/config';
import { phraseWithLlm } from '../ai-assistant/proactive';

/** Допустимые значения (совпадают с enum'ами заявки) — для валидации ответа модели. */
const REPAIR_TYPES: readonly RepairType[] = ['paid', 'warranty', 'service_contract'];
const PRIORITIES: readonly TicketPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Сколько символов тела письма отдаём модели (защита от писем-простыней). */
const BODY_LIMIT = 8000;

export interface ExtractedTicketDraft {
  manufacturer: string | null;
  model: string | null;
  deviceType: string | null;
  serialNumber: string | null;
  symptom: string | null;
  repairType: RepairType | null;
  priority: TicketPriority | null;
}

/* ───────────────────────── чистые хелперы (юнит-тест) ───────────────────────── */

/** Голый e-mail из отображаемого «Имя <addr>» (или сама строка, если это уже адрес). */
export function parseEmailAddress(display: string | null | undefined): string | null {
  if (!display) return null;
  const angle = /<([^>]+)>/.exec(display);
  const candidate = (angle?.[1] ?? display).trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(candidate) ? candidate.toLowerCase() : null;
}

/** Очень простое снятие HTML → текст (для писем без plain-части). Без внешних зависимостей. */
export function stripHtmlToText(html: string | null | undefined): string {
  if (!html) return '';
  return html
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr)\s*\/?\s*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Текст письма → компактный симптом для поля заявки (фолбэк без ИИ).
 * Берём plain-часть (или снятый HTML), выкидываем процитированные строки (> …) и
 * типовые «хвосты» (подписи/цитаты), схлопываем пустоты и обрезаем.
 */
export function cleanSymptomFromBody(
  bodyText: string | null | undefined,
  bodyHtml: string | null | undefined,
  limit = 1200,
): string {
  const src = (bodyText && bodyText.trim()) || stripHtmlToText(bodyHtml);
  if (!src) return '';
  const lines: string[] = [];
  for (const raw of src.replace(/\r\n/g, '\n').split('\n')) {
    const line = raw.trim();
    if (line.startsWith('>')) continue; // цитата предыдущего письма
    // Начало процитированного блока / подписи — дальше не берём.
    if (/^(-{2,}\s*$|_{2,}\s*$|—{2,}\s*$)/.test(line)) break;
    if (/^(с уважением|best regards|regards|отправлено с)/i.test(line)) break;
    lines.push(line);
  }
  const text = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return text.length > limit ? `${text.slice(0, limit).trimEnd()}…` : text;
}

/** Человекочитаемая подсказка по технике: «УЗИ · Mindray DC-70 · сер. 3F-90212». */
export function buildDeviceHint(d: {
  deviceType?: string | null;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
}): string | null {
  const bits = [
    d.deviceType?.trim() || null,
    [d.manufacturer?.trim(), d.model?.trim()].filter(Boolean).join(' ').trim() || null,
    d.serialNumber?.trim() ? `сер. ${d.serialNumber.trim()}` : null,
  ].filter(Boolean);
  return bits.length ? bits.join(' · ') : null;
}

function cleanStr(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s ? s : null;
}

function asEnum<T extends string>(v: unknown, allowed: readonly T[]): T | null {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : null;
}

/** Достаёт первый JSON-объект из текста (на случай, если модель не вызвала tool, а ответила текстом). */
function tryParseJsonObject(text: string | null): Record<string, unknown> | null {
  if (!text) return null;
  const fenced = text.replace(/```(?:json)?/gi, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const obj = JSON.parse(fenced.slice(start, end + 1)) as unknown;
    return obj && typeof obj === 'object' ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function normalizeDraft(raw: Record<string, unknown>): ExtractedTicketDraft {
  return {
    manufacturer: cleanStr(raw.manufacturer),
    model: cleanStr(raw.model),
    deviceType: cleanStr(raw.deviceType),
    serialNumber: cleanStr(raw.serialNumber),
    symptom: cleanStr(raw.symptom),
    repairType: asEnum(raw.repairType, REPAIR_TYPES),
    priority: asEnum(raw.priority, PRIORITIES),
  };
}

/* ───────────────────────── ИИ-извлечение черновика ───────────────────────── */

const EXTRACT_SYSTEM =
  'Ты — ассистент сервис-центра ремонта медтехники. Из письма клиента извлеки данные для ' +
  'заявки на ремонт и ОБЯЗАТЕЛЬНО вызови инструмент propose_ticket_draft. Заполняй только то, ' +
  'что прямо следует из письма; ничего не выдумывай, неизвестное оставляй пустым. ' +
  'symptom — короткое описание неисправности со слов клиента (1–2 предложения, по-русски).';

const EXTRACT_TOOL: LlmFunctionTool = {
  type: 'function',
  function: {
    name: 'propose_ticket_draft',
    description: 'Черновик заявки на ремонт, извлечённый из письма клиента.',
    parameters: {
      type: 'object',
      properties: {
        manufacturer: { type: 'string', description: 'Производитель техники, если указан' },
        model: { type: 'string', description: 'Модель аппарата, если указана' },
        deviceType: {
          type: 'string',
          description: 'Тип техники: УЗИ, рентген, автоклав, отсасыватель и т.п.',
        },
        serialNumber: { type: 'string', description: 'Серийный или инвентарный номер, если есть' },
        symptom: { type: 'string', description: 'Краткое описание неисправности со слов клиента' },
        repairType: {
          type: 'string',
          enum: ['paid', 'warranty', 'service_contract'],
          description: 'Тип ремонта, если явно следует из письма (по умолчанию платный)',
        },
        priority: {
          type: 'string',
          enum: ['low', 'normal', 'high', 'urgent'],
          description: 'Срочность, если явно следует из письма',
        },
      },
      required: ['symptom'],
    },
  },
};

/**
 * Извлекает черновик заявки из письма через LLM (tool-use). Возвращает null, если LLM
 * не настроен/сбой/не смог распарсить — тогда сервис соберёт черновик детерминированно.
 */
export async function extractTicketDraftFromEmail(
  db: Db,
  tenant: ResolvedTenant,
  input: { subject: string | null; body: string },
): Promise<ExtractedTicketDraft | null> {
  let cfg;
  try {
    cfg = await loadLlmRuntimeConfig(db, tenant);
  } catch (err) {
    logger.warn({ err }, 'email-draft: loadLlmRuntimeConfig failed');
    return null;
  }
  if (!cfg) return null;

  const body = input.body.slice(0, BODY_LIMIT);
  const user = `Тема письма: ${input.subject ?? '(без темы)'}\n\nТекст письма:\n${body}`;

  try {
    const reply = await callLlm(
      [
        { role: 'system', content: EXTRACT_SYSTEM },
        { role: 'user', content: user },
      ],
      [EXTRACT_TOOL],
      cfg,
    );
    const call =
      reply.toolCalls.find((t) => t.name === 'propose_ticket_draft') ?? reply.toolCalls[0];
    let raw: Record<string, unknown> | null = null;
    if (call) {
      try {
        const parsed = JSON.parse(call.argumentsJson) as unknown;
        raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
      } catch {
        raw = null;
      }
    }
    if (!raw) raw = tryParseJsonObject(reply.content);
    if (!raw) return null;
    return normalizeDraft(raw);
  } catch (err) {
    logger.warn({ err }, 'email-draft: extract callLlm failed');
    return null;
  }
}

/* ───────────────────────── ИИ-черновик ответа клиенту ───────────────────────── */

const REPLY_SYSTEM =
  'Ты — вежливый сотрудник сервис-центра ремонта медтехники. Напиши короткий ответ клиенту ' +
  'на его письмо: поблагодари за обращение, подтверди, что заявка на ремонт оформлена, и что ' +
  'инженер проведёт диагностику и свяжется по срокам и стоимости. По-русски, на «вы», 2–4 ' +
  'коротких предложения. НЕ добавляй подпись компании — она подставляется автоматически. ' +
  'Используй только то, что есть в письме; ничего не выдумывай (номеров, сроков, цен).';

/** Шаблон-фолбэк, если ИИ недоступен (dev без LLM / сбой z.ai). Всегда даёт рабочий ответ. */
export const REPLY_FALLBACK =
  'Здравствуйте!\n\nСпасибо за обращение. Мы оформили заявку на ремонт. Наш инженер проведёт ' +
  'диагностику и свяжется с вами по срокам и стоимости ремонта.';

/**
 * Черновик ответа клиенту. Возвращает { text, aiUsed }: text всегда заполнен (шаблон,
 * если LLM недоступен), aiUsed — сформулировал ли текст ИИ.
 */
export async function draftReplyText(
  db: Db,
  tenant: ResolvedTenant,
  input: { subject: string | null; body: string },
): Promise<{ text: string; aiUsed: boolean }> {
  const body = input.body.slice(0, BODY_LIMIT);
  const user = `Тема письма клиента: ${input.subject ?? '(без темы)'}\n\nТекст письма клиента:\n${body}`;
  const text = await phraseWithLlm(db, tenant, REPLY_SYSTEM, user);
  return text ? { text, aiUsed: true } : { text: REPLY_FALLBACK, aiUsed: false };
}
