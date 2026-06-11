/** Сервис payroll — обёртка над repository с парсингом периода. */
import type { Db } from '@erfolg/db';
import * as repo from './repository';
import { resolvePeriod, type PeriodPreset } from '../dashboard/service';

export async function getRuleQuery(db: Db, tenantId: string) {
  return repo.getRule(db, tenantId);
}

export async function setRuleCmd(
  db: Db,
  tenantId: string,
  input: repo.SetRuleInput,
) {
  return repo.setRule(db, tenantId, input);
}

export async function computePayoutsQuery(
  db: Db,
  tenantId: string,
  input: PeriodPreset & { engineerId?: string | null },
) {
  const period = resolvePeriod(input);
  return repo.computePayouts(db, tenantId, period, {
    engineerId: input.engineerId ?? null,
  });
}
