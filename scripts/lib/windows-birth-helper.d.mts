/** The staged helper and the SHA-256 written beside it. */
export interface StagedWindowsBirthHelper {
  helper: string;
  digest: string;
}

/** Test seams; production passes none of them. */
export interface StageWindowsBirthHelperOptions {
  build?: () => { path: string; cleanup(): void };
  platform?: NodeJS.Platform;
  probeWithPowerShell?: (pid: number) => string | null;
  run?: (file: string, args: string[]) => string | Buffer;
}

export function stageWindowsBirthHelper(
  runtimeDir: string,
  options?: StageWindowsBirthHelperOptions,
): StagedWindowsBirthHelper;
