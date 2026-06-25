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
import { TicketPriority, TicketStatus } from '@erfolg/shared';
import type { appRouter } from '../../trpc/router';
import type { LlmFunctionTool } from './llm';

type Caller = ReturnType<typeof appRouter.createCaller>;

export type ToolKind = 'read' | 'write';

interface ToolHandler {
  kind: ToolKind;
  def: LlmFunctionTool;
  run: (caller: Caller, args: Record<string, unknown>) => Promise<unknown>;
  /** Человекочитаемое описание для карточки подтверждения (только write). */
  preview?: (args: Record<string, unknown>) => string;
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

/* ───────────────────────────── реестр инструментов ───────────────────────────── */

const TOOLS: Record<string, ToolHandler> = {
  // ===================== READ (выполняются сразу) =====================
  search_clients: {
    kind: 'read',
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
    run: (caller, args) => caller.clients.search({ q: reqString(args, 'q') }),
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
};

/** Описания всех инструментов для передачи модели. */
export const TOOL_DEFS_FOR_LLM: LlmFunctionTool[] = Object.values(TOOLS).map((t) => t.def);

export function getTool(name: string): ToolHandler | undefined {
  return TOOLS[name];
}

export function isWriteTool(name: string): boolean {
  return TOOLS[name]?.kind === 'write';
}
