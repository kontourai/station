import type { ProviderKind } from './provider.js';

/** A provider value together with the instant that value was observed. */
export interface ObservedQuotaValue<T> {
  value: T;
  observedAt: string;
}

export interface ConnectionQuotaWindow {
  id: string;
  usedPercent: number;
  observedAt: string;
  label?: string;
  /** Provider-reported duration; this is `windowDurationMins` on the Codex wire. */
  windowDurationMins?: number;
  /** Provider-reported epoch value; Station does not guess its unit or format. */
  resetsAt?: number;
}

/**
 * A quota observation reported directly by a provider. Fields are never
 * inferred: missing provider data stays absent (in particular, no window is
 * synthesized at 0% usage).
 *
 * `observedAt` is the newest constituent observation, not a claim that every
 * field was observed then. Nested window and credits fields have group-level
 * freshness only: their `observedAt` is shared with the containing window or
 * credits group. Ordering is by provider observation time, never arrival time.
 * Codex's rolling wire notification carries no provider timestamp, so its
 * adapter uses local arrival time; it cannot detect reordering before Station.
 * `baselineAt` is the most recent complete provider read on which this snapshot
 * was based; a rolling update without a read has no baseline.
 */
export interface ConnectionQuotaSnapshot {
  connectionId: string;
  provider: ProviderKind;
  observedAt: string;
  baselineAt?: string;
  source: 'provider-reported';
  /** Which Codex account namespace supplied this observation. */
  accountScope: 'profile' | 'global';
  /** `type` is an opaque provider plan string; Station does not enumerate it. */
  plan?: ObservedQuotaValue<{ type: string }>;
  windows: ConnectionQuotaWindow[];
  credits?: ObservedQuotaValue<{
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string;
  }>;
  /** Opaque provider rate-limit-reached string; unknown values pass through. */
  limitReached?: ObservedQuotaValue<string>;
  spendControl?: ObservedQuotaValue<{
    limit: string;
    remainingPercent: number;
    resetsAt: number;
    used: string;
  }>;
}

/**
 * Sparse provider update. `null` is deliberately accepted at each optional
 * group because the app-server uses nullable rolling metadata; null means
 * unavailable, never "clear the value we already observed".
 */
export interface ConnectionQuotaSnapshotUpdate {
  connectionId: string;
  provider: ProviderKind;
  source: 'provider-reported';
  accountScope: 'profile' | 'global';
  plan?: ObservedQuotaValue<{ type: string }> | null;
  windows: ConnectionQuotaWindow[];
  credits?: ObservedQuotaValue<{
    hasCredits: boolean;
    unlimited: boolean;
    balance?: string;
  }> | null;
  limitReached?: ObservedQuotaValue<string> | null;
  spendControl?: ObservedQuotaValue<{
    limit: string;
    remainingPercent: number;
    resetsAt: number;
    used: string;
  }> | null;
}

function newestObservedAt(
  snapshot: Omit<ConnectionQuotaSnapshot, 'observedAt'>,
): string | null {
  const observedAt = [
    ...snapshot.windows.map((window) => window.observedAt),
    snapshot.plan?.observedAt,
    snapshot.credits?.observedAt,
    snapshot.limitReached?.observedAt,
    snapshot.spendControl?.observedAt,
  ].filter((value): value is string => typeof value === 'string');
  return observedAt.length > 0
    ? observedAt.reduce((newest, value) => (value > newest ? value : newest))
    : null;
}

/**
 * Merges an app-server sparse rolling update. Present values replace only
 * fields observed at least as recently as their baseline; absent and null
 * values preserve prior observations. With no baseline, only actually
 * observed update fields are returned.
 */
export function mergeQuotaSnapshot(
  baseline: ConnectionQuotaSnapshot | undefined,
  update: ConnectionQuotaSnapshotUpdate,
): ConnectionQuotaSnapshot | null {
  // Identity guard. Merging observations of two DIFFERENT connections or
  // account scopes would produce one snapshot labelled as a single account
  // while carrying another's numbers — the exact mislabeling this contract
  // exists to prevent. Callers get `null` (nothing observed) rather than a
  // blended lie. Dormant while the pull path never supplies a baseline, and
  // armed for the live-merge slice that will.
  if (
    baseline &&
    (baseline.connectionId !== update.connectionId ||
      baseline.provider !== update.provider ||
      baseline.accountScope !== update.accountScope)
  ) {
    return null;
  }
  const windows = new Map<string, ConnectionQuotaWindow>(
    baseline?.windows.map((window) => [window.id, window]) ?? [],
  );
  for (const updateWindow of update.windows) {
    const baselineWindow = windows.get(updateWindow.id);
    if (baselineWindow && updateWindow.observedAt < baselineWindow.observedAt) {
      continue;
    }
    windows.set(updateWindow.id, {
      ...baselineWindow,
      ...updateWindow,
      ...(updateWindow.label === undefined &&
      baselineWindow?.label !== undefined
        ? { label: baselineWindow.label }
        : {}),
      ...(updateWindow.windowDurationMins === undefined &&
      baselineWindow?.windowDurationMins !== undefined
        ? { windowDurationMins: baselineWindow.windowDurationMins }
        : {}),
      ...(updateWindow.resetsAt === undefined &&
      baselineWindow?.resetsAt !== undefined
        ? { resetsAt: baselineWindow.resetsAt }
        : {}),
    });
  }
  const newest = <T>(
    baselineValue: ObservedQuotaValue<T> | undefined,
    updateValue: ObservedQuotaValue<T> | null | undefined,
  ) =>
    updateValue &&
    (!baselineValue || updateValue.observedAt >= baselineValue.observedAt)
      ? updateValue
      : baselineValue;
  const credits = newest(baseline?.credits, update.credits);
  const merged = {
    connectionId: update.connectionId,
    provider: update.provider,
    source: update.source,
    accountScope: update.accountScope,
    ...(baseline?.baselineAt ? { baselineAt: baseline.baselineAt } : {}),
    ...(newest(baseline?.plan, update.plan)
      ? { plan: newest(baseline?.plan, update.plan) }
      : {}),
    windows: [...windows.values()],
    ...(credits
      ? {
          credits: {
            ...credits,
            value: {
              ...baseline?.credits?.value,
              ...credits.value,
              ...(credits.value.balance === undefined &&
              baseline?.credits?.value.balance !== undefined
                ? { balance: baseline.credits.value.balance }
                : {}),
            },
          },
        }
      : {}),
    ...(newest(baseline?.limitReached, update.limitReached)
      ? { limitReached: newest(baseline?.limitReached, update.limitReached) }
      : {}),
    ...(newest(baseline?.spendControl, update.spendControl)
      ? { spendControl: newest(baseline?.spendControl, update.spendControl) }
      : {}),
  } satisfies Omit<ConnectionQuotaSnapshot, 'observedAt'>;
  const observedAt = newestObservedAt(merged);
  return observedAt ? { ...merged, observedAt } : null;
}

export type ConnectionQuotaResult =
  | { kind: 'snapshot'; snapshot: ConnectionQuotaSnapshot }
  | {
      kind: 'unavailable';
      reason:
        | 'unsupported-provider'
        | 'not-authenticated'
        | 'provider-error'
        | 'timeout';
      detail?: string;
    };
