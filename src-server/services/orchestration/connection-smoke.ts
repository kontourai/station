import crypto from 'node:crypto';
import type { ProviderKind } from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { ProviderAdapterShape } from '../../providers/adapter-shape.js';
import { raceWithSignal, throwIfAborted } from '../../utils/bounded-async.js';
import type {
  ConnectionSmokeRunInput,
  ConnectionSmokeRunResult,
} from '../connections/connection-service.js';
// Type-only import back into the service module: erased at runtime, so no
// import cycle exists.
import type { OrchestrationService } from './orchestration-service.js';

function redactSmokeFailure(value: unknown): string {
  return String(value)
    .replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(
      /(api[_-]?key|token|secret|password)(["'=:\s]+)\S+/gi,
      '$1$2[redacted]',
    )
    .slice(0, 500);
}

export interface ConnectionSmokeDeps {
  /**
   * The service's PUBLIC dispatch — carries the initialize() latch (T9)
   * and is the only entry accepting the third `internal` argument the
   * smoke's systemPrompt / credential-profile selection requires.
   */
  dispatch: OrchestrationService['dispatch'];
  /**
   * Poll read of the ephemeral thread's canonical payloads. Absorbs the
   * optional event store at the ctor seam so this module never sees it.
   */
  listEventPayloads: (threadId: string) => CanonicalRuntimeEvent[];
  /** The SERVICE forwarder, never `transcriptReads` — keeps the T9 latch. */
  readSessionMessages: OrchestrationService['readSessionMessages'];
  /**
   * C1 stays on the service. Called, not captured: reads the LIVE
   * `options.adapterStopTimeoutMs` at each invocation.
   */
  adapterStopTimeoutMs: () => number;
  /**
   * C1's two deadline wrappers. `deadlineAt` is REQUIRED here (it is
   * optional on the service) so the shared cleanup grace cannot be
   * dropped by omission inside this module.
   */
  runCleanupWithinDeadline: (
    cleanup: () => Promise<void>,
    label: string,
    deadlineAt: number,
  ) => Promise<void>;
  runOperationWithinDeadline: (
    operation: Promise<void>,
    label: string,
    deadlineAt: number,
  ) => Promise<void>;
  adapterFor: (provider: ProviderKind) => ProviderAdapterShape | undefined;
  /** C7's ONE raw read, as a named boolean — never a Map handle (T13). */
  hasThreadProvider: (threadId: string) => boolean;
  /** Deliberately NEVER rescinded on the smoke path — see the class docblock. */
  armInternalStop: (threadId: string) => void;
  deleteThread: (threadId: string) => void;
  invalidateSessionOwner: (threadId: string) => void;
}

/**
 * Connection smoke — one explicit, bounded, no-tools chat turn plus the
 * erasure of its ephemeral orchestration session (epic #4024 slice 9,
 * #4195; C17 in docs/design/orchestration-decomposition-map.md §II.3).
 * Owns NO state: eleven named deps and nothing else, which is why this
 * cluster was cuttable on the strength of the existing seams alone.
 *
 * DELIBERATE: this path arms internal-stop suppression at two sites and
 * never rescinds it. Only the first site (the started-session cleanup) is
 * live-reachable with an open turn today: a durable `turn.started` can only
 * exist via `publishCanonicalEvent`, which sets `threadProviders` first, so
 * the adapter-owns branch's arm is a defensive change-detector under the
 * current service invariant (its guard fixture pins the call, not a
 * behavior the invariant permits). `InternalStopSuppression.arm` returns the open turn id;
 * both call sites discard it on purpose (station#3525) — a smoke turn is
 * never a user conversation, so its own diagnostic timeout ending it must
 * not surface as "your agent needs attention." Suppression is consumed
 * downstream by turn-completion-notifications; the un-consumed case is
 * bounded by `arm`'s own leak-prevention timer, not by a rescind here.
 * Contrast the credential-restart path, which binds and rescinds.
 *
 * The `initialize()` latch stays on the service forwarder (T9). Two deps
 * carry latches of their own (`dispatch`, `readSessionMessages`); do not
 * re-point either at a lower-level collaborator.
 *
 * Emits NO metrics (T12) and holds no map handle (T13): C7's single read
 * arrives as the `hasThreadProvider` boolean.
 */
export class ConnectionSmoke {
  constructor(private readonly deps: ConnectionSmokeDeps) {}

  /**
   * Run one explicit, bounded, no-tools chat turn and then erase its ephemeral
   * orchestration session. This is never called by inventory/menu reads.
   */
  async runConnectionSmoke(
    input: ConnectionSmokeRunInput,
  ): Promise<ConnectionSmokeRunResult> {
    const startedAt = Date.now();
    const timeoutError = new Error(
      `The one-turn smoke did not complete within ${input.timeoutMs}ms.`,
    );
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(timeoutError),
      input.timeoutMs,
    );
    const threadId = `station-smoke-${input.provider}-${crypto.randomUUID()}`;
    let sessionStarted = false;
    let turnStarted = false;
    let startOperationSettled = false;
    const startOperation = this.deps
      .dispatch(
        {
          type: 'startSession',
          input: {
            threadId,
            provider: input.provider,
            ...(input.modelId ? { modelId: input.modelId } : {}),
            cwd: input.cwd,
            modelOptions: {
              systemPrompt:
                'This is a one-turn connectivity smoke. Do not use tools. Reply with exactly STATION_SMOKE_OK.',
            },
            metadata: {
              ...input.metadata,
              stationSmoke: true,
              connectionId: input.connectionId,
            },
            ...(input.credentialProfileRef
              ? { credentialProfileRef: input.credentialProfileRef }
              : {}),
            signal: controller.signal,
          },
        },
        undefined,
        // station#978 review r1: this internal connectivity probe is the one
        // legitimate `systemPrompt` sender — see `unsupportedModelOptionKeys`'s
        // docblock (contracts `provider.ts`) for why that key is otherwise
        // rejected unconditionally now, for every provider and every other
        // caller.
        {
          skipModelOptionSupportCheck: true,
          credentialProfileApplication: true,
        },
      )
      .finally(() => {
        startOperationSettled = true;
      });
    const result = await (async (): Promise<ConnectionSmokeRunResult> => {
      try {
        await raceWithSignal(startOperation, controller.signal);
        sessionStarted = true;
        const turn = await raceWithSignal(
          this.deps.dispatch({
            type: 'sendTurn',
            input: {
              threadId,
              input:
                'Reply with exactly STATION_SMOKE_OK. Do not call tools or modify anything.',
              ...(input.modelId ? { modelId: input.modelId } : {}),
              signal: controller.signal,
            },
          }),
          controller.signal,
        );
        if (!turn || !('turnId' in turn)) {
          return {
            ok: false,
            durationMs: Date.now() - startedAt,
            reasonCode: 'turn-failed',
            reason: 'The runtime did not acknowledge the smoke turn.',
            action: 'Check the runtime logs and try the explicit smoke again.',
            ...(input.modelId ? { model: input.modelId } : {}),
          };
        }
        turnStarted = true;
        const deadline = startedAt + input.timeoutMs;
        while (Date.now() < deadline) {
          throwIfAborted(controller.signal);
          const events = this.deps.listEventPayloads(threadId);
          const runtimeError = events.find(
            (event) => event.method === 'runtime.error',
          );
          if (runtimeError?.method === 'runtime.error') {
            return {
              ok: false,
              durationMs: Date.now() - startedAt,
              reasonCode: 'turn-failed',
              reason: redactSmokeFailure(runtimeError.message),
              action:
                'Resolve the runtime or authentication error, then run the explicit smoke again.',
              ...(input.modelId ? { model: input.modelId } : {}),
            };
          }
          const aborted = events.find(
            (event) =>
              event.method === 'turn.aborted' && event.turnId === turn.turnId,
          );
          if (aborted?.method === 'turn.aborted') {
            return {
              ok: false,
              durationMs: Date.now() - startedAt,
              reasonCode: 'cancelled',
              reason: `The smoke turn was cancelled: ${redactSmokeFailure(
                aborted.reason,
              )}`,
              action:
                'Wait for the runtime to become idle and run the smoke again.',
              ...(input.modelId ? { model: input.modelId } : {}),
            };
          }
          const completed = events.find(
            (event) =>
              event.method === 'turn.completed' && event.turnId === turn.turnId,
          );
          if (completed?.method === 'turn.completed') {
            const projectedOutput = this.deps
              .readSessionMessages(threadId, INTERNAL_SESSION_READ_SCOPE)
              .filter((message) => message.role === 'assistant')
              .flatMap((message) => message.parts)
              .filter((part) => part.type === 'text')
              .map((part) => part.text ?? '')
              .join('')
              .trim();
            if (!projectedOutput) {
              return {
                ok: false,
                durationMs: Date.now() - startedAt,
                reasonCode: 'empty-response',
                reason:
                  'The smoke turn completed without an assistant response.',
                action:
                  'Check the selected model and runtime logs, then run the smoke again.',
                ...(input.modelId ? { model: input.modelId } : {}),
              };
            }
            if (projectedOutput !== 'STATION_SMOKE_OK') {
              return {
                ok: false,
                durationMs: Date.now() - startedAt,
                reasonCode: 'unexpected-response',
                reason:
                  'The assistant response did not exactly match the required smoke confirmation.',
                action:
                  'Check the selected model or runtime instructions, then run the explicit smoke again.',
                ...(input.modelId ? { model: input.modelId } : {}),
              };
            }
            return {
              ok: true,
              durationMs: Date.now() - startedAt,
              ...(input.modelId ? { model: input.modelId } : {}),
            };
          }
          await raceWithSignal(
            new Promise((resolve) => setTimeout(resolve, 100)),
            controller.signal,
          );
        }
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          reasonCode: 'timeout',
          reason: `The one-turn smoke did not complete within ${input.timeoutMs}ms.`,
          action:
            'Check the runtime process and network, then retry with the documented 60-second maximum.',
          ...(input.modelId ? { model: input.modelId } : {}),
        };
      } catch (error) {
        if (controller.signal.aborted) {
          return {
            ok: false,
            durationMs: Date.now() - startedAt,
            reasonCode: 'timeout',
            reason: timeoutError.message,
            action:
              'Check the runtime process and network, then retry with the documented 60-second maximum.',
            ...(input.modelId ? { model: input.modelId } : {}),
          };
        }
        return {
          ok: false,
          durationMs: Date.now() - startedAt,
          reasonCode: turnStarted ? 'turn-failed' : 'start-failed',
          reason: redactSmokeFailure(
            error instanceof Error ? error.message : String(error),
          ),
          action: sessionStarted
            ? 'Check the runtime response and run the explicit smoke again.'
            : 'Check runtime prerequisites and authentication, then run the explicit smoke again.',
          ...(input.modelId ? { model: input.modelId } : {}),
        };
      }
    })().finally(() => clearTimeout(timeout));
    // The user-supplied timeout bounds the diagnostic turn. Resource ownership
    // gets one separate shared grace, so observation plus cleanup cannot each
    // consume a fresh adapter-stop deadline.
    const cleanupDeadline = Date.now() + this.deps.adapterStopTimeoutMs();
    let cleanupError: unknown;
    try {
      const adapter = this.deps.adapterFor(input.provider);
      const cleanupObservableOwnership = async () => {
        if (sessionStarted || this.deps.hasThreadProvider(threadId)) {
          // station#3525: this connectivity probe's turn was never a user
          // conversation — its own diagnostic timeout ending it is internal
          // machinery, not something to alarm a user about.
          this.deps.armInternalStop(threadId);
          await this.deps.runCleanupWithinDeadline(
            () =>
              this.deps
                .dispatch({ type: 'stopSession', threadId })
                .then(() => undefined),
            `${input.provider} smoke session cleanup`,
            cleanupDeadline,
          );
          sessionStarted = false;
          return;
        }
        if (!controller.signal.aborted || !adapter) return;
        let adapterOwnsSession = false;
        await this.deps.runOperationWithinDeadline(
          adapter.hasSession(threadId).then((ownsSession) => {
            adapterOwnsSession = ownsSession;
          }),
          `${adapter.provider} timed-out smoke ownership check`,
          cleanupDeadline,
        );
        if (adapterOwnsSession) {
          this.deps.armInternalStop(threadId);
          await this.deps.runCleanupWithinDeadline(
            () => adapter.stopSession(threadId),
            `${adapter.provider} timed-out smoke cleanup`,
            cleanupDeadline,
          );
        }
      };

      // startSession can fail after an adapter session has been tracked (for
      // example while persisting or binding it). Treat tracked ownership as a
      // cleanup obligation even when dispatch never returned successfully.
      await cleanupObservableOwnership();
      if (controller.signal.aborted && !startOperationSettled) {
        await this.deps.runOperationWithinDeadline(
          startOperation.then(
            () => undefined,
            () => undefined,
          ),
          `${input.provider} timed-out smoke startup settlement`,
          cleanupDeadline,
        );
      }
      if (controller.signal.aborted) {
        await cleanupObservableOwnership();
      }
    } catch (error) {
      cleanupError = error;
    }
    const durationMs = Date.now() - startedAt;
    if (cleanupError) {
      return {
        ok: false,
        durationMs,
        reasonCode: 'cleanup-failed',
        reason:
          'The diagnostic ended, but Station could not confirm runtime cleanup within its bounded grace.',
        action:
          'Recover the diagnostic runtime session before running another smoke.',
        ...(input.modelId ? { model: input.modelId } : {}),
      };
    }
    this.deps.deleteThread(threadId);
    this.deps.invalidateSessionOwner(threadId);
    return { ...result, durationMs };
  }
}
