import type { FirstRunTransitionRequest } from '@kontourai/station-contracts/config';
import {
  useConfigQuery,
  useRecordFirstRunDecisionMutation,
  useUpdateConfigMutation,
} from '@kontourai/station-sdk';
import { log } from '@/utils/logger';
import type { AppConfig } from '../types';

type ConfigData = AppConfig & {
  defaultMaxSteps?: number;
};

// #198: `apiBase` was previously defaulted here too, but it had zero real
// consumers (the actual resolved API base is `useApiBase()` /
// `ApiBaseContext.tsx`, which implements the real same-origin-default
// priority chain) — removed as dead code rather than fixed, since fixing it
// would still leave it unused.
export const CONFIG_DEFAULTS = {
  defaultChatFontSize: 14,
  region: '',
  userId: 'default-user', // Static userId until auth is implemented
} as const;

export interface ConfigSnapshot {
  config: ConfigData | null;
  /**
   * The config READ failed.
   *
   * Review M2: this hook logged the error and returned `config: null`, which
   * is also what an in-flight read looks like — so `SettingsView`'s
   * `if (!configData)` skeleton was permanent whenever the initial read
   * failed. A page that cannot say "this failed" says "still loading" forever.
   * `null` when the read has not failed.
   */
  error: unknown;
  /** Re-runs the config read (the Retry action behind `error`). */
  retry: () => void;
  /**
   * React Query's fetch generation for `['config']` — the epoch millisecond
   * stamp of the last successful fetch, bumped on every fetch even when the
   * payload is byte-identical.
   *
   * A consumer reconciling server truth against local edits needs to know
   * *when* a snapshot was fetched, not just what it contains: a value-only
   * comparison cannot tell "the same cached response again" from "the server
   * changed away and back", and it cannot tell a snapshot that predates a
   * local write from one that supersedes it. `0` while no fetch has succeeded.
   */
  dataUpdatedAt: number;
}

export function useConfigSnapshot(): ConfigSnapshot {
  const { data, error, dataUpdatedAt, refetch } = useConfigQuery();

  if (error) log.api('Failed to fetch config:', error);

  return {
    config: (data as ConfigData) || null,
    error: error ?? null,
    retry: () => void refetch(),
    dataUpdatedAt,
  };
}

export function useConfig(): ConfigData | null {
  return useConfigSnapshot().config;
}

/**
 * Whether the app config on screen is a CONFIRMED read rather than a restored
 * one still being revalidated.
 *
 * `['config']` is one of the whitelisted persisted queries
 * (`lib/queryPersistence.ts`), so a boot renders IndexedDB's copy from the
 * PREVIOUS session before the network answers. Anything that merely displays
 * config is right to use that copy — that is what the persister is for. A
 * decision that INTERRUPTS the user is not: the first-run chapter re-opened
 * over a run the user had already deferred, because the restored snapshot
 * still said `pending` (observed live, intermittently, on a real temp home).
 *
 * `isFetching`, not `isLoading`: a restored query has data, so it is never
 * "loading", and `isLoading` would report a stale read as settled.
 */
export function useConfigSettled(): boolean {
  return !useConfigQuery().isFetching;
}

export function useConfigActions() {
  const updateMutation = useUpdateConfigMutation({
    onError: (error) => log.api('Failed to update config:', error),
  });
  // A transition, not a setting: `PUT /config/app` refuses `firstRun` outright
  // (review M1), and this is the only way to record one.
  const firstRunMutation = useRecordFirstRunDecisionMutation({
    onError: (error) => log.api('Failed to record first-run decision:', error),
  });

  return {
    updateConfig: (config: Partial<ConfigData>) =>
      updateMutation.mutateAsync(config),
    recordFirstRunDecision: (next: FirstRunTransitionRequest) =>
      firstRunMutation.mutateAsync(next),
    isSaving: updateMutation.isPending,
  };
}
