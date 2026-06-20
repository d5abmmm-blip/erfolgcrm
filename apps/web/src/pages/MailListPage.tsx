/**
 * /mail — раздел «Почта» в виде почтового клиента (3 панели, как Gmail/webmail):
 *   слева  — рельс папок + «Написать» + «Настройки»;
 *   центр  — список писем выбранной папки (поиск, пагинация);
 *   справа — область чтения выбранного письма (тема/от/кому/дата/тело/вложение + «Ответить»).
 *
 * RBAC: staff. Настройки ящика — только директор. Письма живут на ящике reg.ru;
 * «Входящие» наполнятся после подключения приёма по IMAP (Этап B) — папка уже готова.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import {
  Ban,
  ChevronLeft,
  Clock,
  File as FileIcon,
  FileText,
  Forward,
  Inbox,
  Loader2,
  Mail,
  Paperclip,
  Pencil,
  RefreshCw,
  Reply,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldAlert,
  Trash2,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import type { RouterOutputs } from '../lib/trpc-types';
import { useDebounce } from '../lib/hooks/useDebounce';
import { cn } from '../lib/utils';
import { StatusBadge, type StatusBadgeVariant } from '../components/ui/StatusBadge';
import { Pagination } from '../components/ui/Pagination';
import { ConfirmDialog } from '../components/ui/ConfirmDialog';
import { ComposeEmailModal } from '../components/ComposeEmailModal';
import {
  buildForwardBody,
  buildReferences,
  buildReplyBody,
  forwardSubject,
  replySubject,
} from '../lib/mail-quote';
import { sanitizeEmailHtml } from '../lib/sanitize-html';

/** Письмо треда (полное письмо + вложения) — элемент вывода `email.thread`. */
type ThreadMessage = RouterOutputs['email']['thread'][number];
/** Вложение письма (готовая presigned-ссылка). */
type MailAttachment = ThreadMessage['attachments'][number];

const PAGE_SIZE = 25;

/** Папка интерфейса. Передаётся в `email.list` как folder; предикат считается на сервере. */
type Folder = 'in' | 'out' | 'drafts' | 'scheduled' | 'spam' | 'trash';

/** Входящеподобные папки: показываем отправителя (from) и учитываем прочтение. */
const INBOUND_FOLDERS: Folder[] = ['in', 'spam'];

const FOLDER_TITLE: Record<Folder, string> = {
  in: 'Входящие',
  out: 'Отправленные',
  drafts: 'Черновики',
  scheduled: 'Запланированные',
  spam: 'Спам',
  trash: 'Корзина',
};

const FOLDER_EMPTY: Record<Folder, string> = {
  in: 'Входящих писем пока нет',
  out: 'Отправленных писем пока нет',
  drafts: 'Черновиков пока нет',
  scheduled: 'Запланированных писем нет',
  spam: 'Спама нет',
  trash: 'Корзина пуста',
};

const STATUS_META: Record<string, { label: string; variant: StatusBadgeVariant }> = {
  sent: { label: 'Отправлено', variant: 'success' },
  skipped: { label: 'Пропущено', variant: 'muted' },
  failed: { label: 'Ошибка', variant: 'danger' },
  received: { label: 'Входящее', variant: 'info' },
  draft: { label: 'Черновик', variant: 'muted' },
  scheduled: { label: 'Запланировано', variant: 'info' },
};

function fmtDate(d: Date | string | null): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
}

/** Компактная дата для строки списка: сегодня → время, этот год → «5 июн», иначе дата. */
function fmtListDate(d: Date | string | null): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  }
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  }
  return date.toLocaleDateString('ru-RU', { dateStyle: 'short' });
}

function fmtSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

/** Date → строка для <input type="datetime-local"> в локальном времени (YYYY-MM-DDTHH:mm). */
function toDatetimeLocal(d: Date | string | null): string {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface ComposeInit {
  to?: string;
  subject?: string;
  body?: string;
  relatedTicketId?: string;
  relatedClientId?: string;
  inReplyTo?: string;
  references?: string[];
  title?: string;
  draftId?: string;
  scheduledAt?: string;
  cc?: string;
  bcc?: string;
}

export function MailListPage() {
  const me = trpc.auth.me.useQuery(undefined, { staleTime: 60_000 });
  const isDirector = me.data?.user.role === 'director';

  const [folder, setFolder] = useState<Folder>('in');
  const [search, setSearch] = useState('');
  const debounced = useDebounce(search.trim(), 300);
  const [page, setPage] = useState(1);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composeOpen, setComposeOpen] = useState(false);
  const [composeInit, setComposeInit] = useState<ComposeInit>({});

  const list = trpc.email.list.useQuery({
    search: debounced || undefined,
    page,
    pageSize: PAGE_SIZE,
    folder,
  });
  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const inboundFolder = INBOUND_FOLDERS.includes(folder);

  const unread = trpc.email.unreadCount.useQuery(undefined, { staleTime: 30_000 });
  const unreadCount = unread.data ?? 0;

  const utils = trpc.useUtils();
  const fetchNow = trpc.email.fetchNow.useMutation({
    onSuccess: async () => {
      await utils.email.list.invalidate();
      await utils.email.unreadCount.invalidate();
    },
  });

  const switchFolder = (f: Folder) => {
    setFolder(f);
    setPage(1);
    setSearch('');
    setSelectedId(null);
  };

  const openCompose = (init: ComposeInit = {}) => {
    setComposeInit(init);
    setComposeOpen(true);
  };

  // Клик по черновику/запланированному открывает его для правки в окне написания.
  const openEditable = async (msgId: string, scheduled = false) => {
    const full = await utils.email.get.fetch({ id: msgId });
    if (!full) return;
    openCompose({
      draftId: msgId,
      to: full.to ?? '',
      subject: full.subject ?? '',
      body: full.bodyText ?? '',
      relatedTicketId: full.relatedTicketId ?? undefined,
      relatedClientId: full.relatedClientId ?? undefined,
      inReplyTo: full.inReplyTo ?? undefined,
      references: full.references ? full.references.split(' ').filter(Boolean) : undefined,
      title: scheduled ? 'Запланированное письмо' : 'Черновик',
      scheduledAt: scheduled && full.scheduledAt ? toDatetimeLocal(full.scheduledAt) : undefined,
      cc: full.cc ?? undefined,
      bcc: full.bcc ?? undefined,
    });
  };

  return (
    <div className="flex h-full min-h-0 pr-3 md:pr-5">
      {/* ── Левый рельс: папки ── */}
      <aside className="bg-card/40 hidden w-56 shrink-0 flex-col border-r p-3 md:flex">
        <div className="mb-3 flex items-center gap-2 px-1">
          <Mail className="text-primary h-5 w-5" />
          <span className="font-semibold">Почта</span>
        </div>
        <button
          type="button"
          onClick={() => openCompose()}
          className="bg-primary text-primary-foreground hover:bg-primary/90 mb-3 inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-medium shadow-sm transition"
        >
          <Send className="h-4 w-4" />
          Написать
        </button>
        <nav className="space-y-0.5">
          <RailItem
            icon={Inbox}
            label="Входящие"
            active={folder === 'in'}
            onClick={() => switchFolder('in')}
            badge={unreadCount}
          />
          <RailItem icon={Send} label="Отправленные" active={folder === 'out'} onClick={() => switchFolder('out')} />
          <RailItem icon={FileText} label="Черновики" active={folder === 'drafts'} onClick={() => switchFolder('drafts')} />
          <RailItem icon={Clock} label="Запланированные" active={folder === 'scheduled'} onClick={() => switchFolder('scheduled')} />
          <RailItem icon={ShieldAlert} label="Спам" active={folder === 'spam'} onClick={() => switchFolder('spam')} />
          <RailItem icon={Trash2} label="Корзина" active={folder === 'trash'} onClick={() => switchFolder('trash')} />
        </nav>
        {isDirector && (
          <div className="border-sidebar-border mt-auto border-t pt-2">
            <Link
              href="/settings/email"
              className="text-muted-foreground hover:bg-muted hover:text-foreground flex items-center gap-2 rounded-md px-2.5 py-1.5 text-sm transition"
            >
              <Settings className="h-4 w-4" />
              Настройки почты
            </Link>
          </div>
        )}
      </aside>

      {/* ── Основная область: список писем на всю ширину; при чтении скрывается (как в Gmail) ── */}
      {/* min-w-0 обязателен: flex-1 без него держит min-content (ширину поиска) и распирает экран. */}
      <div className={cn('flex min-h-0 min-w-0 flex-1 flex-col', selectedId && 'hidden')}>
        {/* Заголовок + мобильное переключение папок */}
        <div className="space-y-2 border-b p-3">
          <div className="flex items-center gap-2 md:hidden">
            <div className="bg-secondary flex min-w-0 flex-1 gap-0.5 overflow-x-auto rounded-md p-0.5">
              <MiniFolder label="Входящие" active={folder === 'in'} onClick={() => switchFolder('in')} badge={unreadCount} />
              <MiniFolder label="Отправленные" active={folder === 'out'} onClick={() => switchFolder('out')} />
              <MiniFolder label="Черновики" active={folder === 'drafts'} onClick={() => switchFolder('drafts')} />
              <MiniFolder label="Запланир." active={folder === 'scheduled'} onClick={() => switchFolder('scheduled')} />
              <MiniFolder label="Спам" active={folder === 'spam'} onClick={() => switchFolder('spam')} />
              <MiniFolder label="Корзина" active={folder === 'trash'} onClick={() => switchFolder('trash')} />
            </div>
            <button
              type="button"
              onClick={() => openCompose()}
              className="bg-primary text-primary-foreground inline-flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium"
            >
              <Send className="h-3.5 w-3.5" />
              Написать
            </button>
          </div>
          <div className="hidden items-baseline justify-between md:flex">
            <h2 className="text-sm font-semibold">{FOLDER_TITLE[folder]}</h2>
            <span className="text-muted-foreground text-xs">{total}</span>
          </div>
          <div className="relative">
            <Search className="text-muted-foreground absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2" />
            <input
              type="search"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="Поиск по теме или адресу"
              className="bg-background focus:ring-primary/40 w-full rounded-md border py-1.5 pl-8 pr-3 text-sm outline-none focus:ring-2"
            />
          </div>
        </div>

        {folder === 'in' && (
          <div className="bg-muted/20 flex items-center justify-end gap-2 border-b px-3 py-1.5 text-xs">
            {fetchNow.data && (
              <span className="text-muted-foreground mr-auto">
                {fetchNow.data.skipped
                  ? 'Почта не настроена — откройте «Настройки почты».'
                  : fetchNow.data.fetched > 0
                    ? `Получено новых писем: ${fetchNow.data.fetched}`
                    : 'Новых писем нет.'}
              </span>
            )}
            {fetchNow.error && (
              <span className="text-destructive mr-auto">Ошибка: {fetchNow.error.message}</span>
            )}
            <button
              type="button"
              onClick={() => fetchNow.mutate()}
              disabled={fetchNow.isPending}
              className="hover:bg-muted bg-background inline-flex shrink-0 items-center gap-1.5 rounded-md border px-2.5 py-1 font-medium transition disabled:opacity-50"
            >
              <RefreshCw className={cn('h-3.5 w-3.5', fetchNow.isPending && 'animate-spin')} />
              Проверить почту
            </button>
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-auto">
          {list.isLoading ? (
            <div className="text-muted-foreground p-6 text-center text-sm">Загрузка…</div>
          ) : list.error ? (
            <div className="text-destructive p-4 text-sm">Ошибка: {list.error.message}</div>
          ) : items.length === 0 ? (
            <div className="text-muted-foreground p-6 text-center text-sm">{FOLDER_EMPTY[folder]}</div>
          ) : (
            <ul className="divide-y">
              {items.map((m) => {
                const meta = STATUS_META[m.status] ?? { label: m.status, variant: 'muted' as const };
                const active = m.id === selectedId;
                const inbound = inboundFolder;
                // Жирным — непрочитанные входящие (исходящие «прочитанности» не имеют).
                const unreadRow = inbound && !m.isRead;
                return (
                  <li key={m.id}>
                    <button
                      type="button"
                      onClick={() =>
                        folder === 'drafts' ? void openEditable(m.id) : setSelectedId(m.id)
                      }
                      className={cn(
                        'flex w-full flex-col gap-0.5 px-3 py-2.5 text-left transition',
                        active ? 'bg-primary/10' : 'hover:bg-muted/40',
                      )}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span
                          className={cn('truncate text-sm', unreadRow ? 'font-semibold' : 'font-medium')}
                        >
                          {(inbound ? m.from : m.to) ?? <span className="text-muted-foreground">—</span>}
                        </span>
                        <span className="text-muted-foreground shrink-0 text-[11px]">
                          {fmtListDate(folder === 'scheduled' ? m.scheduledAt : m.createdAt)}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        {m.hasAttachments && (
                          <Paperclip className="text-muted-foreground h-3 w-3 shrink-0" />
                        )}
                        <span
                          className={cn(
                            'truncate text-xs',
                            unreadRow ? 'text-foreground font-medium' : 'text-muted-foreground',
                          )}
                        >
                          {m.subject ?? '(без темы)'}
                        </span>
                      </div>
                      <StatusBadge variant={meta.variant} compact>
                        {meta.label}
                      </StatusBadge>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="border-t p-2">
          <Pagination page={page} total={total} pageSize={PAGE_SIZE} onPageChange={setPage} />
        </div>
      </div>

      {/* ── Чтение письма: на всю ширину (как в Gmail), список при этом скрыт ── */}
      <div className={cn('min-h-0 min-w-0 flex-1 flex-col', selectedId ? 'flex' : 'hidden')}>
        {selectedId &&
          (folder === 'scheduled' ? (
            <ScheduledReader
              key={selectedId}
              id={selectedId}
              onBack={() => setSelectedId(null)}
              onEdit={() => void openEditable(selectedId, true)}
              onDone={() => setSelectedId(null)}
            />
          ) : folder === 'trash' ? (
            <TrashReader
              key={selectedId}
              id={selectedId}
              onBack={() => setSelectedId(null)}
              onDone={() => setSelectedId(null)}
            />
          ) : (
            <MessageReader
              key={selectedId}
              id={selectedId}
              onBack={() => setSelectedId(null)}
              onReply={(init) => openCompose(init)}
              onAfterTrash={() => setSelectedId(null)}
            />
          ))}
      </div>

      <ComposeEmailModal
        open={composeOpen}
        onClose={() => setComposeOpen(false)}
        initialTo={composeInit.to}
        initialSubject={composeInit.subject}
        initialBody={composeInit.body}
        relatedTicketId={composeInit.relatedTicketId}
        relatedClientId={composeInit.relatedClientId}
        inReplyTo={composeInit.inReplyTo}
        references={composeInit.references}
        draftId={composeInit.draftId}
        initialCc={composeInit.cc}
        initialBcc={composeInit.bcc}
        initialScheduledAt={composeInit.scheduledAt}
        title={composeInit.title}
        templateVars={{ company: me.data?.tenant.displayName }}
      />
    </div>
  );
}

function RailItem({
  icon: Icon,
  label,
  active,
  onClick,
  badge,
}: {
  icon: typeof Inbox;
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition',
        active
          ? 'bg-primary/15 text-primary font-medium'
          : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
      aria-pressed={active}
    >
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">{label}</span>
      {badge !== undefined && badge > 0 && (
        <span className="bg-primary text-primary-foreground inline-flex min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}

function MiniFolder({
  label,
  active,
  onClick,
  badge,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  badge?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded px-2.5 py-1 text-xs font-medium transition',
        active ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground',
      )}
      aria-pressed={active}
    >
      {label}
      {badge !== undefined && badge > 0 && (
        <span className="bg-primary text-primary-foreground inline-flex min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-semibold tabular-nums">
          {badge}
        </span>
      )}
    </button>
  );
}

/**
 * Область чтения = вид треда. Тянем всю переписку через `email.thread` и рисуем
 * вертикальный стек карточек (старые → новые). Кнопки «Ответить»/«Переслать» действуют
 * на выбранное (последнее в треде) письмо. При открытии непрочитанного входящего —
 * один раз помечаем прочитанным и обновляем бейдж/список.
 */
function MessageReader({
  id,
  onBack,
  onReply,
  onAfterTrash,
}: {
  id: string;
  onBack: () => void;
  onReply: (init: ComposeInit) => void;
  onAfterTrash: () => void;
}) {
  const thread = trpc.email.thread.useQuery({ messageId: id });
  const utils = trpc.useUtils();
  const [confirmTrash, setConfirmTrash] = useState(false);
  const markRead = trpc.email.markRead.useMutation({
    onSuccess: async () => {
      await utils.email.unreadCount.invalidate();
      await utils.email.list.invalidate();
    },
  });
  const trash = trpc.email.trash.useMutation({
    onSuccess: async () => {
      await utils.email.list.invalidate();
      await utils.email.unreadCount.invalidate();
      onAfterTrash();
    },
  });

  const messages = thread.data ?? [];
  // Выбранное письмо в треде (на нём действуют «Ответить»/«Переслать»); фолбэк — последнее.
  const selected = messages.find((m) => m.id === id) ?? messages[messages.length - 1];

  // Один раз помечаем выбранное непрочитанное входящее прочитанным.
  const markedRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selected) return;
    if (selected.direction === 'in' && !selected.isRead && markedRef.current !== selected.id) {
      markedRef.current = selected.id;
      markRead.mutate({ id: selected.id });
    }
  }, [selected, markRead]);

  if (thread.isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка переписки…
      </div>
    );
  }
  if (thread.error || !selected) {
    return (
      <div className="text-destructive p-6 text-sm">
        {thread.error?.message ?? 'Письмо не найдено'}
      </div>
    );
  }

  const subject = selected.subject;
  const selInbound = selected.direction === 'in';
  const replyTo = selInbound ? selected.from : selected.to;
  const replyDate = selected.sentAt ?? selected.receivedAt ?? selected.createdAt;

  const onReplyClick = () =>
    onReply({
      title: 'Ответить',
      to: replyTo ?? undefined,
      subject: replySubject(subject),
      body: buildReplyBody({ from: selected.from, date: replyDate, bodyText: selected.bodyText }),
      inReplyTo: selected.messageId ?? undefined,
      references: buildReferences(selected.references, selected.messageId),
      relatedTicketId: selected.relatedTicketId ?? undefined,
      relatedClientId: selected.relatedClientId ?? undefined,
    });

  const onForwardClick = () =>
    onReply({
      title: 'Переслать',
      to: '',
      subject: forwardSubject(subject),
      body: buildForwardBody({
        from: selected.from,
        to: selected.to,
        date: replyDate,
        subject,
        bodyText: selected.bodyText,
      }),
      // Пересылка начинает новый тред — без In-Reply-To/References.
      relatedTicketId: selected.relatedTicketId ?? undefined,
      relatedClientId: selected.relatedClientId ?? undefined,
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-7 w-7 shrink-0 place-items-center rounded transition"
          aria-label="Назад к списку"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h2 className="min-w-0 flex-1 truncate text-base font-semibold">{subject ?? '(без темы)'}</h2>
        <button
          type="button"
          onClick={onReplyClick}
          className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition"
        >
          <Reply className="h-3.5 w-3.5" />
          Ответить
        </button>
        <button
          type="button"
          onClick={onForwardClick}
          className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition"
        >
          <Forward className="h-3.5 w-3.5" />
          Переслать
        </button>
        <button
          type="button"
          onClick={() => setConfirmTrash(true)}
          disabled={trash.isPending}
          className="text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition disabled:opacity-50"
          title="Переместить в корзину"
        >
          <Trash2 className="h-3.5 w-3.5" />
          В корзину
        </button>
      </div>

      <div className="bg-muted/20 min-h-0 flex-1 space-y-3 overflow-auto p-4 md:p-6">
        {messages.map((m) => (
          <ThreadCard key={m.id} m={m} highlighted={m.id === id} />
        ))}
      </div>

      <ConfirmDialog
        open={confirmTrash}
        title="Переместить в корзину?"
        description="Письмо можно будет восстановить из «Корзины»."
        confirmText="В корзину"
        variant="danger"
        loading={trash.isPending}
        onConfirm={() => trash.mutate({ id })}
        onCancel={() => setConfirmTrash(false)}
      />
    </div>
  );
}

/**
 * Карточка одного письма в треде — в стиле Gmail: все письма в одну ширину, выровнены
 * по краям (без сдвигов «лесенкой»). Направление различается бейджем и содержимым,
 * а не геометрией. Заголовок: аватар-инициал отправителя, имя/адрес, дата справа.
 */
function ThreadCard({ m, highlighted }: { m: ThreadMessage; highlighted: boolean }) {
  const meta = STATUS_META[m.status] ?? { label: m.status, variant: 'muted' as const };
  // Инициал для аватара — первая буква отправителя без кавычек/скобок («"Rambo" <…>» → R).
  const sender = (m.from ?? m.to ?? '').replace(/["'<>]/g, '').trim();
  const initial = (sender[0] ?? '?').toUpperCase();

  return (
    <div
      className={cn(
        'bg-card rounded-lg border p-3 md:p-4',
        highlighted ? 'border-primary/30 shadow-sm' : 'border-border',
      )}
    >
      <div className="mb-3 flex items-start gap-3">
        <div className="bg-primary/15 text-primary grid h-9 w-9 shrink-0 place-items-center rounded-full text-sm font-semibold">
          {initial}
        </div>
        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <span className="truncate font-medium">{m.from ?? '—'}</span>
            <StatusBadge variant={meta.variant}>{meta.label}</StatusBadge>
            <span className="text-muted-foreground ml-auto whitespace-nowrap text-xs">
              {fmtDate(m.sentAt ?? m.receivedAt ?? m.createdAt)}
            </span>
          </div>
          <div className="text-muted-foreground text-xs">
            кому: {m.to ?? '—'}
            {m.cc ? ` · копия: ${m.cc}` : ''}
          </div>
          {m.error && (
            <div className="text-destructive mt-0.5 text-xs">Ошибка отправки: {m.error}</div>
          )}
        </div>
      </div>

      {m.bodyHtml ? (
        // Входящий HTML очищаем DOMPurify (вырезаем скрипты/стили), затем показываем разметкой.
        <div
          className="text-sm leading-relaxed [&_a]:text-primary [&_a]:underline [&_img]:max-w-full [&_table]:max-w-full"
          dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(m.bodyHtml) }}
        />
      ) : (
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {m.bodyText?.trim() ? (
            m.bodyText
          ) : (
            <span className="text-muted-foreground">(письмо без текста)</span>
          )}
        </div>
      )}

      <MailAttachments items={m.attachments} />
    </div>
  );
}

/** Вложения письма — чипы-ссылки на скачивание в стиле PhotoUploader/ThumbCard. */
function MailAttachments({ items }: { items: MailAttachment[] }) {
  if (!items || items.length === 0) return null;
  return (
    <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 md:grid-cols-4">
      {items.map((a) => {
        const isImg = a.mimeType.startsWith('image/');
        const size = fmtSize(a.sizeBytes);
        return (
          <a
            key={a.id}
            href={a.url}
            target="_blank"
            rel="noreferrer noopener"
            title={a.name}
            className="bg-card group relative block overflow-hidden rounded-md border"
          >
            <div className="aspect-square">
              {isImg ? (
                <img src={a.url} alt={a.name} className="h-full w-full object-cover" loading="lazy" />
              ) : (
                <div className="text-muted-foreground flex h-full w-full flex-col items-center justify-center gap-1 p-2 text-center text-xs">
                  <FileIcon className="h-6 w-6" />
                  <div className="line-clamp-2 break-words">{a.name}</div>
                </div>
              )}
            </div>
            <div className="from-background/90 pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t p-1.5 text-[10px]">
              <div className="line-clamp-1 break-all font-medium">{a.name}</div>
              {size && <div className="text-muted-foreground tabular-nums">{size}</div>}
            </div>
          </a>
        );
      })}
    </div>
  );
}

/**
 * Просмотр запланированного письма + действия: отправить сейчас / редактировать / отменить.
 * Отмена возвращает письмо в «Черновики». Редактирование открывает окно написания (родитель).
 */
function ScheduledReader({
  id,
  onBack,
  onEdit,
  onDone,
}: {
  id: string;
  onBack: () => void;
  onEdit: () => void;
  onDone: () => void;
}) {
  const msg = trpc.email.get.useQuery({ id });
  const utils = trpc.useUtils();
  const afterAction = async () => {
    await utils.email.list.invalidate();
    onDone();
  };
  const sendNow = trpc.email.sendScheduledNow.useMutation({ onSuccess: afterAction });
  const cancel = trpc.email.cancelSchedule.useMutation({ onSuccess: afterAction });
  const busy = sendNow.isPending || cancel.isPending;

  if (msg.isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка…
      </div>
    );
  }
  if (msg.error || !msg.data) {
    return <div className="text-destructive p-6 text-sm">{msg.error?.message ?? 'Письмо не найдено'}</div>;
  }
  const m = msg.data;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-7 w-7 place-items-center rounded transition"
          aria-label="Назад к списку"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h2 className="flex-1 truncate text-base font-semibold">{m.subject ?? '(без темы)'}</h2>
        <button
          type="button"
          onClick={() => sendNow.mutate({ id })}
          disabled={busy}
          className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition disabled:opacity-50"
        >
          <Send className="h-3.5 w-3.5" />
          Отправить сейчас
        </button>
        <button
          type="button"
          onClick={onEdit}
          disabled={busy}
          className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition disabled:opacity-50"
        >
          <Pencil className="h-3.5 w-3.5" />
          Редактировать
        </button>
        <button
          type="button"
          onClick={() => cancel.mutate({ id })}
          disabled={busy}
          className="text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition disabled:opacity-50"
        >
          <Ban className="h-3.5 w-3.5" />
          Отменить
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 md:p-6">
        <div className="text-primary flex items-center gap-2 rounded-md border border-primary/10 bg-primary/5 p-3 text-sm">
          <Clock className="h-4 w-4 shrink-0" />
          Отправится автоматически: {fmtDate(m.scheduledAt)}
        </div>
        <div className="text-sm">
          <span className="text-muted-foreground">Кому:</span> {m.to ?? '—'}
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {m.bodyText?.trim() ? (
            m.bodyText
          ) : (
            <span className="text-muted-foreground">(письмо без текста)</span>
          )}
        </div>
        {(sendNow.error || cancel.error) && (
          <div className="text-destructive text-sm">
            {sendNow.error?.message ?? cancel.error?.message}
          </div>
        )}
      </div>
    </div>
  );
}

/** Просмотр письма из корзины + действия: восстановить / удалить навсегда (с подтверждением). */
function TrashReader({
  id,
  onBack,
  onDone,
}: {
  id: string;
  onBack: () => void;
  onDone: () => void;
}) {
  const msg = trpc.email.get.useQuery({ id });
  const utils = trpc.useUtils();
  const [confirmPurge, setConfirmPurge] = useState(false);
  const afterAction = async () => {
    await utils.email.list.invalidate();
    await utils.email.unreadCount.invalidate();
    onDone();
  };
  const restore = trpc.email.restore.useMutation({ onSuccess: afterAction });
  const purge = trpc.email.purge.useMutation({
    onSuccess: async () => {
      setConfirmPurge(false);
      await afterAction();
    },
  });
  const busy = restore.isPending || purge.isPending;

  if (msg.isLoading) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        Загрузка…
      </div>
    );
  }
  if (msg.error || !msg.data) {
    return <div className="text-destructive p-6 text-sm">{msg.error?.message ?? 'Письмо не найдено'}</div>;
  }
  const m = msg.data;
  const inbound = m.direction === 'in';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b p-3">
        <button
          type="button"
          onClick={onBack}
          className="text-muted-foreground hover:bg-muted hover:text-foreground grid h-7 w-7 place-items-center rounded transition"
          aria-label="Назад к списку"
        >
          <ChevronLeft className="h-4 w-4" />
        </button>
        <h2 className="flex-1 truncate text-base font-semibold">{m.subject ?? '(без темы)'}</h2>
        <button
          type="button"
          onClick={() => restore.mutate({ id })}
          disabled={busy}
          className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition disabled:opacity-50"
        >
          <RotateCcw className="h-3.5 w-3.5" />
          Восстановить
        </button>
        <button
          type="button"
          onClick={() => setConfirmPurge(true)}
          disabled={busy}
          className="text-destructive hover:bg-destructive/10 inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition disabled:opacity-50"
        >
          <Trash2 className="h-3.5 w-3.5" />
          Удалить навсегда
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4 md:p-6">
        <div className="text-sm">
          <span className="text-muted-foreground">{inbound ? 'От:' : 'Кому:'}</span>{' '}
          {(inbound ? m.from : m.to) ?? '—'}
        </div>
        <div className="text-muted-foreground text-xs">
          {fmtDate(m.sentAt ?? m.receivedAt ?? m.createdAt)}
        </div>
        <div className="whitespace-pre-wrap text-sm leading-relaxed">
          {m.bodyText?.trim() ? (
            m.bodyText
          ) : (
            <span className="text-muted-foreground">(письмо без текста)</span>
          )}
        </div>
        {(restore.error || purge.error) && (
          <div className="text-destructive text-sm">
            {restore.error?.message ?? purge.error?.message}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmPurge}
        title="Удалить навсегда?"
        description="Письмо будет удалено без возможности восстановления."
        confirmText="Удалить навсегда"
        variant="danger"
        loading={purge.isPending}
        onConfirm={() => purge.mutate({ id })}
        onCancel={() => setConfirmPurge(false)}
      />
    </div>
  );
}
