/**
 * Déclarations minimales des modules Node utilisés par les TESTS (fs, path, os, url).
 * Le projet n'embarque pas @types/node : ces déclarations ambiantes évitent d'ajouter une dépendance.
 * Ne déclarer ici que ce qui est réellement utilisé ; si @types/node est installé un jour, ce fichier
 * peut être supprimé (les déclarations fusionnent sans conflit en attendant).
 */

declare module 'node:fs' {
  export interface Dirent {
    name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function readFileSync(path: string, encoding: 'utf8' | 'latin1'): string;
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void;
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export function existsSync(path: string): boolean;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function mkdtempSync(prefix: string): string;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  export function unlinkSync(path: string): void;
  export function appendFileSync(path: string, data: string, encoding?: 'utf8'): void;
}

declare module 'node:path' {
  export const sep: string;
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(p: string): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
  export function pathToFileURL(path: string): { href: string };
}

/** Variables d'environnement (calibrage long à la demande : `src/testing/lootCalibration.long.test.ts`). */
declare const process: { env: Record<string, string | undefined> };
