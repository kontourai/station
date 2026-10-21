import type {
  ProviderSendTurnInput,
  ProviderSessionStartInput,
} from '@kontourai/station-contracts/provider';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type {
  ProviderAdapterMetadata,
  ProviderAdapterShape,
  ProviderSession,
} from '../providers/adapter-shape.js';
import { nativeSessionIdentityKey } from '../providers/adapters/native-resume-binding.js';
import type { IProviderAdapterRegistry } from '../providers/provider-interfaces.js';
import { AsyncEventQueue } from '../providers/sessions/async-event-queue.js';
import type { ExecutionSessionBinding } from '../services/execution-target/execution-target-execution.js';
import type { EventStore } from '../services/orchestration/event-store.js';
import type { NativeSessionOwnership } from '../services/orchestration/native-session-ownership.js';

export class TerminalHandoffAdapter implements ProviderAdapterShape {
  readonly metadata: ProviderAdapterMetadata;
  readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  readonly starts: ProviderSessionStartInput[] = [];
  readonly turns: ProviderSendTurnInput[] = [];
  readonly stopped = new Set<string>();
  failNextNativeReturn = false;
  failNextTranscriptSeed = false;
  private readonly nativeIds = new Map<string, string>();
  private readonly sessions = new Map<string, ProviderSession>();

  constructor(
    readonly provider: 'claude' | 'codex',
    readonly nativeReturn = false,
    private readonly ownership?: NativeSessionOwnership,
    private readonly turnOrdinalOffset = 0,
  ) {
    this.metadata = {
      displayName: provider === 'claude' ? 'Claude Code' : 'Codex',
      description: 'Terminal cross-Agent qualification adapter',
      capabilities: ['agent-runtime'],
      ...(nativeReturn
        ? {
            continuity: {
              resume: 'same-session' as const,
              fork: 'none' as const,
              rewind: 'none' as const,
              resumeIdentity: 'require-match' as const,
              nativeReturn: 'same-binding' as const,
            },
          }
        : {}),
      modelLaunch: {
        defaultAtStart: 'engine-selected',
        omissionAtResume: 'engine-selected',
        omissionPerTurn: 'engine-selected',
        overrideAtStart: true,
        overrideAtResume: true,
        overridePerTurn: true,
      },
    };
  }

  async startSession(input: ProviderSessionStartInput) {
    this.starts.push(input);
    const cursor = input.resumeCursor;
    const nativeId =
      cursor &&
      typeof cursor === 'object' &&
      'nativeSessionId' in cursor &&
      typeof cursor.nativeSessionId === 'string'
        ? cursor.nativeSessionId
        : `${this.provider}:native:${input.threadId}`;
    this.nativeIds.set(input.threadId, nativeId);
    if (this.nativeReturn)
      this.ownership?.claim(
        nativeSessionIdentityKey(this.provider, 'a'.repeat(64), nativeId),
        input.threadId,
      );
    const now = new Date().toISOString();
    this.events.push({
      eventId: `${input.threadId}:started`,
      method: 'session.started',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      initialState: 'created',
      metadata: input.metadata,
    });
    this.events.push({
      eventId: `${input.threadId}:configured`,
      method: 'session.configured',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      metadata: {
        ...input.metadata,
        ...(this.nativeReturn
          ? {
              nativeResumeBindingKey: 'a'.repeat(64),
              ...(input.resumeCursor
                ? { nativeResumeIdentity: 'matched' }
                : {}),
            }
          : {}),
      },
    } as CanonicalRuntimeEvent);
    this.events.push({
      eventId: `${input.threadId}:started`,
      method: 'session.started',
      provider: this.provider,
      threadId: input.threadId,
      sessionId: input.threadId,
      createdAt: now,
      metadata: { ...input.metadata },
    });
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready' as const,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      createdAt: now,
      updatedAt: now,
      ...(this.nativeReturn
        ? { resumeCursor: { nativeSessionId: nativeId }, persistSession: true }
        : {}),
    };
    this.sessions.set(input.threadId, session);
    return session;
  }

  /** A live engine session keeps its own context across turns (#2540). */
  private readonly memory = new Map<string, string>();

  async sendTurn(input: ProviderSendTurnInput) {
    this.turns.push(input);
    const ordinal = this.turns.length + this.turnOrdinalOffset;
    const turnId = `${this.provider}-handoff-turn-${ordinal}`;
    const base = {
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      invocationId: input.invocationId,
      createdAt: new Date().toISOString(),
    } as const;
    this.events.push({
      ...base,
      eventId: `${turnId}:started`,
      method: 'turn.started',
      prompt: input.displayInput ?? input.input,
    });
    if (
      (this.failNextNativeReturn &&
        input.ambientContext?.includes(
          'Conversation while this engine was away',
        )) ||
      (this.failNextTranscriptSeed && input.ambientContext)
    ) {
      this.failNextNativeReturn = false;
      this.failNextTranscriptSeed = false;
      this.events.push({
        ...base,
        eventId: `${turnId}:failed`,
        method: 'runtime.error',
        severity: 'error',
        message: 'Scripted failure before processing the transcript seed.',
      });
      return { threadId: input.threadId, turnId };
    }
    const token =
      /HANDOFF-CARRY-[0-9]+/.exec(
        `${input.ambientContext ?? ''}\n${input.input}`,
      )?.[0] ??
      this.memory.get(this.nativeIds.get(input.threadId) ?? input.threadId);
    if (token)
      this.memory.set(
        this.nativeIds.get(input.threadId) ?? input.threadId,
        token,
      );
    this.events.push({
      ...base,
      eventId: `${turnId}:completed`,
      method: 'turn.completed',
      outputText: token
        ? `${this.provider} retained ${token}`
        : `${this.provider} CONTEXT_MISSING`,
    });
    return { threadId: input.threadId, turnId };
  }

  async interruptTurn() {
    return { outcome: 'no-active-turn' } as const;
  }
  async respondToRequest(): Promise<void> {}
  async stopSession(threadId: string): Promise<void> {
    this.stopped.add(threadId);
    if (!this.sessions.delete(threadId)) return;
    this.events.push({
      eventId: `${threadId}:exited`,
      provider: this.provider,
      threadId,
      sessionId: threadId,
      createdAt: new Date().toISOString(),
      method: 'session.exited',
      reason: 'stopped',
    });
    this.ownership?.retired(threadId);
  }
  async retireSession(threadId: string) {
    await this.stopSession(threadId);
    return { status: 'retired' as const };
  }
  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()].map((session) => {
      if (!this.nativeReturn) return session;
      const { resumeCursor: _cursor, ...snapshot } = session;
      return snapshot;
    });
  }
  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }
  async stopAll(): Promise<void> {
    for (const threadId of this.sessions.keys())
      await this.stopSession(threadId);
  }
  streamEvents(options?: { signal?: AbortSignal }) {
    return this.events.iterable(options);
  }
}

export function continuityRegistry(
  adapters: readonly TerminalHandoffAdapter[],
): IProviderAdapterRegistry {
  return {
    register() {},
    get(provider) {
      return adapters.find((adapter) => adapter.provider === provider);
    },
    list() {
      return [...adapters];
    },
  };
}

export function continuityBinding(
  store: EventStore,
  conversationId: string,
): ExecutionSessionBinding | null {
  const current = store.conversationSessions(conversationId).at(-1);
  if (!current) return null;
  const reservation = store.readSessionByThread(current.sessionId)
    ? undefined
    : store.conversationHandoffForSession(current.sessionId);
  const bindingSessionId =
    reservation?.predecessorSessionId ?? current.sessionId;
  const configured = store
    .listEvents(bindingSessionId)
    .map((item) => item.payload)
    .reverse()
    .find((event) => event.method === 'session.configured');
  const metadata = configured?.metadata;
  const boundAgent =
    reservation?.targetAgentId ??
    (typeof metadata?.agentId === 'string'
      ? metadata.agentId
      : typeof metadata?.targetId === 'string'
        ? metadata.targetId
        : undefined);
  if (!metadata || typeof metadata.environmentId !== 'string' || !boundAgent)
    return null;
  const session = store
    .readSessions()
    .find((item) => item.threadId === bindingSessionId);
  const executionAgentId = reservation
    ? reservation.targetExecutionAgentId
    : metadata.executionAgentId;
  const connectionId = reservation
    ? reservation.targetConnectionId
    : metadata.connectionId;
  return {
    environmentId: reservation?.targetEnvironmentId ?? metadata.environmentId,
    agentId: boundAgent,
    ...(typeof executionAgentId === 'string' ? { executionAgentId } : {}),
    ...(typeof connectionId === 'string' ? { connectionId } : {}),
    ...(typeof metadata.userId === 'string' ? { userId: metadata.userId } : {}),
    ...(typeof session?.cwd === 'string' ? { cwd: session.cwd } : {}),
  };
}
