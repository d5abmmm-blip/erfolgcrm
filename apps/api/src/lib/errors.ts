/**
 * Типизированные доменные ошибки.
 *
 * Идея: repositories/services бросают конкретные DomainError-подклассы
 * (никаких `throw new Error('not found')` со строковым match по message).
 * Service-слой / роутеры в catch ловят базовый DomainError и через `toTRPCError`
 * получают TRPCError с правильным кодом.
 *
 * Используется во всех hot-path: invoices, work-orders, payments, tickets, inventory.
 */
import { TRPCError } from '@trpc/server';

export type TrpcErrorCode =
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'BAD_REQUEST'
  | 'FORBIDDEN'
  | 'PRECONDITION_FAILED'
  | 'UNPROCESSABLE_CONTENT';

export class DomainError extends Error {
  readonly code: string;
  readonly trpcCode: TrpcErrorCode;
  constructor(code: string, trpcCode: TrpcErrorCode, message: string) {
    super(message);
    this.name = 'DomainError';
    this.code = code;
    this.trpcCode = trpcCode;
    // Поддержка instanceof в transpiled ES5/ES2015 цепочке
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WorkOrderNotFoundError extends DomainError {
  constructor(message = 'Наряд не найден') {
    super('WORK_ORDER_NOT_FOUND', 'NOT_FOUND', message);
    this.name = 'WorkOrderNotFoundError';
    Object.setPrototypeOf(this, WorkOrderNotFoundError.prototype);
  }
}

export class InvoiceNotFoundError extends DomainError {
  constructor(message = 'Счёт не найден') {
    super('INVOICE_NOT_FOUND', 'NOT_FOUND', message);
    this.name = 'InvoiceNotFoundError';
    Object.setPrototypeOf(this, InvoiceNotFoundError.prototype);
  }
}

export class InvoiceWrongStatusError extends DomainError {
  readonly currentStatus: string;
  readonly expectedStatuses: readonly string[];
  constructor(currentStatus: string, expectedStatuses: readonly string[], message?: string) {
    super(
      'INVOICE_WRONG_STATUS',
      'CONFLICT',
      message ??
        `Счёт в статусе "${currentStatus}", ожидался один из [${expectedStatuses.join(', ')}]`,
    );
    this.name = 'InvoiceWrongStatusError';
    this.currentStatus = currentStatus;
    this.expectedStatuses = expectedStatuses;
    Object.setPrototypeOf(this, InvoiceWrongStatusError.prototype);
  }
}

export class ClientNotFoundError extends DomainError {
  constructor(message = 'Клиент не найден') {
    super('CLIENT_NOT_FOUND', 'NOT_FOUND', message);
    this.name = 'ClientNotFoundError';
    Object.setPrototypeOf(this, ClientNotFoundError.prototype);
  }
}

export class TicketNotFoundError extends DomainError {
  constructor(message = 'Заявка не найдена') {
    super('TICKET_NOT_FOUND', 'NOT_FOUND', message);
    this.name = 'TicketNotFoundError';
    Object.setPrototypeOf(this, TicketNotFoundError.prototype);
  }
}

export class TicketTemplateNotFoundError extends DomainError {
  constructor(message = 'Шаблон заявки не найден') {
    super('TICKET_TEMPLATE_NOT_FOUND', 'NOT_FOUND', message);
    this.name = 'TicketTemplateNotFoundError';
    Object.setPrototypeOf(this, TicketTemplateNotFoundError.prototype);
  }
}

export class TicketTemplateArchivedError extends DomainError {
  constructor(message = 'Шаблон архивирован — нельзя применить к новой заявке') {
    super('TICKET_TEMPLATE_ARCHIVED', 'CONFLICT', message);
    this.name = 'TicketTemplateArchivedError';
    Object.setPrototypeOf(this, TicketTemplateArchivedError.prototype);
  }
}

export class TicketTemplateNameConflictError extends DomainError {
  constructor(name: string, message?: string) {
    super(
      'TICKET_TEMPLATE_NAME_CONFLICT',
      'CONFLICT',
      message ?? `Активный шаблон с именем «${name}» уже существует`,
    );
    this.name = 'TicketTemplateNameConflictError';
    Object.setPrototypeOf(this, TicketTemplateNameConflictError.prototype);
  }
}

export class KbArticleNotFoundError extends DomainError {
  constructor(message = 'Статья базы знаний не найдена') {
    super('KB_ARTICLE_NOT_FOUND', 'NOT_FOUND', message);
    this.name = 'KbArticleNotFoundError';
    Object.setPrototypeOf(this, KbArticleNotFoundError.prototype);
  }
}

export class TicketWrongTransitionError extends DomainError {
  readonly fromStatus: string;
  readonly toStatus: string;
  constructor(fromStatus: string, toStatus: string, message?: string) {
    super(
      'TICKET_WRONG_TRANSITION',
      'CONFLICT',
      message ?? `Недопустимый переход заявки из "${fromStatus}" в "${toStatus}"`,
    );
    this.name = 'TicketWrongTransitionError';
    this.fromStatus = fromStatus;
    this.toStatus = toStatus;
    Object.setPrototypeOf(this, TicketWrongTransitionError.prototype);
  }
}

/**
 * Реэкспорт NotEnoughStockError из inventory-movements/repository,
 * чтобы можно было импортировать всё из одного места `lib/errors`.
 *
 * Класс остаётся определённым в repository (исторически) — но через
 * расширяющий wrapper приводим его иерархию к DomainError.
 */
import { NotEnoughStockError as InventoryNotEnoughStockError } from '../modules/inventory-movements/repository';
export { InventoryNotEnoughStockError as NotEnoughStockError };

/**
 * Маппит DomainError (или любую ошибку) в TRPCError.
 * Известные доменные типы получают правильный TRPC-код.
 * Всё остальное — INTERNAL_SERVER_ERROR (раскрытие сообщения только для Error).
 */
export function toTRPCError(err: unknown): TRPCError {
  if (err instanceof TRPCError) return err;
  if (err instanceof DomainError) {
    return new TRPCError({
      code: err.trpcCode,
      message: err.message,
      cause: err,
    });
  }
  if (err instanceof InventoryNotEnoughStockError) {
    return new TRPCError({
      code: 'UNPROCESSABLE_CONTENT',
      message: 'NOT_ENOUGH_STOCK',
      cause: err,
    });
  }
  if (err instanceof Error) {
    return new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: err.message,
      cause: err,
    });
  }
  return new TRPCError({
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Unknown error',
  });
}
