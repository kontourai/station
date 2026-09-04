export function resolveNpmCli(env?: NodeJS.ProcessEnv, node?: string): string;
export const INERT_INSTALL_TIMEOUT_ENV: string;
export function inertInstallTimeout(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
): number;
export function check(options?: { cwd?: string; bootstrap?: boolean }): unknown;
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
    },
  ) => string;
}): { command: string; args: string[] };
export function pnpmCommand(args: string[], cwd?: string): void;
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
export function install(options?: { developer?: boolean }): void;
export function propose(options?: { cwd?: string }): unknown;
