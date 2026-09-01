export function resolveNpmCli(env?: NodeJS.ProcessEnv, node?: string): string;
export const INERT_INSTALL_TIMEOUT_ENV: string;
export function inertInstallTimeout(
  platform?: NodeJS.Platform,
  env?: NodeJS.ProcessEnv,
): number;
export function check(options?: { cwd?: string }): unknown;
export function preflightInstalledLifecycle(
  allowlist: unknown,
  options?: { cwd?: string; scope?: string },
): unknown[];
export function runApprovedHooks(
  allowlist: unknown,
  options?: { cwd?: string },
): void;
export function stageLifecyclePrebuilds(
  allowlist: unknown,
  options?: { cwd?: string },
): void;
export function verify(options?: { cwd?: string }): unknown;
export function install(options?: { developer?: boolean }): void;
export function propose(options?: { cwd?: string }): unknown;
