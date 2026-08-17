/**
 * Строки наряда → строки для печатных бланков. Одно место на всю программу.
 *
 * ЗАЧЕМ. Сборка данных для PDF была скопирована в три экрана — карточку заявки,
 * мобильную карточку инженера и карточку счёта, — и копии разъехались: десктоп
 * клал в строку `engineerName`, а телефон нет. Из-за этого акт выполненных работ,
 * распечатанный С ТЕЛЕФОНА, терял блок «Работы выполнил: …» — тот самый, который
 * добавляли, чтобы при выезде вдвоём было видно обоих. Один и тот же акт по одной
 * и той же заявке выглядел по-разному в зависимости от того, с какого устройства
 * его напечатали, а документ этот подписывают.
 *
 * Числа в наряде приходят строками (bigint через superjson), бланкам нужны числа —
 * перевод тоже здесь, чтобы он не расходился между экранами.
 */
import type { WorkOrderLine } from './shared';

/** Строка наряда, как её отдаёт сервер (workOrders.getByTicket). */
export interface SourceWorkOrderLine {
  lineType: string;
  name: string;
  unit: string;
  quantity: string | number;
  unitPriceKopecks: string | number;
  amountKopecks: string | number;
  engineerName?: string | null;
}

export function toPdfLines(lines: readonly SourceWorkOrderLine[]): WorkOrderLine[] {
  return lines.map((l) => ({
    lineType: l.lineType as WorkOrderLine['lineType'],
    name: l.name,
    unit: l.unit,
    quantity: Number(l.quantity),
    unitPriceKopecks: Number(l.unitPriceKopecks),
    amountKopecks: Number(l.amountKopecks),
    // Фамилия исполнителя — именно она терялась на телефоне.
    engineerName: l.engineerName ?? null,
  }));
}
