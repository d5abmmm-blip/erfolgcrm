/**
 * Инструменты (tools) AI-ассистента — тонкая обёртка над tRPC-процедурами.
 *
 * Каждый инструмент вызывает существующую процедуру через `appRouter.createCaller(ctx)`,
 * поэтому роль/RLS/аудит соблюдаются АВТОМАТИЧЕСКИ (ассистент действует строго от имени
 * текущего сотрудника). Никакой отдельной логики доступа здесь нет.
 *
 * READ-инструменты выполняются сразу. WRITE-инструменты ассистент только ПРЕДЛАГАЕТ —
 * фактический вызов происходит после подтверждения пользователем (см. service.ts).
 */
import { randomBytes } from 'node:crypto';
import { TRPCError } from '@trpc/server';
import { TicketPriority, TicketStatus } from '@erfolg/shared';
import type { Db } from '@erfolg/db';
import type { appRouter } from '../../trpc/router';
import type { ResolvedTenant } from '../../lib/tenant';
import type { AssistantMode, LlmFunctionTool } from './llm';
import {
  getFinanceSummary,
  getTicketsStats,
  listAgedTickets,
  type FinancePeriod,
} from './read-queries';

type Caller = ReturnType<typeof appRouter.createCaller>;

/** Роль сотрудника текущей сессии — для RBAC-гейта read-инструментов. */
export type SessionRole = 'director' | 'dispatcher' | 'engineer';

/**
 * Read-only инструменты «спроси у системы» вызывают агрегаты кассы/заявок напрямую
 * (минуя tRPC-caller), поэтому им нужен доступ к db+tenant. Передаём отдельным ctx —
 * write-инструменты его игнорируют и работают через caller, как раньше.
 *
 * role нужен потому, что эти инструменты обходят tRPC-caller (а с ним и RBAC
 * staffProcedure). Без него инженер мог бы через чат получить финансы и список
 * заявок с ПДн — те же данные гейтятся staffProcedure в обычных роутерах.
 */
export interface ToolRunCtx {
  db: Db;
  tenant: ResolvedTenant;
  role: SessionRole;
}

export type ToolKind = 'read' | 'write';

/** Роли «staff» (директор + диспетчер) — та же семантика, что у staffProcedure (trpc.ts). */
const STAFF_ROLES: SessionRole[] = ['director', 'dispatcher'];

function isStaffRole(role: SessionRole): boolean {
  return STAFF_ROLES.includes(role);
}

/**
 * Гейт для read-инструментов уровня staff (финансы / заявки с ПДн): инженеру
 * отказываем тем же механизмом и кодом, что staffProcedure (TRPCError FORBIDDEN).
 * Ошибка ловится в service.ts → модель сообщит пользователю о нехватке прав.
 */
function requireStaff(ctx: ToolRunCtx): void {
  if (!isStaffRole(ctx.role)) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'Доступ только для ролей: director, dispatcher',
    });
  }
}

interface ToolHandler {
  kind: ToolKind;
  /**
   * true — инструмент доступен только роли «staff» (director|dispatcher).
   * Жёстко проверяется в run (requireStaff) и используется для фильтрации
   * списка инструментов, отдаваемого модели (см. toolDefsForRole).
   */
  staffOnly?: boolean;
  def: LlmFunctionTool;
  run: (
    caller: Caller,
    args: Record<string, unknown>,
    ctx?: ToolRunCtx,
  ) => Promise<unknown>;
  /** Человекочитаемое описание для карточки подтверждения (только write). */
  preview?: (args: Record<string, unknown>) => string;
}

const FINANCE_PERIODS: FinancePeriod[] = [
  'today',
  'week',
  'month',
  'prev_month',
  'quarter',
  'year',
];

/** Безопасно привести аргумент period к допустимому пресету (по умолчанию month). */
function asFinancePeriod(args: Record<string, unknown>, fallback: FinancePeriod = 'month'): FinancePeriod {
  const v = args.period;
  return typeof v === 'string' && (FINANCE_PERIODS as string[]).includes(v)
    ? (v as FinancePeriod)
    : fallback;
}

/** Read-инструменты «спроси у системы» требуют db+tenant — service всегда их передаёт. */
function reqCtx(ctx?: ToolRunCtx): ToolRunCtx {
  if (!ctx) throw new Error('Внутренняя ошибка: нет контекста БД для read-инструмента');
  return ctx;
}

/* ───────────────────── helpers для разбора аргументов модели ───────────────────── */

function asString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}
function reqString(args: Record<string, unknown>, key: string): string {
  const v = asString(args, key);
  if (!v) throw new Error(`Не указан обязательный параметр «${key}»`);
  return v;
}
function asNumber(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && !Number.isNaN(Number(v))) return Number(v);
  return undefined;
}

const TICKET_STATUSES = [...TicketStatus.options];
const TICKET_PRIORITIES = [...TicketPriority.options];

/* ─────────── генерация логина/пароля для создания сотрудника ─────────── */

const TRANSLIT: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch',
  ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

function translit(s: string): string {
  return s
    .toLowerCase()
    .split('')
    .map((ch) => (ch in TRANSLIT ? TRANSLIT[ch] : ch))
    .join('')
    .replace(/[^a-z0-9._-]+/g, '');
}

/** Логин из ФИО (транслит) + короткий суффикс, гарантированно валиден (3–64, латиница). */
function makeUsername(fullName: string): string {
  const base = translit(fullName).slice(0, 40) || 'user';
  const suffix = randomBytes(2).toString('hex'); // 4 hex-символа
  const u = `${base}.${suffix}`;
  return u.length >= 3 ? u : `user.${suffix}`;
}

/** Временный пароль: читаемый, ≥8 символов, латиница+цифры. Сотрудник сменит при входе. */
function makeTempPassword(): string {
  return `Erfolg-${randomBytes(4).toString('hex')}`; // напр. Erfolg-1a2b3c4d
}

/* ───────────────────────────── реестр инструментов ───────────────────────────── */

const TOOLS: Record<string, ToolHandler> = {
  // ===================== READ (выполняются сразу) =====================
  search_clients: {
    kind: 'read',
    // PII-2: поиск клиентов — только staff (как clients.search=staffProcedure и как
    // глобальный поиск, который скрывает клиентов от инженера). Инженеру инструмент не
    // предлагается (toolDefsForRole) и жёстко блокируется в run (requireStaff).
    staffOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'search_clients',
        description:
          'Найти клиентов по названию/ФИО, ИНН или телефону. Возвращает список клиентов с их ID.',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'Строка поиска (1–100 символов)' } },
          required: ['q'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args, ctx) => {
      requireStaff(reqCtx(ctx));
      return caller.clients.search({ q: reqString(args, 'q') });
    },
  },

  list_engineers: {
    kind: 'read',
    def: {
      type: 'function',
      function: {
        name: 'list_engineers',
        description: 'Список инженеров (id + ФИО) — для назначения на заявки и планирования.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
      },
    },
    run: (caller) => caller.users.list({ onlyEngineers: true }),
  },

  search_assets: {
    kind: 'read',
    def: {
      type: 'function',
      function: {
        name: 'search_assets',
        description:
          'Найти технику/оборудование по модели, серийному или инвентарному номеру. Возвращает список с ID.',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'Строка поиска (1–100 символов)' } },
          required: ['q'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) => caller.assets.search({ q: reqString(args, 'q') }),
  },

  search_kb: {
    kind: 'read',
    def: {
      type: 'function',
      function: {
        name: 'search_kb',
        description:
          'Поиск по внутренней базе знаний (вики сервисного центра: инструкции, регламенты, «как оформить/сделать X»). Возвращает подходящие статьи (заголовок + фрагмент). Используй для вопросов «как это делается в CRM / как у нас принято».',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'Тема или ключевые слова запроса' } },
          required: ['q'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) => caller.kbArticles.list({ query: reqString(args, 'q'), limit: 5 }),
  },

  search_tickets: {
    kind: 'read',
    def: {
      type: 'function',
      function: {
        name: 'search_tickets',
        description: 'Найти заявки по номеру, клиенту или симптому. Возвращает список с ID.',
        parameters: {
          type: 'object',
          properties: { q: { type: 'string', description: 'Строка поиска (1–100 символов)' } },
          required: ['q'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) => caller.tickets.search({ q: reqString(args, 'q') }),
  },

  get_ticket: {
    kind: 'read',
    def: {
      type: 'function',
      function: {
        name: 'get_ticket',
        description: 'Получить подробности заявки по её ID (UUID): статус, клиент, техника, инженер.',
        parameters: {
          type: 'object',
          properties: { id: { type: 'string', description: 'UUID заявки' } },
          required: ['id'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) => caller.tickets.get({ id: reqString(args, 'id') }),
  },

  get_finance_summary: {
    kind: 'read',
    staffOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'get_finance_summary',
        description:
          'Сводка по деньгам (касса/ДДС) за период: сколько пришло (доход), сколько ушло (расход) и ' +
          'разница, плюс разбивка прихода по виду денег (наличные / карта / безнал) и текущие остатки по счетам. ' +
          'Используй, когда спрашивают «сколько заработали/собрали/потратили», «прибыль», «сколько в кассе» и т.п. ' +
          'period: today (сегодня), week (7 дней), month (текущий месяц), prev_month (прошлый месяц), quarter, year. По умолчанию month.',
        parameters: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: FINANCE_PERIODS,
              description: 'Период: today | week | month | prev_month | quarter | year',
            },
          },
          additionalProperties: false,
        },
      },
    },
    run: (_caller, args, ctx) => {
      const c = reqCtx(ctx);
      requireStaff(c);
      return getFinanceSummary(c.db, c.tenant, asFinancePeriod(args));
    },
  },

  list_aged_tickets: {
    kind: 'read',
    staffOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'list_aged_tickets',
        description:
          'Открытые (незакрытые) заявки без активности дольше N дней — «зависшие». Возвращает количество и ' +
          'краткий список (номер заявки, клиент, статус, сколько суток простаивает). Используй для вопросов ' +
          '«какие заявки зависли», «что давно не двигалось», «застрявшие заявки». По умолчанию порог 7 дней.',
        parameters: {
          type: 'object',
          properties: {
            days: {
              type: 'number',
              description: 'Порог простоя в днях (по умолчанию 7)',
            },
          },
          additionalProperties: false,
        },
      },
    },
    run: (_caller, args, ctx) => {
      const c = reqCtx(ctx);
      requireStaff(c);
      return listAgedTickets(c.db, c.tenant, asNumber(args, 'days') ?? 7);
    },
  },

  get_tickets_stats: {
    kind: 'read',
    staffOnly: true,
    def: {
      type: 'function',
      function: {
        name: 'get_tickets_stats',
        description:
          'Счётчики заявок по статусам за период (по дате регистрации заявки). Возвращает общее число и ' +
          'разбивку по статусам. Используй для вопросов «сколько заявок за месяц», «сколько закрыли/в работе». ' +
          'period: today | week | month | prev_month | quarter | year. По умолчанию month.',
        parameters: {
          type: 'object',
          properties: {
            period: {
              type: 'string',
              enum: FINANCE_PERIODS,
              description: 'Период: today | week | month | prev_month | quarter | year',
            },
          },
          additionalProperties: false,
        },
      },
    },
    run: (_caller, args, ctx) => {
      const c = reqCtx(ctx);
      requireStaff(c);
      return getTicketsStats(c.db, c.tenant, asFinancePeriod(args));
    },
  },

  // ===================== WRITE (требуют подтверждения) =====================
  create_ticket: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'create_ticket',
        description:
          'Создать новую заявку на ремонт/обслуживание. Обязателен clientId. Опционально: техника (assetId), симптом, приоритет, инженер.',
        parameters: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'UUID клиента (найти через search_clients)' },
            assetId: { type: 'string', description: 'UUID техники (найти через search_assets)' },
            symptom: { type: 'string', description: 'Описание неисправности / причины обращения' },
            priority: { type: 'string', enum: TICKET_PRIORITIES, description: 'Приоритет заявки' },
            assignedEngineerId: {
              type: 'string',
              description: 'UUID инженера (найти через list_engineers)',
            },
          },
          required: ['clientId'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) =>
      caller.tickets.create({
        clientId: reqString(args, 'clientId'),
        assetId: asString(args, 'assetId') ?? null,
        symptom: asString(args, 'symptom') ?? null,
        priority: asString(args, 'priority'),
        assignedEngineerId: asString(args, 'assignedEngineerId') ?? null,
      } as Parameters<Caller['tickets']['create']>[0]),
    preview: (args) =>
      [
        `Создать заявку для клиента ${asString(args, 'clientId') ?? '—'}`,
        asString(args, 'assetId') ? `Техника: ${asString(args, 'assetId')}` : null,
        asString(args, 'priority') ? `Приоритет: ${asString(args, 'priority')}` : null,
        asString(args, 'assignedEngineerId')
          ? `Инженер: ${asString(args, 'assignedEngineerId')}`
          : null,
        asString(args, 'symptom') ? `Неисправность: ${asString(args, 'symptom')}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
  },

  assign_engineer: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'assign_engineer',
        description: 'Назначить инженера на существующую заявку.',
        parameters: {
          type: 'object',
          properties: {
            ticketId: { type: 'string', description: 'UUID заявки' },
            engineerId: { type: 'string', description: 'UUID инженера' },
          },
          required: ['ticketId', 'engineerId'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) =>
      caller.tickets.update({
        id: reqString(args, 'ticketId'),
        patch: { assignedEngineerId: reqString(args, 'engineerId') },
      }),
    preview: (args) =>
      `Назначить инженера ${asString(args, 'engineerId') ?? '—'} на заявку ${
        asString(args, 'ticketId') ?? '—'
      }`,
  },

  change_ticket_status: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'change_ticket_status',
        description: 'Сменить статус заявки.',
        parameters: {
          type: 'object',
          properties: {
            ticketId: { type: 'string', description: 'UUID заявки' },
            status: { type: 'string', enum: TICKET_STATUSES, description: 'Новый статус' },
            cancelReason: {
              type: 'string',
              description: 'Причина (для статуса отмены), необязательно',
            },
          },
          required: ['ticketId', 'status'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) =>
      caller.tickets.changeStatus({
        id: reqString(args, 'ticketId'),
        status: reqString(args, 'status'),
        cancelReason: asString(args, 'cancelReason'),
      } as Parameters<Caller['tickets']['changeStatus']>[0]),
    preview: (args) =>
      `Сменить статус заявки ${asString(args, 'ticketId') ?? '—'} на «${
        asString(args, 'status') ?? '—'
      }»`,
  },

  schedule_ticket: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'schedule_ticket',
        description:
          'Запланировать заявку (выезд/работу) на инженера: время начала, опционально окончание и оценка в минутах.',
        parameters: {
          type: 'object',
          properties: {
            ticketId: { type: 'string', description: 'UUID заявки' },
            engineerId: { type: 'string', description: 'UUID инженера' },
            scheduledStartAt: {
              type: 'string',
              description: 'Дата-время начала в ISO 8601, напр. 2026-06-25T10:00:00',
            },
            scheduledEndAt: { type: 'string', description: 'Дата-время окончания (ISO 8601)' },
            estimatedMinutes: {
              type: 'number',
              description: 'Оценка длительности в минутах (15–720)',
            },
          },
          required: ['ticketId', 'engineerId', 'scheduledStartAt'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) => {
      const endRaw = asString(args, 'scheduledEndAt');
      return caller.tickets.schedule({
        ticketId: reqString(args, 'ticketId'),
        engineerId: reqString(args, 'engineerId'),
        scheduledStartAt: new Date(reqString(args, 'scheduledStartAt')),
        scheduledEndAt: endRaw ? new Date(endRaw) : undefined,
        estimatedMinutes: asNumber(args, 'estimatedMinutes'),
      });
    },
    preview: (args) =>
      `Запланировать заявку ${asString(args, 'ticketId') ?? '—'} на инженера ${
        asString(args, 'engineerId') ?? '—'
      }, начало ${asString(args, 'scheduledStartAt') ?? '—'}`,
  },

  set_asset_owner: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'set_asset_owner',
        description: 'Закрепить технику за клиентом (сменить владельца оборудования).',
        parameters: {
          type: 'object',
          properties: {
            assetId: { type: 'string', description: 'UUID техники' },
            ownerClientId: { type: 'string', description: 'UUID клиента-владельца' },
          },
          required: ['assetId', 'ownerClientId'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) =>
      caller.assets.update({
        id: reqString(args, 'assetId'),
        patch: { ownerClientId: reqString(args, 'ownerClientId') },
      }),
    preview: (args) =>
      `Закрепить технику ${asString(args, 'assetId') ?? '—'} за клиентом ${
        asString(args, 'ownerClientId') ?? '—'
      }`,
  },

  create_invoice: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'create_invoice',
        description:
          'Создать черновик счёта по заказу-наряду (workOrderId). Опционально срок оплаты в днях и примечание.',
        parameters: {
          type: 'object',
          properties: {
            workOrderId: { type: 'string', description: 'UUID заказа-наряда' },
            dueDays: { type: 'number', description: 'Срок оплаты в днях (0–365)' },
            notes: { type: 'string', description: 'Примечание к счёту' },
          },
          required: ['workOrderId'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) =>
      caller.invoices.createDraft({
        workOrderId: reqString(args, 'workOrderId'),
        dueDays: asNumber(args, 'dueDays'),
        notes: asString(args, 'notes') ?? null,
      }),
    preview: (args) =>
      `Создать счёт (черновик) по заказу-наряду ${asString(args, 'workOrderId') ?? '—'}`,
  },

  issue_invoice: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'issue_invoice',
        description: 'Выставить счёт (перевести черновик в статус «выставлен»).',
        parameters: {
          type: 'object',
          properties: {
            invoiceId: { type: 'string', description: 'UUID счёта' },
            dueDate: { type: 'string', description: 'Срок оплаты в формате ГГГГ-ММ-ДД' },
          },
          required: ['invoiceId'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) =>
      caller.invoices.issue({
        invoiceId: reqString(args, 'invoiceId'),
        dueDate: asString(args, 'dueDate'),
      }),
    preview: (args) => `Выставить счёт ${asString(args, 'invoiceId') ?? '—'}`,
  },

  create_client: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'create_client',
        description:
          'Завести нового клиента. Для организации (clientType="legal") обязательно displayName (название); ' +
          'опционально ИНН/КПП/ОГРН/адрес/телефон/email. Для физлица (clientType="individual") обязательно ' +
          'individualFullName (ФИО полностью). Данные бери из документа/реквизитов. Сначала проверь поиском, нет ли клиента.',
        parameters: {
          type: 'object',
          properties: {
            clientType: { type: 'string', enum: ['legal', 'individual'], description: 'Тип клиента' },
            displayName: { type: 'string', description: 'Название организации (для legal)' },
            inn: { type: 'string', description: 'ИНН (10 или 12 цифр)' },
            kpp: { type: 'string', description: 'КПП (9 цифр)' },
            ogrn: { type: 'string', description: 'ОГРН/ОГРНИП (13 или 15 цифр)' },
            legalAddress: { type: 'string', description: 'Юридический адрес' },
            phone: { type: 'string', description: 'Телефон организации' },
            email: { type: 'string', description: 'Email организации' },
            individualFullName: { type: 'string', description: 'ФИО полностью (для individual)' },
            individualPhone: { type: 'string', description: 'Телефон физлица' },
            individualAddress: { type: 'string', description: 'Адрес физлица' },
            notes: { type: 'string', description: 'Примечание' },
          },
          required: ['clientType'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) => {
      const type = reqString(args, 'clientType');
      if (type === 'individual') {
        return caller.clients.create({
          type: 'individual',
          individualFullName: reqString(args, 'individualFullName'),
          individualPhone: asString(args, 'individualPhone'),
          individualAddress: asString(args, 'individualAddress'),
          notes: asString(args, 'notes') ?? null,
        });
      }
      return caller.clients.create({
        type: 'legal',
        displayName: reqString(args, 'displayName'),
        inn: asString(args, 'inn') ?? null,
        kpp: asString(args, 'kpp') ?? null,
        ogrn: asString(args, 'ogrn') ?? null,
        legalAddress: asString(args, 'legalAddress') ?? null,
        phone: asString(args, 'phone') ?? null,
        email: asString(args, 'email') ?? null,
        notes: asString(args, 'notes') ?? null,
      });
    },
    preview: (args) => {
      const type = asString(args, 'clientType');
      if (type === 'individual') {
        return [
          `Завести клиента-физлицо: ${asString(args, 'individualFullName') ?? '—'}`,
          asString(args, 'individualPhone') ? `Телефон: ${asString(args, 'individualPhone')}` : null,
          asString(args, 'individualAddress') ? `Адрес: ${asString(args, 'individualAddress')}` : null,
        ]
          .filter(Boolean)
          .join('\n');
      }
      return [
        `Завести клиента-организацию: ${asString(args, 'displayName') ?? '—'}`,
        asString(args, 'inn') ? `ИНН: ${asString(args, 'inn')}` : null,
        asString(args, 'kpp') ? `КПП: ${asString(args, 'kpp')}` : null,
        asString(args, 'legalAddress') ? `Адрес: ${asString(args, 'legalAddress')}` : null,
        asString(args, 'phone') ? `Телефон: ${asString(args, 'phone')}` : null,
      ]
        .filter(Boolean)
        .join('\n');
    },
  },

  create_asset: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'create_asset',
        description:
          'Завести единицу техники/оборудования и закрепить за клиентом. Обязательны ownerClientId (UUID клиента, ' +
          'найти через search_clients) и model (модель). Опционально производитель, серийный/инвентарный номер, расположение.',
        parameters: {
          type: 'object',
          properties: {
            ownerClientId: { type: 'string', description: 'UUID клиента-владельца' },
            model: { type: 'string', description: 'Модель/наименование техники' },
            manufacturer: { type: 'string', description: 'Производитель' },
            serialNumber: { type: 'string', description: 'Серийный номер' },
            inventoryNumber: { type: 'string', description: 'Инвентарный номер' },
            location: { type: 'string', description: 'Где находится' },
            notes: { type: 'string', description: 'Примечание' },
          },
          required: ['ownerClientId', 'model'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) =>
      caller.assets.create({
        ownerClientId: reqString(args, 'ownerClientId'),
        model: reqString(args, 'model'),
        manufacturer: asString(args, 'manufacturer') ?? null,
        serialNumber: asString(args, 'serialNumber') ?? null,
        inventoryNumber: asString(args, 'inventoryNumber') ?? null,
        location: asString(args, 'location') ?? null,
        notes: asString(args, 'notes') ?? null,
      }),
    preview: (args) =>
      [
        `Завести технику: ${asString(args, 'model') ?? '—'}`,
        asString(args, 'manufacturer') ? `Производитель: ${asString(args, 'manufacturer')}` : null,
        asString(args, 'serialNumber') ? `Серийный №: ${asString(args, 'serialNumber')}` : null,
        `Владелец: ${asString(args, 'ownerClientId') ?? '—'}`,
      ]
        .filter(Boolean)
        .join('\n'),
  },

  create_contract: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'create_contract',
        description:
          'Завести договор с клиентом. Обязательны clientId (UUID, найти через search_clients), contractNumber ' +
          '(номер договора) и contractDate (дата в формате ГГГГ-ММ-ДД). Опционально тип, ставка НДС, срок действия.',
        parameters: {
          type: 'object',
          properties: {
            clientId: { type: 'string', description: 'UUID клиента' },
            contractNumber: { type: 'string', description: 'Номер договора' },
            contractDate: { type: 'string', description: 'Дата договора, ГГГГ-ММ-ДД' },
            type: { type: 'string', enum: ['service', 'one_time'], description: 'service — абонентский, one_time — разовый' },
            vatRate: { type: 'string', enum: ['0', '5', '10', '20', 'without_vat'], description: 'Ставка НДС' },
            validFrom: { type: 'string', description: 'Действует с (ГГГГ-ММ-ДД)' },
            validUntil: { type: 'string', description: 'Действует по (ГГГГ-ММ-ДД)' },
            notes: { type: 'string', description: 'Примечание' },
          },
          required: ['clientId', 'contractNumber', 'contractDate'],
          additionalProperties: false,
        },
      },
    },
    run: (caller, args) =>
      caller.contracts.create({
        clientId: reqString(args, 'clientId'),
        contractNumber: reqString(args, 'contractNumber'),
        contractDate: reqString(args, 'contractDate'),
        type: asString(args, 'type'),
        vatRate: asString(args, 'vatRate'),
        validFrom: asString(args, 'validFrom') ?? null,
        validUntil: asString(args, 'validUntil') ?? null,
        notes: asString(args, 'notes') ?? null,
      } as Parameters<Caller['contracts']['create']>[0]),
    preview: (args) =>
      [
        `Завести договор № ${asString(args, 'contractNumber') ?? '—'} от ${asString(args, 'contractDate') ?? '—'}`,
        `Клиент: ${asString(args, 'clientId') ?? '—'}`,
        asString(args, 'validUntil') ? `Действует по: ${asString(args, 'validUntil')}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
  },

  create_engineer: {
    kind: 'write',
    def: {
      type: 'function',
      function: {
        name: 'create_engineer',
        description:
          'Завести нового сотрудника (по умолчанию инженера). Обязательно fullName (ФИО). Логин и временный пароль ' +
          'генерируются автоматически и возвращаются — их надо передать сотруднику, он сменит пароль при входе. ' +
          'ВНИМАНИЕ: доступно только директору. Роль по умолчанию engineer.',
        parameters: {
          type: 'object',
          properties: {
            fullName: { type: 'string', description: 'ФИО сотрудника полностью' },
            role: {
              type: 'string',
              enum: ['engineer', 'dispatcher', 'director'],
              description: 'Роль (по умолчанию engineer)',
            },
            email: { type: 'string', description: 'Email (необязательно)' },
            phone: { type: 'string', description: 'Телефон (необязательно)' },
          },
          required: ['fullName'],
          additionalProperties: false,
        },
      },
    },
    run: async (caller, args) => {
      const fullName = reqString(args, 'fullName');
      const username = makeUsername(fullName);
      const tempPassword = makeTempPassword();
      const created = await caller.users.create({
        username,
        password: tempPassword,
        fullName,
        email: asString(args, 'email') ?? null,
        phone: asString(args, 'phone') ?? null,
        role: (asString(args, 'role') ?? 'engineer') as 'engineer' | 'dispatcher' | 'director',
      });
      // Возвращаем логин и ВРЕМЕННЫЙ пароль, чтобы ассистент сообщил их директору.
      return {
        created,
        loginInstructions: {
          username,
          tempPassword,
          note: 'Передайте сотруднику. Пароль временный — пусть сменит после первого входа.',
        },
      };
    },
    preview: (args) =>
      [
        `Завести сотрудника: ${asString(args, 'fullName') ?? '—'}`,
        `Роль: ${asString(args, 'role') ?? 'engineer'}`,
        'Логин и временный пароль сгенерируются автоматически.',
      ].join('\n'),
  },
};

/** Описания всех инструментов для передачи модели. */
export const TOOL_DEFS_FOR_LLM: LlmFunctionTool[] = Object.values(TOOLS).map((t) => t.def);

/**
 * Инструменты, доступные конкретной роли и режиму. staff-only инструменты
 * (финансы/заявки с ПДн) не отдаём инженеру вовсе. В режиме 'read_only' не отдаём
 * инструменты-изменения (kind='write') — модель их даже не предложит. Это в
 * дополнение к жёстким гейтам в run (requireStaff + серверная проверка режима).
 */
export function toolDefsForRole(
  role: SessionRole,
  mode: AssistantMode = 'full',
): LlmFunctionTool[] {
  return Object.values(TOOLS)
    .filter((t) => isStaffRole(role) || !t.staffOnly)
    .filter((t) => mode === 'full' || t.kind === 'read')
    .map((t) => t.def);
}

export function getTool(name: string): ToolHandler | undefined {
  return TOOLS[name];
}

export function isWriteTool(name: string): boolean {
  return TOOLS[name]?.kind === 'write';
}
