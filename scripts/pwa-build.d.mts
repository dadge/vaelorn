/** Déclarations de types pour scripts/pwa-build.mjs (utilisé par vite.config.ts et src/pwa/pwa.test.ts). */

export function listBuildFiles(dir: string): string[];
export function computeVersion(dir: string, files: string[], extra?: string): string;
export function buildServiceWorker(options: { files: string[]; version: string; template?: string }): string;
export function pwaPlugin(): {
  name: string;
  apply: 'build';
  configResolved(config: { root: string; build: { outDir: string } }): void;
  closeBundle(): void;
};
