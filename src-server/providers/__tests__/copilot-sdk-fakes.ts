/**
 * A fake of the Copilot SDK slice the adapter uses (`copilot-sdk-port.ts`),
 * shared by the adapter's own tests and the cross-adapter conformance suites.
 *
 * It calls the same `SessionConfig` callbacks the real SDK calls (`onEvent`,
 * and `onPermissionRequest` with its second `invocation` argument). Every
 * event is typed as the SDK's own `SessionEvent` from `@github/copilot-sdk`
 * 1.0.32 (`dist/generated/session-events.d.ts`; github/copilot-sdk
 * `nodejs/src/generated/session-events.ts`), so a fixture that drifts from
 * the SDK's wire shape fails the typecheck. Nothing here spawns a process.
 */
import type {
  MessageOptions,
  ModelInfo,
  PermissionRequest,
  PermissionRequestResult,
  ResumeSessionConfig,
  SessionConfig,
  SessionEvent,
} from '@github/copilot-sdk';
import type { ProviderRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { CopilotSdkAdapter } from '../adapters/copilot-sdk-adapter.js';
import type {
  CopilotHistoryRewindRequest,
  CopilotHistoryRewindResult,
  CopilotPermissionModeResult,
  CopilotSdkClientPort,
  CopilotSdkSessionPort,
} from '../adapters/copilot-sdk-port.js';

type AnyConfig = SessionConfig | ResumeSessionConfig;

export class FakeCopilotSession implements CopilotSdkSessionPort {
  readonly sends: MessageOptions[] = [];
  readonly rewinds: CopilotHistoryRewindRequest[] = [];
  readonly restarted: string[] = [];
  aborts = 0;
  abortFails = false;
  disconnected = false;
  permissionModeResult: CopilotPermissionModeResult = {
    success: true,
    mode: 'manual',
  };
  persisted: SessionEvent[] = [];
  rewindResult: CopilotHistoryRewindResult = {
    outcome: 'success',
    eventsRemoved: 4,
    restoredFiles: [],
    skippedFiles: [],
  };
  /** Runs before `send()` resolves: the runtime can answer before admission returns. */
  onSend?: (messageId: string, options: MessageOptions) => void;
  /** Runs when `abort()` is accepted: the runtime's own reaction to it. */
  onAbort?: () => void;
  private eventSeq = 0;

  constructor(
    readonly sessionId: string,
    readonly config: AnyConfig,
  ) {}

  /** Delivers one runtime event through the SDK's `onEvent` callback. */
  emit(event: SessionEvent): void {
    this.config.onEvent?.(event);
  }

  /** Raises a permission request the way the SDK calls its handler. */
  ask(
    request: PermissionRequest,
    invocation: { promptRequest?: unknown } = {},
  ): Promise<PermissionRequestResult> {
    return Promise.resolve(
      this.config.onPermissionRequest!(request, {
        sessionId: this.sessionId,
        ...invocation,
      } as never),
    ) as Promise<PermissionRequestResult>;
  }

  nextEventId(): string {
    this.eventSeq += 1;
    return `evt-${this.eventSeq}`;
  }

  async getEvents(): Promise<SessionEvent[]> {
    return this.persisted;
  }
  async send(options: MessageOptions): Promise<string> {
    this.sends.push(options);
    const messageId = `msg-${this.sends.length}`;
    this.onSend?.(messageId, options);
    return messageId;
  }
  async abort(): Promise<void> {
    this.aborts += 1;
    if (this.abortFails) throw new Error('Connection is closed.');
    this.onAbort?.();
  }
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
  async rewind(
    request: CopilotHistoryRewindRequest,
  ): Promise<CopilotHistoryRewindResult> {
    this.rewinds.push(request);
    return this.rewindResult;
  }
  async restartMcpServer(serverName: string): Promise<void> {
    this.restarted.push(serverName);
  }
}

export class FakeCopilotClient implements CopilotSdkClientPort {
  readonly created: FakeCopilotSession[] = [];
  readonly resumed: Array<{ id: string; session: FakeCopilotSession }> = [];
  stopped = 0;
  /** Events the runtime emits while `createSession`/`resumeSession` runs. */
  duringStart: SessionEvent[] = [];
  /** Shapes each new session before it is returned. */
  prepare: (session: FakeCopilotSession) => void = () => undefined;
  models: ModelInfo[] = [];
  private onLost?: (error: unknown) => void;

  /** The runtime process dies: the connection watch reports it. */
  loseConnection(): void {
    this.onLost?.(new Error('Connection is closed.'));
  }

  private open(id: string, config: AnyConfig): FakeCopilotSession {
    const session = new FakeCopilotSession(id, config);
    this.prepare(session);
    for (const event of this.duringStart) session.emit(event);
    return session;
  }
  async createSession(config: SessionConfig): Promise<CopilotSdkSessionPort> {
    const session = this.open('copilot-session-1', config);
    this.created.push(session);
    return session;
  }
  async resumeSession(
    id: string,
    config: ResumeSessionConfig,
  ): Promise<CopilotSdkSessionPort> {
    const session = this.open(id, config);
    this.resumed.push({ id, session });
    return session;
  }
  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
  watchConnection(onLost: (error: unknown) => void): () => void {
    this.onLost = onLost;
    return () => {
      this.onLost = undefined;
    };
  }
  async stop(): Promise<Error[]> {
    this.stopped += 1;
    return [];
  }
}

const TIME = '2026-11-13T12:00:00.000Z';

/**
 * The adapter on the fake, preview on, with a runtime that echoes every sent
 * message as its `user.message` and answers an abort with an aborted idle, as
 * a live runtime does. For the conformance suites.
 */
export function scriptedCopilotSdkEngine(cwd: string) {
  const client = new FakeCopilotClient();
  const adapter = new CopilotSdkAdapter({
    preview: { select: (branches) => branches.enabled() },
    clientFactory: async () => client,
    resolveCliPath: () => '/opt/copilot/bin/copilot',
    env: { COPILOT_HOME: `${cwd}/.copilot-home`, PATH: '/usr/bin' },
    interruptSettleMs: 30,
  });
  client.prepare = (session) => {
    session.onSend = (messageId, options) => {
      if (options.mode !== 'enqueue') return;
      queueMicrotask(() =>
        session.emit({
          type: 'user.message',
          id: session.nextEventId(),
          parentId: null,
          timestamp: TIME,
          data: {
            content: options.prompt,
            clientTurnId: options.clientTurnId,
            messageId,
          },
        }),
      );
    };
    session.onAbort = () =>
      queueMicrotask(() =>
        session.emit({
          type: 'session.idle',
          id: session.nextEventId(),
          parentId: null,
          timestamp: TIME,
          ephemeral: true,
          data: { aborted: true },
        }),
      );
  };
  const current = () => client.created.at(-1)!;
  const emit = (event: SessionEvent) => current().emit(event);
  return {
    adapter,
    client,
    current,
    start: () =>
      adapter.startSession({
        threadId: 'conformance-thread',
        provider: 'copilot-sdk',
        cwd,
      }),
    text: (value: string) =>
      emit({
        type: 'assistant.message_delta',
        id: current().nextEventId(),
        parentId: null,
        timestamp: TIME,
        ephemeral: true,
        data: { messageId: 'reply', deltaContent: value },
      }),
    complete: () =>
      emit({
        type: 'session.idle',
        id: current().nextEventId(),
        parentId: null,
        timestamp: TIME,
        ephemeral: true,
        data: {},
      }),
    emit,
  };
}

/**
 * Replays `events` (the SDK's own event shapes) into one running turn of a
 * real adapter and returns everything it published, for the child-work
 * conformance driver.
 */
export async function replayCopilotSdkTurn(
  cwd: string,
  events: (session: FakeCopilotSession) => SessionEvent[],
): Promise<ProviderRuntimeEvent[]> {
  const engine = scriptedCopilotSdkEngine(cwd);
  const published: ProviderRuntimeEvent[] = [];
  const abort = new AbortController();
  const reader = (async () => {
    for await (const event of engine.adapter.streamEvents({
      signal: abort.signal,
    }))
      published.push(event);
  })();
  await engine.start();
  await engine.adapter.sendTurn({
    threadId: 'conformance-thread',
    input: 'run the subagents',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  for (const event of events(engine.current())) engine.emit(event);
  engine.complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await engine.adapter.stopAll();
  abort.abort();
  await reader;
  return published;
}
