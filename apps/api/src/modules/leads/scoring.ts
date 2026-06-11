/**
 * Расчёт приоритета лида 0..100 (перенос из v1 project_2 shared/leadScoring.ts).
 *
 * Чистая функция — пересчитывается на каждом create/update в leads/service.ts.
 * При желании может использоваться и на фронте для live-preview.
 */
import type { LeadSource, LeadStatus } from '@erfolg/shared';

export interface LeadScoringInput {
  estimatedValue: number;
  email?: string | null;
  source: LeadSource;
  status: LeadStatus;
  updatedAt?: string | Date;
}

export function calculateLeadScore(input: LeadScoringInput): number {
  let score = 30; // базовый

  // +20 за крупный потенциал сделки
  if (input.estimatedValue > 100_000) score += 20;
  else if (input.estimatedValue > 50_000) score += 10;

  // +15 за заполненный email (признак качественного контакта)
  if (input.email && input.email.trim().length > 3) score += 15;

  // тёплый источник
  if (input.source === 'referral') score += 10;
  else if (input.source === 'tender') score += 5;

  // стадия воронки
  switch (input.status) {
    case 'new':
      break;
    case 'contacted':
      score += 5;
      break;
    case 'proposal':
      score += 15;
      break;
    case 'negotiation':
      score += 20;
      break;
    case 'won':
      return 100;
    case 'lost':
      return 0;
  }

  // -30 за «протухший» лид (нет активности > 30 дней); won/lost не штрафуем
  if (input.updatedAt) {
    const updated =
      typeof input.updatedAt === 'string' ? new Date(input.updatedAt) : input.updatedAt;
    if (Number.isFinite(updated.getTime())) {
      const daysSince = Math.floor((Date.now() - updated.getTime()) / (24 * 60 * 60 * 1000));
      if (daysSince > 30) score -= 30;
    }
  }

  return Math.max(0, Math.min(100, score));
}
