import { randomUUID } from 'node:crypto';
import type {
  OrchestrationCommand,
  OrchestrationCommandDispatchResult,
} from '@kontourai/station-contracts/orchestration';
import type {
  ProviderKind,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '@kontourai/station-contracts/provider';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import type { OrchestrationService } from '../orchestration/orchestration-service.js';
import type {
  ReadOnlyReviewExecutor,
  ReviewExecutionInput,
  ReviewExecutionOutcome,
} from './review-evidence-module.js';

interface ReviewOrchestrationPort {
  dispatchWithReceipt(
    command: OrchestrationCommand,
    context?: ReviewOrchestrationContext,
    internal?: Record<string, unknown>,
  ): Promise<OrchestrationCommandDispatchResult<unknown>>;
  dispatch(
    command: OrchestrationCommand,
    context?: ReviewOrchestrationContext,
  ): Promise<unknown>;
  readSessionEventPage: OrchestrationService['readSessionEventPage'];
}

interface ReviewOrchestrationContext {
  userId?: string;
  tenantExecutionContext?: ReviewExecutionInput['context']['tenantExecutionContext'];
}

export interface OrchestrationReviewExecutorOptions {
  orchestration: ReviewOrchestrationPort;
  supportsReadOnlyReview(provider: ProviderKind): boolean;
  provider?: ProviderKind;
  pollMs?: number;
  stopTimeoutMs?: number;
}

/**
 * Executes a reviewer through the canonical orchestration/event path. The
 * server-only reviewIsolation field reaches the provider start AND turn; a
 * provider lacking a native read-only declaration is refused pre-invocation.
 */
export class OrchestrationReviewExecutor implements ReadOnlyReviewExecutor {
  readonly workspaceAccess = 'read-only' as const;
  readonly #orchestration: ReviewOrchestrationPort;
  readonly #supportsReadOnlyReview: (provider: ProviderKind) => boolean;
  readonly #provider: ProviderKind;
  readonly #pollMs: number;
  readonly #stopTimeoutMs: number;

  constructor(options: OrchestrationReviewExecutorOptions) {
    this.#orchestration = options.orchestration;
    this.#supportsReadOnlyReview = options.supportsReadOnlyReview;
    this.#provider = options.provider ?? 'codex';
    this.#pollMs = options.pollMs ?? 100;
    this.#stopTimeoutMs = options.stopTimeoutMs ?? 10_000;
    if (!Number.isInteger(this.#pollMs) || this.#pollMs < 1) {
      throw new Error('review event poll interval is invalid');
    }
    if (!Number.isInteger(this.#stopTimeoutMs) || this.#stopTimeoutMs < 1) {
      throw new Error('review stop timeout is invalid');
    }
  }

  async execute(input: ReviewExecutionInput): Promise<ReviewExecutionOutcome> {
    if (!this.#supportsReadOnlyReview(this.#provider)) {
      return {
        kind: 'failed',
        reason: 'The selected reviewer engine cannot enforce read-only access.',
        workspaceRelease: 'safe',
      };
    }
    if (input.signal.aborted) {
      return {
        kind: 'timed-out',
        reason: 'Reviewer execution timed out.',
        workspaceRelease: 'safe',
      };
    }
    const threadId = `review-${randomUUID()}`;
    const isolation = {
      workspaceAccess: 'read-only' as const,
      requestId: input.requestId,
      reviewerId: input.reviewer.reviewerId,
    };
    let started = false;
    let outcome: ReviewExecutionOutcome | undefined;
    let workspaceRelease: 'safe' | 'retain' = 'safe';
    try {
      const startInput: ProviderSessionStartInput = {
        threadId,
        provider: this.#provider,
        cwd: input.workspace.root,
        persistSession: false,
        metadata: {
          agentSlug: input.reviewer.executorAgentSlug,
          reviewEvidenceRequestId: input.requestId,
          reviewEvidenceReviewerId: input.reviewer.reviewerId,
        },
        signal: input.signal,
      };
      const start = await this.#orchestration.dispatchWithReceipt(
        { type: 'startSession', input: startInput },
        orchestrationContext(input),
        { reviewIsolation: isolation },
      );
      if (!isProviderSession(start.result, threadId)) {
        outcome = {
          kind: 'failed',
          reason: 'Reviewer session did not start.',
          workspaceRelease: 'safe',
        };
        return outcome;
      }
      started = true;
      const turnInput: ProviderSendTurnInput = {
        threadId,
        input: input.prompt,
        displayInput: 'Independent review request',
        clientTurnId: `review:${input.requestId}:${input.reviewer.reviewerId}`,
        signal: input.signal,
      };
      const sent = await this.#orchestration.dispatchWithReceipt(
        { type: 'sendTurn', input: turnInput },
        orchestrationContext(input),
        { reviewIsolation: isolation },
      );
      if (!isTurnStart(sent.result, threadId)) {
        outcome = {
          kind: 'failed',
          reason: 'Reviewer turn did not start.',
          workspaceRelease: 'retain',
        };
        return outcome;
      }
      outcome = await this.#waitForOutput(
        input.signal,
        threadId,
        sent.result.turnId,
      );
      return outcome;
    } catch {
      outcome = {
        kind: input.signal.aborted ? 'timed-out' : 'failed',
        reason: input.signal.aborted
          ? 'Reviewer execution timed out.'
          : 'Reviewer execution failed.',
        workspaceRelease: started ? 'retain' : 'safe',
      };
      return outcome;
    } finally {
      if (started) {
        try {
          await withTimeout(
            this.#orchestration.dispatch(
              { type: 'stopSession', threadId },
              orchestrationContext(input),
            ),
            this.#stopTimeoutMs,
          );
        } catch {
          workspaceRelease = 'retain';
        }
        if (outcome) outcome.workspaceRelease = workspaceRelease;
      }
    }
  }

  async #waitForOutput(
    signal: AbortSignal,
    threadId: string,
    turnId: string,
  ): Promise<ReviewExecutionOutcome> {
    let afterSequence = 0;
    while (!signal.aborted) {
      const page = await this.#orchestration.readSessionEventPage(threadId, {
        afterSequence,
        limit: 200,
        authority: INTERNAL_SESSION_READ_SCOPE,
      });
      if (!page) {
        return {
          kind: 'failed',
          reason: 'Reviewer session disappeared.',
          workspaceRelease: 'retain',
        };
      }
      for (const entry of page.events) {
        afterSequence = Math.max(afterSequence, entry.sequence);
        const event = entry.event;
        if (event.turnId && event.turnId !== turnId) continue;
        if (event.method === 'turn.completed' && event.turnId === turnId) {
          if (typeof event.outputText !== 'string') {
            return {
              kind: 'completed',
              output: null,
              workspaceRelease: 'safe',
            };
          }
          try {
            return {
              kind: 'completed',
              output: JSON.parse(event.outputText),
              workspaceRelease: 'safe',
            };
          } catch {
            return {
              kind: 'completed',
              output: null,
              workspaceRelease: 'safe',
            };
          }
        }
        if (
          (event.method === 'turn.aborted' && event.turnId === turnId) ||
          event.method === 'runtime.error' ||
          event.method === 'session.exited'
        ) {
          return {
            kind: 'failed',
            reason: 'Reviewer execution ended early.',
            workspaceRelease: 'safe',
          };
        }
      }
      if (!page.hasMore) await delay(this.#pollMs, signal);
    }
    return {
      kind: 'timed-out',
      reason: 'Reviewer execution timed out.',
      workspaceRelease: 'retain',
    };
  }
}

function orchestrationContext(
  input: ReviewExecutionInput,
): ReviewOrchestrationContext {
  return {
    ...(input.context.userId ? { userId: input.context.userId } : {}),
    ...(input.context.tenantExecutionContext
      ? { tenantExecutionContext: input.context.tenantExecutionContext }
      : {}),
  };
}

function isProviderSession(
  value: unknown,
  threadId: string,
): value is ProviderSession {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { threadId?: unknown }).threadId === threadId &&
      typeof (value as { provider?: unknown }).provider === 'string',
  );
}

function isTurnStart(
  value: unknown,
  threadId: string,
): value is ProviderTurnStartResult {
  return Boolean(
    value &&
      typeof value === 'object' &&
      (value as { threadId?: unknown }).threadId === threadId &&
      typeof (value as { turnId?: unknown }).turnId === 'string' &&
      Boolean((value as { turnId: string }).turnId),
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Reviewer cleanup timed out.')),
      timeoutMs,
    );
    timer.unref?.();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
