import {
  FOREGROUND_WORK_ACTIONS,
  FOREGROUND_WORK_COLLECTOR_UNSUPPORTED,
  FOREGROUND_WORK_INTERACTIONS,
  FOREGROUND_WORK_JOURNAL_VERSION,
  FOREGROUND_WORK_PANES,
  FOREGROUND_WORK_PHASES,
  FOREGROUND_WORK_STALL_THRESHOLD_MS,
  NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE,
} from './foreground-work-journal-schema.mjs';

export {
  FOREGROUND_WORK_JOURNAL_VERSION,
  FOREGROUND_WORK_STALL_THRESHOLD_MS,
} from './foreground-work-journal-schema.mjs';

export type ForegroundWorkPhase =
  | 'input'
  | 'authoritative-apply'
  | 'layout'
  | 'render'
  | 'pane-restoration';
export type ForegroundWorkInteraction =
  | 'task-editor'
  | 'workspace-pane'
  | 'collaboration'
  | 'navigation';
export type ForegroundWorkAction =
  | 'local-input'
  | 'remote-apply'
  | 'layout-commit'
  | 'pane-restore'
  | 'presence-update';
export type ForegroundWorkPane =
  | 'task-editor'
  | 'file-preview'
  | 'diff-panel'
  | 'workspace-host';
export interface ForegroundWorkAttribution {
  readonly phase: ForegroundWorkPhase;
  readonly interaction: ForegroundWorkInteraction;
  readonly action: ForegroundWorkAction;
  readonly pane: ForegroundWorkPane;
}
export interface ForegroundWorkIncident extends ForegroundWorkAttribution {
  readonly source: 'browser-longtask' | 'manual-stall';
  readonly durationMs: number;
}
export interface ForegroundWorkAggregate {
  readonly count: number;
  readonly totalDurationMs: number;
  readonly maxDurationMs: number;
}
export interface ForegroundWorkJournalSnapshot {
  readonly version: 1;
  readonly collector: 'browser-longtask' | 'NOT_VERIFIED';
  readonly collectorReason?: 'BROWSER_LONGTASK_UNSUPPORTED';
  readonly thresholdMs: 50;
  readonly incidents: readonly ForegroundWorkIncident[];
  readonly aggregate: ForegroundWorkAggregate;
  readonly native: {
    readonly status: 'NOT_VERIFIED';
    readonly reason: 'NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE';
  };
}
export interface ForegroundWorkJournal {
  begin(attribution: ForegroundWorkAttribution): () => void;
  mark(
    attribution: ForegroundWorkAttribution,
    occurrenceTimeMs: number,
    occurrence?: 'start' | 'completion',
  ): void;
  recordManualStall(durationMs: number): void;
  snapshot(): ForegroundWorkJournalSnapshot;
  close(): void;
}
interface Options {
  readonly capacity?: number;
  readonly now?: () => number;
  readonly observeLongTasks?: boolean;
}
interface LongTaskEntry {
  readonly startTime: number;
  readonly duration: number;
}
type ObservableLongTaskObserver = {
  observe(options: { type: string; buffered: boolean }): void;
  disconnect(): void;
};
type LongTaskObserverConstructor = new (
  callback: (list: { getEntries(): readonly LongTaskEntry[] }) => void,
) => ObservableLongTaskObserver;
type PerformanceObserverSupport = {
  readonly PerformanceObserver?: LongTaskObserverConstructor & {
    readonly supportedEntryTypes?: readonly string[];
  };
};
type Ownership = {
  readonly attribution: ForegroundWorkAttribution;
  readonly startedAt: number;
  readonly order: number;
  readonly occurrence: 'start' | 'completion';
  endedAt?: number;
};

const phases = new Set<ForegroundWorkPhase>(
  FOREGROUND_WORK_PHASES as readonly ForegroundWorkPhase[],
);
const interactions = new Set<ForegroundWorkInteraction>(
  FOREGROUND_WORK_INTERACTIONS as readonly ForegroundWorkInteraction[],
);
const actions = new Set<ForegroundWorkAction>(
  FOREGROUND_WORK_ACTIONS as readonly ForegroundWorkAction[],
);
const panes = new Set<ForegroundWorkPane>(
  FOREGROUND_WORK_PANES as readonly ForegroundWorkPane[],
);

function normalizedAttribution(
  value: ForegroundWorkAttribution,
): ForegroundWorkAttribution | undefined {
  if (
    !value ||
    Object.keys(value).length !== 4 ||
    !['phase', 'interaction', 'action', 'pane'].every((key) => key in value) ||
    !phases.has(value.phase) ||
    !interactions.has(value.interaction) ||
    !actions.has(value.action) ||
    !panes.has(value.pane)
  )
    return undefined;
  return {
    phase: value.phase,
    interaction: value.interaction,
    action: value.action,
    pane: value.pane,
  };
}

function validDuration(value: number): number | undefined {
  return Number.isFinite(value) && value >= FOREGROUND_WORK_STALL_THRESHOLD_MS
    ? value
    : undefined;
}

/**
 * Owns foreground attribution intervals only. Intervals are not measurements:
 * an incident exists solely for an observed Long Task or explicit manual stall.
 */
export function createForegroundWorkJournal(
  options: Options = {},
): ForegroundWorkJournal {
  const requestedCapacity = options.capacity;
  const capacity =
    typeof requestedCapacity === 'number' &&
    Number.isSafeInteger(requestedCapacity)
      ? Math.max(1, Math.min(128, requestedCapacity))
      : 64;
  const now = options.now ?? (() => performance.now());
  const incidents: ForegroundWorkIncident[] = [];
  const ownership: Ownership[] = [];
  const dedupe = new Set<string>();
  let nextOwnershipOrder = 0;
  const PerformanceObserverConstructor = (
    globalThis as PerformanceObserverSupport
  ).PerformanceObserver;
  const supportsLongTasks =
    options.observeLongTasks !== false &&
    PerformanceObserverConstructor?.supportedEntryTypes?.includes(
      'longtask',
    ) === true;
  let observer: ObservableLongTaskObserver | undefined;
  let collector: ForegroundWorkJournalSnapshot['collector'] = 'NOT_VERIFIED';

  const append = (
    attribution: ForegroundWorkAttribution,
    source: ForegroundWorkIncident['source'],
    durationMs: number,
    dedupeKey?: string,
  ) => {
    const duration = validDuration(durationMs);
    if (duration === undefined || (dedupeKey && dedupe.has(dedupeKey))) return;
    if (dedupeKey) {
      dedupe.add(dedupeKey);
      if (dedupe.size > capacity) dedupe.delete(dedupe.values().next().value!);
    }
    incidents.push({ ...attribution, source, durationMs: duration });
    if (incidents.length > capacity)
      incidents.splice(0, incidents.length - capacity);
  };
  const latest = (candidates: readonly Ownership[]) =>
    candidates.reduce<Ownership | undefined>((current, owner) => {
      if (
        !current ||
        owner.startedAt > current.startedAt ||
        (owner.startedAt === current.startedAt && owner.order > current.order)
      )
        return owner;
      return current;
    }, undefined);
  const ownerAt = (start: number, end = start) => {
    const completed = latest(
      ownership.filter(
        (owner) =>
          owner.occurrence === 'completion' &&
          owner.startedAt > start &&
          owner.startedAt <= end,
      ),
    );
    if (completed) return completed;
    return latest(
      ownership.filter(
        (owner) =>
          owner.occurrence === 'start' &&
          owner.startedAt <= start &&
          (owner.endedAt === undefined || start <= owner.endedAt),
      ),
    );
  };

  if (supportsLongTasks)
    try {
      observer = new PerformanceObserverConstructor!((list) => {
        for (const entry of list.getEntries()) {
          const owner = ownerAt(
            entry.startTime,
            entry.startTime + entry.duration,
          );
          if (!owner) continue;
          append(
            owner.attribution,
            'browser-longtask',
            entry.duration,
            // Browser Long Task identity is the raw performance entry, not
            // whichever attribution happened to be current when a buffered
            // observer delivered it. The same 10..80 entry can arrive before
            // and after a completion mark; emitting it twice under two
            // plausible owners would turn observer ordering into false work.
            `${entry.startTime}:${entry.duration}`,
          );
        }
      });
      observer.observe({ type: 'longtask', buffered: false });
      collector = 'browser-longtask';
    } catch {
      observer = undefined;
    }

  return {
    begin(attribution) {
      const normalized = normalizedAttribution(attribution);
      if (!normalized) return () => {};
      const owner: Ownership = {
        attribution: normalized,
        startedAt: now(),
        order: nextOwnershipOrder++,
        occurrence: 'start',
      };
      ownership.push(owner);
      if (ownership.length > capacity)
        ownership.splice(0, ownership.length - capacity);
      let finished = false;
      return () => {
        if (finished) return;
        finished = true;
        // A correlated completion or fixture close may have already ended
        // this nested interval. Never extend that fence on a late cleanup.
        owner.endedAt ??= now();
      };
    },
    mark(attribution, occurrenceTimeMs, occurrence = 'start') {
      const normalized = normalizedAttribution(attribution);
      if (
        !normalized ||
        !Number.isFinite(occurrenceTimeMs) ||
        occurrenceTimeMs < 0
      )
        return;
      if (occurrence !== 'start' && occurrence !== 'completion') return;
      if (occurrence === 'completion') {
        // Completion is stack-scoped: it closes the newest active start the
        // fixture can prove preceded it, not every outer interaction. An
        // inner render finishing at t20 must leave its outer input (t0) able
        // to own a Long Task at t25; the later outer completion closes that
        // remaining interval.
        const owner = latest(
          ownership.filter(
            (candidate) =>
              candidate.occurrence === 'start' &&
              candidate.endedAt === undefined &&
              candidate.startedAt <= occurrenceTimeMs,
          ),
        );
        if (owner) owner.endedAt = occurrenceTimeMs;
      }
      ownership.push({
        attribution: normalized,
        startedAt: occurrenceTimeMs,
        order: nextOwnershipOrder++,
        occurrence,
      });
      if (ownership.length > capacity)
        ownership.splice(0, ownership.length - capacity);
    },
    recordManualStall(durationMs) {
      const owner = ownerAt(now());
      if (owner) append(owner.attribution, 'manual-stall', durationMs);
    },
    snapshot() {
      const aggregate = incidents.reduce(
        (total, incident) => ({
          count: total.count + 1,
          totalDurationMs: total.totalDurationMs + incident.durationMs,
          maxDurationMs: Math.max(total.maxDurationMs, incident.durationMs),
        }),
        { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
      );
      return {
        version: FOREGROUND_WORK_JOURNAL_VERSION,
        collector,
        ...(collector === 'NOT_VERIFIED' && {
          collectorReason: FOREGROUND_WORK_COLLECTOR_UNSUPPORTED,
        }),
        thresholdMs: FOREGROUND_WORK_STALL_THRESHOLD_MS,
        incidents: incidents.map((incident) => ({ ...incident })),
        aggregate,
        native: {
          status: 'NOT_VERIFIED',
          reason: NATIVE_FOREGROUND_EXECUTOR_COLLECTOR_UNAVAILABLE,
        },
      };
    },
    close() {
      // A fixture boundary is an ownership boundary too. Long Task delivery
      // is asynchronous, so a callback that was queued before disconnect
      // must not borrow an input start from the fixture that just ended.
      const closedAt = now();
      for (const owner of ownership) {
        if (owner.occurrence === 'start' && owner.endedAt === undefined)
          owner.endedAt = closedAt;
      }
      observer?.disconnect();
      observer = undefined;
    },
  };
}
