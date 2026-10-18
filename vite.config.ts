import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import type { Plugin } from 'vite';

// GitHub Pages serves the app from /<repo>/. The deploy workflow sets BASE_PATH;
// locally we serve from the root.
const base = process.env.BASE_PATH ?? '/';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// ORT dynamically imports /ort/*.mjs at runtime. The dev server refuses to
// serve public/ files to import(), so hand those over untransformed.
function serveOrtRaw(): Plugin {
  return {
    name: 'serve-ort-raw',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (!path.startsWith(`${base}ort/`) || !path.endsWith('.mjs')) return next();
        const file = new URL(`./public/ort/${basename(path)}`, import.meta.url);
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', 'text/javascript');
        createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  plugins: [
    serveOrtRaw(),
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
        globIgnores: ['**/assets/ort-wasm*.wasm', 'corpus/level-*.json', 'audio/**', 'lexicon/cards-*.json', 'lexicon/words-*.json', 'prompts/*.json'],
        // ORT WASM (~21 MB) and the espeak-ng bundle must be pre-cached for offline use.
        maximumFileSizeToCacheInBytes: 40 * 1024 * 1024,
        navigateFallback: `${base}index.html`,
        // Model weights are cached by Transformers.js in its own Cache Storage
        // bucket ("transformers-cache"); don't double-store them here.
        runtimeCaching: [
          {
            // Lexicon shards and extra prompt packs: serve cached, refresh in the background.
            urlPattern: ({ url }) => url.pathname.includes('/lexicon/') || url.pathname.includes('/prompts/'),
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'lexiphon-lexicon', expiration: { maxEntries: 120 } },
          },
          {
            urlPattern: ({ url }) => url.hostname.endsWith('wikimedia.org'),
            handler: 'CacheFirst',
            options: { cacheName: 'lexiphon-images', expiration: { maxEntries: 600, maxAgeSeconds: 60 * 60 * 24 * 180 }, cacheableResponse: { statuses: [0, 200] } },
          },
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
