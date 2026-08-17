/**
 * Реквизиты организации для печатных бланков.
 *
 * ЧТО БЫЛО. Все шесть бланков печатали константу `ERFOLG_FALLBACK` из
 * `lib/pdf/branding.ts`, а в `TicketCardPage` рядом с ней даже стоял
 * «TODO: брать из tenant settings когда появится trpc endpoint». Эндпоинт
 * появился (`settings.getOrganization`) — бланки переводятся на него.
 *
 * 🔴 ПОЧЕМУ ПАДЕНИЕ НА КОНСТАНТУ ПО КАЖДОМУ ПОЛЮ В ОТДЕЛЬНОСТИ, А НЕ ЦЕЛИКОМ.
 * Если просто подставить то, что лежит в базе, любое НЕЗАПОЛНЕННОЕ поле молча
 * исчезнет из документа: пустой ОГРН — и в договоре пропадает строка, пустая
 * фамилия директора — и счёт уходит без подписи. Мы не знаем, что заполнено на
 * бою, и узнать это, не читая боевую базу, нельзя. Поэтому пустое поле берёт
 * прежнее встроенное значение: хуже, чем было, не станет ни при каком состоянии
 * базы, а как только директор заполнит поле на экране «Организация» — в бумаге
 * появится его значение.
 *
 * ⚠️ ОФЛАЙН. Данные приходят обычным запросом, и при потере связи react-query
 * ставит его на паузу (`networkMode: 'online'`), а не роняет. Печать при этом
 * обязана работать: `resolvePrintTenant(undefined)` возвращает ровно встроенные
 * значения. Императивный `fetch()` в обработчике здесь применять НЕЛЬЗЯ — на
 * паузе он висит вечно, этим уже намертво вешался сканер (#112).
 */
import { trpc } from './trpc';
import { ERFOLG_FALLBACK } from './pdf/branding';
import type { TenantData } from './pdf/shared';

/** То, что отдаёт `settings.getOrganization`. */
export interface OrganizationLike {
  displayName: string;
  legalName: string | null;
  slogan: string | null;
  inn: string | null;
  kpp: string | null;
  ogrn: string | null;
  legalAddress: string | null;
  phone: string | null;
  email: string | null;
  bankName: string | null;
  bankAccount: string | null;
  correspondentAccount: string | null;
  bik: string | null;
  licenseSeries: string | null;
  licenseNumber: string | null;
  licenseDate: string | null;
  licenseAuthority: string | null;
  directorName: string | null;
}

/** Непустое значение из базы либо прежнее встроенное. */
function pick(fromDb: string | null | undefined, builtIn: string | null): string | null {
  const v = fromDb?.trim();
  return v ? v : builtIn;
}

export function resolvePrintTenant(org: OrganizationLike | undefined | null): TenantData {
  const f = ERFOLG_FALLBACK;
  return {
    legalName: pick(org?.legalName, f.legalName) ?? f.legalName,
    displayName: pick(org?.displayName, f.displayName) ?? f.displayName,
    slogan: pick(org?.slogan, f.slogan),
    inn: pick(org?.inn, f.inn),
    kpp: pick(org?.kpp, f.kpp),
    ogrn: pick(org?.ogrn, f.ogrn),
    legalAddress: pick(org?.legalAddress, f.legalAddress),
    phone: pick(org?.phone, f.phone),
    email: pick(org?.email, f.email),
    bankName: pick(org?.bankName, f.bankName),
    bankAccount: pick(org?.bankAccount, f.bankAccount),
    correspondentAccount: pick(org?.correspondentAccount, f.correspondentAccount),
    bik: pick(org?.bik, f.bik),
    licenseSeries: pick(org?.licenseSeries, f.licenseSeries),
    licenseNumber: pick(org?.licenseNumber, f.licenseNumber),
    licenseDate: pick(org?.licenseDate, f.licenseDate),
    licenseAuthority: pick(org?.licenseAuthority, f.licenseAuthority),
    director: pick(org?.directorName, f.director) ?? f.director,
  };
}

/**
 * Реквизиты для печати: из базы, с падением на встроенные значения.
 *
 * Запрос обычный, кэшируемый: страница зовёт хук на рендере, а обработчик
 * печати берёт уже готовое значение. Если данные ещё не приехали или связи
 * нет — вернутся встроенные, и документ всё равно напечатается.
 */
export function useTenantRequisites(): TenantData {
  const q = trpc.settings.getOrganization.useQuery(undefined, {
    // Реквизиты меняются раз в год: незачем перезапрашивать их на каждом
    // возврате к вкладке, когда человек печатает акты один за другим.
    staleTime: 5 * 60 * 1000,
  });
  return resolvePrintTenant(q.data);
}
