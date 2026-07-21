import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import { ArrowLeft, Package, Plus, Trash2 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { kopecksToRub } from '../lib/money';
import { InventoryBatchForm } from '../components/InventoryBatchForm';
import { PhotoUploader } from '../components/PhotoUploader';
import { ConfirmDialog } from '../components/ui';
import { QueryError } from '../components/QueryError';

export function InventoryItemPage() {
  const [match, params] = useRoute('/inventory/:id');
  const itemId = match ? params.id : '';
  const [showBatchForm, setShowBatchForm] = useState(false);
  const [writeoffBatch, setWriteoffBatch] = useState<{ id: string; remaining: string } | null>(
    null,
  );

  const item = trpc.inventoryItems.get.useQuery(
    { id: itemId },
    { enabled: itemId.length > 0 },
  );
  const batches = trpc.inventoryBatches.listByItem.useQuery(
    { itemId },
    { enabled: itemId.length > 0 },
  );
  const movements = trpc.inventoryItems.movements.useQuery(
    { itemId, limit: 30 },
    { enabled: itemId.length > 0 },
  );

  const utils = trpc.useUtils();
  const writeoff = trpc.inventoryBatches.writeoff.useMutation({
    onSuccess: () => {
      setWriteoffBatch(null);
      void utils.inventoryBatches.listByItem.invalidate({ itemId });
      void utils.inventoryItems.movements.invalidate({ itemId });
      void utils.inventoryItems.get.invalidate({ id: itemId });
    },
  });

  if (!match) return null;
  if (item.isLoading) return <div className="p-6 text-muted-foreground text-sm">Загрузка…</div>;
  // Без этой ветки сбой загрузки выглядел как «Позиция не найдена» — то есть склад
  // сообщал об удалении позиции, которая на самом деле на месте.
  if (item.error) {
    return (
      <div className="p-6">
        <QueryError
          error={item.error}
          paused={item.fetchStatus === 'paused'}
          what="позицию склада"
          onRetry={() => void item.refetch()}
        />
      </div>
    );
  }
  if (!item.data) return <div className="p-6 text-destructive text-sm">Позиция не найдена</div>;

  const it = item.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-4 md:p-6">
      <Link
        href="/inventory"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        К списку склада
      </Link>

      <header className="bg-card rounded-lg border p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-muted-foreground flex items-center gap-2 text-xs uppercase tracking-wide">
              <Package className="h-3.5 w-3.5" />
              Позиция склада
            </div>
            <h1 className="mt-0.5 text-xl font-semibold md:text-2xl">{it.name}</h1>
            {it.manufacturer && (
              <div className="text-muted-foreground text-sm">{it.manufacturer}</div>
            )}
          </div>
          <div className="text-right">
            <div className="text-muted-foreground text-xs uppercase">Остаток</div>
            <div className="text-2xl font-bold tabular-nums">
              {it.totalRemaining}
              <span className="text-muted-foreground ml-1 text-sm font-normal">{it.unit}</span>
            </div>
          </div>
        </div>
        <div className="text-muted-foreground mt-3 grid grid-cols-2 gap-3 text-xs md:grid-cols-4">
          <Info label="Артикул" value={it.sku} />
          <Info label="Категория" value={it.category} />
          <Info label="Мин. остаток" value={it.minStock !== '0' ? `${it.minStock} ${it.unit}` : null} />
          <Info label="Единица" value={it.unit} />
        </div>
      </header>

      <section className="bg-card overflow-hidden rounded-lg border">
        <div className="flex items-center justify-between border-b p-3">
          <h2 className="text-sm font-semibold">Партии (FEFO-порядок)</h2>
          <button
            type="button"
            onClick={() => setShowBatchForm(true)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1 rounded-md px-2.5 py-1.5 text-xs font-medium transition"
          >
            <Plus className="h-3.5 w-3.5" />
            Приход
          </button>
        </div>
        {batches.isLoading ? (
          <div className="text-muted-foreground p-4 text-center text-sm">Загрузка…</div>
        ) : batches.data && batches.data.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Код</th>
                <th className="px-3 py-2 text-left font-medium">Поставщик</th>
                <th className="px-3 py-2 text-left font-medium">Принято</th>
                <th className="px-3 py-2 text-left font-medium">Срок</th>
                <th className="px-3 py-2 text-right font-medium">Остаток / Изначально</th>
                <th className="px-3 py-2 text-right font-medium">Цена ₽</th>
                <th className="px-2 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {batches.data.map((b) => {
                const expired = b.expiresAt && b.expiresAt.getTime() < Date.now();
                const empty = Number(b.quantityRemaining) === 0;
                return (
                  <tr key={b.id} className={cn('hover:bg-muted/20 transition', empty && 'opacity-50')}>
                    <td className="px-3 py-2 font-mono text-xs">{b.batchCode ?? '—'}</td>
                    <td className="px-3 py-2">{b.supplier ?? '—'}</td>
                    <td className="text-muted-foreground px-3 py-2 text-xs">
                      {b.receivedAt.toLocaleDateString('ru-RU')}
                    </td>
                    <td className={cn('px-3 py-2 text-xs', expired && 'text-destructive font-medium')}>
                      {b.expiresAt ? b.expiresAt.toLocaleDateString('ru-RU') : 'без срока'}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {b.quantityRemaining} / {b.quantityInitial}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {kopecksToRub(b.unitCostKopecks)}
                    </td>
                    <td className="px-2 py-2 text-center">
                      {!empty && (
                        <button
                          type="button"
                          onClick={() =>
                            setWriteoffBatch({
                              id: b.id,
                              remaining: String(b.quantityRemaining),
                            })
                          }
                          className="text-muted-foreground hover:text-destructive"
                          aria-label="Списать"
                          title="Списать остаток"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div className="text-muted-foreground p-4 text-center text-sm">Партий пока нет</div>
        )}
      </section>

      <ConfirmDialog
        open={writeoffBatch !== null}
        title="Списать остаток партии?"
        description={
          writeoffBatch
            ? `Остаток ${writeoffBatch.remaining} будет списан со склада. Движение попадёт в журнал.`
            : undefined
        }
        variant="danger"
        confirmText="Списать"
        loading={writeoff.isPending}
        onConfirm={() =>
          writeoffBatch &&
          writeoff.mutate({ batchId: writeoffBatch.id, comment: 'Списание партии' })
        }
        onCancel={() => setWriteoffBatch(null)}
      />

      <section className="bg-card overflow-hidden rounded-lg border">
        <div className="border-b p-3">
          <h2 className="text-sm font-semibold">Движения</h2>
        </div>
        {movements.data && movements.data.length > 0 ? (
          <table className="w-full text-sm">
            <thead className="bg-muted/40 text-muted-foreground text-xs uppercase tracking-wide">
              <tr>
                <th className="px-3 py-2 text-left font-medium">Дата</th>
                <th className="px-3 py-2 text-left font-medium">Тип</th>
                <th className="px-3 py-2 text-right font-medium">Кол-во</th>
                <th className="px-3 py-2 text-left font-medium">Связано с</th>
                <th className="px-3 py-2 text-left font-medium">Комментарий</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {movements.data.map((m) => (
                <tr key={m.id} className="hover:bg-muted/20 transition">
                  <td className="text-muted-foreground px-3 py-2 text-xs tabular-nums">
                    {m.createdAt.toLocaleString('ru-RU')}
                  </td>
                  <td className="px-3 py-2">
                    <KindBadge kind={m.kind as 'inbound' | 'outbound' | 'adjustment' | 'writeoff'} />
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">{m.quantity}</td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">
                    {m.referenceType === 'work_order_line' ? 'наряд' : 'ручное'}
                  </td>
                  <td className="text-muted-foreground px-3 py-2 text-xs">{m.comment ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="text-muted-foreground p-4 text-center text-sm">Движений пока нет</div>
        )}
      </section>

      {batches.data && batches.data.length > 0 && (
        <BatchAttachments batches={batches.data} />
      )}

      {showBatchForm && (
        <InventoryBatchForm
          itemId={itemId}
          onClose={() => setShowBatchForm(false)}
          onSaved={() => {
            setShowBatchForm(false);
            void utils.inventoryBatches.listByItem.invalidate({ itemId });
            void utils.inventoryItems.movements.invalidate({ itemId });
            void utils.inventoryItems.get.invalidate({ id: itemId });
          }}
        />
      )}
    </div>
  );
}

interface BatchSlim {
  id: string;
  batchCode: string | null;
  receivedAt: Date;
}

function BatchAttachments({ batches }: { batches: BatchSlim[] }) {
  const [selectedId, setSelectedId] = useState(batches[0]?.id ?? '');
  if (!selectedId && batches[0]) {
    return null;
  }
  return (
    <section className="bg-card overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b p-3">
        <h2 className="text-sm font-semibold">Накладные и фото партии</h2>
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="bg-background rounded-md border px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-primary/40"
        >
          {batches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.batchCode ?? '—'} · {new Date(b.receivedAt).toLocaleDateString('ru-RU')}
            </option>
          ))}
        </select>
      </div>
      <div className="p-3">
        <PhotoUploader
          kind="inventory_receipt"
          referenceType="inventory_batch"
          referenceId={selectedId}
          canUpload={true}
          hint="Скан накладной поставщика, фото партии, сертификаты"
        />
      </div>
    </section>
  );
}

function Info({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <div className="uppercase">{label}</div>
      <div className="text-foreground mt-0.5 font-medium">
        {value ?? <span className="text-muted-foreground">—</span>}
      </div>
    </div>
  );
}

const KIND_LABEL: Record<'inbound' | 'outbound' | 'adjustment' | 'writeoff', string> = {
  inbound: 'Приход',
  outbound: 'Расход',
  adjustment: 'Корректировка',
  writeoff: 'Списание',
};

const KIND_CLS: Record<'inbound' | 'outbound' | 'adjustment' | 'writeoff', string> = {
  inbound: 'bg-success/10 text-success',
  outbound: 'bg-primary/10 text-primary',
  adjustment: 'bg-muted text-muted-foreground',
  writeoff: 'bg-destructive/10 text-destructive',
};

function KindBadge({ kind }: { kind: 'inbound' | 'outbound' | 'adjustment' | 'writeoff' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
        KIND_CLS[kind],
      )}
    >
      {KIND_LABEL[kind]}
    </span>
  );
}
