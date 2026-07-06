import { useEffect } from 'react';
import { Route, Switch, Link, useLocation } from 'wouter';
import { Loader2, EyeOff } from 'lucide-react';
import { AppShell } from './components/AppShell';
import { MobileShell } from './components/MobileShell';
import { PWARegister } from './components/PWARegister';
import { DashboardPage } from './pages/DashboardPage';
import { TicketCardPage } from './pages/TicketCardPage';
import { TicketsListPage } from './pages/TicketsListPage';
import { TicketsKanbanPage } from './pages/TicketsKanbanPage';
import { BoardPage } from './pages/BoardPage';
import { PartsWaitingPage } from './pages/PartsWaitingPage';
import { SchedulePage } from './pages/SchedulePage';
import { CalendarPage } from './pages/CalendarPage';
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
import { BackupSettingsPage } from './pages/BackupSettingsPage';
import { InvoicesPage } from './pages/InvoicesPage';
import { InvoiceCardPage } from './pages/InvoiceCardPage';
import { FinanceOverviewPage } from './pages/FinanceOverviewPage';
import { SalesListPage } from './pages/SalesListPage';
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
import { NotificationsSettingsPage } from './pages/NotificationsSettingsPage';
import { MobileInventoryPage } from './pages/mobile/MobileInventoryPage';
import { MobileQueuePage } from './pages/mobile/MobileQueuePage';
import { MobileTicketPage } from './pages/mobile/MobileTicketPage';
import { MobileWorkLogPage } from './pages/mobile/MobileWorkLogPage';
import { MobileScanPage } from './pages/mobile/MobileScanPage';
import { MobileProfilePage } from './pages/mobile/MobileProfilePage';
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
import { isPathDisabled } from './lib/modules';

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

function StaffApp() {
  const me = trpc.auth.me.useQuery(undefined, {
    retry: false,
    staleTime: 60_000,
  });
  const [location, navigate] = useLocation();
  const isMobileRoute = location === '/m' || location.startsWith('/m/');

  // После логина инженера — однократный редирект на /m/queue, если он на корне.
  // Не делаем «вечный» редирект, чтобы инженер мог сознательно зайти на полную версию.
  useEffect(() => {
    if (!me.data) return;
    if (me.data.user.role === 'engineer' && location === '/') {
      navigate('/m/queue');
    }
  }, [me.data, location, navigate]);

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
    return (
      <>
        <MobileShell session={me.data}>
          <Switch>
            <Route path="/m/queue">
              <MobileQueuePage engineerId={me.data.user.id} />
            </Route>
            <Route path="/m/scan" component={MobileScanPage} />
            <Route path="/m/profile" component={MobileProfilePage} />
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

  return (
    <>
      <AppShell session={me.data}>
        {sectionDisabled ? (
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
          <Route path="/finance/transactions" component={CashJournalPage} />
          <Route path="/finance/accounts" component={CashAccountsPage} />
          <Route path="/finance/invoices" component={InvoicesPage} />
          <Route path="/invoices" component={InvoicesPage} />
          <Route path="/invoices/:id" component={InvoiceCardPage} />
          <Route path="/sales" component={SalesListPage} />
          <Route path="/sales/new" component={SalesFormPage} />
          <Route path="/sales/:id" component={SalesFormPage} />
          <Route path="/payroll" component={PayrollPage} />
          <Route path="/reports" component={ReportsPage} />
          <Route path="/templates" component={TemplatesPage} />
          <Route path="/kb" component={KbPage} />
          <Route path="/mail" component={MailListPage} />
          <Route path="/settings" component={SettingsPage} />
          <Route path="/settings/modules" component={ModulesSettingsPage} />
          <Route path="/settings/backup" component={BackupSettingsPage} />
          <Route path="/settings/telegram" component={TelegramSettingsPage} />
          <Route path="/settings/onec" component={OnecSettingsPage} />
          <Route path="/settings/ai" component={AiSettingsPage} />
          <Route path="/settings/email" component={MailSettingsPage} />
          <Route path="/settings/notifications" component={NotificationsSettingsPage} />
          <Route path="/settings/payroll" component={PayrollSettingsPage} />
          <Route path="/settings/users" component={UsersPage} />
          <Route path="/settings/attestations" component={AttestationsPage} />
          <Route path="/settings/audit" component={AuditLogPage} />
          <Route path="/settings/security" component={SecurityPage} />
          <Route>
            <NotFound />
          </Route>
          </Switch>
        )}
      </AppShell>
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
          Этот раздел скрыт в настройках компании. Данные не удалены — раздел можно вернуть
          в «Настройки → Разделы».
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
