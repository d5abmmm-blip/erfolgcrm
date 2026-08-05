/**
 * Что делать с результатами поиска в сканере (/m/scan).
 *
 * Штрих-код уникален — одна находка, открываем сразу. А вот ручной ввод
 * серийника/инвентарного может дать несколько заявок по одному аппарату:
 * раньше молча открывалась первая попавшаяся, теперь инженер выбирает из списка.
 */
export interface ScanMatch {
  id: string;
  ticketNumber: string;
  clientDisplayName: string | null;
  assetModel: string | null;
}

export type ScanPick =
  | { kind: 'none' }
  | { kind: 'one'; id: string }
  | { kind: 'many'; matches: ScanMatch[] };

export function pickScanResult(matches: ScanMatch[]): ScanPick {
  if (matches.length === 0) return { kind: 'none' };
  const first = matches[0];
  if (matches.length === 1 && first) return { kind: 'one', id: first.id };
  return { kind: 'many', matches };
}
