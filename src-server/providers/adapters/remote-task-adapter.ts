/**
 * The remote task engine as a chat (docs/decisions/remote-task-engines.md):
 * the provider adapter over `RemoteTaskEngineService`. A chat on it picks a
 * remote task connection as its "model"; its first turn creates the task,
 * later turns send follow-ups, and each turn's reply is the vendor's
 * messages, caught up until the task is idle, waiting for the person, or
 * finished. The work runs on the vendor's machines: Station sends only the
 * person's message (no instructions, tools or attachments), opens no
 * approval, and confines nothing.
 *
 * Polling is the turn's own: it runs only while a turn is open, so a chat
 * nobody is writing in costs no vendor quota. Every vendor call goes through
 * the service's gate (preview, managed policy, acknowledgement, credential).
 */
import crypto from 'node:crypto';
import {
  engineConnectionId,
  engineId,
} from '@kontourai/station-contracts/agent-identity';
import { REMOTE_TASK_ENGINE_DURABILITY } from '@kontourai/station-contracts/engine-capability-matrix';
import {
  MODEL_NOT_ADVERTISED_CODE,
  type ProviderSession,
} from '@kontourai/station-contracts/provider';
import {
  isRemoteTaskTerminal,
  nextRemoteTaskPollDelay,
  REMOTE_TASK_POLLING_DEFAULT,
  type RemoteTask,
  type RemoteTaskRepository,
  type RemoteTaskStatus,
} from '@kontourai/station-contracts/remote-task-engine';
import type {
  CanonicalRuntimeEvent,
  TurnCompletedEvent,
} from '@kontourai/station-contracts/runtime-events';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import { FeaturePreviewDisabledError } from '../../services/feature-previews/feature-preview-refusal.js';
import { RemoteTaskError } from '../../services/remote-task-engines/remote-task-error.js';
import type { RemoteTaskEngineService } from '../../services/remote-task-engines/service.js';
import {
  type ProviderAdapterMetadata,
  type ProviderAdapterShape,
  type ProviderInterruptTurnResult,
  type ProviderSendTurnInput,
  type ProviderSessionStartInput,
  type ProviderTurnStartResult,
  SendTurnRefusedError,
  SessionStartRefusedError,
} from '../adapter-shape.js';
import type { AsyncEventStreamOptions } from '../sessions/async-event-queue.js';
import { AsyncEventQueue } from '../sessions/async-event-queue.js';

export const REMOTE_TASK_PROVIDER = 'remote-task';

/** Statuses after which the vendor does nothing more until someone writes. */
const TURN_ENDING: readonly RemoteTaskStatus[] = ['idle', 'waiting-for-user'];
/**
 * Right after a follow-up the vendor may still report its previous idle or
 * finished state. A turn ends on such a state only once it has seen the task
 * work (or reply), or after this many polls without either.
 */
const IDLE_POLLS_BEFORE_ENDING = 3;

type RemoteTaskChatService = Pick<
  RemoteTaskEngineService,
  | 'readyConnections'
  | 'previewEnabled'
  | 'createTask'
  | 'sendMessage'
  | 'cancelTask'
  | 'syncTask'
  | 'latestSequence'
  | 'pollingFor'
>;

export interface RemoteTaskAdapterOptions {
  readonly service: RemoteTaskChatService;
  readonly resolveRepository: (
    cwd: string | undefined,
  ) => Promise<RemoteTaskRepository | undefined>;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (handle: unknown) => void;
}

/** What a chat keeps across restarts: its connection and its task. */
export interface RemoteTaskResumeCursor {
  readonly kind: 'remote-task';
  readonly connectionId: string;
  readonly taskId?: string;
}

function readCursor(value: unknown): RemoteTaskResumeCursor | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'remote-task' || typeof record.connectionId !== 'string')
    return undefined;
  return {
    kind: 'remote-task',
    connectionId: record.connectionId,
    ...(typeof record.taskId === 'string' ? { taskId: record.taskId } : {}),
  };
}

interface ChatSession extends ProviderSession {
  connectionId: string;
  taskId?: string;
  repository?: RemoteTaskRepository;
}

interface OpenTurn {
  readonly turnId: string;
  readonly invocationId?: string;
  handle: unknown;
  delayMs: number;
  lastSequence: number;
  text: string;
  closed: boolean;
  sawWork: boolean;
  idlePolls: number;
}

/**
 * A gate refusal is decided before anything reaches the vendor, so the turn
 * is refused, not indeterminate. A vendor's own refusal (4xx) also created
 * nothing. Anything else may have reached the vendor and stays a plain error.
 */
function refusal(error: unknown): unknown {
  if (error instanceof FeaturePreviewDisabledError)
    return new SendTurnRefusedError(error.message, 'unavailable');
  if (!(error instanceof RemoteTaskError)) return error;
  switch (error.code) {
    case 'remote-task-policy-refused':
    case 'remote-task-acknowledgement-required':
    case 'remote-task-not-granted':
      return new SendTurnRefusedError(error.message, 'permission_denied');
    case 'remote-task-credential-missing':
    case 'remote-task-not-found':
      return new SendTurnRefusedError(error.message, 'unavailable');
    case 'remote-task-capability-unsupported':
    case 'remote-task-invalid':
    case 'remote-task-vendor-refused':
      return new SendTurnRefusedError(error.message, 'input_unsupported');
    case 'remote-task-rate-limited':
      return new SendTurnRefusedError(error.message, 'busy');
    default:
      return error;
  }
}

/** A finished turn's facts about the task, value-free beyond the vendor's. */
function taskMetadata(task: RemoteTask): Record<string, unknown> {
  return {
    remoteTask: {
      connectionId: task.connectionId,
      vendor: task.vendor,
      taskId: task.taskId,
      status: task.status,
      vendorStatus: task.vendorStatus,
      ...(task.url ? { url: task.url } : {}),
      outputs: task.outputs,
      usage: task.usage,
    },
  };
}

export class RemoteTaskAdapter implements ProviderAdapterShape {
  readonly provider = REMOTE_TASK_PROVIDER;
  readonly metadata: ProviderAdapterMetadata = {
    displayName: 'Remote task engines',
    description:
      "Cloud coding agents that work on the vendor's machines. Prompts and repository code leave this computer.",
    capabilities: ['agent-runtime', 'session-lifecycle'],
    connectionId: engineConnectionId('remote-task'),
    builtin: true,
    engineId: engineId('remote-task'),
    durability: REMOTE_TASK_ENGINE_DURABILITY,
    continuity: { resume: 'same-session', fork: 'none', rewind: 'none' },
    approvalAcknowledgement: 'none',
    modelCatalogIdentityMapped: true,
    // The "model" is the remote task connection, chosen at start and kept.
    modelLaunch: {
      defaultAtStart: 'station-resolved',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: false,
      overridePerTurn: false,
    },
  };

  readonly #options: RemoteTaskAdapterOptions;
  readonly #events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly #sessions = new Map<string, ChatSession>();
  readonly #turns = new Map<string, OpenTurn>();
  readonly #setTimer: (run: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;

  constructor(options: RemoteTaskAdapterOptions) {
    this.#options = options;
    this.#setTimer =
      options.setTimer ??
      ((run, ms) => {
        const timer = setTimeout(run, ms);
        timer.unref?.();
        return timer;
      });
    this.#clearTimer =
      options.clearTimer ??
      ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  }

  #publish(event: CanonicalRuntimeEvent): void {
    this.#events.push(event);
  }

  #base(threadId: string) {
    return {
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: new Date().toISOString(),
    };
  }

  // --- catalog and readiness ---------------------------------------------------

  async listModelCatalog() {
    return {
      models: this.#options.service.readyConnections().map((connection) => ({
        id: connection.id,
        name: connection.label,
        originalId: connection.id,
      })),
    };
  }

  async listModels() {
    return (await this.listModelCatalog()).models;
  }

  async getPrerequisites(): Promise<Prerequisite[]> {
    const preview = this.#options.service.previewEnabled();
    const ready =
      preview && this.#options.service.readyConnections().length > 0;
    return [
      {
        id: 'remote-task-preview',
        name: 'Remote task engines preview',
        description:
          'Turn on Remote task engines in Settings → Advanced → Feature previews.',
        status: preview ? 'installed' : 'missing',
        category: 'required',
      },
      {
        id: 'remote-task-connection',
        name: 'A ready remote task connection',
        description:
          'Add a connection, accept that its work leaves this computer, and give it a token.',
        status: ready ? 'installed' : 'missing',
        category: 'required',
      },
    ];
  }

  // --- sessions --------------------------------------------------------------------

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const cursor = readCursor(input.resumeCursor);
    const ready = this.#options.service.readyConnections();
    const wanted = cursor?.connectionId ?? input.modelId;
    const connection = wanted
      ? ready.find((entry) => entry.id === wanted)
      : ready.length === 1
        ? ready[0]
        : undefined;
    // Refused before anything is published or sent: no session exists.
    if (!connection)
      throw new SessionStartRefusedError(
        wanted
          ? 'That remote task connection is not ready: check the preview, the policy, its acknowledgement and its token.'
          : 'Choose a remote task connection for this chat.',
        MODEL_NOT_ADVERTISED_CODE,
      );
    const now = new Date().toISOString();
    const repository = await this.#options.resolveRepository(input.cwd);
    const session: ChatSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      model: connection.id,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      resumeCursor: {
        kind: 'remote-task',
        connectionId: connection.id,
        ...(cursor?.taskId ? { taskId: cursor.taskId } : {}),
      } satisfies RemoteTaskResumeCursor,
      createdAt: now,
      updatedAt: now,
      connectionId: connection.id,
      ...(cursor?.taskId ? { taskId: cursor.taskId } : {}),
      ...(repository ? { repository } : {}),
    };
    this.#sessions.set(input.threadId, session);
    this.#publish({
      ...this.#base(input.threadId),
      method: 'session.started',
      sessionId: input.threadId,
      initialState: 'created',
      metadata: { ...input.metadata, cwd: input.cwd },
    });
    this.#publish({
      ...this.#base(input.threadId),
      method: 'session.configured',
      sessionId: input.threadId,
      model: connection.id,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      metadata: {
        remoteTask: {
          connectionId: connection.id,
          vendor: connection.vendor,
          ...(repository
            ? { repository: `${repository.owner}/${repository.name}` }
            : {}),
        },
      },
    });
    return session;
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const session = this.#sessions.get(input.threadId);
    if (!session)
      throw new SendTurnRefusedError(
        'This remote task chat has no session; start it again.',
        'unavailable',
      );
    if (this.#turns.has(input.threadId))
      throw new SendTurnRefusedError(
        'The remote task is still answering the last message.',
        'busy',
      );
    // Only the person's own words leave the host: never the composed input
    // with Station's ambient context or instructions.
    const text = input.displayInput ?? input.input;
    let taskId = session.taskId;
    let lastSequence = 0;
    try {
      if (!taskId) {
        const task = await this.#options.service.createTask(
          session.connectionId,
          {
            prompt: text,
            ...(session.repository ? { repository: session.repository } : {}),
          },
        );
        taskId = task.taskId;
      } else {
        lastSequence = this.#options.service.latestSequence(
          session.connectionId,
          taskId,
        );
        await this.#options.service.sendMessage(
          session.connectionId,
          taskId,
          text,
        );
      }
    } catch (error) {
      throw refusal(error);
    }
    const turnId = crypto.randomUUID();
    session.taskId = taskId;
    session.status = 'running';
    session.updatedAt = new Date().toISOString();
    const resumeCursor: RemoteTaskResumeCursor = {
      kind: 'remote-task',
      connectionId: session.connectionId,
      taskId,
    };
    session.resumeCursor = resumeCursor;
    const turn: OpenTurn = {
      turnId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      handle: undefined,
      delayMs: 0,
      lastSequence,
      text: '',
      closed: false,
      sawWork: false,
      idlePolls: 0,
    };
    this.#turns.set(input.threadId, turn);
    this.#publish({
      ...this.#base(input.threadId),
      turnId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      method: 'turn.started',
      prompt: text,
      ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
    });
    this.#schedule(input.threadId, turn, 0);
    return { threadId: input.threadId, turnId, resumeCursor };
  }

  #schedule(threadId: string, turn: OpenTurn, delayMs: number): void {
    turn.delayMs = delayMs;
    turn.handle = this.#setTimer(
      () => void this.#poll(threadId, turn),
      delayMs,
    );
  }

  async #poll(threadId: string, turn: OpenTurn): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (turn.closed || !session?.taskId || this.#turns.get(threadId) !== turn)
      return;
    const polling =
      this.#options.service.pollingFor(session.connectionId) ??
      REMOTE_TASK_POLLING_DEFAULT;
    let result: Awaited<ReturnType<RemoteTaskChatService['syncTask']>>;
    try {
      result = await this.#options.service.syncTask(
        session.connectionId,
        session.taskId,
      );
    } catch (error) {
      if (turn.closed) return;
      const code = error instanceof RemoteTaskError ? error.code : undefined;
      if (
        code === 'remote-task-rate-limited' ||
        code === 'remote-task-vendor-unavailable'
      ) {
        this.#schedule(
          threadId,
          turn,
          nextRemoteTaskPollDelay(polling, turn.delayMs, {
            kind:
              code === 'remote-task-rate-limited' ? 'rate-limited' : 'failed',
            ...(error instanceof RemoteTaskError &&
            error.details.retryAfterMs !== undefined
              ? { retryAfterMs: error.details.retryAfterMs }
              : {}),
          }),
        );
        return;
      }
      this.#endTurn(threadId, turn, {
        kind: 'aborted',
        reason:
          error instanceof RemoteTaskError ||
          error instanceof FeaturePreviewDisabledError
            ? error.message
            : 'Station stopped following the remote task.',
      });
      return;
    }
    if (turn.closed) return;
    // The vendor's own messages, after what this turn already showed. The
    // person's echoed message and Station's status lines are not reply text.
    for (const event of result.appended) {
      if (event.sequence <= turn.lastSequence) continue;
      turn.lastSequence = event.sequence;
      if (event.author !== 'agent') continue;
      turn.sawWork = true;
      const delta = turn.text ? `\n\n${event.text}` : event.text;
      turn.text += delta;
      this.#publish({
        ...this.#base(threadId),
        turnId: turn.turnId,
        ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
        itemId: `${turn.turnId}:reply`,
        method: 'content.text-delta',
        delta,
      });
    }
    const resting =
      result.quiescent ||
      isRemoteTaskTerminal(result.task.status) ||
      TURN_ENDING.includes(result.task.status);
    if (!resting) turn.sawWork = true;
    else turn.idlePolls += 1;
    if (
      resting &&
      (turn.sawWork || turn.idlePolls >= IDLE_POLLS_BEFORE_ENDING)
    ) {
      this.#endTurn(threadId, turn, { kind: 'completed', task: result.task });
      return;
    }
    this.#schedule(
      threadId,
      turn,
      nextRemoteTaskPollDelay(polling, turn.delayMs, { kind: 'ok' }),
    );
  }

  #endTurn(
    threadId: string,
    turn: OpenTurn,
    outcome:
      | { kind: 'completed'; task: RemoteTask }
      | { kind: 'aborted'; reason: string },
  ): void {
    if (turn.closed) return;
    turn.closed = true;
    this.#clearTimer(turn.handle);
    if (this.#turns.get(threadId) === turn) this.#turns.delete(threadId);
    const session = this.#sessions.get(threadId);
    if (session) {
      session.status = 'ready';
      session.updatedAt = new Date().toISOString();
    }
    const base = {
      ...this.#base(threadId),
      turnId: turn.turnId,
      ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
    };
    if (outcome.kind === 'completed') {
      const finishReason: TurnCompletedEvent['finishReason'] =
        outcome.task.status === 'cancelled' ? 'cancelled' : 'stop';
      this.#publish({
        ...base,
        method: 'turn.completed',
        finishReason,
        ...(turn.text ? { outputText: turn.text } : {}),
        metadata: taskMetadata(outcome.task),
      });
    } else {
      this.#publish({
        ...base,
        method: 'turn.aborted',
        reason: outcome.reason,
      });
    }
  }

  async interruptTurn(
    threadId: string,
    turnId?: string,
  ): Promise<ProviderInterruptTurnResult> {
    const turn = this.#turns.get(threadId);
    if (!turn) return { outcome: 'no-active-turn' };
    if (turnId && turnId !== turn.turnId)
      return { outcome: 'target-mismatch', activeTurnId: turn.turnId };
    const session = this.#sessions.get(threadId);
    let stopped = false;
    if (session?.taskId) {
      try {
        await this.#options.service.cancelTask(
          session.connectionId,
          session.taskId,
        );
        stopped = true;
      } catch {
        // No cancel at this vendor, or it failed: the work goes on there.
      }
    }
    this.#endTurn(threadId, turn, {
      kind: 'aborted',
      reason: stopped
        ? 'interrupted'
        : 'Stopped following the remote task; it keeps running at the vendor.',
    });
    return stopped
      ? { outcome: 'cancelled', turnId: turn.turnId }
      : { outcome: 'termination-unconfirmed', turnId: turn.turnId };
  }

  /** No Station request is ever opened for a remote task. */
  async respondToRequest(): Promise<void> {}

  async stopSession(threadId: string): Promise<void> {
    const turn = this.#turns.get(threadId);
    if (turn)
      this.#endTurn(threadId, turn, {
        kind: 'aborted',
        reason: 'Session stopped; the remote task keeps running at the vendor.',
      });
    if (!this.#sessions.delete(threadId)) return;
    this.#publish({
      ...this.#base(threadId),
      method: 'session.exited',
      sessionId: threadId,
      reason: 'stopped',
    });
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.#sessions.values()];
  }

  /** This process's binding only; a restart resumes from the cursor. */
  async hasSession(threadId: string): Promise<boolean> {
    return this.#sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    try {
      await Promise.all(
        [...this.#sessions.keys()].map((id) => this.stopSession(id)),
      );
    } finally {
      this.#events.close();
    }
  }

  streamEvents(
    options?: AsyncEventStreamOptions<CanonicalRuntimeEvent>,
  ): AsyncIterable<CanonicalRuntimeEvent> {
    return this.#events.iterable(options);
  }
}
