import { useState } from 'react';
import { Link, useRoute } from 'wouter';
import {
  ChevronLeft,
  Clock,
  Loader2,
  MapPin,
  Phone,
  User,
  Wrench,
  ScanLine,
  PlayCircle,
  Stethoscope,
  ClipboardCheck,
  StickyNote,
  Tag,
  Printer,
  Info,
  FileWarning,
  FileCheck,
} from 'lucide-react';
import type { TicketStatus } from '@erfolg/shared';
import { trpc, getTenantSubdomain } from '../../lib/trpc';
import { QUEUED_MUTATION } from '../../lib/query-defaults';
import { openPrintWindow } from '../../lib/open-print-window';
import { executeOrQueue } from '../../lib/offline/executor';
import { cn } from '../../lib/utils';
import { TICKET_STATUS_META, TICKET_STATUS_PILL } from '../../lib/dictionaries/tickets';
import { engineerOwnsTicket } from '../../lib/engineer-ticket-access';
import { contactLine, mapsHref, telHref } from '../../lib/client-contact';
import { describeTicketEvent } from '../../lib/ticket-events';
import { fmtScheduleSlot, fmtShortDateTime } from '../../lib/dates';
import { showToast } from '../../lib/toast';
import { QueryError } from '../../components/QueryError';
import { PhotoUploader } from '../../components/PhotoUploader';
import { RepairArchiveBlock } from '../../components/RepairArchiveBlock';
import { assetIdentifierLine } from '../../lib/asset-identifiers';

interface ActionDef {
  /** Кнопка-цель (ставит этот status). */
  target: TicketStatus;
  label: string;
  icon: typeof PlayCircle;
  /** Visible только если текущий статус ∈ from. */
  from: TicketStatus[];
  variant: 'primary' | 'accent' | 'success' | 'ghost';
}

const ACTIONS: ActionDef[] = [
  {
    target: 'diagnostics',
    label: 'Начать диагностику',
    icon: Stethoscope,
    from: ['received'],
    variant: 'primary',
  },
  {
    target: 'in_progress',
    label: 'В работу',
    icon: PlayCircle,
    from: ['diagnostics'],
    variant: 'primary',
  },
  {
    target: 'act_pending',
    label: 'Готов к акту',
    icon: ClipboardCheck,
    from: ['in_progress', 'diagnostics'],
    variant: 'accent',
  },
];

export function MobileTicketPage() {
  const [, params] = useRoute<{ id: string }>('/m/tickets/:id');
  const id = params?.id ?? '';

  const ticket = trpc.tickets.get.useQuery({ id }, { enabled: !!id });
  const wo = trpc.workOrders.getByTicket.useQuery({ ticketId: id }, { enabled: !!id });
  const me = trpc.auth.me.useQuery();
  const utils = trpc.useUtils();
  const changeStatusM = trpc.tickets.changeStatus.useMutation(QUEUED_MUTATION);
  const addNoteM = trpc.tickets.addNote.useMutation(QUEUED_MUTATION);

  // «Своя» заявка = ответственный ИЛИ помощник, как на сервере. От этого
  // зависит и печать актов с реквизитами клиента, и — с 2026-08-07 — сами
  // правки: сервер их теперь не принимает по чужим заявкам, и экран не должен
  // предлагать кнопки, которые всё равно откажут.
  const canPrintActs = engineerOwnsTicket(
    me.data ? { id: me.data.user.id, role: me.data.user.role } : undefined,
    ticket.data ?? undefined,
  );
  const assetFull = trpc.assets.get.useQuery(
    { id: ticket.data?.assetId ?? '' },
    { enabled: !!ticket.data?.assetId },
  );
  const clientDoc = trpc.tickets.documentClient.useQuery(
    { ticketId: id },
    { enabled: !!id && canPrintActs },
  );
  const recordPrintM = trpc.tickets.recordPrint.useMutation();
  // История заявки: комментарии (свои и диспетчерские) и события — раньше
  // инженер писал комментарий «в пустоту», не видя ленты.
  const events = trpc.tickets.events.useQuery({ ticketId: id, limit: 10 }, { enabled: !!id });

  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  if (ticket.isLoading) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 p-8 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка…
      </div>
    );
  }
  if (ticket.error || !ticket.data) {
    return (
      <div className="m-3 space-y-2">
        <QueryError
          error={ticket.error}
          paused={ticket.fetchStatus === 'paused'}
          what="заявку"
          onRetry={() => void ticket.refetch()}
        />
        {!ticket.error && ticket.fetchStatus !== 'paused' && (
          <div className="text-muted-foreground text-sm">Заявка не найдена</div>
        )}
      </div>
    );
  }
  const t = ticket.data;
  const tenantSubdomain = getTenantSubdomain();
  // Серийный и/или инвентарный — чем аппарат опознаётся на месте.
  const assetIds = assetIdentifierLine({
    serialNumber: t.assetSerialNumber,
    inventoryNumber: t.assetInventoryNumber,
  });
  // Контакт клиента: позвонить и открыть адрес на карте одним тапом.
  // Сервер отдаёт documentClient только по «своим» заявкам (см. canPrintActs).
  const clientInfo = clientDoc.data;
  const clientPhoneHref = telHref(clientInfo?.phone);
  const clientMapsHref = mapsHref(clientInfo?.legalAddress);
  const clientContact = contactLine(clientInfo?.contactName, clientInfo?.contactPosition);

  /**
   * Сформировать акт (выполненных работ / дефектный) в PDF прямо с телефона.
   * На мобильных браузерах это открывается как «сохранить/поделиться PDF».
   */
  const printAct = async (kind: 'work_act' | 'defect_act' | 'tech_condition_act') => {
    const woData = wo.data;
    // Акт работ и дефектный требуют наряд; акт тех.состояния можно печатать и без него
    // (пустой бланк под заполнение от руки прямо в поле).
    if (!woData && kind !== 'tech_condition_act') {
      showToast('error', 'Наряд ещё не создан — акт сформировать нельзя');
      return;
    }
    const win = openPrintWindow();
    try {
      const [{ printWorkAct, printDefectAct, printTechConditionAct }, { ERFOLG_FALLBACK }] =
        await Promise.all([import('../../lib/pdf'), import('../../lib/pdf/branding')]);
      const doc = clientDoc.data;
      const ass = assetFull.data;
      const workOrder = woData
        ? {
            vatRate: woData.vatRate,
            worksAmountKopecks: Number(woData.worksAmountKopecks),
            partsAmountKopecks: Number(woData.partsAmountKopecks),
            expensesAmountKopecks: Number(woData.expensesAmountKopecks),
            totalAmountKopecks: Number(woData.totalAmountKopecks),
            diagnosis: woData.diagnosis ?? null,
            repairDescription: woData.repairDescription ?? null,
            recommendation: woData.recommendation ?? null,
            lines: woData.lines.map((l) => ({
              lineType: l.lineType,
              name: l.name,
              unit: l.unit,
              quantity: Number(l.quantity),
              unitPriceKopecks: Number(l.unitPriceKopecks),
              amountKopecks: Number(l.amountKopecks),
            })),
          }
        : null;
      const payloadBase = {
        tenant: { ...ERFOLG_FALLBACK },
        client: {
          displayName: doc?.displayName ?? t.clientDisplayName,
          inn: doc?.inn ?? null,
          kpp: doc?.kpp ?? null,
          ogrn: doc?.ogrn ?? null,
          legalAddress: doc?.legalAddress ?? null,
          phone: doc?.phone ?? null,
          contactName: doc?.contactName ?? null,
          contactPosition: doc?.contactPosition ?? null,
        },
        asset: ass
          ? {
              model: ass.model,
              manufacturer: ass.manufacturer ?? null,
              serialNumber: ass.serialNumber ?? null,
              inventoryNumber: ass.inventoryNumber ?? null,
              riskClass: ass.riskClass ?? null,
              commissionedAt: ass.commissionedAt ? String(ass.commissionedAt) : null,
            }
          : null,
        ticket: {
          ticketNumber: t.ticketNumber,
          receivedAt:
            t.receivedAt instanceof Date ? t.receivedAt.toISOString() : String(t.receivedAt),
          repairType: t.repairType,
          symptom: t.symptom ?? null,
          barcode: t.barcode,
        },
        // Инженер, печатающий акт, — исполнитель в строке «Осмотр произвёл».
        executorName: me.data?.user.fullName ?? null,
      };
      if (kind === 'tech_condition_act') {
        await printTechConditionAct({ ...payloadBase, workOrder }, win);
      } else if (workOrder) {
        if (kind === 'work_act') await printWorkAct({ ...payloadBase, workOrder }, win);
        else await printDefectAct({ ...payloadBase, workOrder }, win);
      }
      recordPrintM.mutate({ ticketId: t.id, documentKind: kind });
    } catch (err) {
      win?.close();
      console.error('[print]', err);
      showToast('error', 'Не удалось сформировать PDF');
    }
  };

  const onAction = async (target: TicketStatus, label: string) => {
    setBusy(target);
    const result = await executeOrQueue(
      'tickets.changeStatus',
      { id: t.id, status: target },
      (p) => changeStatusM.mutateAsync(p),
      tenantSubdomain,
      undefined,
      t.ticketNumber,
    );
    setBusy(null);
    if (result.status === 'ok') {
      await Promise.all([
        utils.tickets.get.invalidate({ id: t.id }),
        utils.tickets.list.invalidate(),
        // История заявки живёт отдельным запросом: без этой строки инженер
        // менял статус, а лента ниже оставалась вчерашней.
        utils.tickets.events.invalidate({ ticketId: t.id }),
      ]);
      showToast('ok', `Статус изменён: ${label}`);
    } else if (result.status === 'queued') {
      showToast('queued', 'Нет связи — изменение сохранено в очередь, отправится автоматически');
    } else {
      showToast('error', result.error.message);
    }
  };

  const onSendNote = async () => {
    if (!comment.trim()) return;
    setBusy('note');
    const result = await executeOrQueue(
      'tickets.addNote',
      { ticketId: t.id, comment: comment.trim() },
      (p) => addNoteM.mutateAsync(p),
      tenantSubdomain,
      undefined,
      t.ticketNumber,
    );
    setBusy(null);
    if (result.status === 'ok') {
      setComment('');
      await utils.tickets.events.invalidate({ ticketId: t.id });
      showToast('ok', 'Комментарий добавлен');
    } else if (result.status === 'queued') {
      setComment('');
      showToast('queued', 'Сохранено в очередь');
    } else {
      showToast('error', result.error.message);
    }
  };

  // Фильтр «инженеру только diagnostics/in_progress/act_pending» убран как
  // мёртвый: в ACTIONS других целей и нет, он ничего не отсеивал.
  const isEngineer = me.data?.user.role === 'engineer';
  const canEdit = !isEngineer || canPrintActs;
  const allowedActions = canEdit ? ACTIONS.filter((a) => a.from.includes(t.status)) : [];

  return (
    <div className="space-y-3 p-3">
      <Link
        href="/m/queue"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />К очереди
      </Link>

      {/* Чужая заявка: смотреть можно (приехал на объект, отсканировал аппарат —
          надо понимать, что это), менять нельзя. Сервер откажет в любом случае,
          но человек должен узнать причину до нажатия, а не после. */}
      {!canEdit && (
        <div className="bg-warning/15 text-warning border-warning/40 flex items-start gap-2 rounded-lg border p-3 text-sm">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <div className="font-medium">Это не ваша заявка</div>
            <div className="opacity-90">
              Смотреть можно, менять нельзя. Если работу передали вам — попросите диспетчера
              назначить заявку.
            </div>
          </div>
        </div>
      )}

      <div className="bg-card space-y-3 rounded-lg border p-4">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="font-mono text-base font-semibold">{t.ticketNumber}</div>
            <div className="text-muted-foreground text-xs">
              принята {fmtShortDateTime(t.receivedAt)}
            </div>
          </div>
          <span
            className={cn(
              'rounded-full px-3 py-1 text-xs font-medium',
              TICKET_STATUS_PILL[t.status],
            )}
          >
            {TICKET_STATUS_META[t.status].label}
          </span>
        </div>

        {t.scheduledStartAt && (
          <div className="bg-primary/10 text-primary inline-flex items-center gap-2 rounded-lg px-3 py-2 text-base font-bold">
            <Clock className="h-5 w-5 shrink-0" />
            <span>{fmtScheduleSlot(t.scheduledStartAt, t.scheduledEndAt)}</span>
          </div>
        )}

        <div className="space-y-2 border-t pt-3 text-sm">
          <Row icon={User} label="Клиент">
            {t.clientDisplayName || '—'}
          </Row>
          {t.assetModel && (
            <Row icon={Wrench} label="Техника">
              {t.assetModel}
              {assetIds && <span className="text-muted-foreground"> · {assetIds}</span>}
            </Row>
          )}
          {t.barcode && (
            <Row icon={ScanLine} label="Штрих-код">
              <span className="break-all font-mono text-xs">{t.barcode}</span>
            </Row>
          )}
        </div>

        {clientInfo && (clientContact || clientInfo.phone || clientInfo.legalAddress) && (
          <div className="space-y-2 border-t pt-3 text-sm">
            {clientContact && (
              <Row icon={User} label="Контакт">
                {clientContact}
              </Row>
            )}
            {clientInfo.phone && (
              <Row icon={Phone} label="Телефон">
                {clientPhoneHref ? (
                  <a
                    href={clientPhoneHref}
                    className="text-primary font-medium underline-offset-2 hover:underline"
                  >
                    {clientInfo.phone}
                  </a>
                ) : (
                  clientInfo.phone
                )}
              </Row>
            )}
            {clientInfo.legalAddress && (
              <Row icon={MapPin} label="Адрес (юр.)">
                {clientMapsHref ? (
                  <a
                    href={clientMapsHref}
                    target="_blank"
                    rel="noreferrer"
                    className="text-primary underline-offset-2 hover:underline"
                  >
                    {clientInfo.legalAddress}
                  </a>
                ) : (
                  clientInfo.legalAddress
                )}
              </Row>
            )}
          </div>
        )}
        {t.assetModel && (
          <button
            type="button"
            onClick={() =>
              void (async () => {
                // Раньше здесь не было try/catch, в отличие от печати актов:
                // при сбое инженер получал пустое открытое окно и ни слова.
                const win = openPrintWindow();
                try {
                  const [{ printAssetLabel }, { ERFOLG_FALLBACK }] = await Promise.all([
                    import('../../lib/pdf'),
                    import('../../lib/pdf/branding'),
                  ]);
                  await printAssetLabel(
                    {
                      asset: {
                        model: t.assetModel ?? '—',
                        manufacturer: null,
                        serialNumber: t.assetSerialNumber ?? null,
                        inventoryNumber: t.assetInventoryNumber ?? null,
                        riskClass: null,
                      },
                      ticket: t.barcode
                        ? {
                            ticketNumber: t.ticketNumber,
                            receivedAt:
                              typeof t.receivedAt === 'string'
                                ? t.receivedAt
                                : t.receivedAt.toISOString(),
                            barcode: t.barcode,
                          }
                        : null,
                      fallbackBarcode: t.assetId ?? t.id,
                      tenantDisplayName: ERFOLG_FALLBACK.displayName,
                    },
                    win,
                  );
                } catch (err) {
                  win?.close();
                  console.error('[print label]', err);
                  showToast('error', 'Не удалось сформировать ярлык');
                }
              })()
            }
            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium"
          >
            <Tag className="h-4 w-4" />
            Печать ярлыка
          </button>
        )}

        {canPrintActs && (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={!wo.data}
                onClick={() => void printAct('work_act')}
                className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-10 items-center justify-center gap-2 rounded-md text-sm font-medium disabled:opacity-50"
              >
                <Printer className="h-4 w-4" />
                Акт работ
              </button>
              <button
                type="button"
                disabled={!wo.data}
                onClick={() => void printAct('defect_act')}
                className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-10 items-center justify-center gap-2 rounded-md text-sm font-medium disabled:opacity-50"
              >
                <FileWarning className="h-4 w-4" />
                Дефектный акт
              </button>
            </div>
            {/* Акт технического состояния — «полевой» документ: печатается и без наряда
                (пустой бланк под заполнение от руки), поэтому кнопка не блокируется. */}
            <button
              type="button"
              onClick={() => void printAct('tech_condition_act')}
              className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium"
            >
              <FileCheck className="h-4 w-4" />
              Акт технического состояния
            </button>
          </div>
        )}

        {t.symptom && (
          <div className="bg-muted/40 rounded-md p-3 text-sm">
            <div className="text-muted-foreground mb-1 text-[11px] font-medium uppercase">
              Жалоба клиента
            </div>
            <div className="whitespace-pre-wrap">{t.symptom}</div>
          </div>
        )}
      </div>

      {/* AI-подсказка «похожие ремонты» из архива 2015–2023: что за симптом, что нашли,
          что делали. Инженеру у аппарата она нужнее всего — на десктопе диспетчера блок
          уже был, на телефоне его не хватало.
          canSummarize={false}: ИИ-резюме «что обычно помогало» — только для staff
          (repairArchive.summarize = staffProcedure), сам список архива инженеру разрешён
          (repairArchive.searchSimilar = engineerProcedure). Блок сам прячется, если
          похожего не нашлось. В архиве нет ПДн клиента — только техника. */}
      <RepairArchiveBlock ticketId={t.id} canSummarize={false} />

      {allowedActions.length > 0 && (
        <div className="space-y-2">
          {allowedActions.map((a) => {
            const Icon = a.icon;
            const isBusy = busy === a.target;
            return (
              <button
                key={a.target}
                type="button"
                disabled={!!busy}
                onClick={() => void onAction(a.target, a.label)}
                className={cn(
                  'flex h-14 w-full items-center justify-center gap-2 rounded-lg text-base font-semibold transition disabled:opacity-60',
                  a.variant === 'primary'
                    ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                    : 'bg-accent text-accent-foreground hover:bg-accent/90',
                )}
              >
                {isBusy ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <Icon className="h-5 w-5" />
                )}
                {a.label}
              </button>
            );
          })}
        </div>
      )}

      <Link
        href={`/m/tickets/${t.id}/work-log`}
        className="bg-card hover:bg-muted/40 flex h-14 w-full items-center justify-center gap-2 rounded-lg border text-base font-semibold transition"
      >
        <Wrench className="h-5 w-5" />
        {/* Рублей здесь нет намеренно (решение владельца #122): цену и строки наряда
            заводит менеджер в десктопе. Себестоимость труда — процент от цены строки,
            поэтому одним числом инженер и счёт клиенту выставлял бы, и сделку себе
            назначал. Итог наряда печатался ровно тот, который прячут двумя экранами
            дальше. Количество строк — не деньги, и ориентироваться по нему можно. */}
        Журнал работ{wo.data ? ` · ${wo.data.lines.length} стр.` : ''}
      </Link>

      {canEdit && (
        <div className="bg-card space-y-2 rounded-lg border p-3">
          <label className="text-muted-foreground text-[11px] font-medium uppercase">
            Комментарий
          </label>
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            placeholder="Например: «приехал на объект, ожидаю клиента»"
            rows={3}
            className="border-input bg-background w-full resize-none rounded-md border px-3 py-2 text-sm"
          />
          <button
            type="button"
            onClick={() => void onSendNote()}
            disabled={!comment.trim() || busy === 'note'}
            className="bg-secondary text-secondary-foreground hover:bg-secondary/80 inline-flex h-10 w-full items-center justify-center gap-2 rounded-md text-sm font-medium disabled:opacity-50"
          >
            {busy === 'note' ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <StickyNote className="h-4 w-4" />
            )}
            Сохранить комментарий
          </button>
        </div>
      )}

      {(events.data ?? []).length > 0 && (
        <div className="bg-card space-y-2 rounded-lg border p-3">
          <div className="text-muted-foreground text-[11px] font-medium uppercase">История</div>
          <ul className="space-y-3">
            {(events.data ?? []).map((e) => {
              const d = describeTicketEvent(e);
              return (
                <li key={e.id} className="text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="font-medium">{d.title}</span>
                    <span className="text-muted-foreground shrink-0 text-[11px]">
                      {fmtShortDateTime(e.createdAt)}
                    </span>
                  </div>
                  {d.body && (
                    <div className="text-muted-foreground mt-0.5 whitespace-pre-wrap text-xs">
                      {d.body}
                    </div>
                  )}
                  {e.userFullName && (
                    <div className="text-muted-foreground/80 mt-0.5 text-[11px]">
                      {e.userFullName}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      )}

      <div className="bg-card rounded-2xl border p-4">
        <div className="text-foreground mb-3 text-sm font-semibold">Фото</div>
        <PhotoUploader
          kind="ticket_photo"
          referenceType="ticket"
          referenceId={t.id}
          canUpload={canEdit}
          showCamera={true}
          hint="Фото техники, состояния, повреждений"
        />
      </div>
    </div>
  );
}

function Row({
  icon: Icon,
  label,
  children,
}: {
  icon: typeof User;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="text-muted-foreground mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1">
        <div className="text-muted-foreground text-[11px] font-medium uppercase">{label}</div>
        <div className="text-sm">{children}</div>
      </div>
    </div>
  );
}
