import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'wouter';
import { useForm, type SubmitHandler } from 'react-hook-form';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronLeft,
  Loader2,
  Mail,
  Sparkles,
  X,
} from 'lucide-react';
import type {
  IntakeMethod,
  RepairType,
  TicketPriority,
  TicketSource,
} from '@erfolg/shared';
import { SLA_HOURS_BY_PRIORITY, computeSlaTargetAt } from '@erfolg/shared';
import { trpc } from '../lib/trpc';
import { ClientPicker } from '../components/ClientPicker';
import { AssetPicker } from '../components/AssetPicker';
import { AssetModelPicker, type AssetModelLite } from '../components/AssetModelPicker';
import {
  TicketTemplatePicker,
  type TemplateDefaults,
} from '../components/TicketTemplatePicker';
import { EngineerAssignmentHints } from '../components/EngineerAssignmentHints';
import { RepairArchiveBlock } from '../components/RepairArchiveBlock';
import { cn } from '../lib/utils';

interface FormValues {
  clientId: string;
  assetId: string;
  contactId: string;
  contractId: string;
  source: TicketSource;
  intakeMethod: IntakeMethod;
  repairType: RepairType;
  priority: TicketPriority;
  symptom: string;
  notes: string;
  assignedEngineerId: string;
  deadlineAt: string; // YYYY-MM-DD
}

const EMPTY: FormValues = {
  clientId: '',
  assetId: '',
  contactId: '',
  contractId: '',
  source: 'call',
  intakeMethod: 'brought_in',
  repairType: 'paid',
  priority: 'normal',
  symptom: '',
  notes: '',
  assignedEngineerId: '',
  deadlineAt: '',
};

const SOURCE_OPTS: Array<{ v: TicketSource; label: string }> = [
  { v: 'call', label: 'Звонок' },
  { v: 'telegram', label: 'Telegram' },
  { v: 'email', label: 'Email' },
  { v: 'web_form', label: 'Веб-форма' },
  { v: 'manual', label: 'Вручную' },
];
const INTAKE_OPTS: Array<{ v: IntakeMethod; label: string }> = [
  { v: 'brought_in', label: 'Привезли в СЦ' },
  { v: 'onsite_visit', label: 'Выезд на объект' },
  { v: 'pickup', label: 'Забрать у клиента' },
];
const REPAIR_OPTS: Array<{ v: RepairType; label: string }> = [
  { v: 'paid', label: 'Платный' },
  { v: 'warranty', label: 'Гарантия' },
  { v: 'service_contract', label: 'По договору' },
];
const PRIORITY_OPTS: Array<{ v: TicketPriority; label: string }> = [
  { v: 'low', label: 'низкий' },
  { v: 'normal', label: 'обычный' },
  { v: 'high', label: 'высокий' },
  { v: 'urgent', label: 'срочный' },
];

export function NewTicketPage() {
  const [, navigate] = useLocation();
  const utils = trpc.useUtils();
  const form = useForm<FormValues>({ defaultValues: EMPTY });
  const [serverError, setServerError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [picked, setPicked] = useState<TemplateDefaults | null>(null);
  const applyTemplate = trpc.ticketTemplates.applyToTicket.useMutation();

  // Режим «Новый аппарат»: выбираем модель из каталога + вводим серийник/инв. номер.
  // На submit заводим единицу техники на клиента заявки и привязываем её к тикету.
  const [addingAsset, setAddingAsset] = useState(false);
  const [naModelId, setNaModelId] = useState('');
  const [naModel, setNaModel] = useState<AssetModelLite | null>(null);
  const [naSerial, setNaSerial] = useState('');
  const [naInventory, setNaInventory] = useState('');
  const createAsset = trpc.assets.create.useMutation();

  // «Заявка из письма»: если пришли из Почты (?fromEmail=<id>), сервер отдаёт ИИ-черновик
  // (клиент по адресу + техника/симптом из ИИ), которым мы разово префиллим форму.
  const emailId = new URLSearchParams(window.location.search).get('fromEmail');
  const emailDraft = trpc.email.draftTicketFromEmail.useQuery(
    { emailId: emailId ?? '' },
    { enabled: !!emailId, staleTime: Infinity, retry: false },
  );
  const linkTicket = trpc.email.linkTicket.useMutation();
  const prefilledRef = useRef(false);

  const clientId = form.watch('clientId');
  const assetId = form.watch('assetId');

  // Контакты подгружаются из клиента
  const clientDetail = trpc.clients.get.useQuery(
    { id: clientId || '' },
    { enabled: !!clientId },
  );

  // Активные контракты выбранного клиента — для блока «Договор».
  const clientContracts = trpc.contracts.listActiveByClient.useQuery(
    { clientId: clientId || '' },
    { enabled: !!clientId },
  );

  // Инженеры для назначения — выпадающий список вместо ручного ввода UUID.
  const engineers = trpc.users.list.useQuery({ onlyEngineers: true });
  // Контракт у госучреждения — ПОДСКАЗКА, а не требование (решение владельца 2026-07-23).
  // Раньше форма не давала завести заявку без контракта, и работа вставала: договоров
  // в базе заведено 0, а госучреждения — три четверти всех заявок.
  const isBudgetClient = clientDetail.data?.subtype === 'budget';

  const assignedEngineerId = form.watch('assignedEngineerId');
  // Тип техники для подсказок при назначении: из сохранённой единицы (по assetId)
  // или из выбранной модели каталога в режиме «Новый аппарат».
  const selectedAsset = trpc.assets.get.useQuery(
    { id: assetId || '' },
    { enabled: !!assetId },
  );
  const hintDeviceType = assetId
    ? (selectedAsset.data?.deviceType ?? null)
    : addingAsset
      ? (naModel?.deviceType ?? null)
      : null;

  // AI-диагностика по симптому: живая подсказка «похожие ремонты» под полем симптома.
  const me = trpc.auth.me.useQuery();
  const canSummarizeArchive =
    me.data?.user.role === 'director' || me.data?.user.role === 'dispatcher';
  const watchedSymptom = form.watch('symptom');
  const archiveModel = assetId
    ? (selectedAsset.data?.model ?? null)
    : addingAsset
      ? (naModel?.model ?? null)
      : null;

  // Сброс зависимых полей при смене клиента
  useEffect(() => {
    form.setValue('assetId', '');
    form.setValue('contactId', '');
    form.setValue('contractId', '');
    setAddingAsset(false);
    setNaModelId('');
    setNaModel(null);
    setNaSerial('');
    setNaInventory('');
    // intentionally not depending on form
  }, [clientId]);

  // При переходе к другому письму (смена ?fromEmail без размонтирования) — разрешить префилл заново.
  useEffect(() => {
    prefilledRef.current = false;
  }, [emailId]);

  // Разовый префилл формы из ИИ-черновика письма (клиент/симптом/источник/тип/приоритет).
  // Технику менеджер выбирает сам — ИИ-подсказка показана в баннере выше.
  // Клиента и симптом подставляем только в пустые поля — чтобы не затереть ручной выбор,
  // если менеджер успел что-то заполнить, пока грузился черновик.
  useEffect(() => {
    if (prefilledRef.current) return;
    const d = emailDraft.data;
    if (!d) return;
    prefilledRef.current = true;
    if (d.client && !form.getValues('clientId')) form.setValue('clientId', d.client.id);
    form.setValue('source', 'email');
    form.setValue('repairType', d.repairType);
    form.setValue('priority', d.priority);
    if (d.symptom && !form.getValues('symptom')) form.setValue('symptom', d.symptom);
    // intentionally not depending on form
  }, [emailDraft.data, emailId]);

  const create = trpc.tickets.create.useMutation({
    onSuccess: async (res) => {
      await utils.tickets.list.invalidate();
      // Если выбран шаблон — применяем строки в наряде, потом переходим на карточку.
      // Ошибка apply не должна терять созданный тикет: показываем серверную ошибку
      // и всё равно ведём на карточку, где менеджер увидит, что строк нет.
      if (picked) {
        try {
          await applyTemplate.mutateAsync({
            ticketId: res.id,
            templateId: picked.templateId,
          });
        } catch (e) {
          setServerError(
            `Заявка создана (${res.ticketNumber}), но шаблон не применился: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
      }
      // Заявка создана из письма — привяжем письмо к ней (best-effort, не блокируем переход).
      if (emailId) {
        try {
          await linkTicket.mutateAsync({ emailId, ticketId: res.id });
        } catch {
          /* не критично: заявка создана, связь можно проставить позже */
        }
      }
      navigate(`/tickets/${res.id}`);
    },
    onError: (e) => setServerError(e.message),
  });

  function handlePickTemplate(d: TemplateDefaults) {
    setPicked(d);
    setPickerOpen(false);
    if (d.defaultPriority) form.setValue('priority', d.defaultPriority);
    if (d.defaultRepairType) form.setValue('repairType', d.defaultRepairType);
  }

  function clearPicked() {
    setPicked(null);
  }

  const onSubmit: SubmitHandler<FormValues> = async (v) => {
    setServerError(null);
    if (!v.clientId) {
      setServerError('Выберите клиента');
      return;
    }
    if (!v.symptom.trim()) {
      setServerError('Опишите симптом со слов клиента');
      return;
    }

    // Если включён режим «Новый аппарат» — заводим единицу техники на клиента заявки,
    // затем привязываем её id к тикету. Серийник/инв. номер опциональны.
    let assetIdToUse: string | null = v.assetId || null;
    if (addingAsset) {
      if (!naModelId || !naModel) {
        setServerError('Выберите модель аппарата из каталога или вернитесь к выбору существующего');
        return;
      }
      try {
        const created = await createAsset.mutateAsync({
          ownerClientId: v.clientId,
          assetModelId: naModelId,
          model: naModel.model,
          manufacturer: naModel.manufacturer,
          serialNumber: naSerial.trim() || null,
          inventoryNumber: naInventory.trim() || null,
          riskClass: naModel.riskClass,
          requiredAttestationCategory: naModel.requiredAttestationCategory,
        });
        assetIdToUse = created.id;
      } catch (e) {
        setServerError(
          `Не удалось завести аппарат: ${e instanceof Error ? e.message : String(e)}`,
        );
        return;
      }
    }

    create.mutate({
      clientId: v.clientId,
      assetId: assetIdToUse,
      contactId: v.contactId || null,
      contractId: v.contractId || null,
      source: v.source,
      intakeMethod: v.intakeMethod,
      repairType: v.repairType,
      priority: v.priority,
      symptom: v.symptom.trim(),
      notes: v.notes.trim() || null,
      assignedEngineerId: v.assignedEngineerId || null,
      deadlineAt: v.deadlineAt ? new Date(v.deadlineAt) : null,
    });
  };

  const isPending = create.isPending || createAsset.isPending;

  function toggleAddingAsset() {
    if (!addingAsset) {
      // включаем режим нового аппарата — сбрасываем выбор существующего
      form.setValue('assetId', '');
      setAddingAsset(true);
    } else {
      // возвращаемся к выбору существующего — чистим ввод нового
      setNaModelId('');
      setNaModel(null);
      setNaSerial('');
      setNaInventory('');
      setAddingAsset(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-4 p-4 md:p-6">
      <Link
        href="/tickets"
        className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
      >
        <ChevronLeft className="h-4 w-4" />
        К списку заявок
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold md:text-2xl">Новая заявка</h1>
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="border-primary/40 text-primary hover:bg-primary/5 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium"
        >
          <Sparkles className="h-3.5 w-3.5" />
          По шаблону
        </button>
      </div>

      {picked && (
        <div className="bg-primary/5 border-primary/30 flex flex-wrap items-center justify-between gap-2 rounded-md border p-2.5 text-xs">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="text-primary h-4 w-4" />
            <span>
              Шаблон <strong>{picked.templateName}</strong> ·{' '}
              {picked.linesCount > 0
                ? `${picked.linesCount} строк наряда применятся после создания`
                : 'без строк наряда (только дефолты)'}
            </span>
          </div>
          <button
            type="button"
            onClick={clearPicked}
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <X className="h-3 w-3" /> убрать
          </button>
        </div>
      )}

      {emailId && (
        <div className="bg-primary/5 border-primary/30 space-y-2 rounded-md border p-3 text-xs">
          {emailDraft.isLoading ? (
            <div className="text-muted-foreground flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin" /> ИИ читает письмо…
            </div>
          ) : emailDraft.error ? (
            <div className="text-destructive flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              Не удалось разобрать письмо: {emailDraft.error.message}
            </div>
          ) : emailDraft.data ? (
            <>
              <div className="text-primary flex items-center gap-2 font-medium">
                <Sparkles className="h-4 w-4" /> Черновик из письма
              </div>
              <div className="text-muted-foreground flex items-start gap-1.5">
                <Mail className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                <span>
                  {emailDraft.data.from ?? 'отправитель'} · «
                  {emailDraft.data.subject ?? '(без темы)'}»
                </span>
              </div>
              {!emailDraft.data.client && (
                <div className="text-warning flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>Клиент по адресу не найден — выберите существующего или создайте нового.</span>
                </div>
              )}
              {emailDraft.data.deviceHint && (
                <div className="text-foreground">
                  Техника (подсказка ИИ): <strong>{emailDraft.data.deviceHint}</strong> — выберите
                  аппарат ниже.
                </div>
              )}
              {emailDraft.data.linkedTicket && (
                <div className="text-muted-foreground">
                  Письмо уже связано с заявкой{' '}
                  <Link
                    href={`/tickets/${emailDraft.data.linkedTicket.id}`}
                    className="text-primary underline"
                  >
                    {emailDraft.data.linkedTicket.number}
                  </Link>
                  .
                </div>
              )}
              <div className="text-muted-foreground border-primary/20 border-t pt-1.5">
                {emailDraft.data.aiUsed
                  ? 'Текст письма отправлялся в ИИ для разбора (152-ФЗ). Проверьте поля перед созданием.'
                  : 'ИИ недоступен — черновик собран из письма без ИИ. Проверьте поля перед созданием.'}
              </div>
            </>
          ) : null}
        </div>
      )}

      <form
        onSubmit={(e) => void form.handleSubmit(onSubmit)(e)}
        className="bg-card space-y-5 rounded-lg border p-4 md:p-6"
      >
        <div>
          <Label required>Клиент</Label>
          <ClientPicker
            value={clientId || null}
            onChange={(id) => form.setValue('clientId', id)}
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 flex items-center justify-between gap-2">
              <Label>Техника</Label>
              {clientId && (
                <button
                  type="button"
                  onClick={toggleAddingAsset}
                  className="text-primary text-xs font-medium hover:underline"
                >
                  {addingAsset ? '← выбрать существующий' : '➕ Новый аппарат'}
                </button>
              )}
            </div>

            {!clientId ? (
              <p className="text-muted-foreground text-xs">Сначала выберите клиента</p>
            ) : addingAsset ? (
              <div className="space-y-2">
                <AssetModelPicker
                  value={naModelId || null}
                  onChange={(id, m) => {
                    setNaModelId(id);
                    setNaModel(m);
                  }}
                />
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="text"
                    value={naSerial}
                    onChange={(e) => setNaSerial(e.target.value)}
                    placeholder="Серийный №"
                    className="bg-background w-full rounded-md border px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-primary/40"
                  />
                  <input
                    type="text"
                    value={naInventory}
                    onChange={(e) => setNaInventory(e.target.value)}
                    placeholder="Инвентарный №"
                    className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
                <p className="text-muted-foreground text-xs">
                  Аппарат добавится в парк клиента при создании заявки
                </p>
              </div>
            ) : (
              <>
                <AssetPicker
                  value={assetId || null}
                  ownerClientId={clientId || null}
                  onChange={(id) => form.setValue('assetId', id)}
                />
                <p className="text-muted-foreground mt-1 text-xs">Из парка клиента</p>
              </>
            )}
          </div>
          <div>
            <Label>Контактное лицо</Label>
            <select
              {...form.register('contactId')}
              disabled={!clientId}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
            >
              <option value="">— не выбран —</option>
              {(clientDetail.data?.contacts ?? []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.fullName}
                  {c.position ? ` · ${c.position}` : ''}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div>
          <Label>Договор</Label>
          <select
            {...form.register('contractId')}
            disabled={!clientId}
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-50"
          >
            <option value="">— без договора —</option>
            {(clientContracts.data ?? []).map((c) => (
              <option key={c.id} value={c.id}>
                № {c.contractNumber} от {new Date(c.contractDate).toLocaleDateString('ru-RU')}
              </option>
            ))}
          </select>
          {!clientId ? (
            <p className="text-muted-foreground mt-1 text-xs">Сначала выберите клиента</p>
          ) : isBudgetClient ? (
            <p className="text-warning mt-1 text-xs">
              Бюджетная организация — обычно работают по контракту (44-ФЗ). Если контракта
              нет, заявку всё равно можно завести.{' '}
              <Link href="/contracts/new" className="underline hover:text-primary">
                Создать договор
              </Link>
            </p>
          ) : (
            <p className="text-muted-foreground mt-1 text-xs">
              Опционально.{' '}
              <Link href="/contracts/new" className="underline hover:text-primary">
                Создать новый
              </Link>
            </p>
          )}
        </div>

        <div>
          <Label>Откуда заявка</Label>
          <Pills
            value={form.watch('source')}
            options={SOURCE_OPTS}
            onChange={(v) => form.setValue('source', v)}
          />
        </div>

        <div>
          <Label>Где техника</Label>
          <Pills
            value={form.watch('intakeMethod')}
            options={INTAKE_OPTS}
            onChange={(v) => form.setValue('intakeMethod', v)}
          />
        </div>

        <div>
          <Label>Тип ремонта</Label>
          <Pills
            value={form.watch('repairType')}
            options={REPAIR_OPTS}
            onChange={(v) => form.setValue('repairType', v)}
          />
        </div>

        <div>
          <Label>Приоритет</Label>
          <Pills
            value={form.watch('priority')}
            options={PRIORITY_OPTS}
            onChange={(v) => form.setValue('priority', v)}
          />
          <p className="text-muted-foreground mt-1.5 text-xs">
            Срок реакции (SLA): до{' '}
            <strong className="text-foreground">
              {computeSlaTargetAt(new Date(), form.watch('priority')).toLocaleString('ru-RU', {
                day: 'numeric',
                month: 'long',
                hour: '2-digit',
                minute: '2-digit',
              })}
            </strong>{' '}
            ({SLA_HOURS_BY_PRIORITY[form.watch('priority')]} ч от приёма) — проставится
            автоматически и подсветит «горит / успеваем» в списке и на доске.
          </p>
        </div>

        <div>
          <Label required>Симптом со слов клиента</Label>
          <textarea
            rows={4}
            {...form.register('symptom', { required: true })}
            placeholder="«При включении монитор показывает заставку, после чего гаснет…»"
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
          <RepairArchiveBlock
            symptom={watchedSymptom}
            model={archiveModel}
            canSummarize={canSummarizeArchive}
            className="mt-3"
          />
        </div>

        <div>
          <Label>Внутренние заметки</Label>
          <textarea
            rows={2}
            {...form.register('notes')}
            placeholder="Видны только сотрудникам сервиса"
            className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <Label>Назначить инженера</Label>
            <select
              {...form.register('assignedEngineerId')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            >
              <option value="">
                {engineers.isLoading ? 'загрузка…' : 'назначим позже'}
              </option>
              {(engineers.data ?? []).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.fullName}
                </option>
              ))}
            </select>
            {engineers.error && (
              <p className="text-destructive mt-1 text-xs">
                Не удалось загрузить список инженеров
              </p>
            )}
            <EngineerAssignmentHints
              deviceType={hintDeviceType}
              assetId={assetId || null}
              selectedEngineerId={assignedEngineerId || null}
            />
          </div>
          <div>
            <Label>Дедлайн</Label>
            <input
              type="date"
              {...form.register('deadlineAt')}
              className="bg-background w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </div>
        </div>

        {serverError && (
          <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border p-2.5 text-xs">
            {serverError}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={() => navigate('/tickets')}
            className="hover:bg-muted rounded-md border px-3 py-2 text-sm"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={isPending}
            className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 rounded-md px-4 py-2 text-sm font-medium"
          >
            {isPending ? 'Создание…' : 'Создать заявку'}
          </button>
        </div>
      </form>

      <TicketTemplatePicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onPick={handlePickTemplate}
      />
    </div>
  );
}

function Pills<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ v: T; label: string }>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt.v}
          type="button"
          onClick={() => onChange(opt.v)}
          className={cn(
            'rounded-md border px-2.5 py-1 text-xs transition',
            value === opt.v
              ? 'border-primary bg-primary/10 text-primary'
              : 'border-border text-muted-foreground hover:border-foreground/30',
          )}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Label({
  children,
  required = false,
}: {
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="text-foreground mb-1 flex items-center gap-1 text-xs font-medium">
      {children}
      {required && <span className="text-destructive">*</span>}
    </label>
  );
}
