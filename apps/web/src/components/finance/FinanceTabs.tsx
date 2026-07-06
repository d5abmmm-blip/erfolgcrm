/**
 * Под-навигация раздела «Финансы»: Обзор / Приход и расход / Счета на оплату / Счета и статьи.
 * Вкладка «Счета и статьи» — только директору (управление кассой).
 */
import { Link, useLocation } from 'wouter';
import { trpc } from '../../lib/trpc';
import { cn } from '../../lib/utils';

interface TabDef {
  href: string;
  label: string;
  /** Точное совпадение пути (для «Обзора» — иначе он активен на всех /finance/*). */
  exact?: boolean;
  directorOnly?: boolean;
}

const TABS: TabDef[] = [
  { href: '/finance', label: 'Обзор', exact: true },
  { href: '/finance/receivables', label: 'Дебиторка' },
  { href: '/finance/transactions', label: 'Приход и расход' },
  { href: '/finance/invoices', label: 'Счета на оплату' },
  { href: '/finance/accounts', label: 'Счета и статьи', directorOnly: true },
];

export function FinanceTabs() {
  const [location] = useLocation();
  const me = trpc.auth.me.useQuery();
  const isDirector = me.data?.user.role === 'director';
  const tabs = TABS.filter((t) => !t.directorOnly || isDirector);

  return (
    <div className="border-b">
      <nav className="-mb-px flex flex-wrap gap-1" aria-label="Разделы финансов">
        {tabs.map((t) => {
          const active = t.exact ? location === t.href : location.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={cn(
                'border-b-2 px-3 py-2 text-sm font-medium transition',
                active
                  ? 'border-primary text-foreground'
                  : 'text-muted-foreground hover:text-foreground border-transparent',
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
