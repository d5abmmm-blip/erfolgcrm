/**
 * Человеческая подпись к записи очереди.
 *
 * ЗАЧЕМ. Когда сервер отказался принять правку, инженер видел одно число:
 * «сервер не принял 3 изменения». Что это было — комментарий, смена статуса
 * или строка наряда на 18 000 ₽ — и какой текст он писал, восстановить было
 * нельзя. Теперь у каждой записи есть название, содержимое и текст, который
 * можно скопировать и вставить заново.
 *
 * Чистая функция: работает от payload, ничего не спрашивает у сервера —
 * ей и не у кого спросить, когда связи нет.
 */
import { TICKET_STATUS_META } from '../dictionaries/tickets';
import type { TicketStatus } from '@erfolg/shared';
import type { MutationKind } from './queue';

export interface OutboxDescription {
  /** «Комментарий к заявке WSP-6472» */
  title: string;
  /** Содержимое: текст комментария, название строки наряда, новый статус. */
  detail: string;
  /** То, что уйдёт в буфер обмена по кнопке «Скопировать». */
  copyText: string;
}

const KIND_TITLE: Record<MutationKind, string> = {
  'tickets.changeStatus': 'Статус заявки',
  'tickets.addNote': 'Комментарий к заявке',
  'tickets.engineerReact': 'Ответ по заявке',
  'workOrders.upsertLine': 'Строка в наряд',
  'workOrders.deleteLine': 'Удаление строки наряда',
  'workOrders.updateHeader': 'Заполнение наряда',
  'inventoryMovements.issueToWorkOrder': 'Списание со склада',
  'maintenance.recordPerformed': 'Отметка о выполненном ТО',
  'tasks.setDone': 'Отметка по задаче',
};

const REACTION: Record<string, string> = {
  inwork: 'Ещё в работе',
  ready: 'Готово к выдаче',
  part: 'Жду запчасть',
};

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '';
}

function detailOf(kind: MutationKind, payload: Record<string, unknown>): string {
  switch (kind) {
    case 'tickets.addNote':
      return str(payload.comment);
    case 'tickets.changeStatus': {
      const status = str(payload.status) as TicketStatus;
      return TICKET_STATUS_META[status]?.label ?? status;
    }
    case 'tickets.engineerReact':
      return REACTION[str(payload.action)] ?? str(payload.action);
    case 'workOrders.upsertLine': {
      const line = (payload.line ?? {}) as Record<string, unknown>;
      const parts = [str(line.name)];
      const qty = str(line.quantity);
      if (qty) parts.push(`${qty} ${str(line.unit) || 'шт'}`);
      const price = str(line.unitPriceRub);
      if (price) parts.push(`${price} ₽`);
      return parts.filter(Boolean).join(' · ');
    }
    case 'workOrders.updateHeader': {
      const patch = (payload.patch ?? {}) as Record<string, unknown>;
      return Object.values(patch).map(str).filter(Boolean).join(' · ');
    }
    case 'maintenance.recordPerformed':
      return str(payload.summary);
    case 'tasks.setDone':
      return payload.isDone === true ? 'сделана' : 'отметка снята';
    case 'inventoryMovements.issueToWorkOrder': {
      const qty = str(payload.quantity);
      return qty ? `${qty} шт` : '';
    }
    default:
      return '';
  }
}

export function describeOutboxItem(item: {
  kind: MutationKind;
  payload: unknown;
  /** Номер заявки или название задачи — то, что человек узнаёт глазами. */
  label?: string;
}): OutboxDescription {
  const payload = (item.payload ?? {}) as Record<string, unknown>;
  const base = KIND_TITLE[item.kind] ?? 'Изменение';
  const title = item.label ? `${base} ${item.label}` : base;
  const detail = detailOf(item.kind, payload);
  return {
    title,
    detail,
    copyText: detail ? `${title}\n${detail}` : title,
  };
}
