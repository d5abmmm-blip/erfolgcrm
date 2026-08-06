import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/storybook-static/**',
      '**/dev-dist/**',
      '**/*.config.{js,ts,mjs,cjs}',
      // Вне tsconfig-проектов — typed-линтинг для них невозможен:
      // archive — замороженный код (метрология после 0036), scripts — простые
      // mjs-утилиты, public — service-worker-скрипты без сборки.
      'archive/**',
      'scripts/**',
      'apps/web/public/**',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Решение аудита 2026-06-11: метрики размера/сложности выключены.
      // На сложившейся кодовой базе они давали 400+ предупреждений и при
      // --max-warnings 0 блокировали линт целиком; контроль сложности —
      // через code review, а не через пороги, требующие массовых рефакторингов.
      'max-lines': 'off',
      'max-lines-per-function': 'off',
      'max-params': 'off',
      'max-depth': ['warn', 4],
      complexity: 'off',

      // Безопасность типов
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports' }],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',

      // Стиль
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    // Тесты: сырой SQL через tx.execute<T>() и касты результатов — осознанный
    // паттерн (см. __tests__/*). unsafe-семейство и require-await здесь шумят,
    // не ловя реальных проблем; в боевом коде эти правила остаются строгими.
    files: ['**/__tests__/**', '**/*.test.ts', '**/*.test.tsx'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-base-to-string': 'off',
      '@typescript-eslint/require-await': 'off',
    },
  },
);
