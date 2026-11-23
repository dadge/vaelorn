/** Déclarations de types pour scripts/build-info.mjs (utilisé par vite.config.ts et src/buildInfo.test.ts). */

export interface BuildInfo {
  version: string;
  commit: string | null;
  date: string | null;
}

export function readBuildInfo(
  root: string,
  env?: { GITHUB_SHA?: string },
  git?: (args: string[], cwd: string) => string | null,
): BuildInfo;
