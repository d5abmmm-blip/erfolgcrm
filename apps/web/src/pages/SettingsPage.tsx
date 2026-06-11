/**
 * /settings — индекс разделов настроек. Сейчас доступен только Telegram (другие появятся
 * по мере роста — реквизиты, шаблоны документов, биллинг и т.д.).
 */
import { Link } from 'wouter';
import {
  Award,
  Bot,
  ChevronRight,
  Database,
  FileStack,
  History,
  Shield,
  Users,
  Wallet,
} from 'lucide-react';

export function SettingsPage() {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <h1 className="text-2xl font-semibold">Настройки</h1>
      <p className="text-muted-foreground mt-1 text-sm">
        Конфигурация tenant'а. Доступно директору.
      </p>

      <div className="mt-6 space-y-2">
        <Link
          href="/settings/users"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 transition"
        >
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
              <Users className="h-5 w-5" />
            </div>
            <div>
              <div className="font-medium">Пользователи</div>
              <div className="text-muted-foreground text-xs">
                Сотрудники компании, роли, блокировки и сброс паролей
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5" />
        </Link>

        <Link
          href="/templates"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 transition"
        >
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
              <FileStack className="h-5 w-5" />
            </div>
            <div>
              <div className="font-medium">Шаблоны заявок</div>
              <div className="text-muted-foreground text-xs">
                Типовые операции (термопаста, калибровка, ТО) — заполняют наряд автоматически
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5" />
        </Link>

        <Link
          href="/settings/telegram"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 transition"
        >
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <div className="font-medium">Telegram-бот</div>
              <div className="text-muted-foreground text-xs">
                Приём заявок от клиентов через Telegram
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5" />
        </Link>

        <Link
          href="/settings/onec"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 transition"
        >
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <div className="font-medium">1С обмен</div>
              <div className="text-muted-foreground text-xs">
                Выгрузка счетов и приём платежей из 1С:Бухгалтерия
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5" />
        </Link>

        <Link
          href="/settings/payroll"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 transition"
        >
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
              <Wallet className="h-5 w-5" />
            </div>
            <div>
              <div className="font-medium">Зарплата инженеров</div>
              <div className="text-muted-foreground text-xs">
                Правила расчёта (сделка/оклад) и почасовая ставка
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5" />
        </Link>

        <Link
          href="/settings/attestations"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 transition"
        >
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
              <Award className="h-5 w-5" />
            </div>
            <div>
              <div className="font-medium">Аттестация инженеров</div>
              <div className="text-muted-foreground text-xs">
                Допуски к категориям медтехники (compliance при назначении на заявку)
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5" />
        </Link>

        <Link
          href="/settings/audit"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 transition"
        >
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
              <History className="h-5 w-5" />
            </div>
            <div>
              <div className="font-medium">Журнал действий</div>
              <div className="text-muted-foreground text-xs">
                Аудит изменений: кто, когда и что менял (152-ФЗ)
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5" />
        </Link>

        <Link
          href="/settings/security"
          className="bg-card hover:bg-muted/40 flex items-center justify-between gap-2 rounded-lg border p-4 transition"
        >
          <div className="flex items-center gap-3">
            <div className="bg-primary/10 text-primary grid h-10 w-10 place-items-center rounded-md">
              <Shield className="h-5 w-5" />
            </div>
            <div>
              <div className="font-medium">Безопасность аккаунта</div>
              <div className="text-muted-foreground text-xs">
                Двухфакторная защита (TOTP) — для директора обязательно по 152-ФЗ
              </div>
            </div>
          </div>
          <ChevronRight className="text-muted-foreground h-5 w-5" />
        </Link>
      </div>
    </div>
  );
}
