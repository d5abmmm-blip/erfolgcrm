import { useEffect, useRef, useState } from 'react';
import { Link, useLocation, useRoute } from 'wouter';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  Award,
  Building2,
  Calendar,
  CheckCircle2,
  ChevronLeft,
  Circle,
  Clock,
  Copy,
  FileText,
  FileWarning,
  Files,
  History,
  Link2,
  Loader2,
  MapPin,
  Package,
  Phone,
  Printer,
  RotateCcw,
  Send,
  Sparkles,
  StickyNote,
  Tag,
  User,
  UserCog,
  Users,
  Wrench,
  XCircle,
  Trash2,
} from 'lucide-react';
import type { TicketEventType, TicketPriority, TicketStatus } from '@erfolg/shared';
import { isLegacyId, isLegacyNumber } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { openPrintWindow } from '../lib/open-print-window';
import { SILENT_ERROR } from '../lib/error-message';
import { PromptDialog } from '../components/ui/PromptDialog';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { WorkOrderEditor, kopecksToRub } from '../components/WorkOrderEditor';
import { engineerOwnsTicket } from '../lib/engineer-ticket-access';
import { mayEditWorkOrder } from '../lib/work-order-window';
import { TicketPayments } from '../components/TicketPayments';
import { PhotoUploader } from '../components/PhotoUploader';
import { IntakeChecklistDialog, type ChecklistKind } from '../components/IntakeChecklistDialog';
import { SimilarCasesBlock } from '../components/SimilarCasesBlock';
import { RepairArchiveBlock } from '../components/RepairArchiveBlock';
import { ExplainBlockPanel } from '../components/ExplainBlockPanel';
import { TicketKpBlock } from '../components/TicketKpBlock';
import { ComposeEmailModal, type AttachmentOption } from '../components/ComposeEmailModal';
import { EngineerAssignmentHints } from '../components/EngineerAssignmentHints';
import { eventPriorityLabel, eventStatusLabel } from '../lib/ticket-events';
import { LegacyBadge } from '../components/ui/LegacyBadge';
import { toPdfLines } from '../lib/pdf/lines';

const STAGES: ReadonlyArray<{ value: TicketStatus; label: string }> = [
  { value: 'received', label: 'Приём' },
  { value: 'diagnostics', label: 'Диагностика' },
  { value: 'in_progress', label: 'Ремонт' },
  { value: 'act_pending', label: 'Акт' },
  { value: 'closed', label: 'Закрыта' },
];

const STATUS_BADGE: Record<TicketStatus, { label: string; cls: string }> = {
  received: { label: 'Принята', cls: 'bg-primary/10 text-primary' },
  diagnostics: { label: 'Диагностика', cls: 'bg-primary/10 text-primary' },
  estimate: { label: 'Смета', cls: 'bg-primary/10 text-primary' },
  approval: { label: 'Согласование', cls: 'bg-warning/15 text-warning' },
  in_progress: { label: 'В работе', cls: 'bg-warning/15 text-warning' },
  act_pending: { label: 'Ожидает акта', cls: 'bg-accent/10 text-accent' },
  closed: { label: 'Закрыта', cls: 'bg-success/10 text-success' },
  cancelled: { label: 'Отменена', cls: 'bg-destructive/10 text-destructive' },
};

const INTAKE_LABELS: Record<string, string> = {
  brought_in: 'Привезли в СЦ',
  onsite_visit: 'Выезд на объект',
  pickup: 'Забираем у клиента',
};

const PRIORITY_OPTS: TicketPriority[] = ['low', 'normal', 'high', 'urgent'];
const PRIORITY_LABEL: Record<TicketPriority, string> = {
  low: 'низкий',
  normal: 'обычный',
  high: 'высокий',
  urgent: 'срочный',
};

const ENGINEER_STATUSES: TicketStatus[] = ['diagnostics', 'in_progress', 'act_pending'];
const STAFF_STATUSES: TicketStatus[] = [
  'received',
  'diagnostics',
  'in_progress',
  'act_pending',
  'closed',
];

type Tab = 'details' | 'history' | 'payments' | 'docs' | 'checklists';

export function TicketCardPage() {
  const [, params] = useRoute<{ id: string }>('/tickets/:id');
  const id = params?.id ?? '';
  const [, navigate] = useLocation();
  const me = trpc.auth.me.useQuery();
  const role = me.data?.user.role;
  const isDirector = role === 'director';
  const isStaff = role === 'director' || role === 'dispatcher';
  const utils = trpc.useUtils();
  const ticket = trpc.tickets.get.useQuery({ id }, { enabled: !!id });
  const events = trpc.tickets.events.useQuery({ ticketId: id }, { enabled: !!id });
  const wo = trpc.workOrders.getByTicket.useQuery({ ticketId: id }, { enabled: !!id });
  // Инженер правит наряд только по своей заявке — то же правило, что и на
  // телефоне: сервер чужие правки не принимает, и десктоп не должен обещать
  // обратное. Диспетчер и директор не ограничены.
  const canEditWorkOrder =
    isStaff ||
    (role === 'engineer' &&
      engineerOwnsTicket({ id: me.data?.user.id ?? '', role: 'engineer' }, ticket.data) &&
      // Наряд закрытой заявки инженер правит три дня — дальше руководитель.
      mayEditWorkOrder(role, ticket.data));
  // Карточка клиента — только staff (clients.get = staffProcedure).
  const clientFull = trpc.clients.get.useQuery(
    { id: ticket.data?.clientId ?? '' },
    { enabled: isStaff && !!ticket.data?.clientId },
  );
  const assetFull = trpc.assets.get.useQuery(
    { id: ticket.data?.assetId ?? '' },
    { enabled: !!ticket.data?.assetId },
  );
  /** Инженер печатает документы только по своим заявкам; staff — по любым. */
  const canPrintDocs =
    isStaff || (!!ticket.data && ticket.data.assignedEngineerId === me.data?.user.id);
  // Реквизиты клиента для акта (минимум полей) — доступны и инженеру по своей заявке.
  const clientDoc = trpc.tickets.documentClient.useQuery(
    { ticketId: id },
    { enabled: !!id && canPrintDocs },
  );

  const [tab, setTab] = useState<Tab>('details');
  // Вместо браузерных alert(): предупреждение об аттестации и ошибки печати PDF
  // показываем встроенными баннерами под шапкой.
  const [attestationWarning, setAttestationWarning] = useState<string | null>(null);
  const [printError, setPrintError] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);

  const invalidateAll = async () => {
    await Promise.all([
      utils.tickets.get.invalidate({ id }),
      utils.tickets.events.invalidate({ ticketId: id }),
      utils.tickets.list.invalidate(),
      utils.workOrders.getByTicket.invalidate({ ticketId: id }),
    ]);
  };

  const changeStatus = trpc.tickets.changeStatus.useMutation({ onSuccess: invalidateAll });
  const update = trpc.tickets.update.useMutation({
    onSuccess: async (data) => {
      await invalidateAll();
      // Stage 10'.I — surface attestation warning от ticket update.
      if (data && 'attestationWarning' in data && data.attestationWarning) {
        setAttestationWarning(String(data.attestationWarning));
      }
      // Та же плашка используется для подсказки про контракт госучреждения:
      // это не ошибка и не запрет, сохранение уже прошло.
      if (data && 'contractWarning' in data && data.contractWarning) {
        setAttestationWarning(String(data.contractWarning));
      }
    },
  });
  const addNote = trpc.tickets.addNote.useMutation({ onSuccess: invalidateAll });
  const setWaitingForPart = trpc.tickets.setWaitingForPart.useMutation({
    onSuccess: invalidateAll,
  });
  const cancel = trpc.tickets.cancel.useMutation({ onSuccess: invalidateAll });
  const reopen = trpc.tickets.reopen.useMutation({ onSuccess: invalidateAll });
  const del = trpc.tickets.delete.useMutation({
    meta: SILENT_ERROR,
    onSuccess: async () => {
      await utils.tickets.list.invalidate();
      navigate('/tickets');
    },
  });
  const recordPrint = trpc.tickets.recordPrint.useMutation({ onSuccess: invalidateAll });

  if (ticket.isLoading) {
    return <div className="text-muted-foreground p-8 text-sm">Загрузка…</div>;
  }
  if (ticket.error || !ticket.data) {
    return (
      <div className="mx-auto max-w-2xl p-8">
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-4 text-sm">
          {ticket.error?.message ?? 'Заявка не найдена'}
        </div>
      </div>
    );
  }
  const t = ticket.data;
  const statusBadge = STATUS_BADGE[t.status];
  // Заявка из прежней программы: помечаем и подписываем, но ничего не прячем —
  // на этих записях держится история клиента и вся себестоимость системы.
  const isLegacy = isLegacyId(t.id) || isLegacyNumber(t.ticketNumber);
  const totalKop = wo.data?.totalAmountKopecks ?? '0';
  const vatRate = wo.data?.vatRate ?? '20';
  const ticketContact = t.contactId
    ? clientFull.data?.contacts.find((c) => c.id === t.contactId)
    : undefined;

  // Сборка данных для PDF (акты/счёт). Используется и печатью, и вложениями писем.
  const assemblePdfInputs = async () => {
    const { ERFOLG_FALLBACK } = await import('../lib/pdf/branding');
    const ass = assetFull.data;
    const woData = wo.data;
    const tenantData = {
      ...ERFOLG_FALLBACK,
      // TODO: брать из tenant settings когда появится trpc endpoint
    };
    // Реквизиты берём из tickets.documentClient — он доступен и инженеру (по своей
    // заявке), поэтому акт печатается полным для любой роли.
    const doc = clientDoc.data;
    const clientData = {
      displayName: doc?.displayName ?? t.clientDisplayName,
      inn: doc?.inn ?? null,
      kpp: doc?.kpp ?? null,
      ogrn: doc?.ogrn ?? null,
      legalAddress: doc?.legalAddress ?? null,
      phone: doc?.phone ?? null,
      contactName: doc?.contactName ?? null,
      contactPosition: doc?.contactPosition ?? null,
    };
    const assetData = ass
      ? {
          model: ass.model,
          manufacturer: ass.manufacturer ?? null,
          serialNumber: ass.serialNumber ?? null,
          inventoryNumber: ass.inventoryNumber ?? null,
          riskClass: ass.riskClass ?? null,
          commissionedAt: ass.commissionedAt ? String(ass.commissionedAt) : null,
        }
      : null;
    const ticketData = {
      ticketNumber: t.ticketNumber,
      receivedAt: t.receivedAt instanceof Date ? t.receivedAt.toISOString() : String(t.receivedAt),
      repairType: t.repairType,
      symptom: t.symptom ?? null,
      barcode: t.barcode,
    };
    const workOrderData = woData
      ? {
          vatRate: woData.vatRate,
          worksAmountKopecks: Number(woData.worksAmountKopecks),
          partsAmountKopecks: Number(woData.partsAmountKopecks),
          expensesAmountKopecks: Number(woData.expensesAmountKopecks),
          totalAmountKopecks: Number(woData.totalAmountKopecks),
          diagnosis: woData.diagnosis ?? null,
          repairDescription: woData.repairDescription ?? null,
          recommendation: woData.recommendation ?? null,
          lines: toPdfLines(woData.lines),
        }
      : null;
    return { tenantData, clientData, assetData, ticketData, workOrderData };
  };

  const printDocument = async (
    kind: 'intake_act' | 'invoice' | 'work_act' | 'defect_act' | 'asset_label',
    _name: string,
  ) => {
    setPrintError(null);
    // Вкладку открываем СИНХРОННО в обработчике клика: иначе после await (загрузка
    // pdfmake/данных) браузер заблокирует popup и выйдет пустая белая вкладка.
    const win = openPrintWindow();
    try {
      const { printIntakeAct, printInvoice, printWorkAct, printDefectAct, printAssetLabel } =
        await import('../lib/pdf');
      const { tenantData, clientData, assetData, ticketData, workOrderData } =
        await assemblePdfInputs();

      if (kind === 'intake_act') {
        await printIntakeAct(
          { tenant: tenantData, client: clientData, asset: assetData, ticket: ticketData },
          win,
        );
      } else if (kind === 'invoice') {
        if (!workOrderData) {
          win?.close();
          setPrintError('Нельзя сформировать счёт: наряд ещё не создан или не содержит позиций.');
          return;
        }
        await printInvoice(
          { tenant: tenantData, client: clientData, ticket: ticketData, workOrder: workOrderData },
          win,
        );
      } else if (kind === 'work_act') {
        if (!workOrderData) {
          win?.close();
          setPrintError('Нельзя сформировать акт работ: наряд ещё не создан.');
          return;
        }
        await printWorkAct(
          {
            tenant: tenantData,
            client: clientData,
            asset: assetData,
            ticket: ticketData,
            workOrder: workOrderData,
          },
          win,
        );
      } else if (kind === 'defect_act') {
        if (!workOrderData) {
          win?.close();
          setPrintError(
            'Нельзя сформировать дефектный акт: наряд ещё не создан (нет диагностики и заключения).',
          );
          return;
        }
        await printDefectAct(
          {
            tenant: tenantData,
            client: clientData,
            asset: assetData,
            ticket: ticketData,
            workOrder: workOrderData,
          },
          win,
        );
      } else {
        if (!assetData) {
          win?.close();
          setPrintError('Нельзя сформировать ярлык: к заявке не привязана техника.');
          return;
        }
        await printAssetLabel(
          {
            asset: assetData,
            ticket: ticketData,
            fallbackBarcode: t.assetId ?? t.id,
            tenantDisplayName: tenantData.displayName,
          },
          win,
        );
      }
      // Ярлык — не документ; recordPrint фиксирует только акты/счета.
      if (kind !== 'asset_label') {
        recordPrint.mutate({ ticketId: t.id, documentKind: kind });
      }
    } catch (err) {
      win?.close();
      console.error('[print]', err);
      setPrintError(
        `Не удалось сформировать PDF: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // Фича №14 — пакет документов одной кнопкой: все применимые документы в один PDF.
  const printPackage = async () => {
    setPrintError(null);
    // Вкладку открываем СИНХРОННО в обработчике клика (иначе popup-блокировка → белая вкладка).
    const win = openPrintWindow();
    try {
      const { printDocumentPackage } = await import('../lib/pdf');
      const { tenantData, clientData, assetData, ticketData, workOrderData } =
        await assemblePdfInputs();
      const { included } = await printDocumentPackage(
        {
          tenant: tenantData,
          client: clientData,
          asset: assetData,
          ticket: ticketData,
          workOrder: workOrderData,
        },
        win,
      );
      // Событие печати по каждому включённому документу (тот же аудит, что у отдельных кнопок).
      for (const kind of included) {
        recordPrint.mutate({ ticketId: t.id, documentKind: kind });
      }
    } catch (err) {
      win?.close();
      console.error('[print-package]', err);
      setPrintError(
        `Не удалось сформировать пакет документов: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const clientEmail = clientFull.data?.email ?? '';
  const composeAttachments: AttachmentOption[] = [
    {
      id: 'intake_act',
      label: 'Акт приёма',
      kind: 'intake_act',
      build: async () => {
        const { getIntakeActAsBase64 } = await import('../lib/pdf');
        const { tenantData, clientData, assetData, ticketData } = await assemblePdfInputs();
        return {
          filename: `Акт приёма ${t.ticketNumber}.pdf`,
          base64: await getIntakeActAsBase64({
            tenant: tenantData,
            client: clientData,
            asset: assetData,
            ticket: ticketData,
          }),
        };
      },
    },
  ];
  if (wo.data) {
    composeAttachments.push(
      {
        id: 'invoice',
        label: 'Счёт на оплату',
        kind: 'invoice',
        build: async () => {
          const { getInvoiceAsBase64 } = await import('../lib/pdf');
          const { tenantData, clientData, ticketData, workOrderData } = await assemblePdfInputs();
          if (!workOrderData) throw new Error('Наряд не создан');
          return {
            filename: `Счёт ${t.ticketNumber}.pdf`,
            base64: await getInvoiceAsBase64({
              tenant: tenantData,
              client: clientData,
              ticket: ticketData,
              workOrder: workOrderData,
            }),
          };
        },
      },
      {
        id: 'work_act',
        label: 'Акт выполненных работ',
        kind: 'work_act',
        build: async () => {
          const { getWorkActAsBase64 } = await import('../lib/pdf');
          const { tenantData, clientData, assetData, ticketData, workOrderData } =
            await assemblePdfInputs();
          if (!workOrderData) throw new Error('Наряд не создан');
          return {
            filename: `Акт работ ${t.ticketNumber}.pdf`,
            base64: await getWorkActAsBase64({
              tenant: tenantData,
              client: clientData,
              asset: assetData,
              ticket: ticketData,
              workOrder: workOrderData,
            }),
          };
        },
      },
      {
        id: 'defect_act',
        label: 'Дефектный акт',
        kind: 'defect_act',
        build: async () => {
          const { getDefectActAsBase64 } = await import('../lib/pdf');
          const { tenantData, clientData, assetData, ticketData, workOrderData } =
            await assemblePdfInputs();
          if (!workOrderData) throw new Error('Наряд не создан');
          return {
            filename: `Дефектный акт ${t.ticketNumber}.pdf`,
            base64: await getDefectActAsBase64({
              tenant: tenantData,
              client: clientData,
              asset: assetData,
              ticket: ticketData,
              workOrder: workOrderData,
            }),
          };
        },
      },
    );
  }

  return (
    <div className="mx-auto max-w-[1600px] space-y-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <Link
          href="/tickets"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ChevronLeft className="h-4 w-4" />К списку заявок
        </Link>
        <div className="flex flex-wrap items-center justify-end gap-2">
          {isStaff && (
            <button
              type="button"
              onClick={() => setComposeOpen(true)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
            >
              <Send className="h-3.5 w-3.5" />
              Написать письмо
            </button>
          )}
          {isStaff && <TrackShareButton ticketId={t.id} />}
          {/* Инженеру — акты только по своим заявкам. Счёт/пакет/приём — дело staff. */}
          {isStaff && (
            <PrintBtn
              icon={FileText}
              label="Акт приёма"
              onClick={() => void printDocument('intake_act', 'акт приёма')}
            />
          )}
          {canPrintDocs && (
            <PrintBtn
              icon={FileWarning}
              label="Дефектный акт"
              onClick={() => void printDocument('defect_act', 'дефектный акт')}
            />
          )}
          {isStaff && (
            <PrintBtn
              icon={FileText}
              label="Счёт"
              onClick={() => void printDocument('invoice', 'счёт на оплату')}
            />
          )}
          {canPrintDocs && (
            <PrintBtn
              icon={Printer}
              label="Акт работ"
              onClick={() => void printDocument('work_act', 'акт выполненных работ')}
            />
          )}
          <PrintBtn
            icon={Tag}
            label="Ярлык"
            onClick={() => void printDocument('asset_label', 'ярлык на технику')}
          />
          {isStaff && (
            <PrintBtn
              icon={Files}
              label="Пакет документов"
              emphasis
              onClick={() => void printPackage()}
            />
          )}
        </div>
      </div>

      {attestationWarning && (
        <div className="bg-warning/10 text-warning border-warning/30 flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>Внимание: {attestationWarning}</span>
          </div>
          <button
            type="button"
            aria-label="Скрыть предупреждение"
            onClick={() => setAttestationWarning(null)}
            className="shrink-0 hover:opacity-70"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}
      {printError && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 flex items-start justify-between gap-3 rounded-md border p-3 text-sm">
          <div className="flex items-start gap-2">
            <AlertOctagon className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{printError}</span>
          </div>
          <button
            type="button"
            aria-label="Скрыть ошибку"
            onClick={() => setPrintError(null)}
            className="shrink-0 hover:opacity-70"
          >
            <XCircle className="h-4 w-4" />
          </button>
        </div>
      )}

      <header className="bg-card rounded-lg border p-4 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <div className="text-muted-foreground text-xs font-medium uppercase tracking-wide">
              Заявка
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-3">
              <h1 className="font-mono text-2xl font-semibold">{t.ticketNumber}</h1>
              <span
                className={cn(
                  'inline-flex items-center rounded-md px-2 py-0.5 text-xs font-medium',
                  statusBadge.cls,
                )}
              >
                {statusBadge.label}
              </span>
              <SlaInline target={t.slaTargetAt} status={t.status} />
              {isLegacy && <LegacyBadge />}
            </div>
            {t.cancelReason && (
              <div className="text-destructive mt-1 text-xs">Причина отмены: {t.cancelReason}</div>
            )}
            {isLegacy && (
              <p className="text-muted-foreground mt-1 max-w-xl text-xs">
                Заявка заведена в прежней программе и перенесена целиком. Сроки, SLA и часть полей
                там не велись — поэтому здесь они пустые.
              </p>
            )}
          </div>
          <div className="text-right">
            <div className="text-muted-foreground text-xs">Итого</div>
            <div className="text-2xl font-semibold tabular-nums">{kopecksToRub(totalKop)} ₽</div>
            <div className="text-muted-foreground text-xs">
              {vatRate === 'without_vat' ? 'без НДС' : `с НДС ${vatRate}%`}
            </div>
          </div>
        </div>

        <div className="mt-5 grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          <InfoBlock label="Клиент" icon={User}>
            <Link
              href={`/clients/${t.clientId}`}
              className="text-foreground hover:text-primary font-medium"
            >
              {t.clientDisplayName || '—'}
            </Link>
          </InfoBlock>
          <InfoBlock label="Контакт" icon={Phone}>
            {!t.contactId ? (
              <span className="text-muted-foreground">—</span>
            ) : ticketContact ? (
              <div>
                <div className="font-medium">{ticketContact.fullName ?? '—'}</div>
                {(ticketContact.position || ticketContact.phone) && (
                  <div className="text-muted-foreground text-xs">
                    {[ticketContact.position, ticketContact.phone].filter(Boolean).join(' · ')}
                  </div>
                )}
              </div>
            ) : clientFull.isLoading ? (
              <span className="text-muted-foreground text-xs">Загрузка…</span>
            ) : (
              <span className="text-muted-foreground text-xs">
                контакт удалён из карточки клиента
              </span>
            )}
          </InfoBlock>
          <InfoBlock label="Где техника" icon={MapPin}>
            <div className="font-medium">{INTAKE_LABELS[t.intakeMethod] ?? t.intakeMethod}</div>
          </InfoBlock>
          <InfoBlock label="Назначен инженер" icon={Wrench}>
            {t.assignedEngineerName ?? <span className="text-muted-foreground">не назначен</span>}
          </InfoBlock>
        </div>
      </header>

      <section className="bg-card rounded-lg border p-4 md:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 className="font-semibold">Жизненный цикл заявки</h2>
          <span className="text-muted-foreground text-xs">
            принято {formatDateTime(t.receivedAt)}
          </span>
        </div>
        <StagesTimeline status={t.status} />
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <section className="bg-card rounded-lg border lg:col-span-2">
          <Tabs value={tab} onChange={setTab} isStaff={isStaff} />
          <div className="space-y-6 p-4 md:p-6">
            {tab === 'details' && (
              <>
                <AssetCard
                  assetId={t.assetId}
                  model={t.assetModel}
                  serialNumber={t.assetSerialNumber}
                />
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Симптом со слов клиента</h3>
                  <p className="text-muted-foreground whitespace-pre-wrap text-sm leading-relaxed">
                    {t.symptom?.trim() || '—'}
                  </p>
                </div>
                {/* Импорт сложил в notes старый номер заказа, комплектацию и все
                    комментарии прежней программы, но веб не показывал это поле нигде —
                    десять лет переписки лежали в базе невидимыми. */}
                {isLegacy && t.notes?.trim() && (
                  <div>
                    <h3 className="mb-2 inline-flex items-center gap-2 text-sm font-semibold">
                      Записи прежней программы
                      <LegacyBadge compact />
                    </h3>
                    <p className="text-muted-foreground bg-muted/30 whitespace-pre-wrap rounded-md border p-3 text-xs leading-relaxed">
                      {t.notes.trim()}
                    </p>
                  </div>
                )}
                <div>
                  <h3 className="mb-2 text-sm font-semibold">Наряд</h3>
                  <WorkOrderEditor
                    ticketId={t.id}
                    ticketNumber={t.ticketNumber}
                    canEdit={canEditWorkOrder}
                    canEditVat={isStaff}
                    // Строки и цены — зона менеджера (решение владельца
                    // 2026-08-08): инженеру по своей заявке остаются текст
                    // шапки и склад, сервер строки от него не принимает.
                    canEditLines={isStaff}
                  />
                </div>
                {/* КП и счёт — деньги: инженеру не показываются и сервером не отдаются. */}
                {isStaff && <TicketKpBlock ticketId={t.id} canManage={isStaff} />}
                {isStaff && (
                  <TicketInvoiceSection
                    ticketId={t.id}
                    workOrderId={wo.data?.id ?? null}
                    isStaff={isStaff}
                    ticketCancelled={t.status === 'cancelled'}
                  />
                )}
              </>
            )}
            {tab === 'history' && (
              <div>
                <h3 className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold">
                  <History className="h-4 w-4" />
                  Хронология ({events.data?.length ?? 0})
                </h3>
                <ol className="space-y-3">
                  {events.isLoading ? (
                    <li className="text-muted-foreground text-sm">Загрузка…</li>
                  ) : (events.data ?? []).length === 0 ? (
                    <li className="text-muted-foreground text-sm">Событий пока нет</li>
                  ) : (
                    (events.data ?? []).map((ev) => <EventRow key={ev.id} event={ev} />)
                  )}
                </ol>
              </div>
            )}
            {tab === 'payments' && isStaff && (
              <TicketPayments ticketId={t.id} canManage={isStaff} />
            )}
            {tab === 'docs' && (
              <div className="space-y-4">
                <h3 className="text-sm font-semibold">Фото и сканы документов</h3>
                <PhotoUploader
                  kind="ticket_photo"
                  referenceType="ticket"
                  referenceId={t.id}
                  canUpload={canEditWorkOrder}
                  hint="Фото техники при приёме, сканы документов клиента, акты"
                />
              </div>
            )}
            {tab === 'checklists' && (
              <ChecklistsTab ticketId={t.id} status={t.status} canEdit={isStaff} />
            )}
          </div>
        </section>

        <aside className="space-y-4">
          <section className="bg-card rounded-lg border p-4">
            <h3 className="mb-3 inline-flex items-center gap-1.5 text-sm font-semibold">
              <Calendar className="h-4 w-4" />
              Последние события
            </h3>
            <ol className="space-y-3 text-xs">
              {events.isLoading ? (
                <li className="text-muted-foreground">Загрузка…</li>
              ) : (events.data ?? []).slice(0, 8).length === 0 ? (
                <li className="text-muted-foreground">Событий пока нет</li>
              ) : (
                (events.data ?? [])
                  .slice(0, 8)
                  .map((ev) => <EventRow key={ev.id} event={ev} compact />)
              )}
            </ol>
          </section>

          <ActionsPanel
            t={t}
            role={role}
            isDirector={isDirector}
            requiredAttestationCategory={assetFull.data?.requiredAttestationCategory ?? null}
            assetId={t.assetId ?? null}
            deviceType={assetFull.data?.deviceTypeResolved ?? null}
            deviceTypeSource={assetFull.data?.deviceTypeSource ?? null}
            onChangeStatus={(s) => changeStatus.mutate({ id: t.id, status: s })}
            onUpdate={(patch) => update.mutate({ id: t.id, patch })}
            onAddNote={(comment) => addNote.mutate({ ticketId: t.id, comment })}
            onCancel={(reason) => cancel.mutate({ id: t.id, reason })}
            onReopen={() => reopen.mutate({ id: t.id })}
            onDelete={() => del.mutate({ id: t.id })}
            deletePending={del.isPending}
            deleteError={del.error?.message ?? null}
            pending={
              changeStatus.isPending || update.isPending || cancel.isPending || reopen.isPending
            }
          />

          {isStaff && (
            <WaitingForPartPanel
              waiting={t.waitingForPart}
              note={t.waitingForPartNote}
              pending={setWaitingForPart.isPending}
              onSave={(waiting, note) =>
                setWaitingForPart.mutate({ ticketId: t.id, waiting, note })
              }
            />
          )}

          {isStaff && t.status !== 'closed' && t.status !== 'cancelled' && (
            <ExplainBlockPanel ticketId={t.id} />
          )}

          <RepairArchiveBlock ticketId={t.id} canSummarize={isStaff} autoSummary />

          <SimilarCasesBlock ticketId={t.id} excludeTicketId={t.id} />
        </aside>
      </div>

      <ComposeEmailModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        initialTo={clientEmail}
        relatedTicketId={t.id}
        relatedClientId={t.clientId}
        templateVars={{
          clientName: t.clientDisplayName,
          ticketNumber: t.ticketNumber,
          company: me.data?.tenant.displayName,
        }}
        attachmentOptions={composeAttachments}
      />
    </div>
  );
}

function PrintBtn({
  icon: Icon,
  label,
  onClick,
  emphasis,
}: {
  icon: typeof FileText;
  label: string;
  onClick: () => void;
  /** Акцентная подача — для «Пакета документов» (главная кнопка панели). */
  emphasis?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition',
        emphasis
          ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20 font-medium'
          : 'hover:bg-muted',
      )}
    >
      <Icon className="h-3.5 w-3.5" />
      {label}
    </button>
  );
}

/**
 * Кнопка «Ссылка для клиента» (фича №3 «Трек как посылку»).
 * Выдаёт публичную ссылку /track/<token> — клиент видит стадию ремонта без логина.
 * Диалог: показать/скопировать ссылку + отозвать её.
 */
function TrackShareButton({ ticketId }: { ticketId: string }) {
  const [open, setOpen] = useState(false);
  const [link, setLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const getLink = trpc.tickets.getShareLink.useMutation({ meta: SILENT_ERROR });
  const revoke = trpc.tickets.revokeShareLink.useMutation();
  const rootRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // a11y (норма кодовой базы, ср. ConfirmDialog): Escape закрывает, фокус заперт в модалке.
  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        return;
      }
      if (e.key === 'Tab' && rootRef.current) {
        const f = rootRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), input, textarea, select, [tabindex]:not([tabindex="-1"])',
        );
        if (f.length === 0) return;
        const first = f[0]!;
        const last = f[f.length - 1]!;
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !rootRef.current.contains(active))) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && (active === last || !rootRef.current.contains(active))) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  async function openDialog() {
    setCopied(false);
    setCopyFailed(false);
    setLink(null);
    setOpen(true);
    try {
      const res = await getLink.mutateAsync({ ticketId });
      setLink(`${window.location.origin}/track/${res.token}`);
    } catch {
      /* ошибка показывается через getLink.isError */
    }
  }

  async function copy() {
    if (!link) return;
    setCopyFailed(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(link);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Небезопасный контекст (http / старый вебвью) — выделяем поле для ручного Ctrl+C.
      inputRef.current?.select();
      setCopyFailed(true);
    }
  }

  async function doRevoke() {
    try {
      await revoke.mutateAsync({ ticketId });
      setOpen(false);
    } catch {
      /* ошибка отзыва — оставляем диалог открытым */
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => void openDialog()}
        disabled={getLink.isPending}
        className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition disabled:opacity-50"
      >
        <Link2 className="h-3.5 w-3.5" />
        Ссылка для клиента
      </button>

      {open && (
        <div
          ref={rootRef}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setOpen(false)}
          role="dialog"
          aria-modal="true"
          aria-label="Ссылка для клиента"
        >
          <div
            className="bg-card w-full max-w-md rounded-lg border p-5 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Link2 className="text-primary h-4 w-4" />
              <h3 className="text-sm font-semibold">Ссылка для клиента</h3>
            </div>
            <p className="text-muted-foreground mt-1 text-sm">
              Клиент откроет её и увидит стадию ремонта — как отслеживание посылки. Логин не нужен.
              Можно отправить в письме или мессенджере.
            </p>

            {getLink.isPending && (
              <div className="text-muted-foreground mt-4 flex items-center gap-2 text-sm">
                <Loader2 className="h-4 w-4 animate-spin" />
                Готовим ссылку…
              </div>
            )}
            {getLink.isError && (
              <div className="text-destructive mt-4 text-sm">Не удалось получить ссылку.</div>
            )}
            {link && (
              <div className="mt-4 flex items-center gap-2">
                <input
                  ref={inputRef}
                  readOnly
                  value={link}
                  onFocus={(e) => e.currentTarget.select()}
                  className="bg-muted/40 flex-1 rounded-md border px-2.5 py-1.5 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex shrink-0 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition"
                >
                  {copied ? (
                    <CheckCircle2 className="h-3.5 w-3.5" />
                  ) : (
                    <Copy className="h-3.5 w-3.5" />
                  )}
                  {copied ? 'Скопировано' : 'Копировать'}
                </button>
              </div>
            )}
            {copyFailed && (
              <div className="text-muted-foreground mt-2 text-xs">
                Не удалось скопировать автоматически — выделите ссылку и нажмите Ctrl+C.
              </div>
            )}

            <div className="mt-5 flex items-center justify-between">
              <button
                type="button"
                onClick={() => void doRevoke()}
                disabled={revoke.isPending || !link}
                className="text-destructive text-sm hover:underline disabled:opacity-50"
              >
                Отозвать ссылку
              </button>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                className="hover:bg-muted rounded-md border px-3 py-1.5 text-sm transition"
              >
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function StagesTimeline({ status }: { status: TicketStatus }) {
  const currentIdx = STAGES.findIndex((s) => s.value === status);
  return (
    <ol className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {STAGES.map((s, i) => {
        const state: 'done' | 'current' | 'pending' =
          status === 'cancelled'
            ? 'pending'
            : i < currentIdx
              ? 'done'
              : i === currentIdx
                ? 'current'
                : 'pending';
        return (
          <li key={s.value} className="relative flex flex-col items-start gap-1.5">
            {i < STAGES.length - 1 && (
              <div
                className={cn(
                  'absolute left-3 right-0 top-3 hidden h-px lg:block',
                  state === 'done' ? 'bg-primary' : 'bg-border',
                )}
                aria-hidden
              />
            )}
            <div className="flex items-center gap-2">
              {state === 'done' ? (
                <CheckCircle2 className="text-primary h-5 w-5 shrink-0" />
              ) : state === 'current' ? (
                <div className="border-primary bg-background relative grid h-5 w-5 shrink-0 place-items-center rounded-full border-2">
                  <div className="bg-primary h-2 w-2 animate-pulse rounded-full" />
                </div>
              ) : (
                <Circle className="text-muted-foreground/40 h-5 w-5 shrink-0" />
              )}
              <span
                className={cn(
                  'text-sm font-medium',
                  state === 'pending' && 'text-muted-foreground',
                )}
              >
                {s.label}
              </span>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function Tabs({
  value,
  onChange,
  isStaff,
}: {
  value: Tab;
  onChange: (v: Tab) => void;
  isStaff: boolean;
}) {
  const tabs: Array<{ v: Tab; label: string }> = [
    { v: 'details', label: 'Детали' },
    { v: 'history', label: 'История' },
    // Деньги — не инженеру («у инженера только техническая часть вопроса»,
    // решение владельца 2026-08-11); сервер это тоже не отдаст (staffProcedure).
    ...(isStaff ? [{ v: 'payments' as Tab, label: 'Платежи' }] : []),
    { v: 'docs', label: 'Документы' },
    { v: 'checklists', label: 'Чек-листы' },
  ];
  return (
    <div className="flex border-b">
      {tabs.map((t) => (
        <button
          key={t.v}
          type="button"
          onClick={() => onChange(t.v)}
          className={cn(
            'border-b-2 px-4 py-2.5 text-sm font-medium transition',
            value === t.v
              ? 'border-primary text-foreground'
              : 'text-muted-foreground hover:text-foreground border-transparent',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function AssetCard({
  assetId,
  model,
  serialNumber,
}: {
  assetId: string | null;
  model: string | null;
  serialNumber: string | null;
}) {
  const asset = trpc.assets.get.useQuery({ id: assetId ?? '' }, { enabled: !!assetId });
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Техника</h3>
      {!assetId ? (
        <div className="text-muted-foreground bg-muted/40 rounded-md border p-3 text-sm">
          Не привязана к единице техники
        </div>
      ) : (
        <div className="bg-muted/40 rounded-md border p-3 text-sm">
          <Link href={`/assets/${assetId}`} className="hover:text-primary font-medium">
            {asset.data?.model ?? model ?? '—'}
          </Link>
          <div className="text-muted-foreground mt-1 grid grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
            <div>
              Серийник:{' '}
              <span className="font-mono">{asset.data?.serialNumber ?? serialNumber ?? '—'}</span>
            </div>
            <div>
              Инв. №: <span className="font-mono">{asset.data?.inventoryNumber ?? '—'}</span>
            </div>
            <div>Класс риска: {asset.data?.riskClass ?? '—'}</div>
            <div>Гарантия до: {asset.data?.warrantyUntil ?? '—'}</div>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionsPanel({
  t,
  role,
  isDirector,
  requiredAttestationCategory,
  assetId,
  deviceType,
  deviceTypeSource,
  onChangeStatus,
  onUpdate,
  onAddNote,
  onCancel,
  onReopen,
  onDelete,
  deletePending,
  deleteError,
  pending,
}: {
  t: {
    id: string;
    status: TicketStatus;
    priority: TicketPriority;
    assignedEngineerId: string | null;
    assignedDispatcherId: string | null;
    helperEngineers: Array<{ userId: string; fullName: string | null }>;
  };
  role?: 'director' | 'dispatcher' | 'engineer';
  isDirector: boolean;
  /** Stage 10'.I — категория аттестации, требуемая для обслуживания asset'а. */
  requiredAttestationCategory: string | null;
  /** Единица техники заявки — для подсказок при назначении (аттестация). */
  assetId: string | null;
  /**
   * Тип техники заявки — для подсказки «есть ли навык». Если в карточке техники он не
   * заполнен, приходит выведенный по архиву прежних ремонтов той же модели.
   */
  deviceType: string | null;
  deviceTypeSource: 'own' | 'archive' | null;
  onChangeStatus: (s: TicketStatus) => void;
  onUpdate: (patch: Record<string, unknown>) => void;
  onAddNote: (c: string) => void;
  onCancel: (reason?: string) => void;
  onReopen: () => void;
  onDelete: () => void;
  deletePending: boolean;
  deleteError: string | null;
  pending: boolean;
}) {
  const [statusDraft, setStatusDraft] = useState<TicketStatus | null>(null);
  const [priorityDraft, setPriorityDraft] = useState<TicketPriority | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  // Список сотрудников для назначений. Заблокированных (в т.ч. историч. аккаунты
  // из миграции WinServisePro — «призраки» с инициалами) в выбор НЕ показываем,
  // чтобы не засорять список. Исключение — тот, кто уже назначен на ЭТУ заявку:
  // его оставляем, чтобы он не «исчез» из селекта (иначе не видно текущего значения).
  const usersQ = trpc.users.list.useQuery({ includeBlocked: true });
  const engineerOptions = (usersQ.data ?? []).filter(
    (u) => u.role === 'engineer' && (u.isActive || u.id === t.assignedEngineerId),
  );
  const dispatcherOptions = (usersQ.data ?? []).filter(
    (u) =>
      (u.role === 'dispatcher' || u.role === 'director') &&
      (u.isActive || u.id === t.assignedDispatcherId),
  );

  const isClosed = t.status === 'closed' || t.status === 'cancelled';
  // Отменяют директор и диспетчер — ровно как разрешает сервер (tickets.cancel).
  const canCancel = (role === 'director' || role === 'dispatcher') && !isClosed;
  const allowedStatuses = role === 'engineer' ? ENGINEER_STATUSES : STAFF_STATUSES;

  return (
    <section className="bg-card space-y-4 rounded-lg border p-4">
      <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide">
        <Activity className="h-4 w-4" />
        Действия
      </h3>

      {!isClosed && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs uppercase">Статус</div>
          <div className="flex gap-2">
            <select
              value={statusDraft ?? t.status}
              onChange={(e) => setStatusDraft(e.target.value as TicketStatus)}
              className="bg-background focus:ring-primary/40 flex-1 rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
            >
              {allowedStatuses.map((s) => (
                <option key={s} value={s}>
                  {STATUS_BADGE[s].label}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={pending || !statusDraft || statusDraft === t.status}
              onClick={() => statusDraft && onChangeStatus(statusDraft)}
              className="bg-primary text-primary-foreground hover:bg-primary/90 rounded-md px-3 py-1.5 text-sm disabled:opacity-50"
            >
              Применить
            </button>
          </div>
          {t.status !== 'act_pending' && (
            <button
              type="button"
              onClick={() => onChangeStatus('act_pending')}
              disabled={pending}
              className="text-primary hover:bg-primary/10 border-primary/30 mt-2 w-full rounded-md border px-3 py-1.5 text-xs"
            >
              Перевести в «Ожидает акта»
            </button>
          )}
          {t.status !== 'closed' && (
            <button
              type="button"
              onClick={() => onChangeStatus('closed')}
              disabled={pending}
              className="bg-success/10 text-success hover:bg-success/20 mt-1 w-full rounded-md px-3 py-1.5 text-xs"
            >
              Закрыть наряд
            </button>
          )}
        </div>
      )}

      {!isClosed && (
        <div>
          <div className="text-muted-foreground mb-1 text-xs uppercase">Приоритет</div>
          <div className="flex flex-wrap gap-1">
            {PRIORITY_OPTS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPriorityDraft(p)}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-xs transition',
                  (priorityDraft ?? t.priority) === p
                    ? 'border-primary bg-primary/10 text-primary'
                    : 'border-border text-muted-foreground hover:border-foreground/30',
                )}
              >
                {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
          {priorityDraft && priorityDraft !== t.priority && (
            <button
              type="button"
              onClick={() => {
                onUpdate({ priority: priorityDraft });
                setPriorityDraft(null);
              }}
              className="bg-primary text-primary-foreground hover:bg-primary/90 mt-2 w-full rounded-md px-3 py-1 text-xs"
            >
              Сохранить приоритет
            </button>
          )}
        </div>
      )}

      {!isClosed && (
        <div className="space-y-1">
          <AssignSelect
            icon={Wrench}
            label="Инженер"
            value={t.assignedEngineerId}
            options={engineerOptions}
            loading={usersQ.isLoading}
            disabled={pending}
            onApply={(id) => onUpdate({ assignedEngineerId: id })}
          />
          <EngineerAssignmentHints
            deviceType={deviceType}
            deviceTypeSource={deviceTypeSource}
            assetId={assetId}
            selectedEngineerId={t.assignedEngineerId}
          />
          <EngineerAttestationBadge
            engineerId={t.assignedEngineerId}
            requiredCategory={requiredAttestationCategory}
          />
          <HelperEngineersPicker
            ticketId={t.id}
            assignedEngineerId={t.assignedEngineerId}
            helpers={t.helperEngineers}
            options={engineerOptions}
            disabled={pending}
          />
        </div>
      )}
      {!isClosed && (
        <AssignSelect
          icon={UserCog}
          label="Диспетчер"
          value={t.assignedDispatcherId}
          options={dispatcherOptions}
          loading={usersQ.isLoading}
          disabled={pending}
          onApply={(id) => onUpdate({ assignedDispatcherId: id })}
        />
      )}

      <div>
        <div className="text-muted-foreground mb-1 text-xs uppercase">Заметка</div>
        <textarea
          value={noteDraft}
          onChange={(e) => setNoteDraft(e.target.value)}
          rows={2}
          placeholder="Что произошло?"
          className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
        />
        <button
          type="button"
          disabled={!noteDraft.trim()}
          onClick={() => {
            onAddNote(noteDraft.trim());
            setNoteDraft('');
          }}
          className="bg-primary text-primary-foreground hover:bg-primary/90 mt-1.5 inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-xs disabled:opacity-50"
        >
          Добавить
        </button>
      </div>

      {/* Отменять может и диспетчер — так же, как на сервере (tickets.cancel —
          staffProcedure). Раньше кнопку видел только директор, хотя диспетчер и
          так отменял заявку сменой статуса. Переоткрытие и удаление — по-прежнему
          только директор. */}
      {(canCancel || isDirector) && (
        <div className="border-t pt-3">
          {canCancel && (
            <button
              type="button"
              onClick={() => setCancelOpen(true)}
              disabled={pending}
              className="text-destructive border-destructive/30 hover:bg-destructive/10 inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-50"
            >
              <XCircle className="h-3.5 w-3.5" />
              Отменить заявку
            </button>
          )}
          {isDirector && isClosed && (
            <button
              type="button"
              onClick={onReopen}
              disabled={pending}
              className="text-primary border-primary/30 hover:bg-primary/10 inline-flex w-full items-center justify-center gap-1.5 rounded-md border px-3 py-1.5 text-xs transition disabled:opacity-50"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Переоткрыть
            </button>
          )}
          {isDirector && (
            <button
              type="button"
              onClick={() => setDeleteOpen(true)}
              disabled={pending || deletePending}
              className="text-destructive/80 hover:bg-destructive/10 mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-xs transition disabled:opacity-50"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Удалить заявку
            </button>
          )}
        </div>
      )}

      <PromptDialog
        open={cancelOpen}
        title="Отменить заявку?"
        description="Заявка перейдёт в статус «Отменена». Вернуть её в работу сможет директор кнопкой «Переоткрыть»."
        label="Причина отмены (необязательно)"
        placeholder="Например: клиент отказался от ремонта"
        multiline
        variant="danger"
        confirmText="Отменить заявку"
        cancelText="Не отменять"
        loading={pending}
        onConfirm={(v) => {
          onCancel(v.trim() || undefined);
          setCancelOpen(false);
        }}
        onCancel={() => setCancelOpen(false)}
      />

      <ConfirmDialog
        open={deleteOpen}
        title="Удалить заявку?"
        description={
          'Заявка исчезнет из всех списков, поиска, доски и отчётов. Данные физически сохранятся ' +
          '(восстановить сможет разработчик по запросу). Заявки с оплатами или выставленными счетами удалить нельзя.'
        }
        variant="danger"
        confirmText="Удалить"
        cancelText="Не удалять"
        loading={deletePending}
        error={deleteError}
        onConfirm={onDelete}
        onCancel={() => setDeleteOpen(false)}
      />
    </section>
  );
}

/**
 * Фича A — панель «Ждём запчасть». Флаг-пометка (не статус): простой из-за ожидания
 * детали — не вина инженера. Менеджер ставит флаг и пишет, что именно ждём.
 */
function WaitingForPartPanel({
  waiting,
  note,
  pending,
  onSave,
}: {
  waiting: boolean;
  note: string | null;
  pending: boolean;
  onSave: (waiting: boolean, note: string | null) => void;
}) {
  const [noteDraft, setNoteDraft] = useState(note ?? '');
  // Синхронизируем черновик при смене заявки/значения с сервера.
  const [lastNote, setLastNote] = useState(note ?? '');
  if ((note ?? '') !== lastNote) {
    setLastNote(note ?? '');
    setNoteDraft(note ?? '');
  }

  return (
    <section
      className={cn(
        'rounded-lg border p-4',
        waiting ? 'border-warning/40 bg-warning/5' : 'bg-card',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="inline-flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wide">
          <Package className={cn('h-4 w-4', waiting && 'text-warning')} />
          Ждём запчасть
        </h3>
        <button
          type="button"
          role="switch"
          aria-checked={waiting}
          aria-label="Ждём запчасть"
          disabled={pending}
          onClick={() => onSave(!waiting, !waiting ? noteDraft.trim() || null : null)}
          className={cn(
            'relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors disabled:opacity-50',
            waiting ? 'bg-warning' : 'bg-muted',
          )}
        >
          <span
            className={cn(
              'pointer-events-none inline-block h-5 w-5 rounded-full bg-white shadow-lg transition-transform',
              waiting ? 'translate-x-5' : 'translate-x-0',
            )}
          />
        </button>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">
        Пометка для менеджера: заявка стоит из-за ожидания детали (простой не на инженере).
      </p>
      {waiting && (
        <div className="mt-3">
          <div className="text-muted-foreground mb-1 text-xs uppercase">Что ждём</div>
          <textarea
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            rows={2}
            maxLength={500}
            placeholder="Например: плата питания Mindray, поставщик МедКомплект, срок ~2 нед."
            className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2"
          />
          <button
            type="button"
            disabled={pending || noteDraft.trim() === (note ?? '')}
            onClick={() => onSave(true, noteDraft.trim() || null)}
            className="bg-primary text-primary-foreground hover:bg-primary/90 mt-1.5 rounded-md px-3 py-1.5 text-xs disabled:opacity-50"
          >
            Сохранить заметку
          </button>
        </div>
      )}
    </section>
  );
}

/**
 * Stage 10'.I — индикатор соответствия инженера требуемой категории аттестации.
 * Показывается под селектом инженера. Цвета:
 *   - серый: требование не задано на ассете;
 *   - зелёный: инженер имеет действующую аттестацию;
 *   - оранжевый: инженер не имеет / просрочена.
 *
 * Не блокирует UI — это soft-warning, диспетчер может назначить и без аттестации.
 */
function EngineerAttestationBadge({
  engineerId,
  requiredCategory,
}: {
  engineerId: string | null;
  requiredCategory: string | null;
}) {
  const q = trpc.attestations.checkAssignment.useQuery(
    { engineerId: engineerId ?? '', requiredCategory },
    { enabled: !!engineerId && !!requiredCategory },
  );
  if (!engineerId) return null;
  if (!requiredCategory) {
    return (
      <div className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
        <Award className="h-3 w-3" />
        требование аттестации не задано
      </div>
    );
  }
  if (q.isLoading) return null;
  // q.data: string | null. null = всё ок.
  if (q.data === null) {
    return (
      <div className="bg-success/10 text-success inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]">
        <Award className="h-3 w-3" />
        аттестация {requiredCategory} — есть
      </div>
    );
  }
  return (
    <div className="bg-warning/15 text-warning inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]">
      <AlertTriangle className="h-3 w-3" />
      {q.data}
    </div>
  );
}

/**
 * Помощники — второй, третий инженер на той же работе.
 *
 * Ответственный выбирается выше отдельным полем и в этом списке НЕ показывается:
 * иначе один человек оказался бы в заявке дважды. Список отправляется целиком,
 * как галочки в форме, — сервер заменяет им прежний.
 */
function HelperEngineersPicker({
  ticketId,
  assignedEngineerId,
  helpers,
  options,
  disabled,
}: {
  ticketId: string;
  assignedEngineerId: string | null;
  helpers: Array<{ userId: string; fullName: string | null }>;
  options: Array<{ id: string; fullName: string; isActive: boolean }>;
  disabled: boolean;
}) {
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const setEngineers = trpc.tickets.setEngineers.useMutation({
    onSuccess: () => {
      void utils.tickets.get.invalidate({ id: ticketId });
    },
  });
  const selected = new Set(helpers.map((h) => h.userId));
  const pickable = options.filter((u) => u.id !== assignedEngineerId);

  function toggle(userId: string) {
    const next = new Set(selected);
    if (next.has(userId)) next.delete(userId);
    else next.add(userId);
    setEngineers.mutate({ ticketId, userIds: [...next] });
  }

  return (
    <div className="pt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-xs disabled:opacity-50"
      >
        <Users className="h-3 w-3" />
        {helpers.length > 0 ? `Ещё работают: ${helpers.length}` : 'Добавить помощников'}
      </button>

      {helpers.length > 0 && !open && (
        <p className="text-muted-foreground mt-1 text-xs">
          {helpers.map((h) => h.fullName ?? 'без имени').join(', ')}
        </p>
      )}

      {open && (
        <div className="mt-2 space-y-1 rounded-md border p-2">
          {pickable.length === 0 ? (
            <p className="text-muted-foreground text-xs">Других инженеров нет</p>
          ) : (
            pickable.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={selected.has(u.id)}
                  disabled={disabled || setEngineers.isPending}
                  onChange={() => toggle(u.id)}
                  className="h-4 w-4 rounded border"
                />
                <span>
                  {u.fullName}
                  {u.isActive ? '' : ' (заблокирован)'}
                </span>
              </label>
            ))
          )}
          {setEngineers.error && (
            <p className="text-destructive text-xs">{setEngineers.error.message}</p>
          )}
        </div>
      )}
    </div>
  );
}

function AssignSelect({
  icon: Icon,
  label,
  value,
  options,
  loading,
  disabled,
  onApply,
}: {
  icon: typeof Wrench;
  label: string;
  /** Текущий назначенный пользователь (id) или null. */
  value: string | null;
  options: Array<{ id: string; fullName: string; isActive: boolean }>;
  loading: boolean;
  disabled: boolean;
  onApply: (id: string | null) => void;
}) {
  return (
    <label className="block">
      <span className="text-muted-foreground mb-1 inline-flex items-center gap-1 text-xs uppercase">
        <Icon className="h-3 w-3" />
        {label}
      </span>
      <select
        value={value ?? ''}
        disabled={disabled || loading}
        onChange={(e) => onApply(e.target.value || null)}
        className="bg-background focus:ring-primary/40 w-full rounded-md border px-2 py-1.5 text-sm outline-none focus:ring-2 disabled:opacity-50"
      >
        <option value="">{loading ? 'загрузка…' : 'не назначен'}</option>
        {options.map((u) => (
          <option key={u.id} value={u.id}>
            {u.fullName}
            {u.isActive ? '' : ' (заблокирован)'}
          </option>
        ))}
      </select>
    </label>
  );
}

function InfoBlock({
  label,
  icon: Icon,
  children,
}: {
  label: string;
  icon: typeof User;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-muted-foreground mb-1 inline-flex items-center gap-1 text-[11px] font-medium uppercase tracking-wide">
        <Icon className="h-3 w-3" />
        {label}
      </div>
      <div className="text-sm">{children}</div>
    </div>
  );
}

function SlaInline({ target, status }: { target: Date | null; status: TicketStatus }) {
  if (status === 'closed' || status === 'cancelled') return null;
  if (!target) return null;
  const diffMs = new Date(target).getTime() - Date.now();
  const diffH = diffMs / 3_600_000;
  let cls = 'bg-success/15 text-success';
  let label = '';
  if (diffMs < 0) {
    cls = 'bg-destructive/15 text-destructive';
    label = `SLA просрочено на ${Math.ceil(-diffH)}ч`;
  } else if (diffH < 4) {
    cls = 'bg-warning/15 text-warning';
    label = `SLA через ${Math.max(1, Math.round(diffH))}ч`;
  } else {
    label = `SLA через ${diffH < 24 ? Math.round(diffH) + 'ч' : Math.round(diffH / 24) + 'д'}`;
  }
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium',
        cls,
      )}
    >
      <Clock className="h-3 w-3" />
      {label}
    </span>
  );
}

interface EventDto {
  id: string;
  type: TicketEventType;
  userId: string | null;
  userFullName: string | null;
  payload: {
    from?: unknown;
    to?: unknown;
    comment?: string;
    documentKind?: 'intake_act' | 'invoice' | 'work_act' | 'defect_act' | 'tech_condition_act';
    role?: 'engineer' | 'dispatcher';
  };
  createdAt: Date;
}

function EventRow({ event, compact }: { event: EventDto; compact?: boolean }) {
  const ts = formatDateTime(event.createdAt);
  let icon = <StickyNote className="text-muted-foreground h-4 w-4" />;
  let title = 'Событие';
  let body: React.ReactNode = null;

  const p = event.payload;

  if (event.type === 'created') {
    icon = <Sparkles className="text-primary h-4 w-4" />;
    title = 'Заявка создана';
  } else if (event.type === 'status_change') {
    icon = <Activity className="text-primary h-4 w-4" />;
    title = 'Изменение статуса';
    body = (
      // Перенесённые заявки хранят историю без поля «откуда» и со статусами старой
      // программы: без защиты на экране печаталось «undefined → Аппарат готов».
      <div className="text-muted-foreground text-xs">
        {eventStatusLabel(p.from)} →{' '}
        <span className="text-foreground font-medium">{eventStatusLabel(p.to)}</span>
      </div>
    );
  } else if (event.type === 'assignment_change') {
    icon = <UserCog className="text-primary h-4 w-4" />;
    title = p.role === 'dispatcher' ? 'Назначен диспетчер' : 'Назначен инженер';
    body = (
      <div className="text-muted-foreground text-xs">
        {typeof p.from === 'string' ? p.from : '—'} →{' '}
        <span className="text-foreground">{typeof p.to === 'string' ? p.to : '—'}</span>
      </div>
    );
  } else if (event.type === 'priority_change') {
    icon = <Tag className="text-warning h-4 w-4" />;
    title = 'Изменение приоритета';
    body = (
      <div className="text-muted-foreground text-xs">
        {eventPriorityLabel(p.from)} →{' '}
        <span className="text-foreground font-medium">{eventPriorityLabel(p.to)}</span>
      </div>
    );
  } else if (event.type === 'sla_change') {
    icon = <AlertOctagon className="text-warning h-4 w-4" />;
    title = 'Изменение SLA / дедлайна';
  } else if (event.type === 'note') {
    icon = <StickyNote className="text-warning h-4 w-4" />;
    title = 'Заметка';
    body = <div className="text-foreground mt-0.5 whitespace-pre-wrap text-sm">{p.comment}</div>;
  } else if (event.type === 'document_printed') {
    icon = <Printer className="text-primary h-4 w-4" />;
    const kindLabel =
      p.documentKind === 'intake_act'
        ? 'Акт приёма'
        : p.documentKind === 'invoice'
          ? 'Счёт'
          : p.documentKind === 'defect_act'
            ? 'Дефектный акт'
            : p.documentKind === 'tech_condition_act'
              ? 'Акт технического состояния'
              : 'Акт работ';
    title = `Документ напечатан: ${kindLabel}`;
  }

  return (
    <li className="flex gap-3">
      <div className="bg-muted/40 flex h-8 w-8 shrink-0 items-center justify-center rounded-full">
        {icon}
      </div>
      <div className="flex-1 border-b pb-3">
        <div className="flex items-baseline justify-between gap-2">
          <div className={cn('font-medium', compact ? 'text-xs' : 'text-sm')}>{title}</div>
          <div className="text-muted-foreground shrink-0 text-[11px]">{ts}</div>
        </div>
        {event.userFullName && (
          <div className="text-muted-foreground inline-flex items-center gap-1 text-[11px]">
            <Building2 className="h-2.5 w-2.5" />
            {event.userFullName}
          </div>
        )}
        {body}
      </div>
    </li>
  );
}

function formatDateTime(d: Date) {
  return new Date(d).toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const INVOICE_STATUS_BADGE: Record<string, { label: string; cls: string }> = {
  draft: { label: 'Черновик', cls: 'bg-muted text-muted-foreground' },
  issued: { label: 'Выставлен', cls: 'bg-primary/10 text-primary' },
  partially_paid: { label: 'Частично', cls: 'bg-warning/15 text-warning' },
  paid: { label: 'Оплачен', cls: 'bg-success/10 text-success' },
  overdue: { label: 'Просрочен', cls: 'bg-destructive/10 text-destructive' },
  cancelled: { label: 'Отменён', cls: 'bg-muted text-muted-foreground' },
};

function TicketInvoiceSection({
  ticketId,
  workOrderId,
  isStaff,
  ticketCancelled,
}: {
  ticketId: string;
  workOrderId: string | null;
  isStaff: boolean;
  /** Отменённая заявка — денег по ней не бывает, сервер счёт и не выставит. */
  ticketCancelled: boolean;
}) {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const invoices = trpc.invoices.listByTicket.useQuery({ ticketId }, { enabled: !!ticketId });
  const createDraft = trpc.invoices.createDraft.useMutation({
    onSuccess: async (inv) => {
      await utils.invoices.listByTicket.invalidate({ ticketId });
      navigate(`/invoices/${inv.id}`);
    },
  });

  const inv = invoices.data?.[0] ?? null;

  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">Счёт</h3>
      {invoices.isLoading ? (
        <div className="text-muted-foreground text-sm">Загрузка…</div>
      ) : inv ? (
        <div className="bg-muted/40 flex items-center justify-between rounded-md border p-3 text-sm">
          <div className="flex items-center gap-2">
            <span className="font-mono text-xs font-medium">{inv.invoiceNumber}</span>
            <span
              className={cn(
                'inline-flex items-center rounded-md px-2 py-0.5 text-xs',
                (INVOICE_STATUS_BADGE[inv.status] ?? { cls: 'bg-muted text-muted-foreground' }).cls,
              )}
            >
              {(INVOICE_STATUS_BADGE[inv.status] ?? { label: inv.status }).label}
            </span>
            <span className="text-muted-foreground text-xs">
              {Number(inv.totalAmountKopecks) > 0
                ? (Number(inv.totalAmountKopecks) / 100).toLocaleString('ru-RU', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  }) + ' ₽'
                : ''}
            </span>
            {inv.dueDate && (
              <span className="text-muted-foreground text-xs">
                до {new Date(inv.dueDate).toLocaleDateString('ru-RU')}
              </span>
            )}
          </div>
          <Link
            href={`/invoices/${inv.id}`}
            className="text-primary text-xs underline-offset-2 hover:underline"
          >
            Открыть
          </Link>
        </div>
      ) : isStaff && workOrderId && !ticketCancelled ? (
        <button
          type="button"
          disabled={createDraft.isPending}
          onClick={() => createDraft.mutate({ workOrderId })}
          className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium disabled:opacity-50"
        >
          {createDraft.isPending ? 'Создаю…' : 'Выставить счёт'}
        </button>
      ) : (
        <div className="text-muted-foreground text-sm">
          {ticketCancelled
            ? 'Заявка отменена — счёт по ней не выставляется'
            : !workOrderId
              ? 'Сначала создайте наряд'
              : 'Счёт не создан'}
        </div>
      )}
      {createDraft.error && (
        <div className="text-destructive mt-1 text-xs">{createDraft.error.message}</div>
      )}
    </div>
  );
}

function ChecklistsTab({
  ticketId,
  status,
  canEdit,
}: {
  ticketId: string;
  status: TicketStatus;
  canEdit: boolean;
}) {
  const list = trpc.intakeChecklists.listForTicket.useQuery({ ticketId });
  const [create, setCreate] = useState<ChecklistKind | null>(null);
  const [view, setView] = useState<string | null>(null);

  const items = list.data ?? [];
  const intakes = items.filter((c) => c.kind === 'intake');
  const handovers = items.filter((c) => c.kind === 'handover');

  // Кнопки доступны по фазам ЖЦ заявки.
  const showIntakeBtn =
    canEdit && (status === 'received' || status === 'diagnostics') && intakes.length === 0;
  const showHandoverBtn =
    canEdit && (status === 'act_pending' || status === 'closed') && handovers.length === 0;

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Чек-листы приёмки и выдачи</h3>
      <p className="text-muted-foreground text-xs">
        Фиксируем состояние техники при приёме (царапины, комплектация, работоспособность) и при
        выдаче. Каждый пункт можно сопроводить фото и комментарием — это исключает споры с клиентом.
      </p>

      <div className="flex flex-wrap items-center gap-2">
        {showIntakeBtn && (
          <button
            type="button"
            onClick={() => setCreate('intake')}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
          >
            <Sparkles className="h-3.5 w-3.5" /> Чек-лист приёмки
          </button>
        )}
        {showHandoverBtn && (
          <button
            type="button"
            onClick={() => setCreate('handover')}
            className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium"
          >
            <Sparkles className="h-3.5 w-3.5" /> Чек-лист выдачи
          </button>
        )}
        {!showIntakeBtn && !showHandoverBtn && items.length === 0 && (
          <span className="text-muted-foreground text-xs">
            Чек-лист доступен на этапах приёма / диагностики и при выдаче (акт / закрытие).
          </span>
        )}
      </div>

      {list.isLoading ? (
        <div className="text-muted-foreground text-sm">Загрузка…</div>
      ) : items.length === 0 ? (
        <div className="text-muted-foreground bg-muted/30 rounded-md border border-dashed p-3 text-xs">
          Чек-листов пока нет.
        </div>
      ) : (
        <ul className="space-y-2">
          {items.map((c) => (
            <li
              key={c.id}
              className="bg-card flex items-center justify-between gap-2 rounded-md border p-2"
            >
              <div className="flex-1 text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{c.kind === 'intake' ? 'Приёмка' : 'Выдача'}</span>
                  <span className="text-muted-foreground text-xs">
                    {new Date(c.completedAt).toLocaleString('ru-RU')}
                  </span>
                </div>
                <div className="text-muted-foreground text-xs">
                  пунктов: {c.itemsCount} · замечаний:{' '}
                  <span className={cn(c.issuesCount > 0 ? 'text-destructive' : '')}>
                    {c.issuesCount}
                  </span>
                  {c.clientSignatureName && ` · принял: ${c.clientSignatureName}`}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setView(c.id)}
                className="hover:bg-muted rounded-md border px-2.5 py-1 text-xs"
              >
                Открыть
              </button>
            </li>
          ))}
        </ul>
      )}

      {create && (
        <IntakeChecklistDialog
          mode="create"
          open
          ticketId={ticketId}
          kind={create}
          onClose={() => setCreate(null)}
        />
      )}
      {view && (
        <IntakeChecklistDialog
          mode="view"
          open
          ticketId={ticketId}
          checklistId={view}
          onClose={() => setView(null)}
        />
      )}
    </div>
  );
}
