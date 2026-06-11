import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: false,
    testTimeout: 10000,
    setupFiles: ['./src/__tests__/setup.ts'],
    // Тесты — интеграционные, ходят в ОБЩУЮ dev-базу (erfolg_dev). При
    // параллельных файлах они загрязняют данные друг друга (например,
    // schedule.test видел чужие тикеты, notify-тест — чужой контакт) и
    // мигали то в одном, то в другом месте. Последовательный прогон файлов
    // дороже по времени (~+1 мин), но 100% воспроизводим.
    fileParallelism: false,
  },
});
