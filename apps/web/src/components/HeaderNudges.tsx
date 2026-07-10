/**
 * Ротирующийся блок напоминаний в шапке (между заголовком страницы и поиском).
 *
 * Ничего не считает заново — переиспользует уже существующие запросы:
 *   - dashboard.navBadges (запчасти/счета/ТО/склад — те же цифры, что и бейджи в меню)
 *   - aiAssistant.dailySummary (застрявшие/перегруженные + готовая ИИ-сводка дня,
 *     кэшированная на сервере раз в сутки — она же используется на дашборде)
 *   - attestations.list (истекающие аттестации)
 * Только для staff (director/dispatcher) — инженеру эти сигналы не показываем.
 * Если показывать нечего — блок ничего не рендерит.
 */
import { useEffect, useMemo, useState } from 'react';
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

const ROTATE_MS = 7000;
const FADE_MS = 250;

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
    if (nb && nb.inventoryLowStock > 0) {
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

    const soonAttestations = isStaff
      ? (attestations.data ?? []).filter((a) => a.status === 'expiring_soon')
      : [];
    if (soonAttestations.length > 0) {
      items.push({
        id: 'attestations',
        icon: ShieldAlert,
        tone: 'warning',
        text: `Истекает аттестация: ${soonAttestations.length} ${plural(soonAttestations.length, 'штука', 'штуки', 'штук')}`,
        href: '/settings/attestations',
      });
    }

    return items;
  }, [isStaff, navBadges.data, summary.data, attestations.data]);

  const [idx, setIdx] = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (nudges.length <= 1) return;
    const timer = setInterval(() => {
      setVisible(false);
      setTimeout(() => {
        setIdx((i) => (i + 1) % nudges.length);
        setVisible(true);
      }, FADE_MS);
    }, ROTATE_MS);
    return () => clearInterval(timer);
  }, [nudges.length]);

  const current = nudges.length > 0 ? nudges[idx % nudges.length] : undefined;
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
