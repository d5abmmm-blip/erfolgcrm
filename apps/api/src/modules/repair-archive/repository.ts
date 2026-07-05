/**
 * Repository для repair_archive — поиск похожих прошлых ремонтов по симптому.
 *
 * Все запросы — через withTenantTx (RLS: видим только свой tenant).
 *
 * Алгоритм поиска (без внешнего AI, локальный полнотекст):
 *   1. Симптом текущей заявки разбиваем на значимые слова (ключевые слова).
 *   2. Модель техники разбиваем на токены.
 *   3. Считаем score строки архива = (сколько ключевых слов симптома в ней встретилось)
 *      + бонус, если совпала модель. Показываем самые релевантные.
 *
 * Русский текст: ILIKE с ЯВНОЙ COLLATE "ru-x-icu". В C-локали обычный lower() не
 * сворачивает регистр кириллицы, а pg_trgm возвращает 0 — поэтому только ICU-путь
 * (см. kb-articles/repository.ts). Ключевые слова уже в нижнем регистре (JS toLowerCase
 * с кириллицей работает корректно), поэтому обе стороны сравнения — нижний регистр.
 */
import { asc, desc, sql, type SQL } from 'drizzle-orm';
import { repairArchive, withTenantTx, type Db } from '@erfolg/db';

export type ArchiveMatchReason = 'symptom' | 'model' | 'symptom_model';

export interface RepairArchiveMatch {
  id: string;
  sourceRef: string;
  deviceModel: string | null;
  manufacturer: string | null;
  deviceType: string | null;
  symptom: string | null;
  diagnosis: string | null;
  worksSummary: string | null;
  year: number | null;
  /** Внутренний вес совпадения (для сортировки; наружу не важен). */
  score: number;
  matchReason: ArchiveMatchReason;
}

export interface ArchiveSearchOpts {
  symptom?: string | null;
  model?: string | null;
  limit: number;
}

/**
 * Генерик-слова, которые встречаются почти в каждом ремонте и не помогают отличить
 * похожий случай (шум). Слова < 3 символов (не, на, по, из, с, и…) отсекаются длиной.
 */
const STOPWORDS = new Set<string>([
  'для', 'что', 'как', 'это', 'или', 'при', 'нет', 'все', 'всё', 'его', 'так',
  'там', 'где', 'над', 'под', 'без', 'был', 'была', 'было', 'были', 'есть',
  'если', 'чтобы', 'после', 'время', 'нужно', 'надо', 'очень', 'один', 'одна',
  'работает', 'работал', 'работала', 'работают', 'работе', 'работу', 'работа',
  'ремонт', 'ремонта', 'ремонте', 'аппарат', 'аппарата', 'прибор', 'прибора',
]);

/** Разбить текст на значимые слова/токены (нижний регистр, дедуп, лимит). */
function tokenize(text: string, minLen: number, max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    const w = raw.trim();
    if (w.length < minLen) continue;
    if (STOPWORDS.has(w)) continue;
    if (seen.has(w)) continue;
    seen.add(w);
    out.push(w);
    if (out.length >= max) break;
  }
  return out;
}

const MODEL_BOOST = 2;

/**
 * Найти похожие прошлые ремонты по симптому (+ модель, если известна).
 * Пустой ввод (нет ни ключевых слов, ни токенов модели) → пустой результат.
 */
export async function searchArchiveBySymptom(
  db: Db,
  tenantId: string,
  opts: ArchiveSearchOpts,
): Promise<RepairArchiveMatch[]> {
  const symptomKeywords = tokenize(opts.symptom ?? '', 3, 8);
  const modelTokens = tokenize(opts.model ?? '', 3, 5);
  if (symptomKeywords.length === 0 && modelTokens.length === 0) return [];

  // Стог текста для симптома: симптом + диагноз + описание работ.
  const textHay = sql`lower((coalesce(${repairArchive.symptom}, '') || ' ' || coalesce(${repairArchive.diagnosis}, '') || ' ' || coalesce(${repairArchive.worksSummary}, '')) COLLATE "ru-x-icu")`;
  const modelHay = sql`lower(coalesce(${repairArchive.deviceModel}, '') COLLATE "ru-x-icu")`;

  const scoreTerms = symptomKeywords.map(
    (kw) => sql`(CASE WHEN ${textHay} LIKE ${'%' + kw + '%'} THEN 1 ELSE 0 END)`,
  );
  const symptomScore: SQL = scoreTerms.length ? sql.join(scoreTerms, sql` + `) : sql`0`;

  let modelMatch: SQL | null = null;
  if (modelTokens.length) {
    const ors = modelTokens.map((tok) => sql`${modelHay} LIKE ${'%' + tok + '%'}`);
    modelMatch = sql.join(ors, sql` OR `);
  }

  const scoreExpr: SQL<number> = modelMatch
    ? sql<number>`((${symptomScore}) + (CASE WHEN (${modelMatch}) THEN ${MODEL_BOOST} ELSE 0 END))`
    : sql<number>`(${symptomScore})`;

  const reasonExpr: SQL<string> = modelMatch
    ? sql<string>`(CASE WHEN (${symptomScore}) > 0 AND (${modelMatch}) THEN 'symptom_model' WHEN (${symptomScore}) > 0 THEN 'symptom' ELSE 'model' END)`
    : sql<string>`'symptom'`;

  const matchCond: SQL = modelMatch
    ? sql`((${symptomScore}) > 0 OR (${modelMatch}))`
    : sql`(${symptomScore}) > 0`;

  return withTenantTx(db, tenantId, async (tx) => {
    const rows = await tx
      .select({
        id: repairArchive.id,
        sourceRef: repairArchive.sourceRef,
        deviceModel: repairArchive.deviceModel,
        manufacturer: repairArchive.manufacturer,
        deviceType: repairArchive.deviceType,
        symptom: repairArchive.symptom,
        diagnosis: repairArchive.diagnosis,
        worksSummary: repairArchive.worksSummary,
        year: repairArchive.year,
        score: scoreExpr,
        reason: reasonExpr,
      })
      .from(repairArchive)
      .where(matchCond)
      .orderBy(desc(scoreExpr), sql`${repairArchive.year} DESC NULLS LAST`, asc(repairArchive.id))
      .limit(opts.limit);

    return rows.map((r) => ({
      id: r.id,
      sourceRef: r.sourceRef,
      deviceModel: r.deviceModel,
      manufacturer: r.manufacturer,
      deviceType: r.deviceType,
      symptom: r.symptom,
      diagnosis: r.diagnosis,
      worksSummary: r.worksSummary,
      year: r.year,
      score: Number(r.score),
      matchReason: (r.reason as ArchiveMatchReason) ?? 'symptom',
    }));
  });
}
