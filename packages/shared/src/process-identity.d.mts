export const PROCESS_BIRTH_FINGERPRINT_TIMEOUT_MS: number;
export const WINDOWS_PROCESS_BIRTH_ATTEMPTS: number;
export const WINDOWS_PROCESS_BIRTH_RETRY_DELAY_MS: number;
export const WINDOWS_PROCESS_BIRTH_DEADLINE_MS: number;
export type ExactProcessIdentity = { pid: number; start: string };
export type ExactProcessIdentityProbe =
  | { state: 'dead' }
  | { state: 'unavailable' }
  | { state: 'exact'; identity: ExactProcessIdentity };
export type ProcessIdentityDependencies = {
  platform?: NodeJS.Platform;
  lookup?: (pid: number) => string | null;
  alive?: (pid: number) => 'alive' | 'dead' | 'unavailable';
  kill?: (pid: number, signal?: number) => void;
  now?: () => number;
  wait?: (delayMs: number) => void;
  retryDelayMs?: number;
  deadlineMs?: number;
  /** execFileSync-shaped seam; #1669 added it to the impl but not here. */
  exec?: (
    file: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ) => string;
};
export function lookupProcessBirthFingerprint(
  pid: number,
  dependencies?: ProcessIdentityDependencies,
): string | null;
export const PROCESS_BIRTH_FINGERPRINT_CACHE_TTL_MS: number;
export type ProcessIdentityAsyncDependencies = Omit<
  ProcessIdentityDependencies,
  'exec'
> & {
  /** callback-execFile-shaped async seam. */
  exec?: (
    file: string,
    args: readonly string[],
    options?: Record<string, unknown>,
  ) => Promise<string>;
};
export type ProcessIdentityCacheDependencies = {
  /** Bypass (and refresh) the cache for this lookup. */
  fresh?: boolean;
  ttlMs?: number;
  now?: () => number;
};
export function lookupProcessBirthFingerprintAsync(
  pid: number,
  dependencies?: ProcessIdentityAsyncDependencies,
): Promise<string | null>;
/**
 * Does a recorded birth fingerprint PROVE this pid was reused? Fail-open on
 * probe failure (the lookup returns null, never undefined, on failure).
 */
export function birthProvesReuse(
  recordedBirth: string | null | undefined,
  pid: number,
  dependencies?: Parameters<typeof lookupProcessBirthFingerprint>[1],
): boolean;
export function lookupProcessBirthFingerprintCached(
  pid: number,
  dependencies?: ProcessIdentityDependencies & ProcessIdentityCacheDependencies,
): string | null;
export function lookupProcessBirthFingerprintCachedAsync(
  pid: number,
  dependencies?: ProcessIdentityAsyncDependencies &
    ProcessIdentityCacheDependencies,
): Promise<string | null>;
export function clearProcessBirthFingerprintCache(): void;
export function probeExactProcessIdentity(
  pid: number,
  dependencies?: ProcessIdentityDependencies,
): ExactProcessIdentityProbe;
export function resolveOwnProcessIdentity(
  pid: number,
  dependencies?: ProcessIdentityDependencies,
): ExactProcessIdentityProbe;
export function exactProcessIdentity(
  pid: number,
  dependencies?: ProcessIdentityDependencies,
): ExactProcessIdentity | null;
export type ProcessIdentityAsyncProbeDependencies = {
  platform?: NodeJS.Platform;
  lookup?: (pid: number) => Promise<string | null>;
  alive?: (pid: number) => 'alive' | 'dead' | 'unavailable';
  kill?: (pid: number, signal?: number) => void;
};
export function probeExactProcessIdentityAsync(
  pid: number,
  dependencies?: ProcessIdentityAsyncProbeDependencies,
): Promise<ExactProcessIdentityProbe>;
