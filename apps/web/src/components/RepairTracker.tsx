import {
  Check,
  Flag,
  PackageCheck,
  PackageSearch,
  Stethoscope,
  Wrench,
  XCircle,
} from 'lucide-react';
import type { TrackStageKey, TrackTimeline, TrackTimelineStage } from '@erfolg/shared';
import { cn } from '../lib/utils';

/**
 * Трек ремонта «как посылка» — вертикальный степпер стадий.
 * Общий компонент: используется и в кабинете клиента, и на публичной странице /track.
 * Данные приходят готовым таймлайном (buildTrackTimeline из @erfolg/shared).
 */

const STAGE_ICON: Record<TrackStageKey, typeof Wrench> = {
  received: PackageCheck,
  diagnostics: Stethoscope,
  repair: Wrench,
  ready: PackageSearch,
  issued: Flag,
};

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

export function RepairTracker({ timeline }: { timeline: TrackTimeline }) {
  return (
    <div>
      {timeline.cancelled && (
        <div className="bg-destructive/10 text-destructive mb-4 flex items-start gap-2 rounded-md px-3 py-2.5 text-sm">
          <XCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Заявка отменена
            {timeline.cancelledAt ? ` · ${formatDate(timeline.cancelledAt)}` : ''}
          </span>
        </div>
      )}
      <ol>
        {timeline.stages.map((stage, i) => (
          <StageRow
            key={stage.key}
            stage={stage}
            isLast={i === timeline.stages.length - 1}
            waitingForPart={timeline.waitingForPart}
          />
        ))}
      </ol>
    </div>
  );
}

function StageRow({
  stage,
  isLast,
  waitingForPart,
}: {
  stage: TrackTimelineStage;
  isLast: boolean;
  waitingForPart: boolean;
}) {
  const Icon = STAGE_ICON[stage.key];
  const date = formatDate(stage.at);
  const done = stage.state === 'done';
  const current = stage.state === 'current';
  const showWaiting = current && waitingForPart;

  return (
    <li className="flex gap-3">
      {/* Рельс: точка + соединительная линия */}
      <div className="flex flex-col items-center">
        <div
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-full',
            done && 'bg-success/15 text-success',
            current && 'bg-primary text-primary-foreground ring-primary/15 ring-4',
            !done && !current && 'bg-card text-muted-foreground border-border border-2',
          )}
        >
          {done ? (
            <Check className="h-4 w-4" />
          ) : (
            <Icon className={cn('h-4 w-4', !current && 'opacity-60')} />
          )}
        </div>
        {!isLast && (
          <div
            className={cn('my-1 w-0.5 flex-1', done ? 'bg-success' : 'bg-border')}
            style={{ minHeight: showWaiting ? '2.75rem' : '1.5rem' }}
          />
        )}
      </div>

      {/* Содержимое стадии */}
      <div className={cn('pb-4', isLast && 'pb-0')}>
        <div
          className={cn(
            'text-sm font-medium',
            current ? 'text-primary' : done ? 'text-foreground' : 'text-muted-foreground',
          )}
        >
          {stage.label}
          {current && <span className="text-primary"> — сейчас здесь</span>}
        </div>
        <div className="text-muted-foreground mt-0.5 text-xs">
          {date ?? (done ? 'выполнено' : stage.description)}
        </div>

        {showWaiting && (
          <div className="bg-warning/15 text-warning mt-2 flex items-start gap-1.5 rounded-md px-2.5 py-1.5 text-xs">
            <Wrench className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {/* Только факт ожидания — внутренняя заметка менеджера клиенту не показывается. */}
            <span>Ждём запчасть. Как приедет, продолжим.</span>
          </div>
        )}
      </div>
    </li>
  );
}
