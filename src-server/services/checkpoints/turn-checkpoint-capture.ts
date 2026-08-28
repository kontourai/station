import { resolve } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import { isSafeCheckpointRefSegment } from '@kontourai/station-shared/checkpoints';
import { expandTilde } from '../../utils/paths.js';
import { isDeferredRetriableTurnError } from '../orchestration/session-lifecycle-service.js';
import type {
  TurnCheckpointPhase,
  TurnCheckpointRecord,
  TurnCheckpointWrite,
  TurnPhaseCheckpoint,
} from './checkpoint-index-store.js';
import type { CheckpointCaptureResult } from './checkpoint-ref-store.js';

interface CaptureCapableRefStore {
  capture(input: {
    repoDir: string;
    threadId: string;
    checkpointId: string;
    kind: string;
    turnId: string;
  }): Promise<CheckpointCaptureResult>;
}

interface CaptureIndexStore {
  readTurn(threadId: string, turnId: string): TurnCheckpointRecord | undefined;
  recordTurnPhase(
    threadId: string,
    turnId: string,
    resolve: (current: TurnCheckpointRecord | undefined) => TurnCheckpointWrite,
  ): void;
}

export interface TurnCheckpointCaptureOutcome {
  threadId: string;
  turnId: string;
  phase: TurnCheckpointPhase;
  outcome: 'captured' | 'not_applicable' | 'skipped' | 'failed' | 'duplicate';
}

export interface TurnCheckpointCaptureCoordinatorDeps {
  refStore: CaptureCapableRefStore;
  indexStore: CaptureIndexStore;
  resolveWorkingDirectory: (threadId: string) => string | undefined;
  logger: {
    debug(message: string, meta?: Record<string, unknown>): void;
    warn(message: string, meta?: Record<string, unknown>): void;
  };
  newCheckpointId?: () => string;
  onOutcome?: (outcome: TurnCheckpointCaptureOutcome) => void;
  runMutationExclusive?: <T>(operation: () => Promise<T>) => Promise<T>;
  retention?: { sweepThread(threadId: string): Promise<unknown> };
}

function withPhase(
  phase: TurnCheckpointPhase,
  value: TurnPhaseCheckpoint,
): TurnCheckpointWrite {
  return phase === 'baseline' ? { baseline: value } : { settle: value };
}

/**
 * Captures workspace checkpoints at turn boundaries (archive#2802).
 *
 * The coordinator's single non-negotiable contract: `captureForTurn` NEVER
 * rejects and NEVER delays anything the user's turn waits on. Every failure
 * — a throwing ref store, an unresolvable working directory, a degraded
 * repository state — is folded into a durable, typed record in the index
 * ("no checkpoint for this turn, and here is why") so the checkpoint layer
 * can fail without the turn noticing. Captures for one thread are chained
 * on a per-thread promise tail, so a slow settle capture for turn N cannot
 * interleave with the baseline capture of turn N+1 in the same thread.
 *
 * The tail is UNCONDITIONAL (`(this.tails.get(id) ?? resolved).then(...)`):
 * `captureForTurn` must return before ANY capture work — including the
 * synchronous index reads/writes at the top of `captureOnce` — runs. The
 * listener is invoked inline inside a turn's event emit on the EventBus, so
 * a first-capture-for-a-thread that ran `captureOnce` synchronously would
 * put whole-file JSON I/O inside the emit itself (H2: measured at up to
 * hundreds of milliseconds at the index's documented bounds), blocking SSE
 * fan-out and the adapter's next stream event.
 */
export class TurnCheckpointCaptureCoordinator {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(private readonly deps: TurnCheckpointCaptureCoordinatorDeps) {}

  captureForTurn(
    threadId: string,
    turnId: string,
    phase: TurnCheckpointPhase,
  ): Promise<void> {
    // Always `.then(...)`, never `?? captureOnce(...)`: the first capture for
    // a thread must not START inside this call.
    const run = (this.tails.get(threadId) ?? Promise.resolve()).then(
      async () => {
        const capture = () => this.captureOnce(threadId, turnId, phase);
        if (this.deps.runMutationExclusive) {
          await this.deps.runMutationExclusive(capture);
        } else {
          await capture();
        }
        if (phase === 'settle') {
          try {
            await this.deps.retention?.sweepThread(threadId);
          } catch (error) {
            this.deps.logger.warn('turn-checkpoint: retention sweep failed', {
              threadId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      },
    );
    // The stored/returned tail swallows every rejection: captureOnce folds
    // failures into index records, but it can itself throw (e.g. the index
    // write hitting ENOSPC — M4), and a rejected tail would poison every
    // later capture for the thread AND reject into the EventBus listener's
    // `void` call as an unhandled rejection. Returning `tail` (not `run`)
    // makes "never rejects" hold for the throwing-index path too.
    const tail = run.catch(() => {});
    this.tails.set(threadId, tail);
    void tail.finally(() => {
      if (this.tails.get(threadId) === tail) this.tails.delete(threadId);
    });
    return tail;
  }

  private async captureOnce(
    threadId: string,
    turnId: string,
    phase: TurnCheckpointPhase,
  ): Promise<void> {
    const existing = this.safeReadTurn(threadId, turnId);
    if (existing?.[phase]) {
      // The boundary was already observed for this turn (a replayed or
      // recovered terminal event). The first observation stands; capturing
      // again would mint a second checkpoint for one boundary.
      this.recordOutcome({ threadId, turnId, phase, outcome: 'duplicate' });
      return;
    }

    if (!isSafeCheckpointRefSegment(threadId)) {
      this.safeRecord(threadId, turnId, phase, () =>
        withPhase(phase, {
          status: 'skipped',
          reason: 'invalid_thread_ref_segment',
          recordedAt: nowIso(),
        }),
      );
      this.recordOutcome({ threadId, turnId, phase, outcome: 'skipped' });
      return;
    }

    let repoDir: string | undefined;
    try {
      repoDir = this.deps.resolveWorkingDirectory(threadId);
    } catch (error) {
      this.deps.logger.warn(
        'turn-checkpoint: working directory resolver threw',
        {
          threadId,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
    if (!repoDir) {
      // A session with no resolvable project working directory is not an
      // error to record loudly — it is the expected shape of every unbound
      // chat, and the record keeps it distinguishable from a capture that
      // ran and found nothing.
      this.safeRecord(threadId, turnId, phase, () =>
        withPhase(phase, {
          status: 'not_applicable',
          reason: 'no_project_working_directory',
          recordedAt: nowIso(),
        }),
      );
      this.recordOutcome({
        threadId,
        turnId,
        phase,
        outcome: 'not_applicable',
      });
      return;
    }

    try {
      const result = await this.deps.refStore.capture({
        repoDir,
        threadId,
        checkpointId: this.nextCheckpointId(),
        kind: phase,
        turnId,
      });
      if (result.status === 'captured') {
        this.safeRecord(threadId, turnId, phase, () =>
          withPhase(phase, {
            status: 'captured',
            checkpointId: result.checkpoint.checkpointId,
            commitSha: result.checkpoint.commitSha,
            treeSha: result.checkpoint.treeSha,
            repoRoot: result.checkpoint.repoRoot,
            capturedAt: result.checkpoint.capturedAt,
          }),
        );
        this.recordOutcome({ threadId, turnId, phase, outcome: 'captured' });
      } else {
        this.safeRecord(threadId, turnId, phase, () =>
          withPhase(phase, {
            status: 'skipped',
            reason: result.reason,
            ...(result.detail ? { detail: result.detail } : {}),
            recordedAt: nowIso(),
          }),
        );
        this.recordOutcome({ threadId, turnId, phase, outcome: 'skipped' });
      }
    } catch (error) {
      // The ref store returns typed degradations rather than throwing, so
      // reaching here means the checkpoint layer itself is broken. Record
      // it and return: the turn this boundary belongs to must never see
      // this failure.
      this.deps.logger.warn('turn-checkpoint: capture threw', {
        threadId,
        turnId,
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
      // safeRecord, not a bare recordTurnPhase: this is the last line of
      // defence, and if the index write ALSO throws here (full disk,
      // EACCES) the throw would escape captureOnce — the zero-record
      // wedge M4 closes.
      this.safeRecord(threadId, turnId, phase, () =>
        withPhase(phase, {
          status: 'failed',
          error: error instanceof Error ? error.message : String(error),
          recordedAt: nowIso(),
        }),
      );
      this.recordOutcome({ threadId, turnId, phase, outcome: 'failed' });
    }
  }

  /**
   * recordTurnPhase can itself throw (ENOSPC/EACCES/EROFS on the index
   * write). A throw from any capture path must never escape as a rejected
   * capture and never wedge the thread's tail: log it and move on. The
   * durable record is best-effort by design — the refs (which carry the
   * turnId, see the ref store) remain the truth.
   */
  private safeRecord(
    threadId: string,
    turnId: string,
    phase: TurnCheckpointPhase,
    resolve: (current: TurnCheckpointRecord | undefined) => TurnCheckpointWrite,
  ): void {
    try {
      this.deps.indexStore.recordTurnPhase(threadId, turnId, resolve);
    } catch (error) {
      this.deps.logger.warn('turn-checkpoint: index record write threw', {
        threadId,
        turnId,
        phase,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private safeReadTurn(
    threadId: string,
    turnId: string,
  ): TurnCheckpointRecord | undefined {
    try {
      return this.deps.indexStore.readTurn(threadId, turnId);
    } catch {
      return undefined;
    }
  }

  private nextCheckpointId(): string {
    if (this.deps.newCheckpointId) return this.deps.newCheckpointId();
    return crypto.randomUUID();
  }

  private recordOutcome(outcome: TurnCheckpointCaptureOutcome): void {
    try {
      this.deps.onOutcome?.(outcome);
    } catch {
      // Telemetry must never fail a capture.
    }
  }
}

function nowIso(): string {
  return new Date().toISOString();
}

type OrchestrationEventMessage = {
  event: string;
  data?: Record<string, unknown>;
};

/**
 * Subscribe the coordinator to turn boundaries on the orchestration event
 * bus: `turn.started` captures the baseline, `turn.completed` /
 * `turn.aborted` capture the settle snapshot. A `turn.started` carrying
 * `inputKind: 'steer'` is input appended INSIDE an already-running turn,
 * not a new boundary — the baseline of the turn that is still running
 * stands. Every capture is dispatched fire-and-forget: the listener returns
 * synchronously (the bus carries it inside a turn's event stream), and all
 * git work happens on the coordinator's per-thread tail. The listener never
 * throws, matching the EventBus's keep-the-subscription contract.
 */
export function wireTurnCheckpointCapture(
  eventBus: {
    subscribe(
      listener: (message: OrchestrationEventMessage) => void,
    ): () => void;
  },
  coordinator: TurnCheckpointCaptureCoordinator,
  logger: { warn(message: string, meta?: Record<string, unknown>): void },
): () => void {
  return eventBus.subscribe((message) => {
    try {
      if (message.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
      const event = message.data?.event as CanonicalRuntimeEvent | undefined;
      if (!event || typeof event.threadId !== 'string' || !event.threadId)
        return;
      if (typeof event.turnId !== 'string' || !event.turnId) return;
      if (event.method === 'turn.started' && event.inputKind !== 'steer') {
        void coordinator.captureForTurn(
          event.threadId,
          event.turnId,
          'baseline',
        );
      } else if (
        event.method === 'turn.completed' ||
        event.method === 'turn.aborted' ||
        // archive#3451 finding 5: a turn that ends only in `runtime.error`
        // (a codex/adapter failure — archive#3442/#3473) never reached this arm, so
        // its baseline checkpoint was captured on `turn.started` but no
        // settle snapshot ever followed. Deferred codex retriable errors are
        // excluded — the turn has not actually ended yet.
        (event.method === 'runtime.error' &&
          !isDeferredRetriableTurnError(event))
      ) {
        void coordinator.captureForTurn(event.threadId, event.turnId, 'settle');
      }
    } catch (error) {
      logger.warn('turn-checkpoint: listener failed to dispatch capture', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

/**
 * The single wiring gate for workspace checkpoint capture (archive#2802
 * fix round, H3): capture writes into the USER'S repository's object
 * database — pinned against `git gc` by reflogs — at two boundaries per
 * turn, so it must never silently turn itself on. `AppConfig.
 * workspaceCheckpoints` defaults to OFF (absent/undefined/false all mean
 * off, matching the `knowledgeStores` pattern); when off, NO event-bus
 * subscription is registered at all and the feature is inert: no git
 * calls, no index writes, no `.git` growth.
 *
 * Read once at boot wiring time (the `knowledgeStores` precedent): a config
 * flip applies on the next Station start, not mid-session — rewiring an
 * EventBus subscription live would add lifecycle complexity this slice
 * does not need while the flag is off everywhere by default.
 *
 * Returns the unsubscribe function either way so callers need not branch.
 */
export function wireTurnCheckpointCaptureWhenEnabled(
  appConfig: { workspaceCheckpoints?: boolean } | undefined,
  deps: {
    eventBus: Parameters<typeof wireTurnCheckpointCapture>[0];
    coordinator: TurnCheckpointCaptureCoordinator;
    logger: { warn(message: string, meta?: Record<string, unknown>): void };
  },
): () => void {
  if (appConfig?.workspaceCheckpoints !== true) return () => {};
  return wireTurnCheckpointCapture(
    deps.eventBus,
    deps.coordinator,
    deps.logger,
  );
}

/**
 * Compose the production working-directory resolver: thread -> session's
 * project binding (same read `resolveSessionProjectSlug` already provides
 * for the approval inbox) -> that project's stored `workingDirectory`,
 * tilde-expanded and resolved. Returns undefined for unbound chats and
 * projects without a directory — the coordinator records those as
 * not_applicable. Never throws.
 */
export function createThreadWorkingDirectoryResolver(
  orchestrationService: {
    resolveSessionProjectSlug(threadId: string): string | undefined;
  },
  listProjects: () => Array<{ slug: string; workingDirectory?: string }>,
): (threadId: string) => string | undefined {
  return (threadId) => {
    try {
      const slug = orchestrationService.resolveSessionProjectSlug(threadId);
      if (!slug) return undefined;
      const project = listProjects().find((entry) => entry.slug === slug);
      if (!project?.workingDirectory) return undefined;
      return resolve(expandTilde(project.workingDirectory));
    } catch {
      return undefined;
    }
  };
}
