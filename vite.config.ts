import { defineConfig } from 'vitest/config';

export default defineConfig({
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
    testTimeout: 60000,
  },
});
