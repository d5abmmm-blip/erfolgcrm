/**
 * Секция профиля инженера (в модалке пользователя): навыки (типы техники) и занятость.
 * Сохраняется отдельными мутациями engineerProfile.* (не через форму пользователя).
 * Видна только для роли «инженер».
 */
import { useMemo, useState } from 'react';
import { Loader2, Plus, Trash2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { COMMON_DEVICE_TYPES } from '../lib/device-types';
import { TelegramLinkSection } from './TelegramLinkSection';

const KIND_LABEL: Record<'day_off' | 'vacation' | 'onsite', string> = {
  day_off: 'выходной',
  vacation: 'отпуск',
  onsite: 'на выезде',
};

export function EngineerProfileSection({ userId }: { userId: string }) {
  const utils = trpc.useUtils();
  const skillsQ = trpc.engineerProfile.listSkills.useQuery();
  const availQ = trpc.engineerProfile.listAvailability.useQuery({ userId });

  const mySkills = useMemo(
    () => (skillsQ.data ?? []).filter((s) => s.userId === userId).map((s) => s.deviceType),
    [skillsQ.data, userId],
  );

  const setSkills = trpc.engineerProfile.setSkills.useMutation({
    onSuccess: () => utils.engineerProfile.listSkills.invalidate(),
  });

  const toggleSkill = (deviceType: string) => {
    const next = mySkills.includes(deviceType)
      ? mySkills.filter((s) => s !== deviceType)
      : [...mySkills, deviceType];
    setSkills.mutate({ userId, deviceTypes: next });
  };

  // Опции = частые типы + уже выбранные (свои, вне списка).
  const options = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...COMMON_DEVICE_TYPES, ...mySkills]) {
      const key = t.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(t);
    }
    return out;
  }, [mySkills]);

  const [customSkill, setCustomSkill] = useState('');

  return (
    <div className="space-y-4 border-t pt-3">
      <div>
        <div className="mb-1.5 text-xs font-medium">Telegram-напоминания</div>
        <TelegramLinkSection userId={userId} />
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2 text-xs font-medium">
          Навыки — какие типы техники обслуживает
          {setSkills.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
        </div>
        <div className="flex flex-wrap gap-1.5">
          {options.map((t) => {
            const on = mySkills.includes(t);
            return (
              <button
                key={t}
                type="button"
                onClick={() => toggleSkill(t)}
                className={cn(
                  'rounded-full border px-2.5 py-1 text-xs transition',
                  on
                    ? 'bg-primary/10 text-primary border-primary/30'
                    : 'bg-background text-muted-foreground hover:bg-muted',
                )}
              >
                {t}
              </button>
            );
          })}
        </div>
        <div className="mt-2 flex gap-2">
          <input
            type="text"
            value={customSkill}
            onChange={(e) => setCustomSkill(e.target.value)}
            placeholder="Свой тип техники"
            className="bg-background flex-1 rounded-md border px-2.5 py-1.5 text-xs outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            type="button"
            disabled={!customSkill.trim() || setSkills.isPending}
            onClick={() => {
              const t = customSkill.trim();
              if (t && !mySkills.some((s) => s.toLowerCase() === t.toLowerCase())) {
                setSkills.mutate({ userId, deviceTypes: [...mySkills, t] });
              }
              setCustomSkill('');
            }}
            className="bg-secondary hover:bg-muted rounded-md px-2.5 py-1.5 text-xs font-medium disabled:opacity-50"
          >
            Добавить
          </button>
        </div>
      </div>

      <AvailabilityEditor userId={userId} rows={availQ.data ?? []} loading={availQ.isLoading} />
    </div>
  );
}

function AvailabilityEditor({
  userId,
  rows,
  loading,
}: {
  userId: string;
  rows: Array<{ id: string; kind: 'day_off' | 'vacation' | 'onsite'; dateFrom: string; dateTo: string; note: string | null }>;
  loading: boolean;
}) {
  const utils = trpc.useUtils();
  const [kind, setKind] = useState<'day_off' | 'vacation' | 'onsite'>('vacation');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  const invalidate = () => utils.engineerProfile.listAvailability.invalidate();
  const add = trpc.engineerProfile.setAvailability.useMutation({
    onSuccess: () => {
      setFrom('');
      setTo('');
      setError(null);
      return invalidate();
    },
    onError: (e) => setError(e.message),
  });
  const del = trpc.engineerProfile.deleteAvailability.useMutation({ onSuccess: invalidate });

  return (
    <div>
      <div className="mb-1.5 text-xs font-medium">Занятость (выходной / отпуск / выезд)</div>
      {loading ? (
        <div className="text-muted-foreground text-xs">Загрузка…</div>
      ) : rows.length > 0 ? (
        <ul className="mb-2 space-y-1">
          {rows.map((r) => (
            <li key={r.id} className="flex items-center gap-2 text-xs">
              <span className="bg-secondary rounded px-1.5 py-0.5">{KIND_LABEL[r.kind]}</span>
              <span className="text-muted-foreground">
                {r.dateFrom} — {r.dateTo}
                {r.note ? ` · ${r.note}` : ''}
              </span>
              <button
                type="button"
                onClick={() => del.mutate({ id: r.id })}
                className="text-muted-foreground hover:text-destructive ml-auto"
                aria-label="Удалить"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="text-muted-foreground mb-2 text-xs">Записей нет</div>
      )}
      <div className="flex flex-wrap items-center gap-1.5">
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as 'day_off' | 'vacation' | 'onsite')}
          className="bg-background rounded-md border px-2 py-1 text-xs"
        >
          <option value="vacation">отпуск</option>
          <option value="day_off">выходной</option>
          <option value="onsite">на выезде</option>
        </select>
        <input
          type="date"
          value={from}
          onChange={(e) => setFrom(e.target.value)}
          className="bg-background rounded-md border px-2 py-1 text-xs"
        />
        <input
          type="date"
          value={to}
          onChange={(e) => setTo(e.target.value)}
          className="bg-background rounded-md border px-2 py-1 text-xs"
        />
        <button
          type="button"
          disabled={!from || !to || add.isPending}
          onClick={() =>
            add.mutate({ userId, kind, dateFrom: from, dateTo: to || from, note: null })
          }
          className="bg-secondary hover:bg-muted inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium disabled:opacity-50"
        >
          <Plus className="h-3 w-3" />
          Добавить
        </button>
      </div>
      {error && <div className="text-destructive mt-1 text-[11px]">{error}</div>}
    </div>
  );
}
