import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { readFileSync } from 'node:fs';

// GitHub Pages serves the app from /<repo>/. The deploy workflow sets BASE_PATH;
// locally we serve from the root.
const base = process.env.BASE_PATH ?? '/';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: false,
      // The manifest lives in public/manifest.json so it can be edited by hand.
      manifest: false,
      includeAssets: ['icons/*.png', 'icons/*.svg', 'manifest.json'],
      workbox: {
        globPatterns: ['**/*.{js,mjs,css,html,json,svg,png,woff2,wasm}'],
        // ORT also emits a hashed copy of its WASM into assets/; we load the one in /ort/.
        // The corpus (≈4 MB) and pre-rendered audio are fetched on demand and cached at runtime.
        globIgnores: ['**/assets/ort-wasm*.wasm', 'corpus/level-*.json', 'audio/**'],
        // ORT WASM (~21 MB) and the espeak-ng bundle must be pre-cached for offline use.
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
        // Model weights are cached by Transformers.js in its own Cache Storage
        // bucket ("transformers-cache"); don't double-store them here.
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/corpus/level-') || url.pathname.includes('/audio/rp/'),
            handler: 'CacheFirst',
            options: { cacheName: 'lexiphon-corpus', expiration: { maxEntries: 400 } },
          },
          {
            urlPattern: ({ url }) => url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com',
            handler: 'CacheFirst',
            options: { cacheName: 'lexiphon-fonts', expiration: { maxEntries: 30 } },
          },
        ],
      },
    }),
  ],
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@huggingface/transformers', 'phonemizer'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 4096 },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
