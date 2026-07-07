import { defineConfig } from 'vitest/config';

// Юнит-тесты чистых функций пакета @erfolg/db (без БД и side-effect'ов).
export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
  },
});
