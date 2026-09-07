import type { ProjectTaskRoomGrant } from '@kontourai/station-contracts/project-task-room';
import {
  type PlannedHomeTransfer,
  type PlannedHomeTransferIntent,
  type PlannedHomeTransferStore,
  plannedHomeTransferClosureDigest,
  type TransferStoreResult,
} from './planned-home-transfer-store.js';
import type { ProjectTaskRoomHistory } from './project-task-room-history.js';
import type { ProjectTaskRoomSourceSeal } from './project-task-room-source-seal.js';

const NO_EXECUTION_AUTHORITY = {
  executionAuthorityTransferred: false,
  executionResumeAvailable: false,
} as const;

export interface PlannedHomeTransferCoordinatorOptions {
  readonly store: PlannedHomeTransferStore;
  /** Trusted controller namespace supplied by the composing authority. */
  readonly tenantId: string;
  readonly source: PlannedHomeTransferSourceOwner;
  readonly target: PlannedHomeTransferTargetOwner;
}

export interface PlannedHomeTransferSourceOwner {
  /** Stable private identity used only to reject one owner in both roles. */
  readonly ownerIdentity: object;
  ensureClosed(intent: Readonly<PlannedHomeTransferIntent>): Promise<
    | { kind: 'sealed'; seal: ProjectTaskRoomSourceSeal }
    | {
        kind:
          | 'unsealed'
          | 'denied'
          | 'unavailable'
          | 'conflict'
          | 'publication-pending'
          | 'execution-pending';
      }
  >;
}

export interface PlannedHomeTransferTargetOwner {
  /** Stable private identity used only to reject one owner in both roles. */
  readonly ownerIdentity: object;
  readSeal(
    intent: Readonly<PlannedHomeTransferIntent>,
  ): Promise<
    | { kind: 'sealed'; seal: ProjectTaskRoomSourceSeal }
    | { kind: 'unsealed' | 'denied' | 'unavailable' | 'conflict' }
  >;
}

export interface LocalProjectTaskRoomTransferOwnersInput {
  readonly source: {
    readonly history: Pick<ProjectTaskRoomHistory, 'sealSource'>;
    readonly grant: ProjectTaskRoomGrant<'home-transfer'>;
  };
  readonly target: {
    readonly history: Pick<ProjectTaskRoomHistory, 'readSourceSeal'>;
    readonly grant: ProjectTaskRoomGrant<'history-read'>;
  };
}

export interface PlannedHomeTransferOwners {
  readonly source: PlannedHomeTransferSourceOwner;
  readonly target: PlannedHomeTransferTargetOwner;
}

/** Bind real local room histories to the intent-shaped transfer owner ports. */
export function createLocalProjectTaskRoomTransferOwners(
  owners: LocalProjectTaskRoomTransferOwnersInput,
): PlannedHomeTransferOwners {
  const sourceHistory = owners.source.history;
  const targetHistory = owners.target.history;
  const sealSource = sourceHistory.sealSource.bind(sourceHistory);
  const readSourceSeal = targetHistory.readSourceSeal.bind(targetHistory);
  const sourceGrant = Object.freeze(structuredClone(owners.source.grant));
  const targetGrant = Object.freeze(structuredClone(owners.target.grant));
  return Object.freeze({
    source: Object.freeze({
      ownerIdentity: sourceHistory as object,
      ensureClosed: (intent: Readonly<PlannedHomeTransferIntent>) =>
        sealSource({
          grant: sourceGrant,
          operationId: intent.operationId,
          sourceHomeRef: intent.sourceHomeRef,
          targetHomeRef: intent.targetHomeRef,
        }),
    }),
    target: Object.freeze({
      ownerIdentity: targetHistory as object,
      readSeal: (_intent: Readonly<PlannedHomeTransferIntent>) =>
        readSourceSeal({ grant: targetGrant }),
    }),
  });
}

export type PlannedHomeTransferCoordinatorResult =
  | (typeof NO_EXECUTION_AUTHORITY & {
      readonly kind: 'decision-committed';
      readonly decision: PlannedHomeTransfer;
    })
  | (typeof NO_EXECUTION_AUTHORITY & {
      readonly kind: 'pending';
      readonly reason:
        | 'publication-pending'
        | 'execution-pending'
        | 'source-not-closed'
        | 'target-unavailable'
        | 'admission-pending';
      readonly decision: PlannedHomeTransfer;
    })
  | (typeof NO_EXECUTION_AUTHORITY & {
      readonly kind: 'denied' | 'unavailable' | 'conflict' | 'not-found';
    });

export interface PlannedHomeTransferCoordinator {
  advance(operationId: string): Promise<PlannedHomeTransferCoordinatorResult>;
}

function blocked(
  kind: 'denied' | 'unavailable' | 'conflict' | 'not-found',
): PlannedHomeTransferCoordinatorResult {
  return { kind, ...NO_EXECUTION_AUTHORITY };
}

function committedOutcome(
  decision: PlannedHomeTransfer,
): PlannedHomeTransferCoordinatorResult {
  return {
    kind: 'decision-committed',
    decision: structuredClone(decision),
    ...NO_EXECUTION_AUTHORITY,
  };
}

function storedDecision(
  result: TransferStoreResult<PlannedHomeTransfer>,
): PlannedHomeTransfer | PlannedHomeTransferCoordinatorResult {
  return result.kind === 'stored' ? result.value : blocked(result.kind);
}

function isBlocked(
  value: PlannedHomeTransfer | PlannedHomeTransferCoordinatorResult,
): value is PlannedHomeTransferCoordinatorResult {
  return 'kind' in value;
}

/**
 * Server-private durable transfer driver. The composing service owns caller
 * authentication and a caller-bound store; this driver never grants execution
 * authority, copies a home, unseals a source, or launches target work.
 */
export function createPlannedHomeTransferCoordinator(
  options: PlannedHomeTransferCoordinatorOptions,
): PlannedHomeTransferCoordinator {
  const tenantId = options.tenantId;
  const sameOwner =
    options.source.ownerIdentity === options.target.ownerIdentity;
  const resolve = options.store.resolve.bind(options.store);
  const recordClosure = options.store.recordClosure.bind(options.store);
  const recordReady = options.store.recordReady.bind(options.store);
  const commit = options.store.commit.bind(options.store);
  const ensureSourceClosed = options.source.ensureClosed.bind(options.source);
  const readTargetSeal = options.target.readSeal.bind(options.target);

  return {
    async advance(operationId) {
      if (sameOwner) return blocked('conflict');
      try {
        const resolved = storedDecision(await resolve(tenantId, operationId));
        if (isBlocked(resolved)) return resolved;
        let decision = structuredClone(resolved);
        const intent = Object.freeze(structuredClone(decision.intent));

        if (decision.phase === 'committed') {
          return committedOutcome(decision);
        }

        if (decision.phase === 'prepared') {
          const sealed = await ensureSourceClosed(intent);
          if (
            sealed.kind === 'publication-pending' ||
            sealed.kind === 'execution-pending'
          ) {
            return {
              kind: 'pending',
              reason: sealed.kind,
              decision,
              ...NO_EXECUTION_AUTHORITY,
            };
          }
          if (sealed.kind === 'unsealed') {
            return {
              kind: 'pending',
              reason: 'source-not-closed',
              decision,
              ...NO_EXECUTION_AUTHORITY,
            };
          }
          if (sealed.kind !== 'sealed') return blocked(sealed.kind);
          const recorded = storedDecision(
            await recordClosure(tenantId, intent.operationId, sealed.seal),
          );
          if (isBlocked(recorded)) return recorded;
          decision = structuredClone(recorded);
        }

        if (
          decision.phase === 'source-closed' ||
          decision.phase === 'target-ready'
        ) {
          const persistedOperationId = intent.operationId;
          const restored = await readTargetSeal(intent);
          if (restored.kind === 'unsealed' || restored.kind === 'unavailable') {
            return {
              kind: 'pending',
              reason: 'target-unavailable',
              decision,
              ...NO_EXECUTION_AUTHORITY,
            };
          }
          if (restored.kind !== 'sealed') return blocked(restored.kind);
          if (
            restored.seal.operationId !== intent.operationId ||
            restored.seal.sourceHomeRef !== intent.sourceHomeRef ||
            restored.seal.targetHomeRef !== intent.targetHomeRef ||
            plannedHomeTransferClosureDigest(restored.seal) !==
              decision.closureDigest
          ) {
            return blocked('conflict');
          }
          if (decision.phase === 'source-closed') {
            const ready = storedDecision(
              await recordReady(
                tenantId,
                persistedOperationId,
                intent.targetHomeRef,
                decision.closureDigest,
              ),
            );
            if (isBlocked(ready)) return ready;
            decision = structuredClone(ready);
          }
        }

        // Another driver may have committed between our checkpoint verification
        // and an idempotent closure/readiness acknowledgement.
        if (decision.phase === 'committed') return committedOutcome(decision);
        if (decision.phase !== 'target-ready') return blocked('conflict');
        const commitResult = await commit(tenantId, intent.operationId);
        if (commitResult.kind === 'admission-pending')
          return {
            ...NO_EXECUTION_AUTHORITY,
            kind: 'pending',
            reason: 'admission-pending',
            decision,
          };
        const committed = storedDecision(commitResult);
        if (isBlocked(committed)) return committed;
        if (committed.phase !== 'committed') return blocked('conflict');
        return committedOutcome(committed);
      } catch {
        return blocked('unavailable');
      }
    },
  };
}
