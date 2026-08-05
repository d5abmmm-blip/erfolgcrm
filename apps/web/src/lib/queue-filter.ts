/**
 * Локальный поиск по загруженной очереди инженера (/m/queue).
 *
 * Фильтр по уже полученному списку: работает офлайн и не дёргает сервер.
 * Ищем по номеру заявки, клиенту, модели, серийному и инвентарному номерам —
 * тем же полям, что видны в карточке.
 */
export interface QueueSearchable {
  ticketNumber: string;
  clientDisplayName: string | null;
  assetModel: string | null;
  assetSerialNumber: string | null;
  assetInventoryNumber: string | null;
}

export function filterQueue<T extends QueueSearchable>(items: T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((t) =>
    [
      t.ticketNumber,
      t.clientDisplayName,
      t.assetModel,
      t.assetSerialNumber,
      t.assetInventoryNumber,
    ].some((v) => v != null && v.toLowerCase().includes(q)),
  );
}
