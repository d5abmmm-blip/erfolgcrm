import { AlertTriangle, Award, CalendarOff, Gauge, Wrench } from 'lucide-react';
import { trpc } from '../lib/trpc';

type AvailabilityKind = 'day_off' | 'vacation' | 'onsite';

const AVAILABILITY_LABEL: Record<AvailabilityKind, string> = {
  day_off: 'выходной',
  vacation: 'в отпуске',
  onsite: 'на выезде',
};

interface Props {
  /** Тип техники заявки — для проверки навыка инженера. */
  deviceType?: string | null;
  /** Единица техники заявки — для проверки обязательной аттестации. */
  assetId?: string | null;
  /** Текущий выбранный инженер (для панели «по выбранному»); null — никто. */
  selectedEngineerId?: string | null;
  /**
   * Режим отображения:
   *   'selected' — компактная панель только по выбранному инженеру;
   *   'overview' — короткий список загрузки по всем инженерам (когда никто не выбран).
   * По умолчанию — авто: пока не выбран инженер, показываем overview, иначе — selected.
   */
  mode?: 'selected' | 'overview' | 'auto';
}

/**
 * Умные подсказки при назначении инженера — ТОЛЬКО ДЛЯ ЧТЕНИЯ.
 * Не меняет данные/статус; сам выбор инженера делает родительский select.
 *
 * Показывает: текущую загрузку, наличие навыка под тип техники, занятость сегодня
 * (выходной/отпуск/выезд) и предупреждение об отсутствии действующей аттестации.
 */
export function EngineerAssignmentHints({
  deviceType = null,
  assetId = null,
  selectedEngineerId = null,
  mode = 'auto',
}: Props) {
  const q = trpc.engineerProfile.assignmentHints.useQuery(
    { deviceType, assetId },
    { staleTime: 60_000 },
  );

  if (q.isLoading) {
    return <div className="text-muted-foreground mt-1.5 text-[11px]">подсказки…</div>;
  }
  if (q.error || !q.data) return null;

  const hints = q.data;
  const effectiveMode = mode === 'auto' ? (selectedEngineerId ? 'selected' : 'overview') : mode;

  if (effectiveMode === 'selected') {
    if (!selectedEngineerId) return null;
    const hint = hints.find((h) => h.userId === selectedEngineerId);
    if (!hint) return null;
    return (
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <Chip tone="muted" icon={Gauge}>
          {hint.activeLoad} {plural(hint.activeLoad)}
        </Chip>
        {hint.hasSkill === false && (
          <Chip tone="warning" icon={AlertTriangle}>
            нет навыка{deviceType ? ` под «${deviceType}»` : ''}
          </Chip>
        )}
        {hint.hasSkill === true && (
          <Chip tone="success" icon={Wrench}>
            есть навык
          </Chip>
        )}
        {hint.availabilityToday && (
          <Chip tone="warning" icon={CalendarOff}>
            {AVAILABILITY_LABEL[hint.availabilityToday]}
          </Chip>
        )}
        {hint.attestationWarning && (
          <Chip tone="warning" icon={Award}>
            {hint.attestationWarning}
          </Chip>
        )}
      </div>
    );
  }

  // overview — короткий список: самые свободные и подходящие сверху.
  const sorted = [...hints].sort((a, b) => {
    // Подходящие по навыку — выше; свободные (без занятости) — выше; меньше загрузка — выше.
    const skillA = a.hasSkill === true ? 0 : 1;
    const skillB = b.hasSkill === true ? 0 : 1;
    if (skillA !== skillB) return skillA - skillB;
    const busyA = a.availabilityToday ? 1 : 0;
    const busyB = b.availabilityToday ? 1 : 0;
    if (busyA !== busyB) return busyA - busyB;
    return a.activeLoad - b.activeLoad;
  });
  if (sorted.length === 0) return null;

  return (
    <div className="bg-muted/40 mt-1.5 space-y-1 rounded-md border p-2">
      <div className="text-muted-foreground text-[10px] font-medium uppercase tracking-wide">
        Загрузка инженеров{deviceType ? ` · навык «${deviceType}»` : ''}
      </div>
      <ul className="space-y-0.5">
        {sorted.slice(0, 6).map((h) => (
          <li key={h.userId} className="flex items-center justify-between gap-2 text-xs">
            <span className="truncate">{h.fullName}</span>
            <span className="flex flex-shrink-0 items-center gap-1">
              {h.hasSkill === true && (
                <Wrench className="text-success h-3 w-3" aria-label="есть навык" />
              )}
              {h.availabilityToday && (
                <span className="bg-warning/15 text-warning rounded-full px-1.5 py-0.5 text-[10px]">
                  {AVAILABILITY_LABEL[h.availabilityToday]}
                </span>
              )}
              {h.attestationWarning && (
                <AlertTriangle className="text-warning h-3 w-3" aria-label="нет аттестации" />
              )}
              <span className="text-muted-foreground tabular-nums">
                {h.activeLoad} {plural(h.activeLoad)}
              </span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'активная';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return 'активные';
  return 'активных';
}

function Chip({
  tone,
  icon: Icon,
  children,
}: {
  tone: 'muted' | 'warning' | 'success';
  icon: typeof Gauge;
  children: React.ReactNode;
}) {
  const cls =
    tone === 'warning'
      ? 'bg-warning/15 text-warning'
      : tone === 'success'
        ? 'bg-success/10 text-success'
        : 'bg-muted text-muted-foreground';
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] ${cls}`}>
      <Icon className="h-3 w-3" />
      {children}
    </span>
  );
}
