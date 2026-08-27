import { randomUUID } from 'node:crypto';
import type { RunSummary } from '@kontourai/station-contracts/runs';
import type {
  NativeInvocationOwner,
  NativeInvocationProcessIdentity,
} from './native-invocation-runs.js';

export type VoiceTurnTransition =
  | { kind: 'applied' }
  | { kind: 'stale' }
  | { kind: 'unavailable' };

type VoiceTurnState = 'running' | 'completed' | 'failed' | 'indeterminate';

export interface VoiceTurnRunsReader {
  list(): { kind: 'available'; runs: RunSummary[] } | { kind: 'unavailable' };
  read(
    runId: string,
  ): { kind: 'available'; run: RunSummary | null } | { kind: 'unavailable' };
}

export interface VoiceTurnHandle {
  readonly runId: string;
  readonly providerSessionId: string;
  readonly providerPromptId: string;
  readonly providerTurnId: string;
  complete(input: { now: string; stopReason: string }): VoiceTurnTransition;
  failed(input: { now: string; reason: string }): VoiceTurnTransition;
  indeterminate(input: { now: string; reason: string }): VoiceTurnTransition;
}

export interface VoiceTurnRuns extends VoiceTurnRunsReader {
  /**
   * Records an observed provider completion. This is intentionally post-effect:
   * the provider has already begun work when it emits completionStart.
   */
  observeStart(input: {
    voiceSessionId: string;
    providerSessionId: string;
    providerPromptId: string;
    providerTurnId: string;
    providerId: string;
    sourceId?: string;
    now: string;
  }):
    | { kind: 'started'; handle: VoiceTurnHandle }
    | { kind: 'duplicate' }
    | {
        kind: 'unavailable';
        /** Exact cleanup capability for a possibly persisted observed start. */
        indeterminate(input: {
          now: string;
          reason: string;
        }): VoiceTurnTransition;
      };
  /** Startup-only: a dead owner cannot resume an observed provider effect. */
  reconcile(now: string): { kind: 'available' } | { kind: 'unavailable' };
}

interface VoiceTurnRecord {
  runId: string;
  voiceSessionId: string;
  providerSessionId: string;
  providerTurnId: string;
  providerPromptId: string;
  providerId: string;
  sourceId?: string;
  ownerId: string;
  ownerPid: number;
  ownerBirth?: string;
  ownerIdentityKind: string;
  state: VoiceTurnState;
  startedAt: string;
  updatedAt: string;
}

interface Coordinator {
  observe(record: VoiceTurnRecord): 'started' | 'duplicate' | 'unavailable';
  transition(input: {
    runId: string;
    voiceSessionId: string;
    providerSessionId: string;
    providerPromptId: string;
    providerTurnId: string;
    ownerId?: string;
    from: VoiceTurnState[];
    to: 'completed' | 'failed' | 'indeterminate';
    now: string;
    failureMessage?: string;
  }): VoiceTurnTransition;
  active(): VoiceTurnRecord[];
  list(): RunSummary[];
  read(runId: string): RunSummary | null;
}

const activeOwners = new Set<string>();
const releasedOwners = new Set<string>();

export function releaseVoiceTurnOwner(ownerId: string): void {
  activeOwners.delete(ownerId);
  releasedOwners.add(ownerId);
}

function ownerIsLive(
  record: VoiceTurnRecord,
  processIdentity: NativeInvocationProcessIdentity,
): boolean {
  if (releasedOwners.has(record.ownerId)) return false;
  if (record.ownerPid === process.pid && activeOwners.has(record.ownerId)) {
    return true;
  }
  const observed = processIdentity.probe(record.ownerPid);
  if (observed.state === 'dead') return false;
  // An unavailable liveness probe must not let another owner classify a live
  // provider effect. Startup remains conservatively running in that case.
  if (observed.state === 'unavailable') return true;
  return (
    record.ownerIdentityKind !== 'exact' ||
    !record.ownerBirth ||
    observed.identity.start === record.ownerBirth
  );
}

/**
 * Private EventStore-composed authority for provider-issued voice turns. It
 * owns exact provider/session correlation and canonical run projection; it is
 * not a public voice or plugin ledger.
 */
export function createVoiceTurnRuns(options: {
  coordinator: Coordinator;
  owner: NativeInvocationOwner;
  processIdentity: NativeInvocationProcessIdentity;
}): VoiceTurnRuns {
  activeOwners.add(options.owner.id);

  const handleFor = (input: {
    runId: string;
    voiceSessionId: string;
    providerSessionId: string;
    providerPromptId: string;
    providerTurnId: string;
  }): VoiceTurnHandle => {
    let intent: 'completed' | 'failed' | 'indeterminate' | undefined;
    let intentNow: string | undefined;
    let intentReason: string | undefined;
    let settled = false;
    const settle = (
      next: NonNullable<typeof intent>,
      now: string,
      reason?: string,
    ): VoiceTurnTransition => {
      if (intent && intent !== next) return { kind: 'stale' };
      if (settled) return { kind: 'applied' };
      if (!intent) {
        intent = next;
        intentNow = now;
        intentReason = reason;
      } else if (intentNow !== now || intentReason !== reason) {
        return { kind: 'stale' };
      }
      const result = options.coordinator.transition({
        runId: input.runId,
        voiceSessionId: input.voiceSessionId,
        providerSessionId: input.providerSessionId,
        providerPromptId: input.providerPromptId,
        providerTurnId: input.providerTurnId,
        ownerId: options.owner.id,
        from: ['running'],
        to: next,
        now: intentNow!,
        ...(intentReason ? { failureMessage: intentReason } : {}),
      });
      if (result.kind === 'applied') settled = true;
      return result;
    };
    return Object.freeze({
      runId: input.runId,
      providerSessionId: input.providerSessionId,
      providerPromptId: input.providerPromptId,
      providerTurnId: input.providerTurnId,
      complete: ({ now, stopReason }: { now: string; stopReason: string }) =>
        stopReason === 'END_TURN'
          ? settle('completed', now)
          : settle(
              'indeterminate',
              now,
              `The provider ended the voice completion with ${stopReason}.`,
            ),
      indeterminate: ({ now, reason }: { now: string; reason: string }) =>
        settle('indeterminate', now, reason),
      failed: ({ now, reason }: { now: string; reason: string }) =>
        settle('failed', now, reason),
    });
  };

  const runs: VoiceTurnRuns = {
    observeStart(input) {
      const record: VoiceTurnRecord = {
        runId: `voice:${randomUUID()}`,
        voiceSessionId: input.voiceSessionId,
        providerSessionId: input.providerSessionId,
        providerTurnId: input.providerTurnId,
        providerPromptId: input.providerPromptId,
        providerId: input.providerId,
        ...(input.sourceId ? { sourceId: input.sourceId } : {}),
        ownerId: options.owner.id,
        ownerPid: options.owner.pid,
        ...(options.owner.identityKind === 'exact'
          ? { ownerBirth: options.owner.birth }
          : {}),
        ownerIdentityKind: options.owner.identityKind,
        state: 'running',
        startedAt: input.now,
        updatedAt: input.now,
      };
      const observed = options.coordinator.observe(record);
      const handle = handleFor({
        runId: record.runId,
        voiceSessionId: record.voiceSessionId,
        providerSessionId: record.providerSessionId,
        providerPromptId: record.providerPromptId,
        providerTurnId: record.providerTurnId,
      });
      if (observed === 'unavailable') {
        return {
          kind: 'unavailable',
          indeterminate: handle.indeterminate,
        };
      }
      if (observed === 'duplicate') return { kind: 'duplicate' };
      return { kind: 'started', handle };
    },
    reconcile(now) {
      try {
        let unavailable = false;
        for (const record of options.coordinator.active()) {
          if (ownerIsLive(record, options.processIdentity)) continue;
          const outcome = options.coordinator.transition({
            runId: record.runId,
            voiceSessionId: record.voiceSessionId,
            providerSessionId: record.providerSessionId,
            providerPromptId: record.providerPromptId,
            providerTurnId: record.providerTurnId,
            ownerId: record.ownerId,
            from: ['running'],
            to: 'indeterminate',
            now,
            failureMessage:
              'The voice provider completion may have continued before Station stopped.',
          });
          if (outcome.kind === 'unavailable') unavailable = true;
        }
        return unavailable ? { kind: 'unavailable' } : { kind: 'available' };
      } catch {
        return { kind: 'unavailable' };
      }
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
  };
  return Object.freeze(runs);
}
