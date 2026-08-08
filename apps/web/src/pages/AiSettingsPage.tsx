/**
 * /settings/ai — реквизиты подключения AI-ассистента к LLM. Доступ — только директор.
 *
 * Ключ write-only: с сервера приходит лишь флаг hasApiKey, пустое поле = не менять.
 * Протокол: z.ai GLM Coding Plan → anthropic; OpenRouter/OpenAI-совместимые → openai.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, Wifi } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

import {
  AI_PROVIDERS,
  CUSTOM_PROVIDER_ID,
  providerByBaseUrl,
  type ApiStyle,
} from '../lib/ai-providers';

type AssistantMode = 'read_only' | 'full';
/** Единый выбор состояния ассистента для UI (маппится в enabled + mode). */
type AssistantState = 'off' | 'read_only' | 'full';

export function AiSettingsPage() {
  const cfg = trpc.aiAssistant.getConfig.useQuery();
  const utils = trpc.useUtils();

  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<AssistantMode>('full');
  const [apiStyle, setApiStyle] = useState<ApiStyle>('anthropic');
  const [baseUrl, setBaseUrl] = useState('');
  const [model, setModel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [customInstructions, setCustomInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [testMsg, setTestMsg] = useState<string | null>(null);

  useEffect(() => {
    const c = cfg.data;
    if (!c) return;
    setEnabled(c.enabled);
    setMode(c.mode ?? 'full');
    setApiStyle(c.apiStyle);
    setBaseUrl(c.baseUrl ?? '');
    setModel(c.model ?? '');
    setCustomInstructions(c.customInstructions ?? '');
  }, [cfg.data]);

  const setConfig = trpc.aiAssistant.setConfig.useMutation({
    onSuccess: async () => {
      setSaved(true);
      setApiKey('');
      setTimeout(() => setSaved(false), 2500);
      await utils.aiAssistant.getConfig.invalidate();
      await utils.aiAssistant.status.invalidate();
    },
    onError: (e) => setError(e.message),
  });

  const testConfig = trpc.aiAssistant.testConfig.useMutation({
    onSuccess: (r) =>
      setTestMsg(
        r.ok
          ? `Связь есть. Модель «${r.model}» ответила: ${r.reply || '(пусто)'}`
          : `Ошибка: ${r.error}`,
      ),
    onError: (e) => setTestMsg(`Ошибка: ${e.message}`),
  });

  /**
   * На экране есть правки, которых нет на сервере.
   *
   * ЗАЧЕМ ЭТО ВООБЩЕ НУЖНО. Карточки режима подсвечиваются при нажатии и
   * выглядят применёнными, но на сервер ничего не уходит до «Сохранить».
   * А «Проверить связь» спрашивает СОХРАНЁННЫЙ конфиг — сервер читает его из
   * базы. Владелец сорок три минуты переключал режим и жал проверку, получая
   * «не настроен»: он проверял не то, что видел перед собой, и приложение об
   * этом молчало.
   */
  const savedCfg = cfg.data;
  const dirty =
    !!savedCfg &&
    (enabled !== savedCfg.enabled ||
      mode !== (savedCfg.mode ?? 'full') ||
      apiStyle !== savedCfg.apiStyle ||
      baseUrl !== (savedCfg.baseUrl ?? '') ||
      model !== (savedCfg.model ?? '') ||
      customInstructions !== (savedCfg.customInstructions ?? '') ||
      apiKey.trim() !== '');

  /**
   * Какой провайдер сейчас выбран — определяем по сохранённому адресу.
   *
   * Незнакомый адрес — это «Своё подключение», а НЕ «похожий из списка»:
   * иначе открытие страницы молча подменило бы человеку рабочую настройку.
   */
  const provider = providerByBaseUrl(baseUrl);
  const providerId = provider?.id ?? CUSTOM_PROVIDER_ID;

  const pickProvider = (id: string) => {
    const p = AI_PROVIDERS.find((x) => x.id === id);
    if (!p) return;
    setApiStyle(p.apiStyle);
    if (id === CUSTOM_PROVIDER_ID) {
      // Своё подключение: поля освобождаем, чтобы человек вписал своё, а не
      // правил чужой адрес поверх.
      setBaseUrl('');
      setModel('');
      return;
    }
    setBaseUrl(p.baseUrl);
    // Модель прежнего провайдера у нового не работает — подставляем его первую.
    setModel(p.models[0] ?? '');
  };

  const save = () => {
    setError(null);
    setConfig.mutate({
      enabled,
      mode,
      apiStyle,
      baseUrl: baseUrl.trim() || null,
      model: model.trim() || null,
      apiKey: apiKey || undefined,
      customInstructions: customInstructions.trim() || null,
    });
  };

  const inputCls =
    'bg-background focus:ring-primary/40 mt-1 w-full rounded-md border px-3 py-2 text-sm outline-none focus:ring-2';

  return (
    <div className="mx-auto max-w-2xl space-y-6 p-6">
      <div className="flex items-center gap-3">
        <Sparkles className="text-primary h-6 w-6" />
        <h1 className="text-2xl font-semibold">ИИ-ассистент — подключение</h1>
      </div>

      <p className="text-muted-foreground text-sm">
        Ключ и модель для встроенного помощника. Получите ключ у провайдера (z.ai, OpenRouter и
        т.п.), вставьте сюда и включите. Ключ хранится в зашифрованном виде и не показывается
        обратно.
      </p>

      {error && (
        <div className="bg-destructive/10 text-destructive border-destructive/30 rounded-md border px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {cfg.data?.usingEnvFallback && (
        <div className="bg-muted text-muted-foreground rounded-md px-4 py-2 text-xs">
          Сейчас ассистент работает из серверных переменных окружения (LLM_*). Заполните и сохраните
          форму, чтобы управлять настройками отсюда.
        </div>
      )}

      {cfg.isLoading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Загрузка…
        </div>
      ) : (
        <div className="space-y-4">
          {/* Режим работы: Выключен / Только смотрит / Полный */}
          <div className="bg-card space-y-3 rounded-lg border p-4">
            <div className="font-medium">Режим работы</div>
            <div className="grid gap-2 sm:grid-cols-3">
              {(
                [
                  {
                    key: 'off',
                    title: 'Выключен',
                    desc: 'Кнопка-бот есть, но запросы к модели не идут',
                  },
                  {
                    key: 'read_only',
                    title: 'Только смотрит',
                    desc: 'Отвечает и советует, но ничего не меняет',
                  },
                  {
                    key: 'full',
                    title: 'Полный',
                    desc: 'Может выполнять действия по запросу (с подтверждением)',
                  },
                ] as { key: AssistantState; title: string; desc: string }[]
              ).map((opt) => {
                const current: AssistantState = !enabled ? 'off' : mode;
                const active = current === opt.key;
                return (
                  <button
                    key={opt.key}
                    type="button"
                    aria-pressed={active}
                    onClick={() => {
                      if (opt.key === 'off') {
                        setEnabled(false);
                      } else {
                        setEnabled(true);
                        setMode(opt.key);
                      }
                    }}
                    className={cn(
                      'rounded-md border p-3 text-left transition',
                      active
                        ? 'border-primary bg-primary/5 ring-primary/40 ring-1'
                        : 'border-input hover:border-primary/40',
                    )}
                  >
                    <div className="text-sm font-medium">{opt.title}</div>
                    <div className="text-muted-foreground mt-0.5 text-xs">{opt.desc}</div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Провайдер */}
          <div className="bg-card space-y-3 rounded-lg border p-4">
            <div className="font-medium">Провайдер и модель</div>

            {/* Выбрал провайдера — адрес и тип API подставились сами. Раньше
                правильную тройку «тип + адрес + модель» надо было знать
                наизусть, и промах выглядел просто как «не работает». */}
            <label className="block">
              <span className="text-xs font-medium">Провайдер</span>
              <select
                aria-label="Провайдер"
                value={providerId}
                onChange={(e) => pickProvider(e.target.value)}
                className={inputCls}
              >
                {AI_PROVIDERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.label}
                  </option>
                ))}
              </select>
              <span
                className={cn(
                  'mt-1 block text-xs',
                  provider?.blockedOnProd ? 'text-warning' : 'text-muted-foreground',
                )}
              >
                {provider?.hint ?? 'Любой другой сервис: адрес и модель вписываются руками.'}
              </span>
            </label>

            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="text-xs font-medium">Базовый URL</span>
                <input
                  aria-label="Базовый URL"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://…"
                  className={inputCls}
                />
              </label>
              <label className="block">
                <span className="text-xs font-medium">Модель</span>
                {/* У известного провайдера — список его моделей: слаги у разных
                    сервисов разные («glm-4.6» против «z-ai/glm-4.6»), и перепутать
                    их стоило владельцу вечера. У «своего» — обычное поле. */}
                {provider && provider.models.length > 0 ? (
                  <select
                    aria-label="Модель"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    className={inputCls}
                  >
                    {(provider.models.includes(model)
                      ? provider.models
                      : [model, ...provider.models]
                    )
                      .filter(Boolean)
                      .map((m) => (
                        <option key={m} value={m}>
                          {m}
                        </option>
                      ))}
                  </select>
                ) : (
                  <input
                    aria-label="Модель"
                    value={model}
                    onChange={(e) => setModel(e.target.value)}
                    placeholder="название модели"
                    className={inputCls}
                  />
                )}
              </label>
            </div>

            <label className="block">
              <span className="text-xs font-medium">API-ключ</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={
                  cfg.data?.hasApiKey ? '•••••• (сохранён, пусто — не менять)' : 'вставьте ключ'
                }
                autoComplete="off"
                className={inputCls}
              />
            </label>
          </div>

          {/* Инструкция для ассистента (регламенты/процессы СЦ) */}
          <div className="bg-card space-y-3 rounded-lg border p-4">
            <div>
              <div className="font-medium">Инструкция для ассистента</div>
              <div className="text-muted-foreground text-xs">
                Опишите, как у вас принято работать: порядок ведения заявки, когда какой статус, как
                оформить гарантию/акт/счёт, ваши правила и особенности. Ассистент будет это
                учитывать и подсказывать сотрудникам «что и куда». Персональные данные сюда не
                вписывайте — это общая памятка.
              </div>
            </div>
            <textarea
              value={customInstructions}
              onChange={(e) => setCustomInstructions(e.target.value)}
              rows={10}
              maxLength={20000}
              placeholder={
                'Например:\n' +
                '• Новую заявку сначала переводим в «Диагностику», потом в «В работе».\n' +
                '• Гарантийный ремонт оформляем без счёта; при платном — сначала счёт, потом акт.\n' +
                '• Медтехнику госбольниц не удаляем, только переназначаем инженера.'
              }
              className={cn(inputCls, 'font-mono leading-relaxed')}
            />
            <div className="text-muted-foreground text-right text-xs tabular-nums">
              {customInstructions.length} / 20000
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={save}
              disabled={setConfig.isPending}
              className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex items-center gap-1.5 rounded-md px-4 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {setConfig.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Сохранить
            </button>
            <button
              type="button"
              onClick={() => {
                // Проверка идёт по тому, что лежит в базе. Пока правки не
                // сохранены, её ответ относился бы к ДРУГИМ настройкам —
                // молчать об этом нельзя, на этом и застревают.
                if (dirty) {
                  setTestMsg(
                    'Сначала сохраните: проверка идёт по сохранённым настройкам, а не по тому, что на экране.',
                  );
                  return;
                }
                setTestMsg(null);
                testConfig.mutate();
              }}
              disabled={testConfig.isPending}
              className="hover:bg-muted inline-flex items-center gap-1.5 rounded-md border px-4 py-2 text-sm font-medium transition disabled:opacity-50"
            >
              {testConfig.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wifi className="h-4 w-4" />
              )}
              Проверить связь
            </button>
            {saved && (
              <span className="text-success inline-flex items-center gap-1 text-sm">
                <CheckCircle2 className="h-4 w-4" />
                Сохранено
              </span>
            )}
            {dirty && !saved && (
              <span className="text-warning inline-flex items-center gap-1 text-sm font-medium">
                <AlertTriangle className="h-4 w-4" />
                Изменения не сохранены — нажмите «Сохранить»
              </span>
            )}
            {testMsg && <span className="text-muted-foreground text-sm">{testMsg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
