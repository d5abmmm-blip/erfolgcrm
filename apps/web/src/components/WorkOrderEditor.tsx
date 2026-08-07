/**
 * Редактор наряда. Открывается и на десктопе (карточка заявки), и на телефоне
 * инженера (`/m/tickets/:id/work-log`) — другой формы наряда в приложении нет.
 *
 * Четыре свойства, на которых держится сохранность работы инженера в поле:
 *  1. Кнопки «Сохранить» нет — пишем по уходу курсора из поля.
 *  2. Уход С ЭКРАНА («назад», сворачивание, выгрузка PWA) — тоже момент записи:
 *     курсор при этом из поля не выходит, и раньше набранное просто исчезало
 *     (см. lib/use-flush-on-leave).
 *  3. Пропала связь → правка ложится в оффлайн-очередь и уходит сама (см. lib/offline).
 *  4. Одна строка = одна запись: пока сервер не вернул номер новой строки,
 *     повторные сохранения не отправляются, иначе он вставил бы дубли.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  CloudOff,
  Plus,
  Trash2,
  Wrench,
  Package,
  Coins,
  Boxes,
  Sparkles,
} from 'lucide-react';
import type { VatRate, WorkOrderLineType } from '@erfolg/shared';
import { trpc, getTenantSubdomain } from '../lib/trpc';
import { cn } from '../lib/utils';
import { executeOrQueue } from '../lib/offline/executor';
import { listPending, removeByDedupeKey, subscribe as subscribeOutbox } from '../lib/offline/queue';
import { humanizeError, SILENT_ERROR } from '../lib/error-message';
import { showToast } from '../lib/toast';
import { useOutbox } from '../lib/offline/useOutbox';
import { useFlushOnLeave } from '../lib/use-flush-on-leave';
import { useSaveMark } from '../lib/use-save-mark';
import type { SaveMarkState } from '../lib/save-state';
import { SaveMark } from './SaveMark';
import { IssueFromInventory } from './IssueFromInventory';
import { ReturnToInventory } from './ReturnToInventory';

/** Отметка «записываю…/записано/ждёт связи» одного поля. */
type HeaderMark = ReturnType<typeof useSaveMark>;

interface Props {
  ticketId: string;
  /** Номер заявки — подпись к записи в очереди, чтобы человек узнал её глазами. */
  ticketNumber?: string;
  canEdit: boolean;
  /** Если true — даём редактировать ставку НДС (директор/диспетчер). */
  canEditVat: boolean;
}

interface LineDraft {
  /**
   * Локальная метка строки, живёт от «Добавить строку» до появления строки
   * с сервера. Именно по ней подставляется номер и склеиваются повторы —
   * сравнивать сами объекты нельзя: любой введённый символ пересоздаёт объект.
   */
  uid: string;
  /** UUID существующей строки или null для новой. */
  id: string | null;
  lineType: WorkOrderLineType;
  name: string;
  unit: string;
  quantity: string;
  unitPriceRub: string;
  /**
   * Кто выполнял эту работу. Заполняется только у строк «Работы»: именно по нему
   * ведомость ЗП делит деньги между инженерами (payroll группирует по
   * COALESCE(line.engineer_id, work_order.engineer_id)). Пусто = вся строка уходит
   * инженеру наряда, как было раньше.
   */
  engineerId: string | null;
  /** Строка лежит в оффлайн-очереди и ждёт связи. */
  queued?: boolean;
}

let draftSeq = 0;
function newDraftUid(): string {
  return `d${++draftSeq}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Ключ склейки повторов в оффлайн-очереди: одна строка наряда — одна запись. */
function lineDedupeKey(ticketId: string, lineIdOrUid: string): string {
  return `wo-line:${ticketId}:${lineIdOrUid}`;
}

const QUEUED_TEXT = 'Нет связи — сохранено в очередь, уйдёт когда появится сеть';

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

export function WorkOrderEditor({ ticketId, ticketNumber, canEdit, canEditVat }: Props) {
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
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium disabled:opacity-50"
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
        key={ticketId}
        ticketId={ticketId}
        ticketNumber={ticketNumber}
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
          ticketNumber={ticketNumber}
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

      {canEdit && <DoneButton />}
    </div>
  );
}

/**
 * Кнопка «Готово», которой инженеру не хватало.
 *
 * ВАЖНО, ЧТО ОНА ДЕЛАЕТ: снимает курсор с поля — и срабатывает та же самая
 * запись по уходу курсора, что и всегда. Она НЕ отправляет ничего сама.
 *
 * Кнопка, которая сама зовёт сохранение, завела бы ВТОРОЙ путь записи рядом
 * с существующим. А на правиле «одна строка = одна запись» держится защита
 * наряда от дублей (см. шапку файла): пока сервер не вернул номер новой
 * строки, повторная отправка вставила бы вторую такую же — то есть задвоила
 * бы и счёт клиенту, и сделку в зарплате.
 *
 * Здесь же — общее слово о том, что происходит с накопленным.
 */
function DoneButton() {
  const outbox = useOutbox();
  const waiting = outbox.pending > 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
      <span
        className={cn(
          'inline-flex items-center gap-1.5 text-xs',
          waiting ? 'text-warning' : 'text-muted-foreground',
        )}
        role="status"
      >
        {waiting ? (
          <>
            <CloudOff className="h-3.5 w-3.5" />
            Ждёт связи: {outbox.pending} — уйдёт само
          </>
        ) : (
          <>
            <Check className="h-3.5 w-3.5" />
            Всё записано
          </>
        )}
      </span>
      <button
        type="button"
        // Курсор уходит из поля — и запись идёт обычным путём.
        onClick={() => (document.activeElement as HTMLElement | null)?.blur()}
        className="bg-primary text-primary-foreground hover:bg-primary/90 h-11 rounded-lg px-6 text-sm font-semibold transition"
      >
        Готово
      </button>
    </div>
  );
}

function WorkOrderHeader({
  ticketId,
  ticketNumber,
  diagnosis,
  repairDescription,
  recommendation,
  vatRate,
  canEdit,
  canEditVat,
}: {
  ticketId: string;
  ticketNumber?: string;
  diagnosis: string | null;
  repairDescription: string | null;
  recommendation: string | null;
  vatRate: VatRate;
  canEdit: boolean;
  canEditVat: boolean;
}) {
  const utils = trpc.useUtils();
  const tenantSubdomain = getTenantSubdomain();
  // Ошибку/очередь показываем сами — глобальный тост здесь молчит (см. main.tsx).
  const updateHeader = trpc.workOrders.updateHeader.useMutation({ meta: SILENT_ERROR });
  const setVat = trpc.workOrders.setVatRate.useMutation({
    onSuccess: () => utils.workOrders.getByTicket.invalidate({ ticketId }),
  });

  const saveHeader = async (
    field: 'diagnosis' | 'repairDescription' | 'recommendation',
    next: string | null,
    mark?: HeaderMark,
  ) => {
    mark?.markSaving();
    const res = await executeOrQueue(
      'workOrders.updateHeader',
      { ticketId, patch: { [field]: next } },
      (p) => updateHeader.mutateAsync(p),
      tenantSubdomain,
      // Правки одного поля склеиваются: в очереди лежит последнее состояние.
      `wo-header:${ticketId}:${field}`,
      ticketNumber,
    );
    mark?.markResult(res.status);
    if (res.status === 'ok') {
      await utils.workOrders.getByTicket.invalidate({ ticketId });
    } else if (res.status === 'queued') {
      showToast('queued', QUEUED_TEXT);
    } else {
      showToast('error', humanizeError(res.error));
    }
  };

  return (
    <div className="bg-card space-y-3 rounded-lg border p-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <Field
          label="Диагноз"
          initial={diagnosis}
          disabled={!canEdit}
          onSave={(next, mark) => void saveHeader('diagnosis', next, mark)}
        />
        <RepairDescriptionField
          ticketId={ticketId}
          initial={repairDescription}
          canEdit={canEdit}
          onSave={(value) => void saveHeader('repairDescription', value)}
        />
        <Field
          label="Рекомендации"
          initial={recommendation}
          disabled={!canEdit}
          onSave={(next, mark) => void saveHeader('recommendation', next, mark)}
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground text-xs uppercase">Ставка НДС</span>
        <select
          disabled={!canEditVat}
          value={vatRate}
          onChange={(e) => setVat.mutate({ ticketId, vatRate: e.target.value as VatRate })}
          className="bg-background focus:ring-primary/40 rounded-md border px-2 py-1 text-xs outline-none focus:ring-2 disabled:opacity-50"
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

/**
 * Фича №13 — поле «Описание ремонта» с кнопкой «ИИ-черновик».
 * Управляемое (чтобы вписать ИИ-текст), сохраняется по blur, как соседние поля.
 * Кнопка зовёт workOrders.draftRepairDescription; при отсутствии ИИ приходит
 * простой черновик из строк наряда (aiUsed=false) — деградация на стороне API.
 */
function RepairDescriptionField({
  ticketId,
  initial,
  canEdit,
  onSave,
}: {
  ticketId: string;
  initial: string | null;
  canEdit: boolean;
  onSave: (value: string | null) => void;
}) {
  const [value, setValue] = useState(initial ?? '');
  const [note, setNote] = useState<string | null>(null);
  const draft = trpc.workOrders.draftRepairDescription.useMutation({
    onSuccess: (res) => {
      setValue(res.text);
      setNote(
        res.aiUsed
          ? 'Черновик сгенерирован ИИ — проверьте перед сохранением'
          : 'Черновик собран из строк наряда',
      );
    },
  });

  /** Что уже ушло на сервер — см. такой же ref в `Field`. */
  const sent = useRef<string | null>(initial ?? null);
  useEffect(() => {
    sent.current = initial ?? null;
  }, [initial]);
  // Текст читаем из ref: уход с экрана случается вне отрисовки, и замыкание
  // на состояние отдало бы значение на момент подписки.
  const current = useRef(value);
  current.current = value;

  const save = () => {
    if (!canEdit) return;
    const next = current.current.trim() || null;
    if (next === sent.current) return;
    sent.current = next;
    onSave(next);
  };
  /**
   * Отдельная беда ИИ-черновика: кнопка вписывает текст в поле, но курсор в
   * поле не встаёт — уходить оттуда нечему. Без записи по уходу с экрана
   * сгенерированный текст пропадал целиком.
   */
  useFlushOnLeave(save);

  return (
    <div>
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[11px] uppercase">Описание ремонта</span>
        {canEdit && (
          <button
            type="button"
            disabled={draft.isPending}
            onClick={() => draft.mutate({ ticketId })}
            className="text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium disabled:opacity-50"
          >
            <Sparkles className="h-3 w-3" />
            {draft.isPending ? 'ИИ пишет…' : 'ИИ-черновик'}
          </button>
        )}
      </div>
      <textarea
        value={value}
        disabled={!canEdit}
        rows={3}
        onChange={(e) => setValue(e.target.value)}
        onBlur={save}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2 disabled:opacity-60"
      />
      {draft.isError ? (
        <div className="text-destructive mt-1 text-[11px]">
          Не удалось получить черновик: {draft.error.message}
        </div>
      ) : (
        note && <div className="text-muted-foreground mt-1 text-[11px]">{note}</div>
      )}
    </div>
  );
}

/**
 * Поле шапки наряда. Само держит свою отметку состояния: раньше при удачном
 * сохранении оно не показывало ничего, и человек не знал, записалось ли.
 *
 * Пишет в ДВУХ случаях — курсор ушёл из поля и экран ушёл целиком. Второй
 * добавлен потому, что «назад» и сворачивание приложения курсор из поля не
 * выводят, и набранное пропадало вместе с полем.
 */
function Field({
  label,
  initial,
  disabled,
  onSave,
}: {
  label: string;
  initial: string | null;
  disabled?: boolean;
  onSave: (next: string | null, mark: HeaderMark) => void;
}) {
  const mark = useSaveMark();
  const box = useRef<HTMLTextAreaElement>(null);
  /**
   * Последний набранный текст.
   *
   * ⚠️ Ради него всё и написано: на размонтировании React обнуляет ссылку на
   * узел РАНЬШЕ, чем зовёт уборку эффекта, — читать текст из поля в этот
   * момент уже поздно, приходит null. Поле при этом остаётся неуправляемым:
   * так набранное переживает перечитывание наряда с сервера.
   */
  const typed = useRef<string | null>(null);
  /**
   * Что уже ушло на сервер. Сравнивать с приходящим `initial` нельзя: после
   * записи он какое-то время остаётся прежним (пока не перечитается наряд),
   * и уход с экрана отправил бы тот же текст второй раз.
   */
  const sent = useRef<string | null>(initial ?? null);
  useEffect(() => {
    sent.current = initial ?? null;
  }, [initial]);

  const save = () => {
    if (disabled) return;
    const raw = box.current?.value ?? typed.current ?? initial ?? '';
    const next = raw.trim() || null;
    if (next === sent.current) return;
    sent.current = next;
    onSave(next, mark);
  };
  useFlushOnLeave(save);

  return (
    <div>
      <div className="text-muted-foreground mb-1 text-[11px] uppercase">{label}</div>
      <textarea
        ref={box}
        defaultValue={initial ?? ''}
        disabled={disabled}
        rows={3}
        onChange={(e) => {
          typed.current = e.target.value;
        }}
        onBlur={save}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2 disabled:opacity-60"
      />
      <SaveMark state={mark.state} />
    </div>
  );
}

function LineTable({
  ticketId,
  ticketNumber,
  lineType,
  title,
  icon: Icon,
  totalKopecks,
  lines,
  canEdit,
}: {
  ticketId: string;
  ticketNumber?: string;
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
    engineerId: string | null;
  }>;
  canEdit: boolean;
}) {
  const utils = trpc.useUtils();
  const tenantSubdomain = getTenantSubdomain();
  // Список для колонки «Кто делал». Грузим только там, где он нужен — у работ.
  //
  // ⚠️ Просим и ЗАБЛОКИРОВАННЫХ, но показываем лишь тех из них, кто уже стоит в строках
  // этого наряда. Причина: у импортированных нарядов инженер — исторический аккаунт из
  // старой программы (заблокирован). Таких строк 2218. Отфильтруй их — и менеджер увидит
  // «инженер наряда» там, где на самом деле стоит конкретный человек, то есть ЛОЖЬ.
  // Тот же приём уже применён у выбора инженера на карточке заявки.
  const engineersQ = trpc.users.list.useQuery(
    { onlyEngineers: true, includeBlocked: true },
    { enabled: lineType === 'work' },
  );
  const usedEngineerIds = new Set(lines.map((l) => l.engineerId).filter(Boolean));
  const engineerOptions = (engineersQ.data ?? [])
    .filter((u) => u.isActive || usedEngineerIds.has(u.id))
    .map((u) => ({
      id: u.id,
      fullName: u.isActive ? u.fullName : `${u.fullName} (уволен)`,
    }));
  // Ошибку и «легло в очередь» показываем сами — глобальный тост молчит (main.tsx).
  const upsert = trpc.workOrders.upsertLine.useMutation({ meta: SILENT_ERROR });
  const remove = trpc.workOrders.deleteLine.useMutation({ meta: SILENT_ERROR });

  // Локальные «ещё не сохранённые» новые строки. После первого успешного upsert
  // строка прилетит из data — локальная скрывается.
  // Дублируем в ref: сохранение читает СВЕЖИЙ черновик прямо в обработчике,
  // куда состояние React ещё не успело доехать.
  const [drafts, setDrafts] = useState<LineDraft[]>([]);
  const draftsRef = useRef<LineDraft[]>([]);
  const patchDrafts = (fn: (prev: LineDraft[]) => LineDraft[]) => {
    draftsRef.current = fn(draftsRef.current);
    setDrafts(draftsRef.current);
  };

  /** Строки, чей запрос уже в пути: второй посылать нельзя — будет дубль. */
  const inFlight = useRef<Set<string>>(new Set());
  /** Строки, которые правили, пока шёл их же запрос — досохраним после ответа. */
  const resaveNeeded = useRef<Set<string>>(new Set());
  /** Что уже ушло по каждой строке — чтобы уход с экрана не слал то же самое. */
  const lastSent = useRef<Map<string, string>>(new Map());

  const [issuingFromInventory, setIssuingFromInventory] = useState(false);
  const [returningToInventory, setReturningToInventory] = useState(false);

  // Если строка с тем же id появилась в lines — выкидываем её из drafts.
  useEffect(() => {
    patchDrafts((prev) => prev.filter((d) => !d.id || !lines.find((l) => l.id === d.id)));
  }, [lines]);

  // Очередь опустела → наши «ждущие» строки уже ушли на сервер. Убираем локальные
  // копии и перечитываем наряд, иначе строка задвоится на экране: одна ждущая,
  // вторая пришедшая с сервера.
  useEffect(() => {
    return subscribeOutbox(() => {
      void (async () => {
        const waiting = draftsRef.current.filter((d) => d.queued);
        if (waiting.length === 0) return;
        const pending = await listPending();
        const stillQueued = new Set(pending.map((i) => i.dedupeKey).filter(Boolean));
        const sent = waiting.filter(
          (d) => !stillQueued.has(lineDedupeKey(ticketId, d.id ?? d.uid)),
        );
        if (sent.length === 0) return;
        const sentUids = new Set(sent.map((d) => d.uid));
        patchDrafts((prev) => prev.filter((d) => !sentUids.has(d.uid)));
        await utils.workOrders.getByTicket.invalidate({ ticketId });
      })();
    });
  }, [ticketId]);

  const addRow = () => {
    patchDrafts((prev) => [
      ...prev,
      {
        uid: newDraftUid(),
        id: null,
        lineType,
        name: '',
        unit: 'шт',
        quantity: '1',
        unitPriceRub: '0',
        engineerId: null,
      },
    ]);
  };

  const saveLine = async (uid: string): Promise<void> => {
    const line = draftsRef.current.find((d) => d.uid === uid);
    if (!line || !line.name.trim()) return; // пустые не сохраняем

    const payload = {
      ticketId,
      line: {
        id: line.id ?? undefined,
        lineType,
        name: line.name.trim(),
        unit: line.unit.trim() || 'шт',
        quantity: line.quantity.trim() || '0',
        unitPriceRub: Math.max(0, Math.round(Number(line.unitPriceRub) || 0)),
        // Только для работ. У запчастей и расходов инженер на зарплату не влияет
        // (payroll считает по строкам line_type='work'), а слать его вслепую нельзя:
        // сервер отличает «поле не прислали» от «сбросить в пусто».
        ...(lineType === 'work' ? { engineerId: line.engineerId } : {}),
      },
    };
    // Уход с экрана зовёт запись у КАЖДОЙ строки, в том числе у той, что
    // только что сохранилась по уходу курсора. Отправлять то же самое второй
    // раз незачем; условие на id — чтобы новая строка всегда доехала.
    const stamp = JSON.stringify(payload);
    if (line.id && lastSent.current.get(uid) === stamp) return;

    // Пока сервер не вернул номер новой строки, второй запрос слать нельзя —
    // он вставил бы ещё одну строку. Запомним и досохраним после ответа.
    if (inFlight.current.has(uid)) {
      resaveNeeded.current.add(uid);
      return;
    }
    inFlight.current.add(uid);

    const res = await executeOrQueue(
      'workOrders.upsertLine',
      payload,
      (p) => upsert.mutateAsync(p),
      tenantSubdomain,
      lineDedupeKey(ticketId, line.id ?? uid),
      ticketNumber,
    );
    inFlight.current.delete(uid);
    if (res.status !== 'error') lastSent.current.set(uid, stamp);

    if (res.status === 'ok') {
      // Подставим номер, чтобы дальнейшие правки шли как изменение, а не вставка.
      patchDrafts((prev) =>
        prev.map((d) => (d.uid === uid ? { ...d, id: res.data.id, queued: false } : d)),
      );
      await utils.workOrders.getByTicket.invalidate({ ticketId });
    } else if (res.status === 'queued') {
      patchDrafts((prev) => prev.map((d) => (d.uid === uid ? { ...d, queued: true } : d)));
      showToast('queued', QUEUED_TEXT);
    } else {
      showToast('error', humanizeError(res.error));
    }

    // Правили, пока шёл запрос — сохраняем ещё раз (теперь уже с номером строки).
    if (resaveNeeded.current.delete(uid)) await saveLine(uid);
  };

  const cancelDraft = (uid: string) => {
    const line = draftsRef.current.find((d) => d.uid === uid);
    patchDrafts((prev) => prev.filter((d) => d.uid !== uid));
    // Строка уже уехала в очередь — убираем и оттуда, иначе при возврате связи
    // отменённая строка всё равно появится на сервере.
    if (line?.queued) {
      void removeByDedupeKey(lineDedupeKey(ticketId, line.id ?? uid));
    }
  };

  const deleteLine = async (lineId: string) => {
    const res = await executeOrQueue(
      'workOrders.deleteLine',
      { ticketId, lineId },
      (p) => remove.mutateAsync(p),
      tenantSubdomain,
      `wo-line-del:${ticketId}:${lineId}`,
      ticketNumber,
    );
    if (res.status === 'ok') {
      await utils.workOrders.getByTicket.invalidate({ ticketId });
    } else if (res.status === 'queued') {
      showToast('queued', QUEUED_TEXT);
    } else {
      showToast('error', humanizeError(res.error));
    }
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
              {lineType === 'work' && (
                <th className="w-48 px-3 py-2 text-left font-medium">Кто делал</th>
              )}
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
                <td
                  colSpan={lineType === 'work' ? 7 : 6}
                  className="text-muted-foreground p-3 text-center text-xs"
                >
                  пусто
                </td>
              </tr>
            )}
            {lines.map((l) => (
              <ExistingRow
                key={l.id}
                line={l}
                ticketId={ticketId}
                ticketNumber={ticketNumber}
                lineType={lineType}
                canEdit={canEdit}
                engineerOptions={engineerOptions}
                onDelete={() => void deleteLine(l.id)}
              />
            ))}
            {drafts.map((d) => (
              <DraftRow
                key={d.uid}
                draft={d}
                engineerOptions={engineerOptions}
                onChange={(patch) =>
                  patchDrafts((prev) => prev.map((x) => (x.uid === d.uid ? { ...x, ...patch } : x)))
                }
                onSave={() => void saveLine(d.uid)}
                onCancel={() => cancelDraft(d.uid)}
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
  ticketNumber,
  lineType,
  canEdit,
  engineerOptions,
  onDelete,
}: {
  line: {
    id: string;
    name: string;
    unit: string;
    quantity: string;
    unitPriceKopecks: string;
    amountKopecks: string;
    engineerId: string | null;
  };
  ticketId: string;
  ticketNumber?: string;
  lineType: WorkOrderLineType;
  canEdit: boolean;
  engineerOptions: Array<{ id: string; fullName: string }>;
  onDelete: () => void;
}) {
  const utils = trpc.useUtils();
  const tenantSubdomain = getTenantSubdomain();
  // Ошибку и «легло в очередь» показываем сами — глобальный тост молчит (main.tsx).
  const upsert = trpc.workOrders.upsertLine.useMutation({ meta: SILENT_ERROR });
  // Отметка «записываю… / записано / ждёт связи» — раньше при удаче строка
  // не показывала ничего, и человек не знал, ушла ли правка.
  const mark = useSaveMark();
  // Используем locally controlled значения, чтобы onBlur мог сравнить с исходным
  const initialPriceRub = useMemo(
    () => kopecksToRubInput(line.unitPriceKopecks),
    [line.unitPriceKopecks],
  );

  /** Общая отправка строки. `engineerId` шлём только у работ (см. saveLine). */
  const sendLine = (
    extras: { name: string; unit: string; quantity: string; unitPriceRub: string },
    engineerId: string | null,
  ) => {
    const priceRub = Math.max(0, Math.round(Number(extras.unitPriceRub) || 0));
    mark.markSaving();
    void (async () => {
      const res = await executeOrQueue(
        'workOrders.upsertLine',
        {
          ticketId,
          line: {
            id: line.id,
            lineType,
            name: extras.name.trim(),
            unit: extras.unit.trim() || 'шт',
            quantity: extras.quantity.trim() || '0',
            unitPriceRub: priceRub,
            ...(lineType === 'work' ? { engineerId } : {}),
          },
        },
        (p) => upsert.mutateAsync(p),
        tenantSubdomain,
        lineDedupeKey(ticketId, line.id),
        ticketNumber,
      );
      mark.markResult(res.status);
      if (res.status === 'ok') {
        await utils.workOrders.getByTicket.invalidate({ ticketId });
      } else if (res.status === 'queued') {
        showToast('queued', QUEUED_TEXT);
      } else {
        showToast('error', humanizeError(res.error));
      }
    })();
  };

  const handleBlur = (
    field: 'name' | 'unit' | 'quantity' | 'unitPriceRub',
    value: string,
    extras: { name: string; unit: string; quantity: string; unitPriceRub: string },
  ) => {
    if (!extras.name.trim()) return;
    // не отправляем если ничего не изменилось
    const changed =
      (field === 'name' && value !== line.name) ||
      (field === 'unit' && value !== line.unit) ||
      (field === 'quantity' && value !== line.quantity) ||
      (field === 'unitPriceRub' && Number(value) !== Number(initialPriceRub));
    if (!changed) return;
    sendLine(extras, line.engineerId);
  };

  /**
   * Ушли с экрана, не выходя из поля. Сверяем со строкой, какой её знает
   * сервер: после удачной записи она перечитывается, поэтому повторной
   * отправки того же самого не будет.
   */
  const handleLeave = (vals: {
    name: string;
    unit: string;
    quantity: string;
    unitPriceRub: string;
  }) => {
    if (!canEdit || !vals.name.trim()) return;
    const changed =
      vals.name !== line.name ||
      vals.unit !== line.unit ||
      vals.quantity !== line.quantity ||
      Number(vals.unitPriceRub) !== Number(initialPriceRub);
    if (!changed) return;
    sendLine(vals, line.engineerId);
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
      onLeave={handleLeave}
      onDelete={onDelete}
      saveState={mark.state}
      engineer={
        lineType === 'work'
          ? {
              value: line.engineerId,
              options: engineerOptions,
              // Смена инженера сохраняется сразу: это не текстовое поле, ждать
              // ухода курсора не с чего.
              onChange: (id) =>
                sendLine(
                  {
                    name: line.name,
                    unit: line.unit,
                    quantity: line.quantity,
                    unitPriceRub: initialPriceRub,
                  },
                  id,
                ),
            }
          : undefined
      }
    />
  );
}

function DraftRow({
  draft,
  engineerOptions,
  onChange,
  onSave,
  onCancel,
}: {
  draft: LineDraft;
  engineerOptions: Array<{ id: string; fullName: string }>;
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
      // Новая строка, которую начали набирать и ушли с экрана. Повтор того же
      // самого отсекается в saveLine — иначе строка задвоилась бы, а с ней деньги.
      onLeave={() => onSave()}
      onDelete={onCancel}
      isDraft
      saveState={draft.queued ? 'queued' : 'idle'}
      engineer={
        draft.lineType === 'work'
          ? {
              value: draft.engineerId,
              options: engineerOptions,
              onChange: (id) => onChange({ engineerId: id }),
            }
          : undefined
      }
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
  onLeave,
  onDelete,
  isDraft,
  saveState = 'idle',
  engineer,
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
  /**
   * Экран уходит, а курсор так и не покинул поле. Значения строки живут
   * здесь, поэтому отдаём их наверх — там знают, изменилось ли что-то.
   */
  onLeave?: (vals: { name: string; unit: string; quantity: string; unitPriceRub: string }) => void;
  onDelete: () => void;
  isDraft?: boolean;
  /** Строка лежит в оффлайн-очереди — покажем это прямо в таблице. */
  /** «записываю… / записано / ждёт связи» — одно слово на весь наряд. */
  saveState?: SaveMarkState;
  /**
   * Колонка «Кто делал» — только у работ. Если не передана, колонки нет вовсе:
   * у запчастей и расходов инженер на зарплату не влияет.
   */
  engineer?: {
    value: string | null;
    options: Array<{ id: string; fullName: string }>;
    onChange: (id: string | null) => void;
  };
}) {
  const [vals, setVals] = useState(initial);
  // Если приходят новые значения снаружи (после mutation refetch) — синхронизируем
  useEffect(() => {
    if (!controlled) setVals(initial);
  }, [initial.name, initial.unit, initial.quantity, initial.unitPriceRub]);

  /**
   * ПУСТОЕ ЧИСЛО — НЕ НОЛЬ (решение владельца).
   *
   * Инженер стирает количество, чтобы набрать заново, и отвлекается. Раньше
   * строка уходила с нулём: клиенту выставили меньше, инженеру начислили
   * меньше (сделка — процент от строки), а в наряде это выглядело как обычная
   * строка. Теперь пустое поле не сохраняется — возвращаем последнее нормальное
   * число и говорим словами. Набранный руками «0» остаётся разрешён: бесплатно
   * по гарантии бывает, и мешать работать нельзя.
   */
  const lastGood = useRef({ quantity: initial.quantity, unitPriceRub: initial.unitPriceRub });
  const [emptyField, setEmptyField] = useState<'quantity' | 'unitPriceRub' | null>(null);
  useEffect(() => {
    if (!controlled) {
      lastGood.current = { quantity: initial.quantity, unitPriceRub: initial.unitPriceRub };
    }
  }, [initial.quantity, initial.unitPriceRub]);

  /** Пустое число заменяем последним нормальным — ноль тут появиться не должен. */
  const withNumbers = (v: typeof vals) => ({
    ...v,
    quantity: v.quantity.trim() === '' ? lastGood.current.quantity : v.quantity,
    unitPriceRub: v.unitPriceRub.trim() === '' ? lastGood.current.unitPriceRub : v.unitPriceRub,
  });

  // Свежие значения для записи по уходу с экрана: она случается вне отрисовки.
  const current = useRef(vals);
  current.current = vals;
  // Ушли с экрана с пустым полем — на сервер уедет прежнее число, а не ноль:
  // подсказку человек уже не увидит, значит и молча портить строку нельзя.
  useFlushOnLeave(() => onLeave?.(withNumbers(current.current)));

  const update = (patch: Partial<typeof vals>) => {
    setVals((prev) => ({ ...prev, ...patch }));

    // Наверх пустое число НЕ отдаём. Черновик строки — то, что реально уедет
    // на сервер: если положить туда пустоту, сохранение по СОСЕДНЕМУ полю
    // (ушёл курсор из названия) записало бы ноль. В самом поле пусто остаётся —
    // человек ведь набирает число заново.
    const forParent: Partial<typeof vals> = { ...patch };
    if (forParent.quantity?.trim() === '') delete forParent.quantity;
    if (forParent.unitPriceRub?.trim() === '') delete forParent.unitPriceRub;
    if (Object.keys(forParent).length > 0) onChange?.(forParent);

    if (patch.quantity !== undefined && patch.quantity.trim() !== '') {
      lastGood.current.quantity = patch.quantity;
    }
    if (patch.unitPriceRub !== undefined && patch.unitPriceRub.trim() !== '') {
      lastGood.current.unitPriceRub = patch.unitPriceRub;
    }
    // Человек снова печатает — подсказка своё дело сделала.
    setEmptyField(null);
  };

  /** Уход курсора из поля с числом. Пустое — возвращаем, а не сохраняем. */
  const numberBlur = (field: 'quantity' | 'unitPriceRub', value: string) => {
    if (value.trim() === '') {
      const restored = lastGood.current[field];
      setVals((prev) => ({ ...prev, [field]: restored }));
      onChange?.({ [field]: restored });
      setEmptyField(field);
      return;
    }
    onFieldBlur(field, value, vals);
  };

  return (
    <tr className={cn(isDraft && 'bg-primary/5', saveState === 'queued' && 'bg-warning/10')}>
      <td className="px-3 py-1.5">
        <input
          type="text"
          value={vals.name}
          disabled={!canEdit}
          onChange={(e) => update({ name: e.target.value })}
          onBlur={(e) => onFieldBlur('name', e.target.value, vals)}
          className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1 text-sm outline-none focus:ring-2"
          placeholder="Что выполнено"
        />
        <SaveMark state={saveState} />
      </td>
      {engineer && (
        <td className="px-3 py-1.5">
          <select
            value={engineer.value ?? ''}
            disabled={!canEdit}
            onChange={(e) => engineer.onChange(e.target.value || null)}
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1 text-sm outline-none focus:ring-2 disabled:opacity-50"
          >
            <option value="">— инженер наряда —</option>
            {engineer.options.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </select>
        </td>
      )}
      <td className="px-3 py-1.5">
        <input
          type="text"
          value={vals.unit}
          disabled={!canEdit}
          onChange={(e) => update({ unit: e.target.value })}
          onBlur={(e) => onFieldBlur('unit', e.target.value, vals)}
          className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1 text-sm outline-none focus:ring-2"
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
          onBlur={(e) => numberBlur('quantity', e.target.value)}
          className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1 text-right text-sm tabular-nums outline-none focus:ring-2"
        />
        {emptyField === 'quantity' && (
          <div className="text-destructive mt-0.5 text-right text-[11px]" role="status">
            Количество не может быть пустым — вернули прежнее
          </div>
        )}
      </td>
      <td className="px-3 py-1.5">
        <input
          type="number"
          step="1"
          min="0"
          value={vals.unitPriceRub}
          disabled={!canEdit}
          onChange={(e) => update({ unitPriceRub: e.target.value })}
          onBlur={(e) => numberBlur('unitPriceRub', e.target.value)}
          className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1 text-right text-sm tabular-nums outline-none focus:ring-2"
        />
        {emptyField === 'unitPriceRub' && (
          <div className="text-destructive mt-0.5 text-right text-[11px]" role="status">
            Цена не может быть пустой — вернули прежнюю
          </div>
        )}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{kopecksToRub(amountKopecks)}</td>
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
