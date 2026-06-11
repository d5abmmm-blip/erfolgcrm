import { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2, Wrench, Package, Coins, Boxes } from 'lucide-react';
import type { VatRate, WorkOrderLineType } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { IssueFromInventory } from './IssueFromInventory';
import { ReturnToInventory } from './ReturnToInventory';

interface Props {
  ticketId: string;
  canEdit: boolean;
  /** Если true — даём редактировать ставку НДС (директор/диспетчер). */
  canEditVat: boolean;
}

interface LineDraft {
  /** UUID существующей строки или null для новой. */
  id: string | null;
  lineType: WorkOrderLineType;
  name: string;
  unit: string;
  quantity: string;
  unitPriceRub: string;
}

const LINE_GROUPS: Array<{
  type: WorkOrderLineType;
  title: string;
  icon: typeof Wrench;
  totalKey: 'worksAmountKopecks' | 'partsAmountKopecks' | 'expensesAmountKopecks';
}> = [
  { type: 'work', title: 'Работы', icon: Wrench, totalKey: 'worksAmountKopecks' },
  { type: 'part', title: 'Запчасти', icon: Package, totalKey: 'partsAmountKopecks' },
  { type: 'expense', title: 'Прочие расходы', icon: Coins, totalKey: 'expensesAmountKopecks' },
];

const VAT_OPTS: Array<{ v: VatRate; label: string }> = [
  { v: '0', label: '0%' },
  { v: '5', label: '5% (льготная)' },
  { v: '10', label: '10%' },
  { v: '20', label: '20%' },
  { v: 'without_vat', label: 'без НДС' },
];

export function WorkOrderEditor({ ticketId, canEdit, canEditVat }: Props) {
  const utils = trpc.useUtils();
  const wo = trpc.workOrders.getByTicket.useQuery({ ticketId });

  const ensure = trpc.workOrders.ensure.useMutation({
    onSuccess: async () => {
      await utils.workOrders.getByTicket.invalidate({ ticketId });
    },
  });

  if (wo.isLoading) {
    return <div className="text-muted-foreground text-sm">Загрузка наряда…</div>;
  }
  if (wo.error) {
    return (
      <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-3 text-sm">
        Не удалось загрузить наряд: {wo.error.message}
      </div>
    );
  }
  if (!wo.data) {
    return (
      <div className="bg-muted/40 flex items-center justify-between rounded-md border p-4 text-sm">
        <span className="text-muted-foreground">Наряд для этой заявки ещё не создан</span>
        {canEdit && (
          <button
            type="button"
            disabled={ensure.isPending}
            onClick={() => ensure.mutate({ ticketId })}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
          >
            <Plus className="h-3.5 w-3.5" />
            Создать наряд
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <WorkOrderHeader
        ticketId={ticketId}
        diagnosis={wo.data.diagnosis}
        repairDescription={wo.data.repairDescription}
        recommendation={wo.data.recommendation}
        vatRate={wo.data.vatRate}
        canEdit={canEdit}
        canEditVat={canEditVat}
      />

      {LINE_GROUPS.map((g) => (
        <LineTable
          key={g.type}
          ticketId={ticketId}
          lineType={g.type}
          title={g.title}
          icon={g.icon}
          totalKopecks={wo.data![g.totalKey]}
          lines={wo.data!.lines.filter((l) => l.lineType === g.type)}
          canEdit={canEdit}
        />
      ))}

      <Totals
        works={wo.data.worksAmountKopecks}
        parts={wo.data.partsAmountKopecks}
        expenses={wo.data.expensesAmountKopecks}
        total={wo.data.totalAmountKopecks}
        vatRate={wo.data.vatRate}
      />
    </div>
  );
}

function WorkOrderHeader({
  ticketId,
  diagnosis,
  repairDescription,
  recommendation,
  vatRate,
  canEdit,
  canEditVat,
}: {
  ticketId: string;
  diagnosis: string | null;
  repairDescription: string | null;
  recommendation: string | null;
  vatRate: VatRate;
  canEdit: boolean;
  canEditVat: boolean;
}) {
  const utils = trpc.useUtils();
  const updateHeader = trpc.workOrders.updateHeader.useMutation({
    onSuccess: () => utils.workOrders.getByTicket.invalidate({ ticketId }),
  });
  const setVat = trpc.workOrders.setVatRate.useMutation({
    onSuccess: () => utils.workOrders.getByTicket.invalidate({ ticketId }),
  });

  const blurSave = (
    field: 'diagnosis' | 'repairDescription' | 'recommendation',
    initial: string | null,
  ) => (e: React.FocusEvent<HTMLTextAreaElement>) => {
    const next = e.target.value.trim() || null;
    if (next === (initial ?? null)) return;
    updateHeader.mutate({ ticketId, patch: { [field]: next } });
  };

  return (
    <div className="bg-card space-y-3 rounded-lg border p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field
          label="Диагноз"
          defaultValue={diagnosis ?? ''}
          disabled={!canEdit}
          onBlur={blurSave('diagnosis', diagnosis)}
        />
        <Field
          label="Описание ремонта"
          defaultValue={repairDescription ?? ''}
          disabled={!canEdit}
          onBlur={blurSave('repairDescription', repairDescription)}
        />
        <Field
          label="Рекомендации"
          defaultValue={recommendation ?? ''}
          disabled={!canEdit}
          onBlur={blurSave('recommendation', recommendation)}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs uppercase">Ставка НДС</span>
        <select
          disabled={!canEditVat}
          value={vatRate}
          onChange={(e) => setVat.mutate({ ticketId, vatRate: e.target.value as VatRate })}
          className="bg-background rounded-md border px-2 py-1 text-xs outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
        >
          {VAT_OPTS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
        {!canEditVat && (
          <span className="text-muted-foreground text-[11px]">меняет директор/диспетчер</span>
        )}
      </div>
    </div>
  );
}

function Field({
  label,
  defaultValue,
  disabled,
  onBlur,
}: {
  label: string;
  defaultValue: string;
  disabled?: boolean;
  onBlur: (e: React.FocusEvent<HTMLTextAreaElement>) => void;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 text-[11px] uppercase">{label}</div>
      <textarea
        defaultValue={defaultValue}
        disabled={disabled}
        rows={3}
        onBlur={onBlur}
        className="bg-background w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
      />
    </div>
  );
}

function LineTable({
  ticketId,
  lineType,
  title,
  icon: Icon,
  totalKopecks,
  lines,
  canEdit,
}: {
  ticketId: string;
  lineType: WorkOrderLineType;
  title: string;
  icon: typeof Wrench;
  totalKopecks: string;
  lines: Array<{
    id: string;
    name: string;
    unit: string;
    quantity: string;
    unitPriceKopecks: string;
    amountKopecks: string;
    inventoryItemId: string | null;
  }>;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const upsert = trpc.workOrders.upsertLine.useMutation({
    onSuccess: () => utils.workOrders.getByTicket.invalidate({ ticketId }),
  });
  const remove = trpc.workOrders.deleteLine.useMutation({
    onSuccess: () => utils.workOrders.getByTicket.invalidate({ ticketId }),
  });

  // Локальные «ещё не сохранённые» новые строки. После первого успешного upsert
  // строка прилетит из data — локальная скрывается.
  const [drafts, setDrafts] = useState<LineDraft[]>([]);
  const [issuingFromInventory, setIssuingFromInventory] = useState(false);
  const [returningToInventory, setReturningToInventory] = useState(false);

  // Если строка с тем же id появилась в lines — выкидываем её из drafts.
  useEffect(() => {
    setDrafts((prev) => prev.filter((d) => !d.id || !lines.find((l) => l.id === d.id)));
  }, [lines]);

  const addRow = () => {
    setDrafts((prev) => [
      ...prev,
      {
        id: null,
        lineType,
        name: '',
        unit: 'шт',
        quantity: '1',
        unitPriceRub: '0',
      },
    ]);
  };

  const saveLine = (line: LineDraft) => {
    if (!line.name.trim()) return; // пустые не сохраняем
    const qty = line.quantity.trim() || '0';
    const priceRub = Math.max(0, Math.round(Number(line.unitPriceRub) || 0));
    upsert.mutate(
      {
        ticketId,
        line: {
          id: line.id ?? undefined,
          lineType,
          name: line.name.trim(),
          unit: line.unit.trim() || 'шт',
          quantity: qty,
          unitPriceRub: priceRub,
        },
      },
      {
        onSuccess: (res) => {
          if (!line.id) {
            // подставим id, чтобы дальнейшие onBlur пошли как update
            setDrafts((prev) =>
              prev.map((d) => (d === line ? { ...d, id: res.id } : d)),
            );
          }
        },
      },
    );
  };

  return (
    <div className="bg-card rounded-lg border">
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="inline-flex items-center gap-1.5 text-sm font-semibold">
          <Icon className="text-primary h-4 w-4" />
          {title}
        </div>
        <div className="text-muted-foreground text-xs tabular-nums">
          итого {kopecksToRub(totalKopecks)} ₽
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-muted-foreground text-[11px] uppercase tracking-wide">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Наименование</th>
              <th className="w-20 px-3 py-2 text-left font-medium">Ед.</th>
              <th className="w-24 px-3 py-2 text-right font-medium">Кол-во</th>
              <th className="w-32 px-3 py-2 text-right font-medium">Цена ₽</th>
              <th className="w-32 px-3 py-2 text-right font-medium">Сумма ₽</th>
              <th className="w-10 px-2 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {lines.length === 0 && drafts.length === 0 && (
              <tr>
                <td colSpan={6} className="text-muted-foreground p-3 text-center text-xs">
                  пусто
                </td>
              </tr>
            )}
            {lines.map((l) => (
              <ExistingRow
                key={l.id}
                line={l}
                ticketId={ticketId}
                lineType={lineType}
                canEdit={canEdit}
                onDelete={() => remove.mutate({ ticketId, lineId: l.id })}
              />
            ))}
            {drafts.map((d, idx) => (
              <DraftRow
                key={`draft-${idx}`}
                draft={d}
                onChange={(patch) =>
                  setDrafts((prev) =>
                    prev.map((x, i) => (i === idx ? { ...x, ...patch } : x)),
                  )
                }
                onSave={() => saveLine(drafts[idx]!)}
                onCancel={() =>
                  setDrafts((prev) => prev.filter((_, i) => i !== idx))
                }
              />
            ))}
          </tbody>
        </table>
      </div>
      {canEdit && (
        <div className="flex items-center gap-1 border-t p-2">
          <button
            type="button"
            onClick={addRow}
            className="text-muted-foreground hover:text-foreground hover:bg-muted/40 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs"
          >
            <Plus className="h-3.5 w-3.5" />
            Добавить строку
          </button>
          {lineType === 'part' && (
            <>
              <button
                type="button"
                onClick={() => setIssuingFromInventory(true)}
                className="text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs"
              >
                <Boxes className="h-3.5 w-3.5" />
                Списать со склада
              </button>
              {lines.some((l) => l.inventoryItemId) && (
                <button
                  type="button"
                  onClick={() => setReturningToInventory(true)}
                  className="text-muted-foreground hover:text-foreground hover:bg-muted/40 inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs"
                >
                  <Boxes className="h-3.5 w-3.5 rotate-180" />
                  Вернуть на склад
                </button>
              )}
            </>
          )}
        </div>
      )}
      {issuingFromInventory && (
        <IssueFromInventory
          ticketId={ticketId}
          onClose={() => setIssuingFromInventory(false)}
          onIssued={() => setIssuingFromInventory(false)}
        />
      )}
      {returningToInventory && (
        <ReturnToInventory
          ticketId={ticketId}
          lines={lines.map((l) => ({
            id: l.id,
            name: l.name,
            quantity: l.quantity,
            inventoryItemId: l.inventoryItemId,
            lineType,
          }))}
          onClose={() => setReturningToInventory(false)}
          onReturned={() => setReturningToInventory(false)}
        />
      )}
    </div>
  );
}

function ExistingRow({
  line,
  ticketId,
  lineType,
  canEdit,
  onDelete,
}: {
  line: {
    id: string;
    name: string;
    unit: string;
    quantity: string;
    unitPriceKopecks: string;
    amountKopecks: string;
  };
  ticketId: string;
  lineType: WorkOrderLineType;
  canEdit: boolean;
  onDelete: () => void;
}) {
  const utils = trpc.useUtils();
  const upsert = trpc.workOrders.upsertLine.useMutation({
    onSuccess: () => utils.workOrders.getByTicket.invalidate({ ticketId }),
  });
  // Используем locally controlled значения, чтобы onBlur мог сравнить с исходным
  const initialPriceRub = useMemo(
    () => kopecksToRubInput(line.unitPriceKopecks),
    [line.unitPriceKopecks],
  );

  const handleBlur = (
    field: 'name' | 'unit' | 'quantity' | 'unitPriceRub',
    value: string,
    extras: { name: string; unit: string; quantity: string; unitPriceRub: string },
  ) => {
    if (!extras.name.trim()) return;
    const priceRub = Math.max(0, Math.round(Number(extras.unitPriceRub) || 0));
    // не отправляем если ничего не изменилось
    const changed =
      (field === 'name' && value !== line.name) ||
      (field === 'unit' && value !== line.unit) ||
      (field === 'quantity' && value !== line.quantity) ||
      (field === 'unitPriceRub' && Number(value) !== Number(initialPriceRub));
    if (!changed) return;
    upsert.mutate({
      ticketId,
      line: {
        id: line.id,
        lineType,
        name: extras.name.trim(),
        unit: extras.unit.trim() || 'шт',
        quantity: extras.quantity.trim() || '0',
        unitPriceRub: priceRub,
      },
    });
  };

  return (
    <RowInputs
      key={line.id}
      initial={{
        name: line.name,
        unit: line.unit,
        quantity: line.quantity,
        unitPriceRub: initialPriceRub,
      }}
      amountKopecks={line.amountKopecks}
      canEdit={canEdit}
      onFieldBlur={handleBlur}
      onDelete={onDelete}
    />
  );
}

function DraftRow({
  draft,
  onChange,
  onSave,
  onCancel,
}: {
  draft: LineDraft;
  onChange: (patch: Partial<LineDraft>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const amountKop = useMemo(() => {
    const qty = Number(draft.quantity) || 0;
    const price = Number(draft.unitPriceRub) || 0;
    return BigInt(Math.round(qty * price * 100)).toString();
  }, [draft.quantity, draft.unitPriceRub]);
  return (
    <RowInputs
      initial={{
        name: draft.name,
        unit: draft.unit,
        quantity: draft.quantity,
        unitPriceRub: draft.unitPriceRub,
      }}
      controlled
      amountKopecks={amountKop}
      canEdit
      onChange={onChange}
      onFieldBlur={() => onSave()}
      onDelete={onCancel}
      isDraft
    />
  );
}

function RowInputs({
  initial,
  amountKopecks,
  canEdit,
  controlled,
  onChange,
  onFieldBlur,
  onDelete,
  isDraft,
}: {
  initial: { name: string; unit: string; quantity: string; unitPriceRub: string };
  amountKopecks: string;
  canEdit: boolean;
  controlled?: boolean;
  onChange?: (patch: Partial<LineDraft>) => void;
  onFieldBlur: (
    field: 'name' | 'unit' | 'quantity' | 'unitPriceRub',
    value: string,
    extras: { name: string; unit: string; quantity: string; unitPriceRub: string },
  ) => void;
  onDelete: () => void;
  isDraft?: boolean;
}) {
  const [vals, setVals] = useState(initial);
  // Если приходят новые значения снаружи (после mutation refetch) — синхронизируем
  useEffect(() => {
    if (!controlled) setVals(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.name, initial.unit, initial.quantity, initial.unitPriceRub]);

  const update = (patch: Partial<typeof vals>) => {
    setVals((prev) => ({ ...prev, ...patch }));
    onChange?.(patch);
  };

  return (
    <tr className={cn(isDraft && 'bg-primary/5')}>
      <td className="px-3 py-1.5">
        <input
          type="text"
          value={vals.name}
          disabled={!canEdit}
          onChange={(e) => update({ name: e.target.value })}
          onBlur={(e) => onFieldBlur('name', e.target.value, vals)}
          className="bg-background w-full rounded-md border px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          placeholder="Что выполнено"
        />
      </td>
      <td className="px-3 py-1.5">
        <input
          type="text"
          value={vals.unit}
          disabled={!canEdit}
          onChange={(e) => update({ unit: e.target.value })}
          onBlur={(e) => onFieldBlur('unit', e.target.value, vals)}
          className="bg-background w-full rounded-md border px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-primary/40"
        />
      </td>
      <td className="px-3 py-1.5">
        <input
          type="number"
          step="0.01"
          min="0"
          value={vals.quantity}
          disabled={!canEdit}
          onChange={(e) => update({ quantity: e.target.value })}
          onBlur={(e) => onFieldBlur('quantity', e.target.value, vals)}
          className="bg-background w-full rounded-md border px-2 py-1 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
        />
      </td>
      <td className="px-3 py-1.5">
        <input
          type="number"
          step="1"
          min="0"
          value={vals.unitPriceRub}
          disabled={!canEdit}
          onChange={(e) => update({ unitPriceRub: e.target.value })}
          onBlur={(e) => onFieldBlur('unitPriceRub', e.target.value, vals)}
          className="bg-background w-full rounded-md border px-2 py-1 text-right text-sm tabular-nums outline-none focus:ring-2 focus:ring-primary/40"
        />
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">
        {kopecksToRub(amountKopecks)}
      </td>
      <td className="px-2 py-1.5 text-center">
        {canEdit && (
          <button
            type="button"
            onClick={onDelete}
            className="text-muted-foreground hover:text-destructive"
            aria-label={isDraft ? 'Удалить черновик' : 'Удалить строку'}
            title={isDraft ? 'Удалить черновик' : 'Удалить строку'}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        )}
      </td>
    </tr>
  );
}

function Totals({
  works,
  parts,
  expenses,
  total,
  vatRate,
}: {
  works: string;
  parts: string;
  expenses: string;
  total: string;
  vatRate: VatRate;
}) {
  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="grid grid-cols-2 gap-y-1 text-sm md:grid-cols-4">
        <div className="text-muted-foreground">Итого работы</div>
        <div className="text-right tabular-nums">{kopecksToRub(works)} ₽</div>
        <div className="text-muted-foreground">Итого запчасти</div>
        <div className="text-right tabular-nums">{kopecksToRub(parts)} ₽</div>
        <div className="text-muted-foreground">Итого расходы</div>
        <div className="text-right tabular-nums">{kopecksToRub(expenses)} ₽</div>
        <div className="text-foreground font-semibold">
          ВСЕГО ({vatRate === 'without_vat' ? 'без НДС' : `с НДС ${vatRate}%`})
        </div>
        <div className="text-right text-base font-semibold tabular-nums">
          {kopecksToRub(total)} ₽
        </div>
      </div>
    </div>
  );
}

/**
 * Форматирует копейки в строку «12 345,67» с группами тысяч.
 * Принимает bigint в виде string (как сериализуется на API).
 */
export function kopecksToRub(s: string): string {
  if (!s) return '0,00';
  const neg = s.startsWith('-');
  const raw = neg ? s.slice(1) : s;
  const padded = raw.padStart(3, '0');
  const intPart = padded.slice(0, -2);
  const fracPart = padded.slice(-2);
  // вставляем неразрывные пробелы каждые 3 цифры
  const grouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${neg ? '−' : ''}${grouped},${fracPart}`;
}

/** Возвращает копейки → рубли как обычное число в виде строки для input number. */
function kopecksToRubInput(s: string): string {
  if (!s || s === '0') return '0';
  // целое число рублей округляем (не теряем копейки если они есть, но input целочисленный)
  const big = BigInt(s);
  const rub = big / 100n;
  return rub.toString();
}
