/**
 * Ротирующийся блок напоминаний в шапке (между заголовком страницы и поиском).
 *
 * Ничего не считает заново — переиспользует уже существующие запросы:
 *   - dashboard.navBadges (запчасти/счета/склад — те же цифры, что и бейджи в меню).
 *     ТО сюда СОЗНАТЕЛЬНО не выведено: сообщения показываются по одному с
 *     ротацией, а просроченный график нельзя погасить из интерфейса — счётчик
 *     висел бы вечно и отнимал показы у сигналов, за которыми стоит работа.
 *   - aiAssistant.dailySummary (застрявшие/перегруженные + готовая ИИ-сводка дня,
 *     кэшированная на сервере раз в сутки — она же используется на дашборде)
 *   - attestations.list (истекающие аттестации)
 * Только для staff (director/dispatcher) — инженеру эти сигналы не показываем.
 * Если показывать нечего — блок ничего не рендерит.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  AlertTriangle,
  Hourglass,
  Package,
  PhoneCall,
  Receipt,
  ShieldAlert,
  Sparkles,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

interface Nudge {
  id: string;
  icon: LucideIcon;
  text: string;
  href?: string;
  tone: 'info' | 'warning' | 'ai';
}

/** Русское склонение по числу: plural(5, 'заявка', 'заявки', 'заявок'). */
function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) return few;
  return many;
}

/** Первая непустая строка ИИ-сводки без маркера списка, обрезанная под ширину строки шапки. */
function firstLine(text: string | null | undefined): string | null {
  if (!text) return null;
  const line = text
    .split('\n')
    .map((l) => l.replace(/^[\s•\-*]+/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  return line.length > 110 ? `${line.slice(0, 109)}…` : line;
}

/** Как часто пытаемся сменить сообщение. */
const ROTATE_MS = 7000;
/** Длительность плавного затухания при смене. */
const FADE_MS = 250;
/**
 * Кулдаун: одно и то же сообщение не показываем повторно чаще, чем раз в
 * MIN_REPEAT_MS. При 5+ активных сообщениях круг ротации и так длиннее этого
 * порога — смена идёт плавно; порог «кусается» только когда сообщений мало
 * (2–3), т.е. именно там, где иначе была бы навязчивая мигалка. Тогда текущее
 * сообщение просто держится на экране дольше, а не повторяется раньше срока.
 */
const MIN_REPEAT_MS = 30_000;
/** Ключ в localStorage — «когда какое сообщение последний раз показывали». */
const SHOWN_LS_KEY = 'erfolg-header-nudges-shown';

type ShownMap = Record<string, number>;

/** Прочитать историю показов из localStorage (устойчиво к битым/чужим данным). */
function loadShown(): ShownMap {
  try {
    const raw = localStorage.getItem(SHOWN_LS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: ShownMap = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persistShown(map: ShownMap): void {
  try {
    localStorage.setItem(SHOWN_LS_KEY, JSON.stringify(map));
  } catch {
    /* приватный режим / переполнение — не критично, просто без памяти между сессиями */
  }
}

/**
 * Выбрать следующее сообщение: «кто дольше всех не показывался» среди тех, что
 * уже отстояли кулдаун. Если ничего нового не готово — держим текущее (не
 * повторяем раньше срока). Если текущее пропало из данных — берём самое
 * залежавшееся, даже если оно в кулдауне (лучше показать что-то, чем пусто).
 */
function pickNext(
  available: Nudge[],
  shown: ShownMap,
  currentId: string | null,
  now: number,
): Nudge | null {
  if (available.length === 0) return null;

  const oldestFirst = (a: Nudge, b: Nudge) => (shown[a.id] ?? 0) - (shown[b.id] ?? 0);

  const eligible = available
    .filter((n) => n.id !== currentId && now - (shown[n.id] ?? 0) >= MIN_REPEAT_MS)
    .sort(oldestFirst);
  if (eligible.length > 0) return eligible[0]!;

  // Ничего нового не «остыло» — держим текущее, если оно ещё в списке.
  const current = available.find((n) => n.id === currentId);
  if (current) return current;

  // Текущее исчезло из данных — показываем самое давнее из доступного.
  return [...available].sort(oldestFirst)[0]!;
}

/**
 * Разбор аттестаций на две разные новости.
 *
 * Раньше в напоминания попадали только «истекает» (expiring_soon), поэтому на
 * следующий день после окончания допуска сигнал ПРОПАДАЛ — система замолкала
 * ровно тогда, когда инженер уже работает без действующего допуска.
 *
 * Просроченные и истекающие не сливаем в одно число: это разные действия.
 * «Истекает» — запланировать обучение, «просрочен» — снять с работ сегодня.
 */
export function splitAttestations(rows: Array<{ status: string }>): {
  expired: number;
  expiringSoon: number;
} {
  let expired = 0;
  let expiringSoon = 0;
  for (const r of rows) {
    if (r.status === 'expired') expired += 1;
    else if (r.status === 'expiring_soon') expiringSoon += 1;
  }
  return { expired, expiringSoon };
}

export function HeaderNudges({ role }: { role: 'director' | 'dispatcher' | 'engineer' }) {
  const isStaff = role === 'director' || role === 'dispatcher';

  const navBadges = trpc.dashboard.navBadges.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const summary = trpc.aiAssistant.dailySummary.useQuery(undefined, {
    enabled: isStaff,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });
  const attestations = trpc.attestations.list.useQuery(undefined, {
    enabled: isStaff,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  });

  const nudges = useMemo<Nudge[]>(() => {
    const items: Nudge[] = [];
    const nb = navBadges.data;

    if (isStaff && nb && nb.partsWaiting > 0) {
      items.push({
        id: 'parts',
        icon: Hourglass,
        tone: 'warning',
        text: `Ждут запчасти: ${nb.partsWaiting} ${plural(nb.partsWaiting, 'заявка', 'заявки', 'заявок')}`,
        href: '/parts-waiting',
      });
    }
    if (isStaff && nb && nb.invoicesOverdue > 0) {
      items.push({
        id: 'invoices',
        icon: Receipt,
        tone: 'warning',
        text: `Просрочено счетов: ${nb.invoicesOverdue}`,
        href: '/finance',
      });
    }
    if (isStaff && nb && nb.inventoryLowStock > 0) {
      items.push({
        id: 'stock',
        icon: Package,
        tone: 'info',
        text: `На складе ниже минимума: ${nb.inventoryLowStock} ${plural(nb.inventoryLowStock, 'позиция', 'позиции', 'позиций')}`,
        href: '/inventory',
      });
    }

    const d = summary.data?.data;
    if (isStaff && d) {
      if (d.stuckCount > 0) {
        items.push({
          id: 'stuck',
          icon: AlertTriangle,
          tone: 'warning',
          text: `Простаивают без движения: ${d.stuckCount} ${plural(d.stuckCount, 'заявка', 'заявки', 'заявок')}`,
          href: '/board',
        });
      }
      if (d.readyCount > 0) {
        items.push({
          id: 'ready',
          icon: PhoneCall,
          tone: 'info',
          text: `Готово к выдаче — позвоните клиентам: ${d.readyCount}`,
          href: '/board',
        });
      }
      if (d.overloaded[0]) {
        const top = d.overloaded[0];
        items.push({
          id: 'overloaded',
          icon: Users,
          tone: 'warning',
          text: `Перегружен инженер ${top.name}: ${top.count} активных`,
          href: '/board',
        });
      }
    }

    const tip = isStaff ? firstLine(summary.data?.text) : null;
    if (tip) {
      items.push({ id: 'ai-tip', icon: Sparkles, tone: 'ai', text: tip, href: '/board' });
    }

    const att = splitAttestations(isStaff ? (attestations.data ?? []) : []);
    if (att.expired > 0) {
      items.push({
        id: 'attestations-expired',
        icon: ShieldAlert,
        tone: 'warning',
        text: `Просрочен допуск: ${att.expired} ${plural(att.expired, 'штука', 'штуки', 'штук')} — инженер работает без аттестации`,
        href: '/settings/attestations',
      });
    }
    if (att.expiringSoon > 0) {
      items.push({
        id: 'attestations',
        icon: ShieldAlert,
        tone: 'warning',
        text: `Истекает аттестация: ${att.expiringSoon} ${plural(att.expiringSoon, 'штука', 'штуки', 'штук')}`,
        href: '/settings/attestations',
      });
    }

    return items;
  }, [isStaff, navBadges.data, summary.data, attestations.data]);

  const [currentId, setCurrentId] = useState<string | null>(null);
  const [visible, setVisible] = useState(true);

  // История показов (переживает перезагрузку) — читаем из localStorage один раз.
  const shownRef = useRef<ShownMap | null>(null);
  if (shownRef.current === null) shownRef.current = loadShown();

  // Свежие ссылки для замыкания в setInterval, чтобы тик всегда видел актуальное.
  const nudgesRef = useRef(nudges);
  nudgesRef.current = nudges;
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Зафиксировать показ и переключиться на сообщение (с записью в историю).
  function commit(next: Nudge, now: number) {
    shownRef.current![next.id] = now;
    persistShown(shownRef.current!);
    currentIdRef.current = next.id;
    setCurrentId(next.id);
  }

  // Первичный выбор + мгновенная реакция на смену данных: если текущее сообщение
  // пропало из списка (или его ещё нет) — сразу подобрать замену без затухания.
  useEffect(() => {
    const stillThere =
      currentIdRef.current !== null && nudges.some((n) => n.id === currentIdRef.current);
    if (stillThere) return;
    const next = pickNext(nudges, shownRef.current!, null, Date.now());
    if (next) {
      commit(next, Date.now());
      setVisible(true);
    } else {
      currentIdRef.current = null;
      setCurrentId(null);
    }
  }, [nudges]);

  // Ротация: каждые ROTATE_MS пытаемся сменить сообщение. Если pickNext вернул то
  // же самое (кулдаун/одно сообщение) — просто держим, без мигания.
  useEffect(() => {
    const timer = setInterval(() => {
      const now = Date.now();
      const next = pickNext(nudgesRef.current, shownRef.current!, currentIdRef.current, now);
      if (!next) {
        currentIdRef.current = null;
        setCurrentId(null);
        return;
      }
      if (next.id === currentIdRef.current) return; // держим текущее
      setVisible(false);
      fadeTimerRef.current = setTimeout(() => {
        // За время затухания данные могли обновиться — перевыбираем от актуального
        // списка, чтобы не «закоммитить» исчезнувшее сообщение и не оставить пустоту.
        const later = Date.now();
        const fresh = pickNext(nudgesRef.current, shownRef.current!, currentIdRef.current, later);
        if (fresh) {
          commit(fresh, later);
        } else {
          currentIdRef.current = null;
          setCurrentId(null);
        }
        setVisible(true);
      }, FADE_MS);
    }, ROTATE_MS);
    return () => {
      clearInterval(timer);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, []);

  const current = currentId ? nudges.find((n) => n.id === currentId) : undefined;
  if (!current) return null;
  const Icon = current.icon;

  const content = (
    <>
      <span
        className={cn(
          'grid h-6 w-6 shrink-0 place-items-center rounded-md',
          current.tone === 'ai' && 'bg-primary/10 text-primary',
          current.tone === 'warning' && 'bg-warning/10 text-warning',
          current.tone === 'info' && 'bg-muted text-muted-foreground',
        )}
      >
        <Icon className="h-3.5 w-3.5" />
      </span>
      <span className="truncate">{current.text}</span>
    </>
  );

  const className = cn(
    'flex items-center gap-2 rounded-md px-2 py-1 text-sm transition-opacity',
    visible ? 'opacity-100' : 'opacity-0',
    current.href && 'text-foreground hover:bg-muted transition-colors',
    !current.href && 'text-muted-foreground',
  );
  const style = { transitionDuration: `${FADE_MS}ms` };

  return (
    <div className="hidden min-w-0 flex-1 items-center justify-center px-2 lg:flex">
      {current.href ? (
        <Link href={current.href} className={className} style={style} title={current.text}>
          {content}
        </Link>
      ) : (
        <div className={className} style={style} title={current.text}>
          {content}
        </div>
      )}
    </div>
  );
}
