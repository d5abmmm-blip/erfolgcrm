/**
 * Фича №11 «AI-итог месяца директору».
 *
 * Короткая человекочитаемая сводка директору за календарный месяц: собирает УЖЕ готовые
 * агрегаты трёх модулей — Касса (доход/расход/прибыль + остатки), Рентабельность №12
 * (выручка/маржа по закрытым нарядам), Дебиторка №10 (сколько должны/просрочено) — в
 * детерминированный объект `data`. LLM только ФОРМУЛИРУЕТ эти цифры живым языком
 * (phraseWithLlm → text|null). Если ассистент не настроен/недоступен — text === null,
 * а data (все цифры) отдаётся всегда. Ничего не пересчитываем и не бросаем наружу.
 *
 * 152-ФЗ: в LLM уходят только агрегаты + внутренние подписи (статьи расходов, имя
 * инженера, тип техники) — БЕЗ ПДн клиентов/должников (ФИО/тел/адрес). См. renderMonthlyPrompt.
 *
 * Без миграции: своей таблицы нет, кэша LLM-текста нет (генерируем по запросу).
 */
import type { Db } from '@erfolg/db';
import type { ResolvedTenant } from '../../lib/tenant';
import { getAccountBalances, getPeriodSummary } from '../cash/repository';
import { phraseWithLlm } from '../ai-assistant/proactive';
import { profitabilityReport, receivables } from './repository';

const MONTHS_RU = [
  'Январь',
  'Февраль',
  'Март',
  'Апрель',
  'Май',
  'Июнь',
  'Июль',
  'Август',
  'Сентябрь',
  'Октябрь',
  'Ноябрь',
  'Декабрь',
];

/* ───────────────────────────── границы месяца ───────────────────────────── */

interface MonthBounds {
  /** Первый день месяца, UTC (для кассы — start включительно). */
  startDate: Date;
  /** Первый день СЛЕДУЮЩЕГО месяца, UTC (для кассы — end исключительно). */
  endExclDate: Date;
  /** 'YYYY-MM-01' — для profitability (closed_at::date >=). */
  fromIso: string;
  /** 'YYYY-MM-DD' последний день месяца — для profitability (closed_at::date <=). */
  toIso: string;
  /** 'Июль 2026'. */
  label: string;
}

const MONTH_RE = /^\d{4}-\d{2}$/;

function isValidMonth(m: string | undefined | null): m is string {
  if (!m || !MONTH_RE.test(m)) return false;
  const mo = Number(m.slice(5, 7));
  return mo >= 1 && mo <= 12;
}

/** 'YYYY-MM' текущего месяца в таймзоне организации. */
export function currentMonthInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  })
    .format(new Date())
    .slice(0, 7);
}

function monthBounds(month: string): MonthBounds {
  const y = Number(month.slice(0, 4));
  const mo = Number(month.slice(5, 7)); // 1..12
  const startDate = new Date(Date.UTC(y, mo - 1, 1));
  const endExclDate = new Date(Date.UTC(y, mo, 1)); // Date.UTC переносит mo=12 → январь след. года
  const lastDay = new Date(Date.UTC(y, mo, 0)); // день 0 след. месяца = последний день текущего
  const toIso = lastDay.toISOString().slice(0, 10);
  return {
    startDate,
    endExclDate,
    fromIso: `${month}-01`,
    toIso,
    label: `${MONTHS_RU[mo - 1]} ${y}`,
  };
}

/* ───────────────────────────── модель данных ───────────────────────────── */

export interface MonthlySummaryData {
  /** Касса за месяц. */
  cash: {
    incomeKopecks: string;
    expenseKopecks: string;
    profitKopecks: string;
    /** Крупнейшие статьи расходов за месяц (до 3). */
    topExpenses: Array<{ name: string; amountKopecks: string }>;
    /** Остаток по счетам «сейчас» (не за месяц). */
    balanceTotalKopecks: string;
    balanceCashKopecks: string;
    balanceNonCashKopecks: string;
  };
  /** Рентабельность по закрытым нарядам за месяц (по closed_at). */
  profit: {
    closedOrdersCount: number;
    revenueKopecks: string;
    costKopecks: string;
    marginKopecks: string;
    marginPercent: number | null;
    /** Инженер с наибольшей маржой (только именованный), либо null. */
    topEngineer: { name: string; marginKopecks: string } | null;
    /** Тип техники с наибольшей маржой (только именованный), либо null. */
    topEquipment: { name: string; marginKopecks: string } | null;
  };
  /** Дебиторка «сейчас» (не привязана к месяцу — текущее состояние долгов). */
  receivables: {
    totalRemainingKopecks: string;
    overdueRemainingKopecks: string;
    /** Число клиентов-должников (по неоплаченным счетам). */
    debtorCount: number;
    /** Число просроченных счетов. */
    overdueInvoiceCount: number;
  };
}

export interface MonthlySummaryResult {
  /** 'YYYY-MM'. */
  month: string;
  /** 'Июль 2026'. */
  monthLabel: string;
  /** Сформулированный LLM текст. null — показать факты (data). */
  text: string | null;
  data: MonthlySummaryData;
}

/* ───────────────────────────── сборка данных ───────────────────────────── */

/** Первый именованный (key !== null) ряд — уже отсортированы по марже убыв. */
function firstNamed(
  rows: Array<{ key: string | null; name: string; marginAmountKopecks: string }>,
): { name: string; marginKopecks: string } | null {
  const r = rows.find((x) => x.key !== null);
  return r ? { name: r.name, marginKopecks: r.marginAmountKopecks } : null;
}

/**
 * Детерминированные данные итога месяца — БЕЗ LLM. Три готовых агрегата + разбор.
 * Отдельная от buildMonthlySummary функция, чтобы тестировать цифры без вызова модели
 * (образец — buildDailySummaryData в proactive.ts).
 */
export async function buildMonthlySummaryData(
  db: Db,
  tenant: ResolvedTenant,
  monthInput?: string,
): Promise<{ month: string; monthLabel: string; data: MonthlySummaryData }> {
  const month = isValidMonth(monthInput) ? monthInput : currentMonthInTz(tenant.timezone);
  const b = monthBounds(month);

  const [cashSummary, balances, profit, recv] = await Promise.all([
    getPeriodSummary(db, tenant.id, { start: b.startDate, end: b.endExclDate }),
    getAccountBalances(db, tenant.id),
    profitabilityReport(db, tenant.id, { from: b.fromIso, to: b.toIso }),
    receivables(db, tenant.id),
  ]);

  const debtorIds = new Set(recv.items.map((i) => i.clientId ?? '—'));
  const overdueInvoiceCount = recv.items.filter(
    (i) => i.status === 'overdue' || i.overdueDays > 0,
  ).length;

  const data: MonthlySummaryData = {
    cash: {
      incomeKopecks: cashSummary.incomeKopecks,
      expenseKopecks: cashSummary.expenseKopecks,
      profitKopecks: cashSummary.profitKopecks,
      topExpenses: cashSummary.expenseByCategory
        .slice(0, 3)
        .map((c) => ({ name: c.categoryName, amountKopecks: c.amountKopecks })),
      balanceTotalKopecks: balances.totalKopecks,
      balanceCashKopecks: balances.cashKopecks,
      balanceNonCashKopecks: balances.nonCashKopecks,
    },
    profit: {
      closedOrdersCount: profit.summary.closedOrdersCount,
      revenueKopecks: profit.summary.totalAmountKopecks,
      costKopecks: profit.summary.costAmountKopecks,
      marginKopecks: profit.summary.marginAmountKopecks,
      marginPercent: profit.summary.marginPercent,
      topEngineer: firstNamed(profit.byEngineer),
      topEquipment: firstNamed(profit.byEquipment),
    },
    receivables: {
      totalRemainingKopecks: recv.totalRemainingKopecks,
      overdueRemainingKopecks: recv.overdueRemainingKopecks,
      debtorCount: recv.items.length === 0 ? 0 : debtorIds.size,
      overdueInvoiceCount,
    },
  };

  return { month, monthLabel: b.label, data };
}

/* ───────────────────────────── промпт (PII-free) ───────────────────────────── */

/** Копейки (строка) → «1 240 000 ₽», округление до целых рублей. */
function kopToRub(kop: string): string {
  let neg = false;
  let abs = kop;
  if (abs.startsWith('-')) {
    neg = true;
    abs = abs.slice(1);
  }
  let rub: string;
  try {
    rub = (BigInt(abs) / 100n).toString();
  } catch {
    return `${kop} коп.`;
  }
  const grouped = rub.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${grouped} ₽`;
}

const MONTHLY_SUMMARY_SYSTEM =
  'Ты — финансовый ассистент директора сервис-центра ремонта медтехники. По внутренним ' +
  'данным за месяц напиши директору короткий человеческий итог на русском. Формат: сначала ' +
  'абзац 2–4 предложения «что с деньгами и работой» простым деловым языком; затем 2–4 пункта ' +
  'маркированным списком «На что обратить внимание» — конкретные действия (например: напомнить ' +
  'должникам при большой просрочке; обратить внимание на крупную статью расходов; низкая маржа). ' +
  'Используй ТОЛЬКО приведённые цифры, ничего не выдумывай и не искажай суммы. Без вступления ' +
  '«вот итог» и без общего заключения — только суть.';

/**
 * Промпт из детерминированных данных. Содержит ТОЛЬКО агрегаты и внутренние подписи
 * (статьи расходов, имя инженера, тип техники) — НИКАКИХ ПДн клиентов/должников.
 * Экспортирован для юнит-теста (проверка, что ПДн не утекают в промпт).
 */
export function renderMonthlyPrompt(data: MonthlySummaryData, monthLabel: string): string {
  const lines: string[] = [];
  lines.push(`Месяц: ${monthLabel}.`);
  lines.push('');
  lines.push('Касса за месяц:');
  lines.push(`  • приход: ${kopToRub(data.cash.incomeKopecks)}`);
  lines.push(`  • расход: ${kopToRub(data.cash.expenseKopecks)}`);
  lines.push(`  • прибыль (приход − расход): ${kopToRub(data.cash.profitKopecks)}`);
  if (data.cash.topExpenses.length) {
    lines.push('  • крупнейшие статьи расходов:');
    for (const e of data.cash.topExpenses) {
      lines.push(`      – ${e.name}: ${kopToRub(e.amountKopecks)}`);
    }
  }
  lines.push(
    `  • остаток по счетам сейчас: ${kopToRub(data.cash.balanceTotalKopecks)} ` +
      `(наличные ${kopToRub(data.cash.balanceCashKopecks)}, безнал ${kopToRub(data.cash.balanceNonCashKopecks)}).`,
  );
  lines.push('');
  lines.push('Рентабельность по закрытым нарядам за месяц:');
  lines.push(`  • закрыто нарядов: ${data.profit.closedOrdersCount}`);
  lines.push(`  • выручка: ${kopToRub(data.profit.revenueKopecks)}`);
  lines.push(
    `  • маржа (прибыль по ремонтам): ${kopToRub(data.profit.marginKopecks)}` +
      (data.profit.marginPercent === null ? '' : ` (${data.profit.marginPercent}%)`),
  );
  if (data.profit.topEngineer) {
    lines.push(
      `  • больше всех заработал инженер ${data.profit.topEngineer.name}: маржа ${kopToRub(data.profit.topEngineer.marginKopecks)}`,
    );
  }
  if (data.profit.topEquipment) {
    lines.push(
      `  • самый прибыльный тип техники — ${data.profit.topEquipment.name}: маржа ${kopToRub(data.profit.topEquipment.marginKopecks)}`,
    );
  }
  lines.push('');
  lines.push('Дебиторка (текущее состояние, не за месяц):');
  // debtorCount — число должников по ВСЕМ неоплаченным счетам → ставим в строку «всего».
  // overdueInvoiceCount — только просроченные счета → в строку «просрочено». Не смешиваем
  // множества в одном предложении, иначе LLM передаст директору искажённый факт.
  lines.push(
    `  • клиенты должны всего: ${kopToRub(data.receivables.totalRemainingKopecks)} ` +
      `(должников: ${data.receivables.debtorCount}).`,
  );
  lines.push(
    `  • из них просрочено: ${kopToRub(data.receivables.overdueRemainingKopecks)} ` +
      `(просроченных счетов: ${data.receivables.overdueInvoiceCount}).`,
  );
  return lines.join('\n');
}

/**
 * Полный итог месяца: детерминированные данные всегда + LLM-формулировка (или null).
 * Никогда не бросает из-за LLM — phraseWithLlm гасит сбои внутри.
 */
export async function buildMonthlySummary(
  db: Db,
  tenant: ResolvedTenant,
  monthInput?: string,
): Promise<MonthlySummaryResult> {
  const { month, monthLabel, data } = await buildMonthlySummaryData(db, tenant, monthInput);
  const text = await phraseWithLlm(
    db,
    tenant,
    MONTHLY_SUMMARY_SYSTEM,
    renderMonthlyPrompt(data, monthLabel),
  );
  return { month, monthLabel, text, data };
}
