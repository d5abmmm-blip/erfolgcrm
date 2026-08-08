/**
 * Список ИИ-провайдеров для настроек ассистента.
 *
 * ЗАЧЕМ СПИСКОМ, А НЕ ДВУМЯ ПОЛЯМИ. Раньше адрес и модель вписывались руками,
 * а тип API выбирался отдельно — и правильную тройку надо было знать наизусть.
 * Ошибиться было проще, чем попасть: адрес OpenRouter при типе Anthropic даёт
 * запрос на `…/api/v1/v1/messages` (404), а слаг `z-ai/glm-4.6` — это формат
 * OpenRouter: у самого z.ai модель зовётся `glm-4.6`. Обе ошибки выглядят
 * одинаково — «не работает».
 *
 * ⚠️ ДОСТУПНОСТЬ С БОЕВОГО СЕРВЕРА — НЕ ПУСТЯК. Проверено 2026-08-08 запросами
 * без ключа прямо из боевого контейнера: openrouter.ai и api.openai.com
 * отдают **403 «Access denied by security policy»** (Cloudflare, блок по
 * адресу сервера — ключ не при чём), а z.ai, DeepSeek и Mistral отвечают 401,
 * то есть путь живой. Поэтому у заблокированных стоит пометка: без неё человек
 * будет менять ключи и настройки там, где дело не в них.
 */
/** Как разговаривать с провайдером. Должно совпадать с ApiStyle на сервере. */
export type ApiStyle = 'openai' | 'anthropic';

export interface AiProvider {
  id: string;
  /** Как показываем в списке. */
  label: string;
  apiStyle: ApiStyle;
  /** Базовый URL без хвостового слэша. */
  baseUrl: string;
  /** Первая модель — та, что подставится по умолчанию. */
  models: string[];
  /** Короткая подсказка под списком. */
  hint: string;
  /** Заблокирован с боевого сервера (проверено, см. шапку файла). */
  blockedOnProd?: boolean;
}

export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    id: 'zai-anthropic',
    label: 'z.ai — GLM (Anthropic-совместимый)',
    apiStyle: 'anthropic',
    baseUrl: 'https://api.z.ai/api/anthropic',
    // Порядок = что подставится по умолчанию. Сначала бесплатное и дешёвое:
    // причесать фразу инженера и ответить в чате — работа лёгкая, флагман за
    // $4,4 за миллион здесь не нужен. Цены сверены с прайсом z.ai 2026-08-08.
    models: ['glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.5-air', 'glm-4.7', 'glm-4.6', 'glm-5'],
    hint: 'Работает с боевого сервера. GLM-4.7-Flash — бесплатная, её и берите для начала; GLM-4.7 (~$0,6 за млн) — если понадобится лучше.',
  },
  {
    id: 'zai-openai',
    label: 'z.ai — GLM (OpenAI-совместимый)',
    apiStyle: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    models: ['glm-4.7-flash', 'glm-4.7-flashx', 'glm-4.5-air', 'glm-4.7', 'glm-4.6', 'glm-5'],
    hint: 'Тот же z.ai, но по стилю OpenAI. Работает с боевого сервера, GLM-4.7-Flash бесплатна.',
  },
  {
    id: 'zai-vision',
    label: 'z.ai — GLM Vision (разбор фото)',
    apiStyle: 'openai',
    baseUrl: 'https://api.z.ai/api/paas/v4',
    // Отдельная строка, потому что текстовые модели фото не понимают: если
    // помощнику будут слать снимки документов, нужна именно такая.
    models: ['glm-4.6v-flash', 'glm-4.6v-flashx', 'glm-4.6v', 'glm-ocr'],
    hint: 'Для фото документов. GLM-4.6V-Flash — бесплатная. Обычные текстовые модели картинки не понимают.',
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    apiStyle: 'openai',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    hint: 'Работает с боевого сервера. Дешёвый, хорошо пишет по-русски.',
  },
  {
    id: 'mistral',
    label: 'Mistral',
    apiStyle: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    models: ['mistral-large-latest', 'mistral-small-latest'],
    hint: 'Работает с боевого сервера.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (на бою заблокирован)',
    apiStyle: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'z-ai/glm-4.6',
      'deepseek/deepseek-chat',
      'anthropic/claude-3.5-sonnet',
      'openai/gpt-4o-mini',
    ],
    hint: 'С боевого сервера отдаёт 403 (блок по адресу сервера, ключ не поможет). На dev работает.',
    blockedOnProd: true,
  },
  {
    id: 'openai',
    label: 'OpenAI (на бою заблокирован)',
    apiStyle: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o'],
    hint: 'С боевого сервера отдаёт 403. На dev работает.',
    blockedOnProd: true,
  },
  {
    id: 'custom',
    label: 'Своё подключение (вписать адрес и модель)',
    apiStyle: 'openai',
    baseUrl: '',
    models: [],
    hint: 'Любой другой сервис: адрес и модель вписываются руками.',
  },
];

/** Ручной ввод — у него нет списка моделей и нет подставляемого адреса. */
export const CUSTOM_PROVIDER_ID = 'custom';

/**
 * Пункт «вписать модель руками» внутри списка моделей известного провайдера.
 *
 * ЗАЧЕМ. Провайдеры выпускают модели чаще, чем мы деплоим: список z.ai устарел
 * в тот же день, когда появился. Без этого пункта выпадающий список, задуманный
 * как помощь, ОТНИМАЕТ возможность — вписать новую модель можно было бы только
 * через «Своё подключение», а оно стирает и адрес провайдера.
 */
export const OTHER_MODEL = '__other__';

function normalize(url: string): string {
  return url.trim().replace(/\/+$/, '').toLowerCase();
}

/**
 * Какому провайдеру принадлежит сохранённый адрес.
 *
 * Незнакомый адрес обязан давать `undefined`, а не «первый попавшийся»:
 * иначе открытие страницы молча подменило бы человеку рабочую настройку.
 */
export function providerByBaseUrl(baseUrl: string | null | undefined): AiProvider | undefined {
  if (!baseUrl?.trim()) return undefined;
  const needle = normalize(baseUrl);
  return AI_PROVIDERS.find((p) => p.baseUrl && normalize(p.baseUrl) === needle);
}

/**
 * Провайдер по адресу И модели.
 *
 * Одного адреса мало: у z.ai текстовые модели и модели для фото живут на ОДНОМ
 * адресе (`/api/paas/v4`), и поиск только по адресу всегда возвращал бы первый
 * попавшийся — «Vision» стал бы невыбираемым. Поэтому при совпадении адреса
 * предпочитаем того, у кого в списке есть текущая модель.
 */
export function resolveProvider(
  baseUrl: string | null | undefined,
  model: string | null | undefined,
): AiProvider | undefined {
  if (!baseUrl?.trim()) return undefined;
  const needle = normalize(baseUrl);
  const sameUrl = AI_PROVIDERS.filter((p) => p.baseUrl && normalize(p.baseUrl) === needle);
  if (sameUrl.length === 0) return undefined;
  const m = (model ?? '').trim().toLowerCase();
  return sameUrl.find((p) => p.models.some((x) => x.toLowerCase() === m)) ?? sameUrl[0];
}
