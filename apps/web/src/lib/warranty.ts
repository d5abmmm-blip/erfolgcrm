/**
 * Гарантии на экранах: подписи и выбор той, что сейчас закрывает технику.
 *
 * СВОЕГО СЧЁТА ДАТ ЗДЕСЬ НЕТ СОЗНАТЕЛЬНО. Действует гарантия или нет — решает
 * сервер одним выражением (`statusSql` в warranties/repository.ts, там же
 * фильтры и статистика). Пересчитай мы это по часам браузера — получилось бы
 * второе определение, которое разъедется с реестром, как уже разъезжалось
 * «просрочено» у ТО в пяти местах (#165).
 */
import type { WarrantyStatus, WarrantyType } from '@erfolg/shared';

/** Минимум, который нужен экранам от записи о гарантии. */
export interface WarrantyLike {
  status: WarrantyStatus;
  endDate: string;
  type: WarrantyType;
}

const TYPE_RU: Record<WarrantyType, string> = {
  manufacturer: 'заводская',
  service: 'сервисная',
  extended: 'расширенная',
};

const STATUS_RU: Record<WarrantyStatus, string> = {
  active: 'действует',
  expiring: 'заканчивается',
  expired: 'истекла',
  voided: 'аннулирована',
};

export function warrantyTypeRu(type: WarrantyType): string {
  return TYPE_RU[type];
}

export function warrantyStatusRu(status: WarrantyStatus): string {
  return STATUS_RU[status];
}

/** Гарантия сейчас закрывает технику: действует или на исходе, но не истекла. */
export function isCovering(w: WarrantyLike): boolean {
  return w.status === 'active' || w.status === 'expiring';
}

/**
 * Какая гарантия закрывает технику сейчас. Если их несколько (заводская плюс
 * расширенная — обычное дело), берём ту, что кончается позже: именно до неё
 * ремонт остаётся бесплатным для клиента.
 */
export function pickCoveringWarranty<T extends WarrantyLike>(list: readonly T[]): T | null {
  let best: T | null = null;
  for (const w of list) {
    if (!isCovering(w)) continue;
    if (!best || w.endDate > best.endDate) best = w;
  }
  return best;
}
