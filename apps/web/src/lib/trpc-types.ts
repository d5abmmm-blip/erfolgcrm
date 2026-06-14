/**
 * Выводимые типы tRPC-роутера для веб-приложения.
 *
 * Используем `inferRouterInputs`/`inferRouterOutputs` поверх реального `AppRouter` из
 * apps/api — это даёт сквозную типобезопасность UI ↔ API без ручных DTO-контрактов.
 * Подтипы конкретных процедур выводим как `RouterOutputs['email']['thread'][number]` и т.п.
 */
import type { inferRouterInputs, inferRouterOutputs } from '@trpc/server';
import type { AppRouter } from '@erfolg/api';

export type RouterOutputs = inferRouterOutputs<AppRouter>;
export type RouterInputs = inferRouterInputs<AppRouter>;
