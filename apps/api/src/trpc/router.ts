import { router, publicProcedure } from './trpc';
import { authRouter } from '../modules/auth/router';
import { clientsRouter } from '../modules/clients';
import { assetsRouter } from '../modules/assets';
import { ticketsRouter } from '../modules/tickets';
import { workOrdersRouter } from '../modules/work-orders';
import { inventoryItemsRouter } from '../modules/inventory-items';
import { inventoryBatchesRouter } from '../modules/inventory-batches';
import { inventoryMovementsRouter } from '../modules/inventory-movements';
import { maintenanceRouter } from '../modules/maintenance';
import { paymentsRouter } from '../modules/payments';
import { attachmentsRouter } from '../modules/attachments';
import { contractsRouter } from '../modules/contracts';
import { notificationsRouter } from '../modules/notifications';
import { telegramRouter } from '../modules/telegram';
import { invoicesRouter } from '../modules/invoices';
import { onecRouter } from '../modules/onec';
import { dashboardRouter } from '../modules/dashboard';
import { payrollRouter } from '../modules/payroll';
import { usersRouter } from '../modules/users';
import { attestationsRouter } from '../modules/attestations';
import { auditRouter } from '../modules/audit';
import { searchRouter } from '../modules/search';
import { intakeChecklistsRouter } from '../modules/intake-checklists';
import { ticketTemplatesRouter } from '../modules/ticket-templates';
import { kbArticlesRouter } from '../modules/kb-articles';
import { leadsRouter } from '../modules/leads';
import { warrantiesRouter } from '../modules/warranties';
import { ticketKpRouter } from '../modules/kp-versions';
import { reportsRouter } from '../modules/reports';
import { tradeInRouter } from '../modules/trade-in';
import { roadmapRouter } from '../modules/roadmap';
import { calendarRouter } from '../modules/calendar';
import { settingsRouter } from '../modules/settings';
import { emailRouter } from '../modules/email';
import { cashRouter } from '../modules/cash';
import { salesRouter } from '../modules/sales';
import { backupRouter } from '../modules/backup';
import {
  clientAuthRouter,
  clientCabinetRouter,
  adminClientUsersRouter,
} from '../modules/client-cabinet';

export const appRouter = router({
  health: publicProcedure.query(() => ({
    status: 'ok',
    ts: new Date().toISOString(),
  })),
  auth: authRouter,
  clients: clientsRouter,
  assets: assetsRouter,
  tickets: ticketsRouter,
  workOrders: workOrdersRouter,
  inventoryItems: inventoryItemsRouter,
  inventoryBatches: inventoryBatchesRouter,
  inventoryMovements: inventoryMovementsRouter,
  maintenance: maintenanceRouter,
  payments: paymentsRouter,
  attachments: attachmentsRouter,
  contracts: contractsRouter,
  notifications: notificationsRouter,
  telegram: telegramRouter,
  invoices: invoicesRouter,
  onec: onecRouter,
  dashboard: dashboardRouter,
  payroll: payrollRouter,
  users: usersRouter,
  attestations: attestationsRouter,
  audit: auditRouter,
  /** Глобальный поиск (Cmd+K / Ctrl+K) — заявки/клиенты/техника/счета/договоры. */
  search: searchRouter,
  /** Stage 10'.J — чек-листы приёма/выдачи техники. */
  intakeChecklists: intakeChecklistsRouter,
  /** Шаблоны заявок (Замена термопасты, Калибровка тонометра и пр.) — autofill при создании тикета. */
  ticketTemplates: ticketTemplatesRouter,
  /** База знаний — внутренняя «вики» по моделям техники + блок «Похожие случаи». */
  kbArticles: kbArticlesRouter,
  /** Stage 10'.H — кабинет клиента. */
  clientAuth: clientAuthRouter,
  clientCabinet: clientCabinetRouter,
  /** Управление учётками клиентов от лица staff. */
  adminClientUsers: adminClientUsersRouter,
  /** Лиды — воронка продаж (перенос из v1). */
  leads: leadsRouter,
  /** Гарантии на технику (перенос из v1). */
  warranties: warrantiesRouter,
  /** КП с версиями по заявке (перенос из v1). */
  ticketKp: ticketKpRouter,
  /** Периодные аналитические отчёты (перенос из v1). */
  reports: reportsRouter,
  /** Трейд-ин — приём б/у техники в зачёт (перенос из v1). */
  tradeIn: tradeInRouter,
  /** Дорожная карта — цели компании по кварталам (перенос из v1). */
  roadmap: roadmapRouter,
  /** Календарь компании — выезды, дедлайны, ТО, окончания договоров/гарантий. */
  calendar: calendarRouter,
  /** Настройки tenant'а: отключаемые разделы (модули) интерфейса. */
  settings: settingsRouter,
  /** Раздел «Почта» (Этап A): реквизиты ящика, отправка писем, журнал. */
  email: emailRouter,
  /** Касса / ДДС: доходы и расходы, денежные счета с остатками, операции и обзор. */
  cash: cashRouter,
  /** Продажи запчастей/оборудования клиентам (отдельно от ремонтных заявок). */
  sales: salesRouter,
  /** Резервные копии и архив по годам (только директор). */
  backup: backupRouter,
});

export type AppRouter = typeof appRouter;
