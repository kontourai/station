import { randomUUID } from 'node:crypto';
import type { RunSummary } from '@kontourai/station-contracts/runs';

export type NativeInvocationKind =
  | 'agent-invoke'
  | 'agent-invoke-stream'
  | 'global-invoke'
  | 'global-structure';

type NativeInvocationState =
  | 'starting'
  | 'running'
  | 'completed'
  | 'failed'
  | 'indeterminate';

export type NativeInvocationOwner =
  | { id: string; pid: number; birth: string; identityKind: 'exact' }
  | { id: string; pid: number; identityKind: 'unverified' };

export interface NativeInvocationProcessIdentity {
  probe(
    pid: number,
  ):
    | { state: 'dead' }
    | { state: 'unavailable' }
    | { state: 'exact'; identity: { pid: number; start: string } };
}

interface NativeInvocationRecord {
  runId: string;
  kind: NativeInvocationKind;
  sourceId?: string;
  state: NativeInvocationState;
  ownerId: string;
  ownerPid: number;
  ownerBirth?: string;
  ownerIdentityKind: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  failureMessage?: string;
}

type Transition =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'unavailable' };

interface Coordinator {
  begin(input: NativeInvocationRecord & { state: 'starting' }): Transition;
  transition(input: {
    runId: string;
    ownerId: string;
    from: NativeInvocationState[];
    to: Extract<
      NativeInvocationState,
      'running' | 'completed' | 'failed' | 'indeterminate'
    >;
    now: string;
    failureMessage?: string;
  }): Transition;
  read(runId: string): RunSummary | null;
  list(): RunSummary[];
  active(): NativeInvocationRecord[];
}

const activeOwners = new Set<string>();
const releasedOwners = new Set<string>();

/** Called by EventStore shutdown so a replacement in this process can reconcile. */
export function releaseNativeInvocationOwner(ownerId: string): void {
  activeOwners.delete(ownerId);
  releasedOwners.add(ownerId);
}

export interface NativeInvocationRunClaim {
  /** Must succeed immediately before the external provider call. */
  beginInvocation(now: string): Transition;
  completed(now: string): Transition;
  failedBeforeInvocation(now: string, failureMessage: string): Transition;
  indeterminate(now: string, failureMessage: string): Transition;
}

/** Narrow pre-effect capability used only by direct invoke route composition. */
export interface NativeInvocationStarter {
  begin(input: {
    kind: NativeInvocationKind;
    sourceId?: string;
    now: string;
  }):
    | { kind: 'owner'; runId: string; claim: NativeInvocationRunClaim }
    | { kind: 'unavailable' };
}

/** Read-only projection capability required by RunService composition. */
export interface NativeInvocationRunReader {
  list(): { kind: 'available'; runs: RunSummary[] } | { kind: 'unavailable' };
  read(
    runId: string,
  ): { kind: 'available'; run: RunSummary | null } | { kind: 'unavailable' };
}

interface NativeInvocationRuns
  extends NativeInvocationStarter,
    NativeInvocationRunReader {
  /** Startup-only: a dead post-boundary owner is never replayed. */
  reconcile(now: string): { kind: 'available' } | { kind: 'unavailable' };
}

function isOwnerLive(
  record: NativeInvocationRecord,
  processIdentity: NativeInvocationProcessIdentity,
): boolean {
  if (releasedOwners.has(record.ownerId)) return false;
  if (record.ownerPid === process.pid && activeOwners.has(record.ownerId)) {
    return true;
  }
  const observed = processIdentity.probe(record.ownerPid);
  if (observed.state === 'dead') return false;
  if (observed.state === 'unavailable') return true;
  return (
    record.ownerIdentityKind !== 'exact' ||
    !record.ownerBirth ||
    observed.identity.start === record.ownerBirth
  );
}

/**
 * One narrow authority for provider calls that do not create orchestration
 * sessions. It owns only the invocation boundary and its run projection;
 * callers receive an opaque, one-way claim rather than EventStore access.
 */
export function createNativeInvocationRuns(options: {
  coordinator: Coordinator;
  owner: NativeInvocationOwner;
  processIdentity: NativeInvocationProcessIdentity;
}): NativeInvocationRuns {
  activeOwners.add(options.owner.id);

  const transition = (
    runId: string,
    from: NativeInvocationState[],
    to: Extract<
      NativeInvocationState,
      'running' | 'completed' | 'failed' | 'indeterminate'
    >,
    now: string,
    failureMessage?: string,
  ): Transition =>
    options.coordinator.transition({
      runId,
      ownerId: options.owner.id,
      from,
      to,
      now,
      ...(failureMessage ? { failureMessage } : {}),
    });

  return {
    begin(input) {
      const runId = `invoke:${randomUUID()}`;
      const record: NativeInvocationRecord & { state: 'starting' } = {
        runId,
        kind: input.kind,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        state: 'starting',
        ownerId: options.owner.id,
        ownerPid: options.owner.pid,
        ...(options.owner.identityKind === 'exact'
          ? { ownerBirth: options.owner.birth }
          : {}),
        ownerIdentityKind: options.owner.identityKind,
        startedAt: input.now,
        updatedAt: input.now,
      };
      const begun = options.coordinator.begin(record);
      if (begun.kind !== 'applied') return { kind: 'unavailable' };
      let invocationStarted = false;
      let invocationNow: string | undefined;
      let terminalIntent:
        | 'completed'
        | 'failed-before-invocation'
        | 'indeterminate'
        | undefined;
      let terminalNow: string | undefined;
      let terminalApplied = false;
      const terminal = (
        nextIntent: NonNullable<typeof terminalIntent>,
        from: NativeInvocationState[],
        to: Extract<
          NativeInvocationState,
          'running' | 'completed' | 'failed' | 'indeterminate'
        >,
        now: string,
        failureMessage?: string,
      ) => {
        if (terminalIntent && terminalIntent !== nextIntent)
          return { kind: 'stale' } as const;
        if (terminalApplied) return { kind: 'applied' } as const;
        terminalIntent = nextIntent;
        terminalNow ??= now;
        const result = transition(runId, from, to, terminalNow, failureMessage);
        if (result.kind === 'applied') terminalApplied = true;
        return result;
      };
      return {
        kind: 'owner',
        runId,
        claim: Object.freeze({
          beginInvocation: (now: string) =>
            invocationStarted
              ? ({ kind: 'applied' } as const)
              : (() => {
                  invocationNow ??= now;
                  const result = transition(
                    runId,
                    ['starting'],
                    'running',
                    invocationNow,
                  );
                  if (result.kind === 'applied') invocationStarted = true;
                  return result;
                })(),
          completed: (now: string) =>
            terminal('completed', ['running'], 'completed', now),
          failedBeforeInvocation: (now: string, failureMessage: string) =>
            terminal(
              'failed-before-invocation',
              ['starting'],
              'failed',
              now,
              failureMessage,
            ),
          indeterminate: (now: string, failureMessage: string) =>
            terminal(
              'indeterminate',
              ['starting', 'running'],
              'indeterminate',
              now,
              failureMessage,
            ),
        }),
      };
    },
    list() {
      try {
        return { kind: 'available', runs: options.coordinator.list() };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    read(runId) {
      try {
        return { kind: 'available', run: options.coordinator.read(runId) };
      } catch {
        return { kind: 'unavailable' };
      }
    },
    reconcile(now) {
      try {
        for (const record of options.coordinator.active()) {
          if (isOwnerLive(record, options.processIdentity)) continue;
          const state =
            record.state === 'starting' ? 'failed' : 'indeterminate';
          const result = options.coordinator.transition({
            runId: record.runId,
            ownerId: record.ownerId,
            from: [record.state],
            to: state,
            now,
            failureMessage:
              state === 'failed'
                ? 'The invocation ended before the provider call started.'
                : 'The provider call may have started before Station stopped.',
          });
          if (result.kind === 'unavailable') return { kind: 'unavailable' };
        }
        return { kind: 'available' };
      } catch {
        return { kind: 'unavailable' };
      }
    },
  };
}
