/**
 * Service для repair_archive (AI-диагностика по симптому).
 *
 *   - searchArchiveQuery: список похожих прошлых ремонтов. Принимает ticketId
 *     (сервер сам достанет симптом + модель) ИЛИ прямые symptom/model (для живой
 *     подсказки в форме новой заявки).
 *   - summarizeArchiveQuery: короткое ИИ-резюме «что обычно помогало» поверх
 *     найденных ремонтов. Деградирует до text:null, если LLM не настроен/сбой.
 *
 * 152-ФЗ: в LLM уходит ТОЛЬКО техника — симптом, что нашли, что делали, модель, год.
 * В самом справочнике repair_archive персональных данных клиента нет по построению
 * (см. schema/repair-archive.ts и import-repair-archive.ts).
 */
import { eq } from 'drizzle-orm';
import { assets, tickets, withTenantTx } from '@erfolg/db';
import { phraseWithLlm } from '../ai-assistant/proactive';
import { searchArchiveBySymptom, type RepairArchiveMatch } from './repository';
import type { CmdCtx } from '../../trpc/helpers';

const DEFAULT_LIMIT = 6;
const MAX_LIMIT = 20;
const SUMMARY_LIMIT = 6;

export interface ArchiveSearchInput {
  ticketId?: string;
  symptom?: string;
  model?: string;
  limit?: number;
}

/** Достать симптом и модель: из явных полей ввода или из заявки по ticketId. */
async function resolveSymptomAndModel(
  ctx: CmdCtx,
  input: ArchiveSearchInput,
): Promise<{ symptom: string; model: string }> {
  let symptom = (input.symptom ?? '').trim();
  let model = (input.model ?? '').trim();

  if (input.ticketId) {
    const [t] = await withTenantTx(ctx.db, ctx.tenant.id, (tx) =>
      tx
        .select({ symptom: tickets.symptom, assetId: tickets.assetId })
        .from(tickets)
        .where(eq(tickets.id, input.ticketId!))
        .limit(1),
    );
    if (t) {
      if (!symptom && t.symptom) symptom = t.symptom;
      if (!model && t.assetId) {
        const [a] = await withTenantTx(ctx.db, ctx.tenant.id, (tx) =>
          tx.select({ model: assets.model }).from(assets).where(eq(assets.id, t.assetId!)).limit(1),
        );
        if (a?.model) model = a.model;
      }
    }
  }

  return { symptom, model };
}

export async function searchArchiveQuery(
  ctx: CmdCtx,
  input: ArchiveSearchInput,
): Promise<RepairArchiveMatch[]> {
  const limit = Math.min(Math.max(input.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
  const { symptom, model } = await resolveSymptomAndModel(ctx, input);
  if (!symptom && !model) return [];
  return searchArchiveBySymptom(ctx.db, ctx.tenant.id, { symptom, model, limit });
}

export interface ArchiveSummaryResult {
  /** Сформулированный LLM текст. null — LLM не настроен/сбой/нет данных. */
  text: string | null;
  /** По скольким прошлым ремонтам построено резюме (для подписи в UI). */
  basedOn: number;
}

const SUMMARY_SYSTEM =
  'Ты — ассистент сервис-центра ремонта медтехники. Ниже — несколько похожих прошлых ремонтов из архива. ' +
  'Дай инженеру короткое резюме на русском: какая типовая причина и что чаще всего помогало. ' +
  '2–4 коротких предложения, простым языком. Используй ТОЛЬКО данные ниже, ничего не выдумывай. ' +
  'Без вступления и заключения.';

function renderSummaryPrompt(
  symptom: string,
  model: string,
  matches: RepairArchiveMatch[],
): string {
  const lines: string[] = [];
  lines.push(`Текущий симптом: ${symptom || '—'}${model ? `; техника: ${model}` : ''}.`);
  lines.push('Похожие прошлые ремонты:');
  for (const m of matches) {
    const bits = [
      m.symptom ? `симптом: ${m.symptom}` : null,
      m.diagnosis ? `нашли: ${m.diagnosis}` : null,
      m.worksSummary ? `делали: ${m.worksSummary}` : null,
      m.deviceModel
        ? `(${m.deviceModel}${m.year ? `, ${m.year}` : ''})`
        : m.year
          ? `(${m.year})`
          : null,
    ].filter(Boolean);
    lines.push(`  • ${bits.join('. ')}`);
  }
  return lines.join('\n');
}

export async function summarizeArchiveQuery(
  ctx: CmdCtx,
  input: ArchiveSearchInput,
): Promise<ArchiveSummaryResult> {
  const { symptom, model } = await resolveSymptomAndModel(ctx, input);
  if (!symptom && !model) return { text: null, basedOn: 0 };
  const matches = await searchArchiveBySymptom(ctx.db, ctx.tenant.id, {
    symptom,
    model,
    limit: SUMMARY_LIMIT,
  });
  if (matches.length === 0) return { text: null, basedOn: 0 };
  const text = await phraseWithLlm(
    ctx.db,
    ctx.tenant,
    SUMMARY_SYSTEM,
    renderSummaryPrompt(symptom, model, matches),
  );
  return { text, basedOn: matches.length };
}

export type { RepairArchiveMatch } from './repository';
