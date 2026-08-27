/**
 * Types for the station#4177 WSL host-class predicate, so the src-ui
 * touch-target test can import the same predicate the scripts-side quarantine
 * uses instead of re-deriving one that would drift from it (same shape as
 * `scripts/accent-foreground-ratchet.d.mts`).
 */

export declare const WSL_HOST_CLASS_OVERRIDE_ENV: 'STATION_FORCE_WSL_HOST_CLASS';

export declare const WSL_QUARANTINE_REASON: string;

export interface WslHostClassProbe {
  platform?: string;
  osRelease?: string;
}

export interface WslHostPredicateProbe extends WslHostClassProbe {
  env?: Record<string, string | undefined>;
}

export declare function detectWslHostClass(probe?: WslHostClassProbe): boolean;

export declare function isWslHost(probe?: WslHostPredicateProbe): boolean;

/** The one member of vitest's test context the quarantine helper touches. */
export interface WslQuarantineSkippableContext {
  skip(condition: boolean, note?: string): void;
}

export interface CreateWslQuarantinedTestOptions {
  test: (
    name: string,
    fn: (ctx: WslQuarantineSkippableContext) => unknown,
  ) => unknown;
  quarantinedNames: readonly string[];
  reason: string;
  env?: Record<string, string | undefined>;
}

export declare function createWslQuarantinedTest(
  options: CreateWslQuarantinedTestOptions,
): (name: string, fn: (ctx: WslQuarantineSkippableContext) => unknown) => void;
