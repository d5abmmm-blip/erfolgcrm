import { useEffect, useState } from 'react';
import { Route, Switch, Link, useLocation } from 'wouter';
import { Loader2, EyeOff } from 'lucide-react';
import { AppShell } from './components/AppShell';
import { MobileShell } from './components/MobileShell';
import { StaffMobileShell } from './components/StaffMobileShell';
import { PWARegister } from './components/PWARegister';
import { DashboardPage } from './pages/DashboardPage';
import { TicketCardPage } from './pages/TicketCardPage';
import { TicketsListPage } from './pages/TicketsListPage';
import { TicketsKanbanPage } from './pages/TicketsKanbanPage';
import { BoardPage } from './pages/BoardPage';
import { PartsWaitingPage } from './pages/PartsWaitingPage';
import { SchedulePage } from './pages/SchedulePage';
import { CalendarPage } from './pages/CalendarPage';
import { AttendancePage } from './pages/AttendancePage';
import { StaffListPage } from './pages/StaffListPage';
import { StaffCardPage } from './pages/StaffCardPage';
import { NewTicketPage } from './pages/NewTicketPage';
import { LoginPage } from './pages/LoginPage';
import { ClientsListPage } from './pages/ClientsListPage';
import { ClientFormPage } from './pages/ClientFormPage';
import { ClientCardPage } from './pages/ClientCardPage';
import { AssetsListPage } from './pages/AssetsListPage';
import { AssetModelsPage } from './pages/AssetModelsPage';
import { AssetFormPage } from './pages/AssetFormPage';
import { AssetCardPage } from './pages/AssetCardPage';
import { InventoryListPage } from './pages/InventoryListPage';
import { InventoryItemPage } from './pages/InventoryItemPage';
import { MaintenancePage } from './pages/MaintenancePage';
import { ContractsListPage } from './pages/ContractsListPage';
import { ContractFormPage } from './pages/ContractFormPage';
import { ContractCardPage } from './pages/ContractCardPage';
import { LeadsListPage } from './pages/LeadsListPage';
import { LeadFormPage } from './pages/LeadFormPage';
import { LeadCardPage } from './pages/LeadCardPage';
import { WarrantiesListPage } from './pages/WarrantiesListPage';
import { WarrantyFormPage } from './pages/WarrantyFormPage';
import { ReportsPage } from './pages/ReportsPage';
import { TradeInListPage } from './pages/TradeInListPage';
import { TradeInFormPage } from './pages/TradeInFormPage';
import { RoadmapPage } from './pages/RoadmapPage';
import { TelegramSettingsPage } from './pages/TelegramSettingsPage';
import { SettingsPage } from './pages/SettingsPage';
import { ModulesSettingsPage } from './pages/ModulesSettingsPage';
import { OrganizationSettingsPage } from './pages/OrganizationSettingsPage';
import { BackupSettingsPage } from './pages/BackupSettingsPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { InvoiceCardPage } from './pages/InvoiceCardPage';
import { FinanceOverviewPage } from './pages/FinanceOverviewPage';
import { ReceivablesPage } from './pages/ReceivablesPage';
import { SalesPage } from './pages/SalesPage';
import { TendersListPage } from './pages/TendersListPage';
import { TenderFormPage } from './pages/TenderFormPage';
import { SalesFormPage } from './pages/SalesFormPage';
import { CashJournalPage } from './pages/CashJournalPage';
import { CashAccountsPage } from './pages/CashAccountsPage';
import { OnecSettingsPage } from './pages/OnecSettingsPage';
import { PayrollPage, PayrollSettingsPage } from './pages/PayrollPage';
import { UsersPage } from './pages/UsersPage';
import { AuditLogPage } from './pages/AuditLogPage';
import { SecurityPage } from './pages/SecurityPage';
import { AttestationsPage } from './pages/AttestationsPage';
import { TemplatesPage } from './pages/TemplatesPage';
import { KbPage } from './pages/KbPage';
import { MailListPage } from './pages/MailListPage';
import { MailSettingsPage } from './pages/MailSettingsPage';
import { AiSettingsPage } from './pages/AiSettingsPage';
import { MobileInventoryPage } from './pages/mobile/MobileInventoryPage';
import { MobileInventoryItemPage } from './pages/mobile/MobileInventoryItemPage';
import { MobileQueuePage } from './pages/mobile/MobileQueuePage';
import { MobileTicketPage } from './pages/mobile/MobileTicketPage';
import { MobileWorkLogPage } from './pages/mobile/MobileWorkLogPage';
import { MobileScanPage } from './pages/mobile/MobileScanPage';
import { MobileProfilePage } from './pages/mobile/MobileProfilePage';
import { MobileEarningsPage } from './pages/mobile/MobileEarningsPage';
import { MobileTasksPage } from './pages/mobile/MobileTasksPage';
import { ClientLoginPage } from './pages/client/ClientLoginPage';
import { ClientDashboardPage } from './pages/client/ClientDashboardPage';
import { ClientTicketsPage } from './pages/client/ClientTicketsPage';
import { ClientNewTicketPage } from './pages/client/ClientNewTicketPage';
import { ClientTicketCardPage } from './pages/client/ClientTicketCardPage';
import { ClientAssetsPage } from './pages/client/ClientAssetsPage';
import { ClientInvoicesPage } from './pages/client/ClientInvoicesPage';
import { ClientContractsPage } from './pages/client/ClientContractsPage';
import { ClientProfilePage } from './pages/client/ClientProfilePage';
import { PublicTrackPage } from './pages/PublicTrackPage';
import { ClientCabinetUsersPage } from './pages/ClientCabinetUsersPage';
import { ClientShell } from './components/ClientShell';
import { trpc } from './lib/trpc';
import { setCurrentUserId } from './lib/offline/current-user';
import { isPathDisabled } from './lib/modules';
import { useIsMobile } from './lib/use-is-mobile';
import {
  clearEngineerWantsDesktop,
  engineerWantsDesktop,
  shouldAutoOpenEngineerQueue,
} from './lib/engineer-redirect';

export default function App() {
  const [location] = useLocation();

  // Публичный трек «как посылка» — без логина и без оболочки (фича №3).
  if (location.startsWith('/track/')) {
    return <PublicTrackPage />;
  }

  const isClientRoute = location === '/client' || location.startsWith('/client/');
  if (isClientRoute) {
    return <ClientCabinet />;
  }
  return <StaffApp />;
}

const FORCE_DESKTOP_KEY = 'erfolg-staff-force-desktop';

function readForceDesktop(): boolean {
  try {
    return localStorage.getItem(FORCE_DESKTOP_KEY) === '1';
  } catch {
    return false;
  }
}

function StaffApp() {
  const me = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const [location, navigate] = useLocation();
  const isMobileRoute = location === '/m' || location.startsWith('/m/');
  const isMobile = useIsMobile();
  const [forceDesktop, setForceDesktopState] = useState(readForceDesktop);
  const setForceDesktop = (v: boolean) => {
    setForceDesktopState(v);
    try {
      localStorage.setItem(FORCE_DESKTOP_KEY, v ? '1' : '0');
    } catch {
      /* ignore */
    }
  };

  // Очередь неотправленных правок должна знать, кто сейчас за телефоном:
  // один аппарат в бригаде переходит из рук в руки, и правки одного инженера
  // не должны уйти от имени другого.
  useEffect(() => {
    setCurrentUserId(me.data?.user.id ?? null);
  }, [me.data?.user.id]);

  // Автопереход инженера с корня в /m/queue уступает явному намерению: кнопка
  // «Открыть полную версию» в мобильном профиле ставит флаг, иначе редирект
  // пружинил обратно и полная версия была недостижима — см. lib/engineer-redirect.
  useEffect(() => {
    if (!me.data) return;
    const role = me.data.user.role;
    // Вернулся в мобильный кабинет — намерение исчерпано, корень снова уводит в очередь.
    if (role === 'engineer' && isMobileRoute) clearEngineerWantsDesktop();
    if (shouldAutoOpenEngineerQueue(role, location, engineerWantsDesktop())) {
      navigate('/m/queue');
    } else if (role !== 'engineer' && isMobileRoute) {
      // Директор/диспетчер не работают в инженерном мобильном приложении /m/* —
      // возвращаем их на свой домашний экран (там сработает StaffMobileShell).
      navigate('/');
    }
  }, [me.data, location, navigate, isMobileRoute]);

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!me.data) {
    return <LoginPage />;
  }

  if (isMobileRoute) {
    // Инженерное мобильное приложение (/m/*) — только для инженера. Staff, попавший
    // сюда (старая ссылка/стартовый экран PWA), редиректится на '/' в useEffect выше;
    // пока показываем спиннер, чтобы не мелькал инженерский экран.
    if (me.data.user.role !== 'engineer') {
      return (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
        </div>
      );
    }
    return (
      <>
        <MobileShell session={me.data}>
          <Switch>
            <Route path="/m/queue">
              <MobileQueuePage engineerId={me.data.user.id} />
            </Route>
            <Route path="/m/tasks" component={MobileTasksPage} />
            <Route path="/m/scan" component={MobileScanPage} />
            <Route path="/m/profile" component={MobileProfilePage} />
            <Route path="/m/earnings" component={MobileEarningsPage} />
            <Route path="/m/inventory/:id" component={MobileInventoryItemPage} />
            <Route path="/m/inventory" component={MobileInventoryPage} />
            <Route path="/m/tickets/:id/work-log" component={MobileWorkLogPage} />
            <Route path="/m/tickets/:id" component={MobileTicketPage} />
            <Route>
              <MobileNotFound />
            </Route>
          </Switch>
        </MobileShell>
        <PWARegister />
      </>
    );
  }

  // Раздел отключён директором → не пускаем по прямому URL (меню его уже скрыло).
  // Маршруты при этом не трогаем — данные/логика живы, это чисто навигационный гард.
  const sectionDisabled = isPathDisabled(me.data.tenant.disabledModules, location);

  const isStaff = me.data.user.role === 'director' || me.data.user.role === 'dispatcher';
  const useMobileShell = isStaff && isMobile && !forceDesktop;

  const inner = sectionDisabled ? (
    <SectionDisabled />
  ) : (
    <Switch>
      <Route path="/" component={DashboardPage} />
      <Route path="/board" component={BoardPage} />
      <Route path="/parts-waiting" component={PartsWaitingPage} />
      <Route path="/tickets" component={TicketsListPage} />
      <Route path="/tickets/kanban" component={TicketsKanbanPage} />
      <Route path="/schedule" component={SchedulePage} />
      <Route path="/calendar" component={CalendarPage} />
      <Route path="/attendance" component={AttendancePage} />
      <Route path="/staff" component={StaffListPage} />
      <Route path="/staff/:id" component={StaffCardPage} />
      <Route path="/tickets/new" component={NewTicketPage} />
      <Route path="/tickets/:id" component={TicketCardPage} />
      <Route path="/leads" component={LeadsListPage} />
      <Route path="/leads/new" component={LeadFormPage} />
      <Route path="/leads/:id/edit" component={LeadFormPage} />
      <Route path="/leads/:id" component={LeadCardPage} />
      <Route path="/clients" component={ClientsListPage} />
      <Route path="/clients/new" component={ClientFormPage} />
      <Route path="/clients/:id/edit" component={ClientFormPage} />
      <Route path="/clients/:id/cabinet-users" component={ClientCabinetUsersPage} />
      <Route path="/clients/:id" component={ClientCardPage} />
      <Route path="/assets" component={AssetsListPage} />
      <Route path="/asset-models" component={AssetModelsPage} />
      <Route path="/assets/new" component={AssetFormPage} />
      <Route path="/assets/:id/edit" component={AssetFormPage} />
      <Route path="/assets/:id" component={AssetCardPage} />
      <Route path="/inventory" component={InventoryListPage} />
      <Route path="/inventory/:id" component={InventoryItemPage} />
      <Route path="/maintenance" component={MaintenancePage} />
      <Route path="/warranties" component={WarrantiesListPage} />
      <Route path="/warranties/new" component={WarrantyFormPage} />
      <Route path="/warranties/:id/edit" component={WarrantyFormPage} />
      <Route path="/trade-in" component={TradeInListPage} />
      <Route path="/trade-in/new" component={TradeInFormPage} />
      <Route path="/trade-in/:id/edit" component={TradeInFormPage} />
      <Route path="/roadmap" component={RoadmapPage} />
      <Route path="/contracts" component={ContractsListPage} />
      <Route path="/contracts/new" component={ContractFormPage} />
      <Route path="/contracts/:id/edit" component={ContractFormPage} />
      <Route path="/contracts/:id" component={ContractCardPage} />
      <Route path="/finance" component={FinanceOverviewPage} />
      <Route path="/finance/receivables" component={ReceivablesPage} />
      <Route path="/finance/transactions" component={CashJournalPage} />
      <Route path="/finance/accounts" component={CashAccountsPage} />
      <Route path="/finance/invoices" component={InvoicesPage} />
      <Route path="/invoices" component={InvoicesPage} />
      <Route path="/invoices/:id" component={InvoiceCardPage} />
      <Route path="/sales" component={SalesPage} />
      <Route path="/sales/new" component={SalesFormPage} />
      <Route path="/sales/:id" component={SalesFormPage} />
      <Route path="/tenders" component={TendersListPage} />
      <Route path="/tenders/new" component={TenderFormPage} />
      <Route path="/tenders/:id" component={TenderFormPage} />
      <Route path="/payroll" component={PayrollPage} />
      <Route path="/reports" component={ReportsPage} />
      <Route path="/templates" component={TemplatesPage} />
      <Route path="/kb" component={KbPage} />
      <Route path="/mail" component={MailListPage} />
      <Route path="/settings" component={SettingsPage} />
      <Route path="/settings/modules" component={ModulesSettingsPage} />
      <Route path="/settings/organization" component={OrganizationSettingsPage} />
      <Route path="/settings/backup" component={BackupSettingsPage} />
      <Route path="/settings/telegram" component={TelegramSettingsPage} />
      <Route path="/settings/onec" component={OnecSettingsPage} />
      <Route path="/settings/ai" component={AiSettingsPage} />
      <Route path="/settings/email" component={MailSettingsPage} />
      <Route path="/settings/payroll" component={PayrollSettingsPage} />
      <Route path="/settings/users" component={UsersPage} />
      <Route path="/settings/attestations" component={AttestationsPage} />
      <Route path="/settings/audit" component={AuditLogPage} />
      <Route path="/settings/security" component={SecurityPage} />
      <Route>
        <NotFound />
      </Route>
    </Switch>
  );

  if (useMobileShell) {
    return (
      <>
        <StaffMobileShell session={me.data} onUseFullVersion={() => setForceDesktop(true)}>
          {inner}
        </StaffMobileShell>
        <PWARegister />
      </>
    );
  }

  return (
    <>
      <AppShell session={me.data}>{inner}</AppShell>
      {isStaff && isMobile && forceDesktop && (
        <button
          type="button"
          onClick={() => setForceDesktop(false)}
          className="bg-primary text-primary-foreground fixed bottom-4 right-4 z-50 rounded-full px-4 py-2 text-sm font-medium shadow-lg md:hidden"
        >
          Мобильная версия
        </button>
      )}
      <PWARegister />
    </>
  );
}

function SectionDisabled() {
  const [, navigate] = useLocation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="bg-muted text-muted-foreground grid h-12 w-12 place-items-center rounded-full">
        <EyeOff className="h-6 w-6" />
      </div>
      <div>
        <h1 className="text-xl font-semibold">Раздел отключён</h1>
        <p className="text-muted-foreground mt-1 max-w-md text-sm">
          Этот раздел скрыт в настройках компании. Данные не удалены — раздел можно вернуть в
          «Настройки → Разделы».
        </p>
      </div>
      <div className="flex gap-2">
        <Link
          href="/"
          onClick={() => navigate('/')}
          className="bg-primary text-primary-foreground rounded-md px-4 py-2 text-sm font-medium"
        >
          На дашборд
        </Link>
        <Link
          href="/settings/modules"
          onClick={() => navigate('/settings/modules')}
          className="hover:bg-muted rounded-md border px-4 py-2 text-sm font-medium"
        >
          Настройки разделов
        </Link>
      </div>
    </div>
  );
}

function NotFound() {
  const [, navigate] = useLocation();
  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      <h1 className="text-2xl font-semibold">404 — страница не найдена</h1>
      <Link
        href="/"
        onClick={() => navigate('/')}
        className="text-primary underline-offset-4 hover:underline"
      >
        На главную
      </Link>
    </div>
  );
}

function MobileNotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 p-8 text-center">
      <h1 className="text-lg font-semibold">Страница не найдена</h1>
      <Link href="/m/queue" className="text-primary underline-offset-4 hover:underline">
        К очереди
      </Link>
    </div>
  );
}

function ClientCabinet() {
  const me = trpc.clientAuth.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const [location, navigate] = useLocation();

  // Если зашёл на корень кабинета не залогинен — направим на login.
  useEffect(() => {
    if (me.isLoading) return;
    const isLoginPage = location === '/client/login';
    if (!me.data && !isLoginPage) {
      navigate('/client/login');
    } else if (me.data && isLoginPage) {
      navigate('/client');
    }
  }, [me.data, me.isLoading, location, navigate]);

  if (me.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="text-muted-foreground h-6 w-6 animate-spin" />
      </div>
    );
  }

  if (!me.data) {
    return (
      <Switch>
        <Route path="/client/login" component={ClientLoginPage} />
        <Route>
          <ClientLoginPage />
        </Route>
      </Switch>
    );
  }

  return (
    <ClientShell session={me.data}>
      <Switch>
        <Route path="/client" component={ClientDashboardPage} />
        <Route path="/client/dashboard" component={ClientDashboardPage} />
        <Route path="/client/tickets" component={ClientTicketsPage} />
        <Route path="/client/tickets/new" component={ClientNewTicketPage} />
        <Route path="/client/tickets/:id" component={ClientTicketCardPage} />
        <Route path="/client/assets" component={ClientAssetsPage} />
        <Route path="/client/invoices" component={ClientInvoicesPage} />
        <Route path="/client/contracts" component={ClientContractsPage} />
        <Route path="/client/profile" component={ClientProfilePage} />
        <Route>
          <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center">
            <h2 className="text-lg font-semibold">Страница не найдена</h2>
            <Link href="/client" className="text-primary underline-offset-4 hover:underline">
              На главную кабинета
            </Link>
          </div>
        </Route>
      </Switch>
    </ClientShell>
  );
}
