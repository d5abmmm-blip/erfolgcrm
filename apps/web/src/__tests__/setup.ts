/**
 * Vitest setup для apps/web. Подменяем IndexedDB на fake-indexeddb,
 * чтобы тесты offline-очереди работали в jsdom без реального браузера.
 */
import 'fake-indexeddb/auto';
