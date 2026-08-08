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
import { useEffect, useId, useMemo, useRef, useState } from 'react';
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
import { forgetDraft, readDraft, rememberDraft } from '../lib/field-draft';
import type { SaveMarkState } from '../lib/save-state';
import { SaveMark } from './SaveMark';
import { IssueFromInventory } from './IssueFromInventory';
import { ReturnToInventory } from './ReturnToInventory';
import { ConfirmDialog } from './ui';

/** Отметка «записываю…/записано/ждёт связи» одного поля. */
type HeaderMark = ReturnType<typeof useSaveMark>;

/**
 * Как рисовать строки наряда.
 *
 * `table` — десктоп, как было. `card` — телефон: на 375 пикселях таблица из
 * семи колонок ужимается так, что поле цены становится 31 пиксель шириной и
 * «12500» в него не влезает (измерено). Раскладку задаёт экран, который
 * открывает редактор, а НЕ медиазапрос внутри: иначе планшет в альбомной
 * ориентации переключался бы сам, посреди ввода.
 */
export type WorkOrderLayout = 'table' | 'card';

interface Props {
  ticketId: string;
  /** Номер заявки — подпись к записи в очереди, чтобы человек узнал её глазами. */
  ticketNumber?: string;
  canEdit: boolean;
  /** Если true — даём редактировать ставку НДС (директор/диспетчер). */
  canEditVat: boolean;
  /** По умолчанию таблица — десктопное поведение не меняется. */
  layout?: WorkOrderLayout;
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

export function WorkOrderEditor({
  ticketId,
  ticketNumber,
  canEdit,
  canEditVat,
  layout = 'table',
}: Props) {
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
        engineerNotes={wo.data.engineerNotes}
        vatRate={wo.data.vatRate}
        canEdit={canEdit}
        canEditVat={canEditVat}
        layout={layout}
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
          layout={layout}
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
  engineerNotes,
  vatRate,
  canEdit,
  canEditVat,
  layout,
}: {
  ticketId: string;
  ticketNumber?: string;
  diagnosis: string | null;
  repairDescription: string | null;
  recommendation: string | null;
  engineerNotes: string | null;
  vatRate: VatRate;
  canEdit: boolean;
  canEditVat: boolean;
  layout: WorkOrderLayout;
}) {
  const utils = trpc.useUtils();
  const tenantSubdomain = getTenantSubdomain();
  // Ошибку/очередь показываем сами — глобальный тост здесь молчит (см. main.tsx).
  const updateHeader = trpc.workOrders.updateHeader.useMutation({ meta: SILENT_ERROR });
  // Ошибку/очередь показываем сами — глобальный тост здесь молчит (см. main.tsx).
  const setVat = trpc.workOrders.setVatRate.useMutation({ meta: SILENT_ERROR });

  /**
   * Ставка НДС идёт тем же путём, что и остальные правки наряда: нет связи —
   * ложится в очередь и уходит сама. Раньше это была единственная правка мимо
   * очереди: без связи она просто не проходила, поле отскакивало назад, и
   * человек должен был вернуться и повторить.
   */
  /**
   * Ставка, которую человек выбрал, но сервер ещё не подтвердил.
   *
   * Найдено живой проверкой: правка ложилась в очередь, а поле возвращалось к
   * прежней ставке — оно управляется данными с сервера, а сервера сейчас нет.
   * Диспетчер выбирал 5 %, видел снова 20 % и решал, что не сохранилось.
   */
  const [chosenVat, setChosenVat] = useState<VatRate | null>(null);
  const vatMark = useSaveMark();

  const sendVat = async (vatRate: VatRate) => {
    setChosenVat(vatRate);
    vatMark.markSaving();
    const res = await executeOrQueue(
      'workOrders.setVatRate',
      { ticketId, vatRate },
      (p) => setVat.mutateAsync(p),
      tenantSubdomain,
      // Ставка у наряда одна: передумал трижды — уедет последний выбор.
      `wo-vat:${ticketId}`,
      ticketNumber,
    );
    vatMark.markResult(res.status);
    if (res.status === 'ok') {
      // Сервер принял — дальше поле снова живёт данными наряда.
      setChosenVat(null);
      await utils.workOrders.getByTicket.invalidate({ ticketId });
    } else if (res.status === 'queued') {
      // Ждёт связи: показываем ВЫБРАННОЕ, иначе человек не поверит, что записалось.
      showToast('queued', QUEUED_TEXT);
    } else {
      // Отказ по существу — честно возвращаем то, что на сервере.
      setChosenVat(null);
      showToast('error', humanizeError(res.error));
    }
  };

  /**
   * Переключения ставки идут строго одно за другим.
   *
   * Без этого три быстрых щелчка уезжают одновременно, и склейка по ключу не
   * успевает сработать: каждый читает очередь до того, как в неё записал
   * предыдущий, — три записи вместо одной, и на сервер поедут промежуточные
   * ставки. Ставка у наряда одна, уехать должен последний выбор.
   */
  const vatChain = useRef<Promise<void>>(Promise.resolve());
  const saveVat = (vatRate: VatRate): Promise<void> => {
    vatChain.current = vatChain.current.then(() => sendVat(vatRate));
    return vatChain.current;
  };

  /**
   * Возвращает исход: по нему поле решает судьбу черновика в памяти телефона.
   * Принял сервер или очередь — страховка больше не нужна; отказ — оставляем,
   * иначе набранное некому будет вернуть.
   */
  const saveHeader = async (
    field: 'diagnosis' | 'repairDescription' | 'recommendation' | 'engineerNotes',
    next: string | null,
    mark?: HeaderMark,
  ): Promise<'ok' | 'queued' | 'error'> => {
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
    return res.status;
  };

  return (
    <div className="bg-card space-y-3 rounded-lg border p-4">
      {/* На телефоне у инженера ОДНО поле вместо трёх (решение владельца
          2026-08-08: «инженеры не любят приложение, надо минимизировать их
          контакт с программой»). На десктопе диспетчер правит поля акта
          напрямую — там всё как было. */}
      {layout === 'card' ? (
        <EngineerNotesField
          ticketId={ticketId}
          initial={engineerNotes}
          diagnosis={diagnosis}
          repairDescription={repairDescription}
          canEdit={canEdit}
          onSaveNotes={(value) => saveHeader('engineerNotes', value)}
          onApply={async (composed) => {
            const first = await saveHeader('diagnosis', composed.diagnosis);
            const second = await saveHeader('repairDescription', composed.repairDescription);
            // Хуже из двух: одно поле легло в очередь, а второе отказали —
            // говорить «записано» в таком случае значит соврать.
            return first === 'error' || second === 'error'
              ? 'error'
              : first === 'queued' || second === 'queued'
                ? 'queued'
                : 'ok';
          }}
        />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field
            label="Диагноз"
            scope={ticketId}
            name="diagnosis"
            initial={diagnosis}
            disabled={!canEdit}
            onSave={(next, mark) => saveHeader('diagnosis', next, mark)}
          />
          <RepairDescriptionField
            ticketId={ticketId}
            initial={repairDescription}
            canEdit={canEdit}
            layout={layout}
            onSave={(value) => saveHeader('repairDescription', value)}
          />
          <Field
            label="Рекомендации"
            scope={ticketId}
            name="recommendation"
            initial={recommendation}
            disabled={!canEdit}
            onSave={(next, mark) => saveHeader('recommendation', next, mark)}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-muted-foreground text-xs uppercase">Ставка НДС</span>
        <select
          disabled={!canEditVat}
          // Пока правка ждёт связи, показываем ВЫБРАННОЕ, а не то, что на сервере.
          value={chosenVat ?? vatRate}
          onChange={(e) => void saveVat(e.target.value as VatRate)}
          className={cn(
            'bg-background focus:ring-primary/40 rounded-md border outline-none focus:ring-2 disabled:opacity-50',
            layout === 'card' ? 'h-11 px-3 text-base' : 'px-2 py-1 text-xs',
          )}
        >
          {VAT_OPTS.map((o) => (
            <option key={o.v} value={o.v}>
              {o.label}
            </option>
          ))}
        </select>
        <SaveMark state={vatMark.state} />
        {!canEditVat && (
          <span className="text-muted-foreground text-[11px]">меняет директор/диспетчер</span>
        )}
      </div>
    </div>
  );
}

/** Про офлайн говорим словами, а не пустой кнопкой. */
const OFFLINE_COMPOSE_TEXT =
  'Нет связи. Ваш текст записан — оформить получится, когда появится связь.';

/**
 * ОДНО поле инженера: «Что было и что сделал».
 *
 * ЗАЧЕМ. Запрос владельца 2026-08-08: «инженеры вообще не любят мобильное
 * приложение, надо минимизировать их контакт с программой. Они по-своему,
 * по-колхозному пишут, что сломалось и что сделали, а ИИ грамотно
 * перефразирует». Три поля на телефоне — три повода не заполнить ни одного.
 *
 * ⚠️ ГЛАВНОЕ ПРАВИЛО: «Оформить» НЕ ТРОГАЕТ текст инженера. Это единственный
 * экземпляр написанного человеком, всё остальное из него выводится. Ровно на
 * этом обжигалась кнопка «ИИ-черновик» (она рядом, для десктопа): собирала
 * текст из строк наряда и затирала поле, не читая написанное.
 *
 * Предложенное показываем ОТДЕЛЬНО и правкой — человек видит, что уйдёт в акт,
 * который подпишет клиент, и может исправить слово до «Применить».
 *
 * БЕЗ СВЯЗИ В СЕТЬ НЕ ХОДИМ ВОВСЕ. Не из вежливости: у запросов режим
 * `networkMode: 'online'`, react-query ставит их на паузу, и обещание не
 * выполняется никогда — так намертво зависал сканер (#112). Мутация ушла бы
 * (у мутаций `always`) и честно упала, но человеку нужен не текст ошибки,
 * а понимание, что делать. Набранное при этом уже записано — своим путём,
 * через очередь.
 */
function EngineerNotesField({
  ticketId,
  initial,
  diagnosis,
  repairDescription,
  canEdit,
  onSaveNotes,
  onApply,
}: {
  ticketId: string;
  initial: string | null;
  diagnosis: string | null;
  repairDescription: string | null;
  canEdit: boolean;
  onSaveNotes: (value: string | null) => Promise<'ok' | 'queued' | 'error'>;
  onApply: (composed: {
    diagnosis: string | null;
    repairDescription: string | null;
  }) => Promise<'ok' | 'queued' | 'error'>;
}) {
  const outbox = useOutbox();
  const mark = useSaveMark();
  const box = useRef<HTMLTextAreaElement>(null);
  /** Черновик читаем ОДИН раз, до первой отрисовки — см. такой же в `Field`. */
  const [restored] = useState(() => readDraft(ticketId, 'engineerNotes'));
  const typed = useRef<string | null>(null);
  const sent = useRef<string | null>(initial ?? null);
  useEffect(() => {
    sent.current = initial ?? null;
  }, [initial]);

  /** Предложенное моделью (или разбором без неё). Пока не применили — только показ. */
  const [proposal, setProposal] = useState<{
    diagnosis: string;
    repairDescription: string;
    aiUsed: boolean;
  } | null>(null);
  const [note, setNote] = useState<string | null>(
    restored != null ? 'Текст восстановлен из памяти телефона — проверьте' : null,
  );
  const [applying, setApplying] = useState(false);

  const compose = trpc.workOrders.composeFromNotes.useMutation({ meta: SILENT_ERROR });

  const saveNotes = () => {
    if (!canEdit) return;
    const raw = box.current?.value ?? typed.current ?? initial ?? '';
    const next = raw.trim() || null;
    if (next === sent.current) return;
    sent.current = next;
    mark.markSaving();
    void onSaveNotes(next).then((status) => {
      mark.markResult(status);
      // Приняли (сервер или очередь) — страховка больше не нужна. Отказ —
      // оставляем: вернуть набранное будет больше неоткуда.
      if (status !== 'error') forgetDraft(ticketId, 'engineerNotes');
    });
  };
  useFlushOnLeave(saveNotes);

  const askToCompose = () => {
    const text = (box.current?.value ?? typed.current ?? '').trim();
    if (!text) {
      setNote('Сначала напишите своими словами, что было и что вы сделали.');
      return;
    }
    // Исходник уходит своим путём в любом случае — даже если оформить сейчас
    // не выйдет. Это и есть обещание «набранное не потеряется».
    saveNotes();
    if (!outbox.isOnline || (typeof navigator !== 'undefined' && !navigator.onLine)) {
      setProposal(null);
      setNote(OFFLINE_COMPOSE_TEXT);
      return;
    }
    setNote(null);
    compose.mutate(
      { ticketId, notes: text },
      {
        onSuccess: (res) => {
          if (!res.diagnosis && !res.repairDescription) {
            setNote('Не получилось разобрать написанное — впишите поля наряда сами.');
            return;
          }
          setProposal({
            diagnosis: res.diagnosis ?? '',
            repairDescription: res.repairDescription ?? '',
            aiUsed: res.aiUsed,
          });
        },
        onError: (err) => setNote(humanizeError(err)),
      },
    );
  };

  const applyProposal = () => {
    if (!proposal) return;
    setApplying(true);
    void onApply({
      diagnosis: proposal.diagnosis.trim() || null,
      repairDescription: proposal.repairDescription.trim() || null,
    }).then((status) => {
      setApplying(false);
      if (status === 'error') {
        setNote('Не удалось записать в наряд — попробуйте ещё раз.');
        return;
      }
      setProposal(null);
      setNote(
        status === 'queued'
          ? 'Записано в наряд — уйдёт, когда появится связь.'
          : 'Записано в наряд.',
      );
    });
  };

  const actFilled = Boolean(diagnosis?.trim() || repairDescription?.trim());

  return (
    <div className="space-y-3">
      <div>
        <label
          htmlFor={`engineer-notes-${ticketId}`}
          className="text-muted-foreground mb-1 block text-[11px] uppercase"
        >
          Что было и что сделал
        </label>
        <textarea
          id={`engineer-notes-${ticketId}`}
          ref={box}
          defaultValue={restored ?? initial ?? ''}
          disabled={!canEdit}
          rows={5}
          placeholder="Своими словами. Например: плата сгорела, поменял, всё работает"
          onChange={(e) => {
            typed.current = e.target.value;
            // Синхронно, на каждую букву: если систему прибьют — это всё, что
            // останется от набранного (см. lib/field-draft).
            rememberDraft(ticketId, 'engineerNotes', e.target.value);
          }}
          onBlur={saveNotes}
          className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-base outline-none focus:ring-2 disabled:opacity-60"
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <SaveMark state={mark.state} />
          {canEdit && (
            <button
              type="button"
              disabled={compose.isPending}
              onClick={askToCompose}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-11 items-center gap-1.5 rounded-lg px-4 text-sm font-semibold disabled:opacity-50"
            >
              <Sparkles className="h-4 w-4" />
              {compose.isPending ? 'Оформляю…' : 'Оформить'}
            </button>
          )}
        </div>
        {note && (
          <div className="text-muted-foreground mt-1 text-[11px]" role="status">
            {note}
          </div>
        )}
      </div>

      {proposal && (
        <div className="border-primary/40 bg-primary/5 space-y-2 rounded-lg border p-3">
          <div className="text-sm font-semibold">Предложено — проверьте и примените</div>
          <div className="text-muted-foreground text-[11px]">
            {proposal.aiUsed
              ? 'Переписал ИИ. Это уйдёт в акт, который подпишет клиент — читайте.'
              : 'ИИ не настроен, разложил по словам без него. Это уйдёт в акт — читайте.'}
          </div>
          <div>
            <label
              htmlFor={`proposal-diagnosis-${ticketId}`}
              className="text-muted-foreground mb-1 block text-[11px] uppercase"
            >
              Диагноз
            </label>
            <textarea
              id={`proposal-diagnosis-${ticketId}`}
              value={proposal.diagnosis}
              rows={2}
              onChange={(e) => setProposal({ ...proposal, diagnosis: e.target.value })}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-base outline-none focus:ring-2"
            />
          </div>
          <div>
            <label
              htmlFor={`proposal-repair-${ticketId}`}
              className="text-muted-foreground mb-1 block text-[11px] uppercase"
            >
              Описание ремонта
            </label>
            <textarea
              id={`proposal-repair-${ticketId}`}
              value={proposal.repairDescription}
              rows={3}
              onChange={(e) => setProposal({ ...proposal, repairDescription: e.target.value })}
              className="bg-background focus:ring-primary/40 w-full rounded-md border px-3 py-2 text-base outline-none focus:ring-2"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={applying}
              onClick={applyProposal}
              className="bg-primary text-primary-foreground hover:bg-primary/90 h-11 rounded-lg px-5 text-sm font-semibold disabled:opacity-50"
            >
              {applying ? 'Записываю…' : 'Применить'}
            </button>
            <button
              type="button"
              onClick={() => setProposal(null)}
              className="hover:bg-muted/40 h-11 rounded-lg border px-4 text-sm"
            >
              Не надо
            </button>
          </div>
        </div>
      )}

      {/* Что сейчас лежит в наряде. Прятать нельзя: инженер должен видеть, под
          чем распишется клиент, — особенно когда правил не он. */}
      {!proposal && actFilled && (
        <div className="bg-muted/30 space-y-1 rounded-lg border p-3 text-sm">
          <div className="text-muted-foreground text-[11px] uppercase">Сейчас в наряде</div>
          {diagnosis?.trim() && (
            <div>
              <span className="text-muted-foreground">Диагноз: </span>
              {diagnosis}
            </div>
          )}
          {repairDescription?.trim() && (
            <div>
              <span className="text-muted-foreground">Описание ремонта: </span>
              {repairDescription}
            </div>
          )}
        </div>
      )}
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
  layout,
  onSave,
}: {
  ticketId: string;
  initial: string | null;
  canEdit: boolean;
  layout: WorkOrderLayout;
  onSave: (value: string | null) => Promise<'ok' | 'queued' | 'error'>;
}) {
  // Черновик в памяти телефона поднимаем ДО первой отрисовки: иначе поле
  // моргнёт пустым и человек решит, что работа пропала.
  const [restored] = useState(() => readDraft(ticketId, 'repairDescription'));
  const [value, setValue] = useState(restored ?? initial ?? '');
  const [note, setNote] = useState<string | null>(
    restored != null ? 'Текст восстановлен из памяти телефона — проверьте и сохраните' : null,
  );
  const draft = trpc.workOrders.draftRepairDescription.useMutation({
    onSuccess: (res) => {
      setValue(res.text);
      rememberDraft(ticketId, 'repairDescription', res.text);
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
    void onSave(next).then((status) => {
      // Приняли (сервер или очередь) — страховка больше не нужна. Отказ —
      // оставляем: вернуть набранное будет больше неоткуда.
      if (status !== 'error') forgetDraft(ticketId, 'repairDescription');
    });
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
            className={cn(
              'text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded font-medium disabled:opacity-50',
              // На телефоне кнопка была 21 пиксель высотой — пальцем не попасть.
              layout === 'card' ? 'h-11 px-3 text-sm' : 'px-1.5 py-0.5 text-[11px]',
            )}
          >
            <Sparkles className={layout === 'card' ? 'h-4 w-4' : 'h-3 w-3'} />
            {draft.isPending ? 'ИИ пишет…' : 'ИИ-черновик'}
          </button>
        )}
      </div>
      <textarea
        value={value}
        disabled={!canEdit}
        rows={3}
        onChange={(e) => {
          setValue(e.target.value);
          // Синхронно, на каждую букву: если систему прибьют — это всё, что
          // останется от набранного (см. lib/field-draft).
          rememberDraft(ticketId, 'repairDescription', e.target.value);
        }}
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
 *
 * Плюс третья, самая грубая страховка: черновик в памяти телефона на каждую
 * букву (см. lib/field-draft). Она нужна там, где не спасает ничто другое —
 * систему выбило приложение, и обе записи умерли вместе со страницей.
 */
function Field({
  label,
  scope,
  name,
  initial,
  disabled,
  onSave,
}: {
  label: string;
  /** К чему привязан черновик — заявка. */
  scope: string;
  /** Какое это поле наряда. */
  name: 'diagnosis' | 'recommendation';
  initial: string | null;
  disabled?: boolean;
  onSave: (next: string | null, mark: HeaderMark) => Promise<'ok' | 'queued' | 'error'>;
}) {
  const mark = useSaveMark();
  const box = useRef<HTMLTextAreaElement>(null);
  /**
   * Черновик читаем ОДИН раз, до первой отрисовки: поле неуправляемое, и
   * подставить в него текст позже — значит на мгновение показать пустоту.
   */
  const [restored] = useState(() => readDraft(scope, name));
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
    void onSave(next, mark).then((status) => {
      // Приняли (сервер или очередь) — страховка больше не нужна. Отказ —
      // оставляем: вернуть набранное будет больше неоткуда.
      if (status !== 'error') forgetDraft(scope, name);
    });
  };
  useFlushOnLeave(save);

  return (
    <div>
      <div className="text-muted-foreground mb-1 text-[11px] uppercase">{label}</div>
      <textarea
        ref={box}
        defaultValue={restored ?? initial ?? ''}
        disabled={disabled}
        rows={3}
        onChange={(e) => {
          typed.current = e.target.value;
          // Синхронно, на каждую букву: если систему прибьют — это всё, что
          // останется от набранного (см. lib/field-draft).
          rememberDraft(scope, name, e.target.value);
        }}
        onBlur={save}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2 disabled:opacity-60"
      />
      <SaveMark state={mark.state} />
      {restored != null && (
        <div className="text-warning mt-1 text-[11px]" role="status">
          Текст восстановлен из памяти телефона — проверьте и сохраните
        </div>
      )}
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
  layout,
}: {
  ticketId: string;
  ticketNumber?: string;
  lineType: WorkOrderLineType;
  title: string;
  icon: typeof Wrench;
  totalKopecks: string;
  layout: WorkOrderLayout;
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
      {/* Строки одни и те же, разная только обёртка: на телефоне — карточки
          во всю ширину, на десктопе — таблица. Сама запись (уход курсора, уход
          с экрана, очередь) живёт в RowInputs и от раскладки не зависит. */}
      {(() => {
        const rows = [
          ...lines.map((l) => (
            <ExistingRow
              key={l.id}
              line={l}
              ticketId={ticketId}
              ticketNumber={ticketNumber}
              lineType={lineType}
              canEdit={canEdit}
              engineerOptions={engineerOptions}
              layout={layout}
              onDelete={() => void deleteLine(l.id)}
            />
          )),
          ...drafts.map((d) => (
            <DraftRow
              key={d.uid}
              draft={d}
              engineerOptions={engineerOptions}
              layout={layout}
              onChange={(patch) =>
                patchDrafts((prev) => prev.map((x) => (x.uid === d.uid ? { ...x, ...patch } : x)))
              }
              onSave={() => void saveLine(d.uid)}
              onCancel={() => cancelDraft(d.uid)}
            />
          )),
        ];
        const isEmpty = lines.length === 0 && drafts.length === 0;

        if (layout === 'card') {
          return (
            <div className="space-y-2 p-2">
              {isEmpty && (
                <div className="text-muted-foreground p-2 text-center text-xs">пусто</div>
              )}
              {rows}
            </div>
          );
        }
        return (
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
                {isEmpty && (
                  <tr>
                    <td
                      colSpan={lineType === 'work' ? 7 : 6}
                      className="text-muted-foreground p-3 text-center text-xs"
                    >
                      пусто
                    </td>
                  </tr>
                )}
                {rows}
              </tbody>
            </table>
          </div>
        );
      })()}
      {canEdit && (
        // На телефоне это кнопки для пальца: «Добавить строку» жмут на каждую
        // строку наряда, а была она 24 пикселя высотой.
        <div
          className={cn(
            'flex items-center border-t',
            layout === 'card' ? 'flex-wrap gap-2 p-2' : 'gap-1 p-2',
          )}
        >
          <button
            type="button"
            onClick={addRow}
            className={cn(
              'text-muted-foreground hover:text-foreground hover:bg-muted/40 inline-flex items-center gap-1 rounded-md',
              layout === 'card' ? 'h-11 border px-3 text-sm' : 'px-2 py-1 text-xs',
            )}
          >
            <Plus className={layout === 'card' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
            Добавить строку
          </button>
          {lineType === 'part' && (
            <>
              <button
                type="button"
                onClick={() => setIssuingFromInventory(true)}
                className={cn(
                  'text-primary hover:bg-primary/10 inline-flex items-center gap-1 rounded-md',
                  layout === 'card'
                    ? 'border-primary/40 h-11 border px-3 text-sm'
                    : 'px-2 py-1 text-xs',
                )}
              >
                <Boxes className={layout === 'card' ? 'h-4 w-4' : 'h-3.5 w-3.5'} />
                Списать со склада
              </button>
              {lines.some((l) => l.inventoryItemId) && (
                <button
                  type="button"
                  onClick={() => setReturningToInventory(true)}
                  className={cn(
                    'text-muted-foreground hover:text-foreground hover:bg-muted/40 inline-flex items-center gap-1 rounded-md',
                    layout === 'card' ? 'h-11 border px-3 text-sm' : 'px-2 py-1 text-xs',
                  )}
                >
                  <Boxes
                    className={cn('rotate-180', layout === 'card' ? 'h-4 w-4' : 'h-3.5 w-3.5')}
                  />
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
  layout,
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
  layout: WorkOrderLayout;
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
      layout={layout}
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
  layout,
  onChange,
  onSave,
  onCancel,
}: {
  draft: LineDraft;
  engineerOptions: Array<{ id: string; fullName: string }>;
  layout: WorkOrderLayout;
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
      layout={layout}
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
  layout,
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
  layout: WorkOrderLayout;
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

  /**
   * Удаление строки спрашивает.
   *
   * Кнопка удаления на телефоне была 14 × 14 пикселей вплотную к полю цены,
   * и нажатие сносило строку сразу — без вопроса и без возврата. Строка
   * наряда это и счёт клиенту, и сделка в зарплате.
   *
   * Пустой черновик не спрашиваем: терять там нечего, а лишний вопрос на
   * «добавил строку и передумал» только мешает работать.
   */
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const nothingToLose = isDraft && !vals.name.trim() && saveState !== 'queued';
  const askDelete = () => (nothingToLose ? onDelete() : setConfirmingDelete(true));

  const deleteButton = (className: string, iconClass: string) =>
    canEdit && (
      <button
        type="button"
        onClick={askDelete}
        className={className}
        aria-label={isDraft ? 'Удалить черновик' : 'Удалить строку'}
        title={isDraft ? 'Удалить черновик' : 'Удалить строку'}
      >
        <Trash2 className={iconClass} />
      </button>
    );

  const confirmDialog = (
    <ConfirmDialog
      open={confirmingDelete}
      title={isDraft ? 'Удалить строку наряда?' : 'Удалить строку наряда?'}
      description={
        isDraft
          ? `Строка «${vals.name.trim() || 'без названия'}» ещё не на сервере — набранное будет потеряно.`
          : `Строка «${vals.name.trim() || 'без названия'}» на ${kopecksToRub(amountKopecks)} ₽ уйдёт из наряда. Это изменит и счёт клиенту, и начисление в зарплате.`
      }
      variant="danger"
      confirmText="Удалить"
      onConfirm={() => {
        setConfirmingDelete(false);
        onDelete();
      }}
      onCancel={() => setConfirmingDelete(false)}
    />
  );

  const numberHint = (field: 'quantity' | 'unitPriceRub', align: string) =>
    emptyField === field && (
      <div className={cn('text-destructive mt-0.5 text-[11px]', align)} role="status">
        {field === 'quantity'
          ? 'Количество не может быть пустым — вернули прежнее'
          : 'Цена не может быть пустой — вернули прежнюю'}
      </div>
    );

  if (layout === 'card') {
    return (
      <CardRow
        vals={vals}
        canEdit={canEdit}
        isDraft={isDraft}
        saveState={saveState}
        amountKopecks={amountKopecks}
        engineer={engineer}
        update={update}
        onFieldBlur={onFieldBlur}
        numberBlur={numberBlur}
        numberHint={numberHint}
        deleteButton={deleteButton}
        confirmDialog={confirmDialog}
      />
    );
  }

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
        {numberHint('quantity', 'text-right')}
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
        {numberHint('unitPriceRub', 'text-right')}
      </td>
      <td className="px-3 py-1.5 text-right tabular-nums">{kopecksToRub(amountKopecks)}</td>
      <td className="px-2 py-1.5 text-center">
        {deleteButton('text-muted-foreground hover:text-destructive', 'h-3.5 w-3.5')}
        {confirmDialog}
      </td>
    </tr>
  );
}

/** Значения строки — общий тип для обеих раскладок. */
type RowVals = { name: string; unit: string; quantity: string; unitPriceRub: string };

/**
 * Строка наряда на телефоне.
 *
 * Только разметка: вся запись (уход курсора, уход с экрана, очередь, «пустое
 * не ноль») осталась в RowInputs и общая для обеих раскладок. Здесь важны три
 * вещи, которых не было в сплющенной таблице: поля во всю ширину, у каждого
 * своя подпись (заголовка колонки в карточке нет) и палец попадает — высота
 * полей и кнопок 44 пикселя.
 */
function CardRow({
  vals,
  canEdit,
  isDraft,
  saveState,
  amountKopecks,
  engineer,
  update,
  onFieldBlur,
  numberBlur,
  numberHint,
  deleteButton,
  confirmDialog,
}: {
  vals: RowVals;
  canEdit: boolean;
  isDraft?: boolean;
  saveState: SaveMarkState;
  amountKopecks: string;
  engineer?: {
    value: string | null;
    options: Array<{ id: string; fullName: string }>;
    onChange: (id: string | null) => void;
  };
  update: (patch: Partial<RowVals>) => void;
  onFieldBlur: (
    field: 'name' | 'unit' | 'quantity' | 'unitPriceRub',
    value: string,
    extras: RowVals,
  ) => void;
  numberBlur: (field: 'quantity' | 'unitPriceRub', value: string) => void;
  numberHint: (field: 'quantity' | 'unitPriceRub', align: string) => React.ReactNode;
  deleteButton: (className: string, iconClass: string) => React.ReactNode;
  confirmDialog: React.ReactNode;
}) {
  // Подписи привязываем к полям по id: поле шириной в пол-экрана без названия
  // остаётся такой же загадкой, как поле шириной 31 пиксель.
  const uid = useId();
  const field =
    'bg-background focus:ring-primary/40 h-11 w-full rounded-md border px-3 text-base outline-none focus:ring-2 disabled:opacity-60';
  const caption = 'text-muted-foreground mb-1 block text-[11px] uppercase';

  return (
    <div
      className={cn(
        'bg-card space-y-2 rounded-lg border p-3',
        isDraft && 'border-primary/40 bg-primary/5',
        saveState === 'queued' && 'border-warning/50 bg-warning/10',
      )}
    >
      <div>
        <label className={caption} htmlFor={`${uid}-name`}>
          Наименование
        </label>
        <input
          id={`${uid}-name`}
          type="text"
          value={vals.name}
          disabled={!canEdit}
          onChange={(e) => update({ name: e.target.value })}
          onBlur={(e) => onFieldBlur('name', e.target.value, vals)}
          className={field}
          placeholder="Что выполнено"
        />
        <SaveMark state={saveState} />
      </div>

      {engineer && (
        <div>
          <label className={caption} htmlFor={`${uid}-engineer`}>
            Кто делал
          </label>
          <select
            id={`${uid}-engineer`}
            value={engineer.value ?? ''}
            disabled={!canEdit}
            onChange={(e) => engineer.onChange(e.target.value || null)}
            className={field}
          >
            <option value="">— инженер наряда —</option>
            {engineer.options.map((u) => (
              <option key={u.id} value={u.id}>
                {u.fullName}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Кол-во · ед. · цена читаются как «1 шт × 12 500» — тем же порядком,
          каким инженер их и произносит. */}
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className={caption} htmlFor={`${uid}-qty`}>
            Кол-во
          </label>
          <input
            id={`${uid}-qty`}
            type="number"
            inputMode="decimal"
            step="0.01"
            min="0"
            value={vals.quantity}
            disabled={!canEdit}
            onChange={(e) => update({ quantity: e.target.value })}
            onBlur={(e) => numberBlur('quantity', e.target.value)}
            className={cn(field, 'text-right tabular-nums')}
          />
        </div>
        <div>
          <label className={caption} htmlFor={`${uid}-unit`}>
            Ед.
          </label>
          <input
            id={`${uid}-unit`}
            type="text"
            value={vals.unit}
            disabled={!canEdit}
            onChange={(e) => update({ unit: e.target.value })}
            onBlur={(e) => onFieldBlur('unit', e.target.value, vals)}
            className={field}
          />
        </div>
        <div>
          <label className={caption} htmlFor={`${uid}-price`}>
            Цена ₽
          </label>
          <input
            id={`${uid}-price`}
            type="number"
            inputMode="numeric"
            step="1"
            min="0"
            value={vals.unitPriceRub}
            disabled={!canEdit}
            onChange={(e) => update({ unitPriceRub: e.target.value })}
            onBlur={(e) => numberBlur('unitPriceRub', e.target.value)}
            className={cn(field, 'text-right tabular-nums')}
          />
        </div>
      </div>
      {numberHint('quantity', '')}
      {numberHint('unitPriceRub', '')}

      <div className="flex items-center justify-between border-t pt-2">
        <div className="text-sm">
          <span className="text-muted-foreground">Сумма </span>
          <span className="font-semibold tabular-nums">{kopecksToRub(amountKopecks)} ₽</span>
        </div>
        {deleteButton(
          'text-muted-foreground hover:text-destructive hover:bg-destructive/10 grid h-11 w-11 place-items-center rounded-md',
          'h-5 w-5',
        )}
      </div>
      {confirmDialog}
    </div>
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
