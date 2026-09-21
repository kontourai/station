export function resolveNpmCli(env?: NodeJS.ProcessEnv, node?: string): string;
export const INERT_INSTALL_TIMEOUT_ENV: string;
export function inertInstallTimeout(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
): number;
export function check(options?: {
  cwd?: string;
  bootstrap?: boolean;
  /** Test-only override of the committed allowlist policy. */
  allowlist?: unknown;
}): unknown;
export function pnpmInvocation(options?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  node?: string;
  platform?: NodeJS.Platform;
  exec?: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      encoding: 'utf8';
      timeout: number;
      windowsHide: true;
      argv0?: string;
    },
  ) => string;
}): { command: string; args: string[]; argv0?: string };
export function pnpmCommand(
  args: string[],
  cwd?: string,
  invocation?: { command: string; args: string[]; argv0?: string },
): void;
export function refreshLock(options?: { cwd?: string }): void;
export function preflightInstalledLifecycle(
  allowlist: unknown,
  options?: { cwd?: string; scope?: string },
): unknown[];
export function runApprovedHooks(
  allowlist: unknown,
  options?: { cwd?: string },
): void;
export function verifyLifecycleArtifacts(
  allowlist: unknown,
  options?: { cwd?: string },
): Array<{ skipped?: boolean; degraded?: boolean; detail: string }>;
export function stageLifecyclePrebuilds(
  allowlist: unknown,
  options?: { cwd?: string },
): void;
export function verify(options?: { cwd?: string }): unknown;
export function install(
  options?: { developer?: boolean },
  execution?: {
    root: string;
    nodePath: string;
    pnpmInvocation: typeof pnpmInvocation;
    command: (
      command: string,
      args: string[],
      options?: { cwd?: string },
    ) => unknown;
    check: typeof check;
    pnpmCommand: typeof pnpmCommand;
    stageLifecyclePrebuilds: typeof stageLifecyclePrebuilds;
    runApprovedHooks: typeof runApprovedHooks;
    stationOwnedHooks: () => unknown;
    verify: typeof verify;
    generateBuildInputs: () => unknown;
  },
): unknown;
export function propose(options?: { cwd?: string }): unknown;
export function describeFailure(
  error: unknown,
  options?: { maxDepth?: number; maxLength?: number },
): string;
export function reportCliFailure(
  error: unknown,
  options?: { log?: (line: string) => void },
): number;
export function generateBuildInputs(options?: {
  run?: (command: string, args: string[]) => unknown;
  exists?: (path: string) => boolean;
  log?: (line: string) => void;
}): void;
