/**
 * The remote task engine as a chat (docs/decisions/remote-task-engines.md):
 * the provider adapter over `RemoteTaskEngineService`. A chat on it picks a
 * remote task connection as its "model"; its first turn creates the task,
 * later turns send follow-ups, and each turn's reply is the vendor's
 * messages, caught up until the task rests. The work runs on the vendor's
 * machines: Station sends only what a person typed (`personText`), opens no
 * approval, and confines nothing. The adapter declares
 * `turnAuthorship: 'person-only'`, so orchestration refuses any start or send
 * that is not a person's own (an agent, a schedule, an automation, a
 * delegation, a review).
 *
 * A turn shows everything the store holds after what the chat last showed,
 * whoever synced it, and ends only once the vendor reacted to the message
 * (a reply, or a status it did not have when the message was sent) and
 * rests, or after its wake or work bound. It polls only while it is open,
 * and reports the task's status as progress, so a quiet vendor never reads as
 * a stalled turn.
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
  REMOTE_TASK_VENDOR_LABELS,
  type RemoteTask,
  type RemoteTaskCapabilities,
  type RemoteTaskRepository,
  type RemoteTaskStatus,
  type RemoteTaskStoredEvent,
  type RemoteTaskVendorId,
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
  PersonAuthoredTurnRequiredError,
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

export interface RemoteTaskTurnBounds {
  /** A turn whose message the vendor has not reacted to by then ends "still waking". */
  readonly wakeMs: number;
  /** A turn still working by then ends "still working"; the task goes on. */
  readonly workMs: number;
  /** The longest gap between a turn's polls, under the turn-stall window. */
  readonly pollCeilingMs: number;
}

export const REMOTE_TASK_TURN_BOUNDS: RemoteTaskTurnBounds = Object.freeze({
  wakeMs: 10 * 60_000,
  workMs: 60 * 60_000,
  pollCeilingMs: 150_000,
});

type RemoteTaskChatService = Pick<
  RemoteTaskEngineService,
  | 'readyConnections'
  | 'previewEnabled'
  | 'createTask'
  | 'sendMessage'
  | 'cancelTask'
  | 'syncTask'
  | 'readEvents'
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
  readonly now?: () => number;
  readonly bounds?: Partial<RemoteTaskTurnBounds>;
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
  vendor: RemoteTaskVendorId;
  capabilities: RemoteTaskCapabilities;
  taskId?: string;
  repository?: RemoteTaskRepository;
  /** The newest Station sequence this chat has shown. */
  shownSequence: number;
  /** The task ended and its vendor takes no more work on it. */
  finished: boolean;
  /** A first send is creating the task. */
  pendingSend: boolean;
}

interface OpenTurn {
  readonly turnId: string;
  readonly invocationId?: string;
  handle: unknown;
  delayMs: number;
  readonly startedAt: number;
  /** The newest stored sequence when the message was sent. */
  readonly sentAtSequence: number;
  /** The task's status when the message was sent; absent for a new task. */
  readonly baselineStatus?: string;
  text: string;
  closed: boolean;
  /** The vendor reacted to this message (a reply, or a new status). */
  sawActivity: boolean;
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
function taskMetadata(task: RemoteTask): {
  remoteTask: Record<string, unknown>;
} {
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

const STATUS_WORDS: Readonly<Record<RemoteTaskStatus, string>> = {
  queued: 'queued',
  running: 'working',
  'waiting-for-user': 'waiting for you',
  idle: 'done for now',
  completed: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
  'timed-out': 'timed out',
  unknown: 'status unknown',
};

/**
 * The line a turn ends with: the vendor, the task's status, every result it
 * reported (a pull request by URL, or by the vendor's reference when it gives
 * no URL), the task's page, and where to answer when Station cannot.
 */
export function summaryLine(
  vendor: RemoteTaskVendorId,
  task: RemoteTask,
  followUp: RemoteTaskCapabilities['followUp'],
  stillWorking: boolean,
): string {
  const label = REMOTE_TASK_VENDOR_LABELS[vendor];
  const parts = [
    stillWorking
      ? `${label} is still working on this; send a message to check again.`
      : `${label}: ${STATUS_WORDS[task.status]}.`,
  ];
  for (const output of task.outputs) {
    const where = output.url ?? output.reference;
    if (where)
      parts.push(
        `Pull request: ${where}${output.state ? ` (${output.state})` : ''}.`,
      );
  }
  if (task.url) parts.push(`Task: ${task.url}`);
  if (followUp === 'none' && task.status === 'waiting-for-user')
    parts.push(`Answer it in ${label}; Station cannot send it messages.`);
  return parts.join(' ');
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
    // Work leaves the host: only a person's own chat and words reach it.
    turnAuthorship: 'person-only',
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
  readonly #now: () => number;
  readonly #bounds: RemoteTaskTurnBounds;

  constructor(options: RemoteTaskAdapterOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
    this.#bounds = { ...REMOTE_TASK_TURN_BOUNDS, ...options.bounds };
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

  /** The stored task and its newest Station sequence; undefined when none. */
  #stored(session: ChatSession): { task: RemoteTask | null; latest: number } {
    if (!session.taskId) return { task: null, latest: 0 };
    try {
      const read = this.#options.service.readEvents(
        session.connectionId,
        session.taskId,
        Number.MAX_SAFE_INTEGER,
      );
      return {
        task: read.task,
        latest: this.#options.service.latestSequence(
          session.connectionId,
          session.taskId,
        ),
      };
    } catch {
      return { task: null, latest: 0 };
    }
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
    const label = REMOTE_TASK_VENDOR_LABELS[connection.vendor];
    const repository = cursor?.taskId
      ? undefined
      : await this.#options.resolveRepository(input.cwd);
    // A vendor that needs a repository is refused here, with the reason,
    // rather than at the first message.
    if (
      !cursor?.taskId &&
      !repository &&
      connection.capabilities.requiresRepository
    )
      throw new SessionStartRefusedError(
        `${label} needs a GitHub repository, and this chat's folder has no GitHub origin remote.`,
        MODEL_NOT_ADVERTISED_CODE,
      );
    const now = new Date().toISOString();
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
      vendor: connection.vendor,
      capabilities: connection.capabilities,
      ...(cursor?.taskId ? { taskId: cursor.taskId } : {}),
      ...(repository ? { repository } : {}),
      shownSequence: 0,
      finished: false,
      pendingSend: false,
    };
    // A resumed chat shows only what arrives from now on, never history, and
    // stays closed if its task already ended for good.
    if (session.taskId) {
      const stored = this.#stored(session);
      session.shownSequence = stored.latest;
      session.finished =
        !!stored.task &&
        isRemoteTaskTerminal(stored.task.status) &&
        !connection.capabilities.finishedAcceptsFollowUp;
    }
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
          repository: repository
            ? `${repository.owner}/${repository.name}`
            : null,
        },
      },
    });
    if (!cursor?.taskId && !repository)
      this.#publish({
        ...this.#base(input.threadId),
        method: 'runtime.warning',
        severity: 'warning',
        code: 'remote-task-no-repository',
        message: `This chat's folder has no GitHub origin remote, so ${label} starts without a repository.`,
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
    const label = REMOTE_TASK_VENDOR_LABELS[session.vendor];
    if (session.finished)
      throw new SendTurnRefusedError(
        `This ${label} task has ended and takes no more messages. Start a new chat to send more work.`,
        'input_unsupported',
      );
    if (this.#turns.has(input.threadId) || session.pendingSend)
      throw new SendTurnRefusedError(
        `${label} is still answering the last message.`,
        'busy',
      );
    // Only what a person typed leaves the host. Orchestration sets
    // `personText` for a person-authored send and removes it from any other.
    const text = input.personText;
    if (typeof text !== 'string' || !text.trim())
      throw new PersonAuthoredTurnRequiredError();
    // Claimed before the vendor call, so a second send cannot create a
    // second paid task while the first is still being created.
    session.pendingSend = true;
    let taskId = session.taskId;
    let baselineStatus: string | undefined;
    let sentAtSequence = 0;
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
        baselineStatus = undefined;
      } else {
        const stored = this.#stored(session);
        baselineStatus = stored.task?.vendorStatus;
        sentAtSequence = stored.latest;
        await this.#options.service.sendMessage(
          session.connectionId,
          taskId,
          text,
        );
      }
    } catch (error) {
      session.pendingSend = false;
      throw refusal(error);
    }
    session.pendingSend = false;
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
    const now = this.#now();
    const turn: OpenTurn = {
      turnId,
      ...(input.invocationId ? { invocationId: input.invocationId } : {}),
      handle: undefined,
      delayMs: 0,
      startedAt: now,
      sentAtSequence,
      ...(baselineStatus !== undefined ? { baselineStatus } : {}),
      text: '',
      closed: false,
      sawActivity: false,
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
    // The remote task as one long-running call: its status is the progress
    // this turn reports while the vendor works.
    this.#publish({
      ...this.#base(input.threadId),
      ...this.#turnIds(turn),
      itemId: `${turnId}:task`,
      method: 'tool.started',
      toolCallId: `${turnId}:task`,
      toolName: 'remote_task',
      purpose: `${label} works on this on its own machines`,
    });
    this.#schedule(input.threadId, turn, 0);
    return { threadId: input.threadId, turnId, resumeCursor };
  }

  #turnIds(turn: OpenTurn) {
    return {
      turnId: turn.turnId,
      ...(turn.invocationId ? { invocationId: turn.invocationId } : {}),
    };
  }

  #schedule(threadId: string, turn: OpenTurn, delayMs: number): void {
    turn.delayMs = delayMs;
    turn.handle = this.#setTimer(
      () => void this.#poll(threadId, turn),
      // Under the turn-stall window, so the progress this turn reports keeps
      // a quiet vendor from reading as a stalled turn.
      Math.min(delayMs, this.#bounds.pollCeilingMs),
    );
  }

  async #poll(threadId: string, turn: OpenTurn): Promise<void> {
    const session = this.#sessions.get(threadId);
    if (turn.closed || !session?.taskId || this.#turns.get(threadId) !== turn)
      return;
    const label = REMOTE_TASK_VENDOR_LABELS[session.vendor];
    const polling =
      this.#options.service.pollingFor(session.connectionId) ??
      REMOTE_TASK_POLLING_DEFAULT;
    let task: RemoteTask;
    try {
      task = (
        await this.#options.service.syncTask(
          session.connectionId,
          session.taskId,
        )
      ).task;
    } catch (error) {
      if (turn.closed) return;
      const code = error instanceof RemoteTaskError ? error.code : undefined;
      if (
        code === 'remote-task-rate-limited' ||
        code === 'remote-task-vendor-unavailable'
      ) {
        this.#progress(threadId, turn, `${label} is not answering; retrying.`);
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
    // Everything stored after what this chat last showed, whoever synced it
    // (this turn, the tracker, or a read): the store is the one record.
    let stored: readonly RemoteTaskStoredEvent[] = [];
    try {
      stored = this.#options.service.readEvents(
        session.connectionId,
        session.taskId,
        session.shownSequence,
      ).events;
    } catch {
      stored = [];
    }
    for (const event of stored) {
      if (event.sequence <= session.shownSequence) continue;
      session.shownSequence = event.sequence;
      if (event.sequence > turn.sentAtSequence && event.author === 'agent')
        turn.sawActivity = true;
      if (event.author !== 'agent') continue;
      const delta = turn.text ? `\n\n${event.text}` : event.text;
      turn.text += delta;
      this.#publish({
        ...this.#base(threadId),
        ...this.#turnIds(turn),
        itemId: `${turn.turnId}:reply`,
        method: 'content.text-delta',
        delta,
      });
    }
    // A status the task did not have when this was sent is the vendor
    // reacting to it; a new task reacts as soon as it reports anything.
    if (
      turn.baselineStatus === undefined ||
      task.vendorStatus !== turn.baselineStatus
    )
      turn.sawActivity = true;
    const resting =
      isRemoteTaskTerminal(task.status) || TURN_ENDING.includes(task.status);
    const elapsed = this.#now() - turn.startedAt;
    if (resting && turn.sawActivity) {
      if (
        isRemoteTaskTerminal(task.status) &&
        !session.capabilities.finishedAcceptsFollowUp
      )
        session.finished = true;
      this.#endTurn(threadId, turn, { kind: 'rested', task });
      return;
    }
    if (!turn.sawActivity && elapsed >= this.#bounds.wakeMs) {
      // Not "completed with nothing": the vendor never picked it up.
      this.#endTurn(threadId, turn, {
        kind: 'aborted',
        reason: `${label} has not picked this message up yet; it may still be waking. Its reply will show with your next message.`,
        task,
      });
      return;
    }
    if (elapsed >= this.#bounds.workMs) {
      this.#endTurn(threadId, turn, { kind: 'still-working', task });
      return;
    }
    this.#progress(threadId, turn, `${label}: ${task.vendorStatus}`);
    this.#schedule(
      threadId,
      turn,
      nextRemoteTaskPollDelay(polling, turn.delayMs, { kind: 'ok' }),
    );
  }

  #progress(threadId: string, turn: OpenTurn, message: string): void {
    this.#publish({
      ...this.#base(threadId),
      ...this.#turnIds(turn),
      itemId: `${turn.turnId}:task`,
      method: 'tool.progress',
      toolCallId: `${turn.turnId}:task`,
      message,
    });
  }

  #endTurn(
    threadId: string,
    turn: OpenTurn,
    outcome:
      | { kind: 'rested'; task: RemoteTask }
      | { kind: 'still-working'; task: RemoteTask }
      | { kind: 'aborted'; reason: string; task?: RemoteTask },
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
    const vendor = session?.vendor;
    const failed =
      outcome.kind === 'rested' &&
      (outcome.task.status === 'failed' || outcome.task.status === 'timed-out');
    // Every vendor's turn ends with a line naming its status and results, so
    // a vendor with no messages (GitHub) still shows its pull request.
    if (vendor && outcome.task) {
      const line = summaryLine(
        vendor,
        outcome.task,
        session?.capabilities.followUp ?? 'none',
        outcome.kind === 'still-working',
      );
      const delta = turn.text ? `\n\n${line}` : line;
      turn.text += delta;
      this.#publish({
        ...this.#base(threadId),
        ...this.#turnIds(turn),
        itemId: `${turn.turnId}:reply`,
        method: 'content.text-delta',
        delta,
      });
    }
    const base = { ...this.#base(threadId), ...this.#turnIds(turn) };
    this.#publish({
      ...base,
      itemId: `${turn.turnId}:task`,
      method: 'tool.completed',
      toolCallId: `${turn.turnId}:task`,
      toolName: 'remote_task',
      status:
        outcome.kind === 'aborted' || failed
          ? outcome.kind === 'aborted' && outcome.reason === 'interrupted'
            ? 'cancelled'
            : 'error'
          : 'success',
      ...(outcome.task
        ? { output: taskMetadata(outcome.task).remoteTask }
        : {}),
    });
    if (outcome.kind === 'aborted' || failed) {
      this.#publish({
        ...base,
        method: 'turn.aborted',
        reason:
          outcome.kind === 'aborted'
            ? outcome.reason
            : `${REMOTE_TASK_VENDOR_LABELS[outcome.task.vendor]} reports the task ${outcome.task.status === 'failed' ? 'failed' : 'timed out'}.`,
        ...(outcome.task ? { metadata: taskMetadata(outcome.task) } : {}),
      });
      return;
    }
    const finishReason: TurnCompletedEvent['finishReason'] =
      outcome.kind === 'still-working'
        ? 'other'
        : outcome.task.status === 'cancelled'
          ? 'cancelled'
          : 'stop';
    this.#publish({
      ...base,
      method: 'turn.completed',
      finishReason,
      ...(turn.text ? { outputText: turn.text } : {}),
      metadata: {
        ...taskMetadata(outcome.task),
        ...(outcome.kind === 'still-working' ? { stillWorking: true } : {}),
      },
    });
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
    // Stop cancels the vendor's current work only where that leaves the task
    // usable (a Cursor run). Where the vendor's cancel ends the whole task
    // (Devin's terminate), Stop only stops following: ending a task is not a
    // chat's Stop.
    let stopped = false;
    if (
      session?.taskId &&
      session.capabilities.cancel &&
      !session.capabilities.cancelEndsTask
    ) {
      try {
        await this.#options.service.cancelTask(
          session.connectionId,
          session.taskId,
        );
        stopped = true;
      } catch {
        // The work goes on at the vendor.
      }
    }
    const label = session ? REMOTE_TASK_VENDOR_LABELS[session.vendor] : 'It';
    this.#endTurn(threadId, turn, {
      kind: 'aborted',
      reason: stopped
        ? 'interrupted'
        : `Stopped following the remote task; ${label} keeps working on it.`,
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
