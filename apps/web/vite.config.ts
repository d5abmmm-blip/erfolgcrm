import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';

export default defineConfig({
  // VITE_*-переменные живут в корневом .env монорепо (см. .env.example).
  // Без envDir Vite искал бы .env в apps/web и корневые значения игнорировались.
  envDir: path.resolve(__dirname, '../..'),
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.png', 'erfolg-logo.png', 'apple-touch-icon.png'],
      manifest: {
        name: 'ErfolgCRM — медтехника',
        short_name: 'ErfolgCRM',
        description: 'CRM для сервисных центров медицинской техники',
        theme_color: '#29ABE2',
        background_color: '#ffffff',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        scope: '/',
        lang: 'ru-RU',
        categories: ['business', 'productivity', 'medical'],
        icons: [
          { src: '/pwa-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/pwa-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
        shortcuts: [
          {
            name: 'Очередь',
            short_name: 'Очередь',
            url: '/m/queue',
            icons: [{ src: '/pwa-192.png', sizes: '192x192' }],
          },
          {
            name: 'Сканер штрих-кода',
            short_name: 'Сканер',
            url: '/m/scan',
            icons: [{ src: '/pwa-192.png', sizes: '192x192' }],
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // pdfmake-чанк весит >2MB — поднимаем лимит precache до 5MB.
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        navigateFallbackDenylist: [/^\/api/],
        // Подключаем push-handler в auto-generated SW (Web Push, Этап 7-A).
        importScripts: ['/push-handler.js'],
        runtimeCaching: [
          {
            // tRPC мутации — никогда не кешировать (а тем более — не отвечать оффлайн)
            urlPattern: ({ url, request }) =>
              url.pathname.startsWith('/api') && request.method !== 'GET',
            handler: 'NetworkOnly',
          },
          {
            // tRPC GET-запросы (queries) — пробуем сеть, fallback на кеш не делаем (offline → ошибка)
            urlPattern: ({ url }) => url.pathname.startsWith('/api'),
            handler: 'NetworkFirst',
            options: {
              cacheName: 'erfolg-api-queries',
              networkTimeoutSeconds: 5,
              expiration: { maxEntries: 50, maxAgeSeconds: 60 * 5 },
            },
          },
        ],
      },
      devOptions: { enabled: false },
    }),
  ],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    port: Number(process.env.PORT) || 5173,
    host: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Code splitting: разбиваем тяжёлые библиотеки на отдельные чанки.
        // pdfmake (~1.5MB) и exceljs (~700KB) подгружаются лениво из lib/pdf и lib/excel,
        // поэтому в главный index*.js они не попадут вообще.
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'wouter'],
          radix: [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-label',
            '@radix-ui/react-slot',
            '@radix-ui/react-tooltip',
          ],
          tanstack: [
            '@tanstack/react-query',
            '@trpc/client',
            '@trpc/react-query',
            '@trpc/server',
          ],
          qrcode: ['qrcode'],
          zxing: ['@zxing/browser', '@zxing/library'],
          workbox: ['workbox-window'],
          lucide: ['lucide-react'],
        },
      },
    },
  },
});
