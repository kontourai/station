export function resolveNpmCli(env?: NodeJS.ProcessEnv, node?: string): string;
export function inertInstallTimeout(platform?: NodeJS.Platform): number;
export function check(options?: { cwd?: string }): unknown;
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
export function verify(options?: { cwd?: string }): unknown;
export function install(options?: { developer?: boolean }): void;
export function propose(options?: { cwd?: string }): unknown;
