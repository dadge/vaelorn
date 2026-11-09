import { defineConfig } from 'vitest/config';
import { pwaPlugin } from './scripts/pwa-build.mjs';

export default defineConfig({
  // PWA : écrit dist/sw.js (pré-cache de tout le build) à la fin de `vite build`
  plugins: [pwaPlugin()],
  // base relatif : build utilisable tel quel dans un wrapper Capacitor/Android plus tard
  base: './',
  server: { port: 5173, open: false },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/testing/vitest.setup.ts'],
    testTimeout: 60000,
  },
});
