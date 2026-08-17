import { Link } from 'wouter';
import { Plus, ShieldCheck } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { QueryError } from './QueryError';
import { pickCoveringWarranty, warrantyStatusRu, warrantyTypeRu } from '../lib/warranty';

/**
 * Гарантии по конкретной единице техники — на её же карточке.
 *
 * Реестр «Гарантии» был заведён целиком (сервер, страница, пункт меню), но
 * `warranties.listByAsset` не звался ниоткуда: на карточке техники и в заявке
 * показывалось только поле `assets.warranty_until` — дата из карточки аппарата,
 * к реестру отношения не имеющая. Гарантия при этом решает, платный ремонт или
 * бесплатный, то есть человек, выставляющий счёт, о ней просто не знал.
 *
 * Заводить и править гарантии может staff (`create`/`update` — staffProcedure),
 * поэтому инженеру кнопку не показываем.
 */
export function AssetWarranties({ assetId, canEdit }: { assetId: string; canEdit: boolean }) {
  const q = trpc.warranties.listByAsset.useQuery({ assetId }, { enabled: !!assetId });
  const list = q.data ?? [];
  const covering = pickCoveringWarranty(list);

  return (
    <section className="bg-card rounded-lg border p-4 md:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide">
          <ShieldCheck className="h-4 w-4" />
          Гарантии ({list.length})
        </h2>
        {canEdit && (
          <Link
            href={`/warranties/new?assetId=${assetId}`}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
          >
            <Plus className="h-3 w-3" />
            Добавить гарантию
          </Link>
        )}
      </div>

      {covering && (
        <div className="border-success/40 bg-success/10 mt-3 rounded-md border p-3 text-sm">
          <b>Техника на гарантии</b> до {formatDate(covering.endDate)} —{' '}
          {warrantyTypeRu(covering.type)}
          {covering.provider ? `, ${covering.provider}` : ''}. Ремонт по ней для клиента бесплатный.
        </div>
      )}

      {q.error ? (
        <QueryError
          error={q.error}
          paused={q.fetchStatus === 'paused'}
          what="гарантии"
          onRetry={() => void q.refetch()}
          className="mt-3"
        />
      ) : q.isLoading ? (
        <div className="text-muted-foreground mt-3 text-sm">Загрузка…</div>
      ) : list.length === 0 ? (
        <p className="text-muted-foreground mt-3 text-sm">
          Гарантий на эту технику не заведено. Ремонт считается платным.
        </p>
      ) : (
        <ul className="mt-3 space-y-2">
          {list.map((w) => (
            <li key={w.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-sm">
              <Link
                href={`/warranties/${w.id}/edit`}
                className="hover:text-primary font-medium capitalize"
              >
                {warrantyTypeRu(w.type)}
              </Link>
              <span
                className={cn(
                  'rounded px-1.5 py-0.5 text-[11px] font-medium',
                  w.status === 'active'
                    ? 'bg-success/10 text-success'
                    : w.status === 'expiring'
                      ? 'bg-warning/10 text-warning'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {warrantyStatusRu(w.status)}
              </span>
              <span className="text-muted-foreground text-xs">
                {formatDate(w.startDate)} — {formatDate(w.endDate)}
              </span>
              {w.provider && <span className="text-muted-foreground text-xs">{w.provider}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Даты гарантий приходят строкой YYYY-MM-DD — показываем по-русски. */
function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return y && m && d ? `${d}.${m}.${y}` : iso;
}
