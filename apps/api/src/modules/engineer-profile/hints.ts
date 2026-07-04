/**
 * «Умная подсказка при назначении инженера».
 *
 * Собирает по каждому активному инженеру (role=engineer, isActive) подсказки
 * ТОЛЬКО ДЛЯ ЧТЕНИЯ — назначение выполняется как раньше:
 *   - activeLoad        — сколько активных заявок уже на инженере (по доске);
 *   - hasSkill          — есть ли у инженера навык под тип техники заявки;
 *   - availabilityToday — занятость на сегодня (выходной/отпуск/на выезде) или null;
 *   - attestationWarning — текст предупреждения, если для техники нужна аттестация,
 *                          которой у инженера нет (иначе null).
 *
 * Переиспользует существующие repo-функции (без дублирования SQL):
 *   listUsers({ onlyEngineers }), listSkills, listActiveAvailability,
 *   boardTickets (загрузка), getAssetRequiredAttestation + getActiveCategoriesForEngineer.
 * ПДн клиента наружу не отдаём — только по инженерам.
 */
import type { Db } from '@erfolg/db';
import { listUsers } from '../users/repository';
import { boardTickets, getAssetRequiredAttestation } from '../tickets/repository';
import { getActiveCategoriesForEngineer } from '../attestations/repository';
import {
  listSkills,
  listActiveAvailability,
  type AvailabilityKind,
} from './repository';

export interface AssignmentHint {
  userId: string;
  fullName: string;
  /** Кол-во активных заявок на инженере (доска). */
  activeLoad: number;
  /**
   * Есть ли навык под тип техники заявки. Если deviceType для заявки не известен —
   * null (нечего проверять), иначе true/false.
   */
  hasSkill: boolean | null;
  /** Занятость сегодня или null, если инженер свободен. */
  availabilityToday: AvailabilityKind | null;
  /** Предупреждение об отсутствии действующей аттестации под категорию техники (или null). */
  attestationWarning: string | null;
}

export interface AssignmentHintsInput {
  /** Тип техники заявки (справочник, совпадает с user_device_skills.deviceType). */
  deviceType?: string | null;
  /** Единица техники заявки — из неё выводим deviceType/категорию аттестации, если не переданы явно. */
  assetId?: string | null;
}

/** Дата «сегодня» в таймзоне организации (YYYY-MM-DD). */
function todayInTz(tz: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * Подсказки по всем активным инженерам под конкретную заявку.
 *
 * deviceType берётся из входа; если не задан, но задан assetId — можно было бы
 * вывести из asset'а, но deviceType сейчас нужен только для навыка и в UI он и так
 * известен из выбранной техники, поэтому подтягиваем через asset ТОЛЬКО категорию
 * аттестации (там она отдельное поле requiredAttestationCategory).
 */
export async function assignmentHints(
  db: Db,
  tenantId: string,
  timezone: string,
  input: AssignmentHintsInput,
): Promise<AssignmentHint[]> {
  const deviceType = input.deviceType?.trim() || null;
  const assetId = input.assetId?.trim() || null;

  const [engineers, skills, availability, board, requiredCategory] = await Promise.all([
    listUsers(db, tenantId, { onlyEngineers: true }),
    listSkills(db, tenantId),
    listActiveAvailability(db, tenantId, todayInTz(timezone)),
    boardTickets(db, tenantId),
    assetId ? getAssetRequiredAttestation(db, tenantId, assetId) : Promise.resolve(null),
  ]);

  // Загрузка: кол-во активных заявок на инженере.
  const loadByUser = new Map<string, number>();
  for (const card of board) {
    if (!card.assignedEngineerId) continue;
    loadByUser.set(
      card.assignedEngineerId,
      (loadByUser.get(card.assignedEngineerId) ?? 0) + 1,
    );
  }

  // Навыки: множество deviceType (нижним регистром) по инженеру.
  const skillsByUser = new Map<string, Set<string>>();
  for (const s of skills) {
    let set = skillsByUser.get(s.userId);
    if (!set) {
      set = new Set<string>();
      skillsByUser.set(s.userId, set);
    }
    set.add(s.deviceType.toLowerCase());
  }

  // Занятость сегодня: kind по инженеру (первая актуальная запись).
  const availByUser = new Map<string, AvailabilityKind>();
  for (const a of availability) {
    if (!availByUser.has(a.userId)) availByUser.set(a.userId, a.kind);
  }

  const deviceTypeKey = deviceType?.toLowerCase() ?? null;

  // Аттестация: если у техники задана обязательная категория — по каждому инженеру
  // сверяем с его действующими категориями (один запрос на инженера, но только
  // когда категория реально требуется).
  const attestationWarnings = new Map<string, string | null>();
  if (requiredCategory) {
    await Promise.all(
      engineers.map(async (e) => {
        const cats = await getActiveCategoriesForEngineer(db, tenantId, e.id);
        attestationWarnings.set(
          e.id,
          cats.includes(requiredCategory)
            ? null
            : `Нет действующей аттестации по категории «${requiredCategory}»`,
        );
      }),
    );
  }

  return engineers.map<AssignmentHint>((e) => ({
    userId: e.id,
    fullName: e.fullName,
    activeLoad: loadByUser.get(e.id) ?? 0,
    hasSkill: deviceTypeKey === null ? null : (skillsByUser.get(e.id)?.has(deviceTypeKey) ?? false),
    availabilityToday: availByUser.get(e.id) ?? null,
    attestationWarning: attestationWarnings.get(e.id) ?? null,
  }));
}
