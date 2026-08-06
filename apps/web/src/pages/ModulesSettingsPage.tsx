/**
 * /settings/modules — включение/отключение разделов интерфейса.
 *
 * Директор скрывает необязательные разделы для всей компании. Отключение влияет
 * только на навигацию и маршруты — данные и API остаются на месте (логика не
 * ломается), поэтому раздел можно вернуть в любой момент без потерь.
 *
 * Источник списка разделов — lib/modules.ts. Текущее состояние читаем из auth.me
 * (tenant.disabledModules); после сохранения инвалидируем me, чтобы меню и гард
 * маршрутов сразу подхватили изменения.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'wouter';
import { ChevronLeft, Loader2, ShieldAlert } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  MODULE_GROUP_ORDER,
  TOGGLEABLE_MODULES,
  type ModuleGroup,
  type ModuleKey,
} from '../lib/modules';

export function ModulesSettingsPage() {
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });

  const serverDisabled = useMemo(() => me.data?.tenant.disabledModules ?? [], [me.data]);
  // Сериализованный «снимок» сервера — пересинхронизируем черновик только когда
  // значение реально поменялось по содержимому (а не на каждый рефетч me).
  const serverKey = useMemo(() => serverDisabled.slice().sort().join(','), [serverDisabled]);

  // Пересинхронизируем черновик с сервером только когда serverKey реально изменился
  // (после сохранения/первой загрузки) — serverDisabled намеренно вне зависимостей.
  const [draft, setDraft] = useState<Set<string>>(() => new Set(serverDisabled));
  useEffect(() => {
    setDraft(new Set(serverDisabled));
  }, [serverKey, serverDisabled]);

  const save = trpc.settings.setDisabledModules.useMutation({
    onSuccess: () => {
      // Меню (AppShell/MobileShell) и гард маршрутов читают из me — обновим везде.
      void utils.auth.me.invalidate();
    },
  });

  const isDirector = me.data?.user.role === 'director';
  const draftKey = useMemo(() => [...draft].sort().join(','), [draft]);
  const isDirty = draftKey !== serverKey;
  const disabledCount = draft.size;

  function toggle(key: ModuleKey) {
    if (!isDirector) return;
    setDraft((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  const byGroup = (group: ModuleGroup) => TOGGLEABLE_MODULES.filter((m) => m.group === group);

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link
        href="/settings"
        className="text-muted-foreground hover:text-foreground mb-3 inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        Настройки
      </Link>

      <h1 className="text-2xl font-semibold">Разделы интерфейса</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Скройте разделы, которыми не пользуетесь — они исчезнут из меню у всех сотрудников. Данные и
        расчёты при этом сохраняются: раздел можно вернуть в любой момент. Базовые разделы (Дашборд,
        Заявки, Клиенты, Настройки) отключить нельзя.
      </p>

      {!isDirector && (
        <div className="border-warning/40 bg-warning/10 text-warning-foreground mt-4 flex items-start gap-2 rounded-lg border p-3 text-sm">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Менять список разделов может только директор. Ниже — текущее состояние (только
            просмотр).
          </span>
        </div>
      )}

      <div className="mt-6 space-y-6">
        {MODULE_GROUP_ORDER.map((group) => {
          const items = byGroup(group);
          if (items.length === 0) return null;
          return (
            <section key={group}>
              <div className="text-muted-foreground px-1 pb-2 text-[11px] font-semibold uppercase tracking-[0.12em]">
                {group}
              </div>
              <div className="bg-card divide-y rounded-lg border">
                {items.map((m) => {
                  const enabled = !draft.has(m.key);
                  return (
                    <div key={m.key} className="flex items-center justify-between gap-3 p-4">
                      <div className="min-w-0">
                        <div className="font-medium">{m.label}</div>
                        <div className="text-muted-foreground text-xs">{m.description}</div>
                      </div>
                      <Toggle
                        checked={enabled}
                        disabled={!isDirector}
                        onChange={() => toggle(m.key)}
                        label={`Раздел «${m.label}»`}
                      />
                    </div>
                  );
                })}
              </div>
            </section>
          );
        })}
      </div>

      {isDirector && (
        <div className="bg-background/80 sticky bottom-0 mt-6 flex items-center justify-between gap-3 border-t py-4 backdrop-blur">
          <div className="text-muted-foreground text-sm">
            {disabledCount === 0 ? 'Все разделы включены' : `Скрыто разделов: ${disabledCount}`}
            {isDirty && (
              <span className="text-warning-foreground"> · есть несохранённые изменения</span>
            )}
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setDraft(new Set(serverDisabled))}
              disabled={!isDirty || save.isPending}
              className="hover:bg-muted rounded-md border px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              Отменить
            </button>
            <button
              type="button"
              onClick={() => save.mutate({ modules: [...draft] })}
              disabled={!isDirty || save.isPending}
              className="bg-primary text-primary-foreground inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {save.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
              Сохранить
            </button>
          </div>
        </div>
      )}

      {save.error && <div className="text-destructive mt-3 text-sm">{save.error.message}</div>}
    </div>
  );
}

function Toggle({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition disabled:cursor-not-allowed disabled:opacity-50',
        checked ? 'bg-primary' : 'bg-muted-foreground/30',
      )}
    >
      <span
        className={cn(
          'bg-background inline-block h-5 w-5 transform rounded-full shadow transition',
          checked ? 'translate-x-[22px]' : 'translate-x-0.5',
        )}
      />
    </button>
  );
}
