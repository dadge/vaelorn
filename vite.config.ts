import { defineConfig } from 'vitest/config';
import { readBuildInfo } from './scripts/build-info.mjs';
import { pwaPlugin } from './scripts/pwa-build.mjs';

export default defineConfig({
  // PWA : écrit dist/sw.js (pré-cache de tout le build) à la fin de `vite build`
  plugins: [pwaPlugin()],
  // base relatif : build utilisable tel quel dans un wrapper Capacitor/Android plus tard
  base: './',
  // Version affichée dans le menu (voir src/buildInfo.ts) : version du package, hash et date du commit construit.
  define: { __BUILD_INFO__: JSON.stringify(readBuildInfo(process.cwd(), process.env)) },
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
