/**
 * The Copilot SDK adapter driven through a fake of the SDK interface it uses
 * (`copilot-sdk-port.ts`). The fake calls the same `SessionConfig` callbacks
 * the real SDK calls (`onEvent`, `onPermissionRequest`), and every event and
 * request below is typed as the SDK's own `SessionEvent` / `PermissionRequest`
 * from `@github/copilot-sdk` 1.0.32 (`dist/generated/session-events.d.ts`;
 * github/copilot-sdk `nodejs/src/generated/session-events.ts`), so a fixture
 * that drifts from the SDK's wire shape fails the typecheck. No test here
 * spawns a process or reaches a Copilot service.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { foldUsageEvents } from '@kontourai/station-shared/usage-fold';
import { describe, expect, test } from 'vitest';
import { SessionStartRefusedError } from '../adapter-shape.js';
import {
  CopilotSdkAdapter,
  resolveCopilotCliLaunchPath,
} from '../adapters/copilot-sdk-adapter.js';
import type {
  CopilotHistoryRewindRequest,
  CopilotHistoryRewindResult,
  CopilotSdkClientPort,
  CopilotSdkLaunch,
  CopilotSdkSessionPort,
} from '../adapters/copilot-sdk-port.js';

const CWD = process.platform === 'win32' ? 'C:\\work\\repo' : '/work/repo';

type AnyConfig = SessionConfig | ResumeSessionConfig;

class FakeCopilotSession implements CopilotSdkSessionPort {
  readonly sends: MessageOptions[] = [];
  readonly rewinds: CopilotHistoryRewindRequest[] = [];
  readonly restarted: string[] = [];
  aborts = 0;
  disconnected = false;
  rewindResult: CopilotHistoryRewindResult = {
    outcome: 'success',
    eventsRemoved: 4,
    restoredFiles: [],
    skippedFiles: [],
  };
  private eventSeq = 0;

  constructor(
    readonly sessionId: string,
    readonly config: AnyConfig,
  ) {}

  /** Delivers one runtime event through the SDK's `onEvent` callback. */
  emit(event: SessionEvent): void {
    this.config.onEvent?.(event);
  }

  /** Raises a permission request the way the SDK's handler is called. */
  ask(request: PermissionRequest): Promise<PermissionRequestResult> {
    return Promise.resolve(
      this.config.onPermissionRequest!(request, { sessionId: this.sessionId }),
    ) as Promise<PermissionRequestResult>;
  }

  nextEventId(): string {
    this.eventSeq += 1;
    return `evt-${this.eventSeq}`;
  }

  async send(options: MessageOptions): Promise<string> {
    this.sends.push(options);
    return `msg-${this.sends.length}`;
  }
  async abort(): Promise<void> {
    this.aborts += 1;
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

class FakeCopilotClient implements CopilotSdkClientPort {
  readonly created: FakeCopilotSession[] = [];
  readonly resumed: Array<{ id: string; session: FakeCopilotSession }> = [];
  stopped = false;
  /** Events the runtime emits while `createSession`/`resumeSession` runs. */
  duringStart: SessionEvent[] = [];
  models: ModelInfo[] = [];

  async createSession(config: SessionConfig): Promise<CopilotSdkSessionPort> {
    const session = new FakeCopilotSession('copilot-session-1', config);
    for (const event of this.duringStart) session.emit(event);
    this.created.push(session);
    return session;
  }
  async resumeSession(
    id: string,
    config: ResumeSessionConfig,
  ): Promise<CopilotSdkSessionPort> {
    const session = new FakeCopilotSession(id, config);
    for (const event of this.duringStart) session.emit(event);
    this.resumed.push({ id, session });
    return session;
  }
  async listModels(): Promise<ModelInfo[]> {
    return this.models;
  }
  async stop(): Promise<Error[]> {
    this.stopped = true;
    return [];
  }
}

function previewSwitch(initial: boolean) {
  const state = { enabled: initial };
  return {
    state,
    selector: {
      select: <T>(branches: { enabled: () => T; disabled: () => T }): T =>
        state.enabled ? branches.enabled() : branches.disabled(),
    },
  };
}

function harness(options: { enabled?: boolean } = {}) {
  const preview = previewSwitch(options.enabled ?? true);
  const client = new FakeCopilotClient();
  const launches: CopilotSdkLaunch[] = [];
  let id = 0;
  const adapter = new CopilotSdkAdapter({
    preview: preview.selector,
    clientFactory: async (launch) => {
      launches.push(launch);
      return client;
    },
    resolveCliPath: () => '/opt/copilot/bin/copilot',
    env: { COPILOT_HOME: '/home/someone/.copilot', PATH: '/usr/bin' },
    newId: () => `id-${++id}`,
    interruptSettleMs: 20,
  });
  const events: ProviderRuntimeEvent[] = [];
  const pump = (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { adapter, client, launches, events, preview, pump, settle };
}

function at(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 13, 12, 0, seconds)).toISOString();
}

function userMessage(
  session: FakeCopilotSession,
  clientTurnId: string,
  content: string,
): SessionEvent {
  return {
    type: 'user.message',
    id: session.nextEventId(),
    parentId: null,
    timestamp: at(1),
    data: { content, clientTurnId },
  };
}

function idle(session: FakeCopilotSession, aborted = false): SessionEvent {
  return {
    type: 'session.idle',
    id: session.nextEventId(),
    parentId: null,
    timestamp: at(9),
    ephemeral: true,
    data: aborted ? { aborted: true } : {},
  };
}

async function startedTurn(h: ReturnType<typeof harness>, prompt = 'hello') {
  await h.adapter.startSession({
    threadId: 'thread-1',
    provider: 'copilot-sdk',
    cwd: CWD,
  });
  const session = h.client.created[0]!;
  const turn = await h.adapter.sendTurn({
    threadId: 'thread-1',
    input: prompt,
  });
  session.emit(userMessage(session, turn.turnId, prompt));
  return { session, turnId: turn.turnId };
}

const methods = (events: ProviderRuntimeEvent[]) =>
  events.map((event) => event.method);

describe('Copilot SDK adapter: Feature Preview gate', () => {
  test('refuses a start while the preview is off and launches nothing', async () => {
    const h = harness({ enabled: false });
    await expect(
      h.adapter.startSession({
        threadId: 't',
        provider: 'copilot-sdk',
        cwd: CWD,
      }),
    ).rejects.toMatchObject({
      name: 'SessionStartRefusedError',
      code: 'feature_preview_disabled',
    });
    expect(h.launches).toHaveLength(0);
    const prerequisites = await h.adapter.getPrerequisites();
    expect(prerequisites).toEqual([
      expect.objectContaining({ id: 'copilot-sdk-preview', status: 'missing' }),
    ]);
    expect(await h.adapter.listModels()).toEqual([]);
  });

  test('a choice changed after composition applies to the next operation', async () => {
    const h = harness({ enabled: false });
    await expect(
      h.adapter.startSession({
        threadId: 't',
        provider: 'copilot-sdk',
        cwd: CWD,
      }),
    ).rejects.toBeInstanceOf(SessionStartRefusedError);
    h.preview.state.enabled = true;
    await h.adapter.startSession({
      threadId: 't',
      provider: 'copilot-sdk',
      cwd: CWD,
    });
    expect(h.launches).toHaveLength(1);
    h.preview.state.enabled = false;
    await expect(
      h.adapter.sendTurn({ threadId: 't', input: 'more' }),
    ).rejects.toMatchObject({ kind: 'unavailable' });
    // Stopping stays available so nothing is stranded.
    await h.adapter.stopSession('t');
    expect(h.client.stopped).toBe(true);
  });
});

describe('Copilot SDK adapter: session create and resume', () => {
  test('creates a manual-permission, file-tracking session on the given CLI', async () => {
    const h = harness();
    const session = await h.adapter.startSession({
      threadId: 'thread-1',
      provider: 'copilot-sdk',
      cwd: CWD,
      modelId: 'gpt-5',
    });
    expect(h.launches[0]).toMatchObject({
      cliPath: '/opt/copilot/bin/copilot',
      cwd: CWD,
    });
    const config = h.client.created[0]!.config as SessionConfig;
    expect(config).toMatchObject({
      workingDirectory: CWD,
      permissionMode: 'manual',
      enableFileChangeTracking: true,
      streaming: true,
      includeSubAgentStreamingEvents: false,
      model: 'gpt-5',
    });
    expect(config.cloud).toBeUndefined();
    expect(session.resumeCursor).toEqual({
      copilotSessionId: 'copilot-session-1',
    });
    await h.settle();
    const configured = h.events.find((e) => e.method === 'session.configured');
    expect(configured).toMatchObject({
      sessionId: 'copilot-session-1',
      metadata: { approvalMode: 'ask' },
    });
    expect(
      (configured as { metadata: Record<string, unknown> }).metadata
        .nativeResumeBindingKey,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  test('resumes the session its cursor names', async () => {
    const h = harness();
    await h.adapter.startSession({
      threadId: 'thread-1',
      provider: 'copilot-sdk',
      cwd: CWD,
      resumeCursor: { copilotSessionId: 'earlier-session' },
    });
    expect(h.client.created).toHaveLength(0);
    expect(h.client.resumed.map((entry) => entry.id)).toEqual([
      'earlier-session',
    ]);
  });

  test('refuses a resume recorded under another configuration home', async () => {
    const h = harness();
    await expect(
      h.adapter.startSession({
        threadId: 'thread-1',
        provider: 'copilot-sdk',
        cwd: CWD,
        resumeCursor: { copilotSessionId: 'earlier-session' },
        nativeResumeBindingKey: '0'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'session_recovery_failed' });
    expect(h.launches).toHaveLength(0);
  });

  test('replays events the runtime sent while a resume was still connecting', async () => {
    const h = harness();
    h.client.duringStart = [
      {
        type: 'session.mcp_servers_loaded',
        id: 'evt-start-1',
        parentId: null,
        timestamp: at(0),
        ephemeral: true,
        data: {
          servers: [
            { name: 'github', status: 'connected' },
            { name: 'docs', status: 'needs-auth' },
          ],
        },
      },
    ];
    await h.adapter.startSession({
      threadId: 'thread-1',
      provider: 'copilot-sdk',
      cwd: CWD,
      resumeCursor: { copilotSessionId: 'earlier-session' },
    });
    await h.settle();
    expect(methods(h.events)).toEqual([
      'session.started',
      'session.configured',
      'engine-mcp.status',
    ]);
    expect(h.events[2]).toMatchObject({
      complete: true,
      servers: [
        { name: 'github', state: 'ready', scope: 'session' },
        { name: 'docs', state: 'needs-auth', scope: 'session' },
      ],
    });
  });
});

describe('Copilot SDK adapter: turns', () => {
  test('streams text, a tool call and usage, and completes on session.idle', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h, 'list the files');
    expect(session.sends).toEqual([
      { prompt: 'list the files', mode: 'enqueue', clientTurnId: turnId },
    ]);
    session.emit({
      type: 'assistant.message_delta',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(2),
      ephemeral: true,
      data: { messageId: 'm1', deltaContent: 'Looking' },
    });
    session.emit({
      type: 'tool.execution_start',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(3),
      data: {
        toolCallId: 'call-1',
        toolName: 'bash',
        arguments: { command: 'ls' },
        shellToolInfo: { hasWriteFileRedirection: false, possiblePaths: [] },
      },
    });
    session.emit({
      type: 'tool.execution_complete',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(4),
      data: {
        toolCallId: 'call-1',
        success: true,
        result: { content: 'a.txt\nb.txt' },
      },
    });
    session.emit({
      type: 'assistant.message',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(5),
      data: { messageId: 'm1', content: 'Looking' },
    });
    session.emit({
      type: 'assistant.usage',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(6),
      ephemeral: true,
      data: { model: 'gpt-5', inputTokens: 100, outputTokens: 20 },
    });
    session.emit(idle(session));
    await h.settle();
    const turnEvents = h.events.filter((e) => e.turnId === turnId);
    expect(methods(turnEvents)).toEqual([
      'turn.started',
      'content.text-delta',
      'tool.started',
      'tool.completed',
      'token-usage.updated',
      'turn.completed',
    ]);
    expect(turnEvents[2]).toMatchObject({
      toolName: 'bash',
      toolKind: 'execute',
    });
    expect(turnEvents[3]).toMatchObject({
      status: 'success',
      output: 'a.txt\nb.txt',
    });
  });

  test('folds each model call, a subagent call included, into the turn total', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    for (const [input, output, agentId] of [
      [100, 20, undefined],
      [40, 10, 'sub-1'],
    ] as const) {
      session.emit({
        type: 'assistant.usage',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(6),
        ephemeral: true,
        ...(agentId ? { agentId } : {}),
        data: { model: 'gpt-5', inputTokens: input, outputTokens: output },
      });
    }
    session.emit(idle(session));
    await h.settle();
    const usage = h.events.filter(
      (e) => e.turnId === turnId && e.method === 'token-usage.updated',
    );
    expect(usage).toHaveLength(2);
    const folded = foldUsageEvents(
      h.events.filter((e) => e.method === 'token-usage.updated'),
    );
    expect(folded).toMatchObject({
      inputTokens: 140,
      outputTokens: 30,
      totalTokens: 170,
    });
  });

  test('a session.error ends the turn with an error', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit({
      type: 'session.error',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(3),
      data: { errorType: 'authentication', message: 'Not signed in.' },
    });
    await h.settle();
    const turnEvents = h.events.filter((e) => e.turnId === turnId);
    expect(methods(turnEvents)).toEqual([
      'turn.started',
      'runtime.error',
      'turn.aborted',
    ]);
    expect(turnEvents[1]).toMatchObject({ message: 'Not signed in.' });
  });

  test('steers into the running turn and refuses a turn that ended', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    await h.adapter.steerTurn('thread-1', ' also check tests ', turnId);
    expect(session.sends[1]).toEqual({
      prompt: 'also check tests',
      mode: 'immediate',
    });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      method: 'turn.started',
      turnId,
      inputKind: 'steer',
    });
    session.emit(idle(session));
    await expect(
      h.adapter.steerTurn('thread-1', 'late', turnId),
    ).rejects.toMatchObject({ name: 'ProviderTurnEndedError' });
  });

  test('an interrupt aborts and is confirmed by the aborted idle', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    const result = h.adapter.interruptTurn('thread-1', turnId);
    await h.settle();
    expect(session.aborts).toBe(1);
    session.emit(idle(session, true));
    await expect(result).resolves.toEqual({ outcome: 'cancelled', turnId });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({ method: 'turn.aborted', turnId });
  });

  test('an interrupt the runtime never confirms reads as unconfirmed', async () => {
    const h = harness();
    const { turnId } = await startedTurn(h);
    await expect(h.adapter.interruptTurn('thread-1', turnId)).resolves.toEqual({
      outcome: 'termination-unconfirmed',
      turnId,
    });
  });
});

describe('Copilot SDK adapter: approvals', () => {
  const shell: PermissionRequest = {
    kind: 'shell',
    canOfferSessionApproval: true,
    commands: [],
    fullCommandText: 'npm test',
    hasWriteFileRedirection: false,
    intention: 'Run the tests',
    possiblePaths: [],
    possibleUrls: [],
    toolCallId: 'call-9',
  };

  test('a person allows a command: request.opened, then approve-once', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    const answer = session.ask(shell);
    await h.settle();
    const opened = h.events.find((e) => e.method === 'request.opened');
    expect(opened).toMatchObject({
      requestType: 'approval',
      title: 'Run a command',
      payload: {
        toolName: 'shell',
        toolInput: { command: 'npm test', intention: 'Run the tests' },
      },
    });
    await h.adapter.respondToRequest(
      'thread-1',
      (opened as { requestId: string }).requestId,
      'accept',
    );
    await expect(answer).resolves.toEqual({ kind: 'approve-once' });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      method: 'request.resolved',
      status: 'approved',
      acknowledgement: 'in-process',
    });
  });

  test('a person declines: the runtime is told reject', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    const answer = session.ask(shell);
    await h.settle();
    const opened = h.events.find((e) => e.method === 'request.opened') as {
      requestId: string;
    };
    await h.adapter.respondToRequest('thread-1', opened.requestId, 'decline');
    await expect(answer).resolves.toEqual({ kind: 'reject' });
  });

  test('allow-for-session covers the same command without asking again', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    const first = session.ask(shell);
    await h.settle();
    const opened = h.events.find((e) => e.method === 'request.opened') as {
      requestId: string;
    };
    await h.adapter.respondToRequest(
      'thread-1',
      opened.requestId,
      'acceptForSession',
    );
    await expect(first).resolves.toEqual({ kind: 'approve-once' });
    await expect(session.ask(shell)).resolves.toEqual({ kind: 'approve-once' });
    // A different command is not covered by that grant.
    void session.ask({ ...shell, fullCommandText: 'rm -rf build' });
    await h.settle();
    expect(h.events.filter((e) => e.method === 'request.opened')).toHaveLength(
      2,
    );
  });

  test('auto mode allows a write inside the working directory only', async () => {
    const h = harness();
    await h.adapter.startSession({
      threadId: 'thread-1',
      provider: 'copilot-sdk',
      cwd: CWD,
      modelOptions: { approvalMode: 'auto' },
    });
    const session = h.client.created[0]!;
    const write = (fileName: string): PermissionRequest => ({
      kind: 'write',
      canOfferSessionApproval: true,
      diff: '+x',
      fileName,
      intention: 'Edit',
    });
    await expect(session.ask(write('src/a.ts'))).resolves.toEqual({
      kind: 'approve-once',
    });
    void session.ask(write('../outside.ts'));
    await h.settle();
    expect(h.events.filter((e) => e.method === 'request.opened')).toHaveLength(
      1,
    );
  });

  test('full access outside a host session still asks before a command', async () => {
    const h = harness();
    await h.adapter.startSession({
      threadId: 'thread-1',
      provider: 'copilot-sdk',
      cwd: CWD,
      modelOptions: { approvalMode: 'never' },
      confinement: 'workspace',
    });
    const session = h.client.created[0]!;
    void session.ask(shell);
    await h.settle();
    expect(h.events.some((e) => e.method === 'request.opened')).toBe(true);
  });

  test('stopping the session answers its open requests', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    const answer = session.ask(shell);
    await h.adapter.stopSession('thread-1');
    await expect(answer).resolves.toEqual({ kind: 'user-not-available' });
    expect(session.disconnected).toBe(true);
    expect(h.client.stopped).toBe(true);
  });
});

describe('Copilot SDK adapter: subagents', () => {
  test('a subagent is child work from started to completed', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit({
      type: 'subagent.started',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(2),
      data: {
        toolCallId: 'task-1',
        agentName: 'explore',
        agentDisplayName: 'Explore',
        agentDescription: 'Find the tests',
      },
    });
    session.emit({
      type: 'subagent.completed',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(5),
      data: {
        toolCallId: 'task-1',
        agentName: 'explore',
        agentDisplayName: 'Explore',
        totalTokens: 900,
        totalToolCalls: 4,
        durationMs: 3000,
      },
    });
    await h.settle();
    const deltas = h.events
      .filter((e) => e.method === 'child-work.updated')
      .map((e) => (e as { delta: Record<string, unknown> }).delta);
    expect(deltas).toEqual([
      expect.objectContaining({
        kind: 'upsert',
        item: expect.objectContaining({
          producer: 'engine-subagent',
          reporterThreadId: 'thread-1',
          childId: 'task-1',
          status: 'running',
          title: 'Find the tests',
          parent: expect.objectContaining({ turnId, toolCallId: 'task-1' }),
        }),
      }),
      expect.objectContaining({
        kind: 'settle',
        childId: 'task-1',
        status: 'completed',
        usage: { totalTokens: 900, toolUses: 4, durationMs: 3000 },
      }),
    ]);
  });

  test('a subagent still open when its turn ends is settled unresolved', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    session.emit({
      type: 'subagent.started',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(2),
      data: {
        toolCallId: 'task-2',
        agentName: 'task',
        agentDisplayName: 'Task',
        agentDescription: 'Background work',
      },
    });
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(true);
    session.emit(idle(session));
    await h.settle();
    const settle = h.events.find(
      (e) =>
        e.method === 'child-work.updated' &&
        (e as { delta: { kind: string } }).delta.kind === 'settle',
    );
    expect(settle).toMatchObject({
      delta: { childId: 'task-2', status: 'unresolved' },
    });
    expect(h.adapter.hasOpenEngineWork('thread-1')).toBe(false);
  });

  test('subagent text and tool calls stay out of the parent transcript', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    session.emit({
      type: 'tool.execution_start',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(3),
      data: {
        toolCallId: 'inner',
        toolName: 'view',
        parentToolCallId: 'task-1',
      },
    });
    session.emit({
      type: 'assistant.message',
      id: session.nextEventId(),
      parentId: null,
      timestamp: at(4),
      agentId: 'sub-1',
      data: { messageId: 'inner-m', content: 'child says hi' },
    });
    await h.settle();
    expect(methods(h.events.filter((e) => e.turnId === turnId))).toEqual([
      'turn.started',
    ]);
  });
});

describe('Copilot SDK adapter: rewind', () => {
  async function twoTurns(h: ReturnType<typeof harness>) {
    const { session, turnId: first } = await startedTurn(h, 'one');
    session.emit(idle(session));
    const second = await h.adapter.sendTurn({
      threadId: 'thread-1',
      input: 'two',
    });
    session.emit(userMessage(session, second.turnId, 'two'));
    session.emit(idle(session));
    return { session, first, second: second.turnId };
  }

  test('rewinds to before a turn at its user.message event and restores files', async () => {
    const h = harness();
    const { session, first, second } = await twoTurns(h);
    session.rewindResult = {
      outcome: 'success',
      eventsRemoved: 6,
      restoredFiles: [`${CWD}/src/a.ts`],
      skippedFiles: [],
    };
    const outcome = await h.adapter.rewindSession('thread-1', first);
    // The user.message event of the first turn was the first event emitted.
    expect(session.rewinds).toEqual([
      { eventId: 'evt-1', mode: 'conversation-and-files' },
    ]);
    expect(outcome).toEqual({
      kind: 'rewound',
      beforeTurnId: first,
      hiddenTurnIds: [first, second],
      affectedFiles: { count: 1, paths: [`${CWD}/src/a.ts`] },
    });
    await h.settle();
    expect(h.events.at(-1)).toMatchObject({
      method: 'runtime.warning',
      code: 'acp.session-rewound',
      details: { beforeTurnId: first, hiddenTurnIds: [first, second] },
    });
    // A hidden turn is no longer a rewind point.
    await expect(h.adapter.rewindSession('thread-1', second)).resolves.toEqual({
      kind: 'refused',
      reason: 'unknown-turn',
    });
  });

  test('refuses while a turn runs, and reports the runtime refusing', async () => {
    const h = harness();
    const { session, turnId } = await startedTurn(h);
    await expect(h.adapter.rewindSession('thread-1', turnId)).resolves.toEqual({
      kind: 'refused',
      reason: 'turn-running',
    });
    expect(session.rewinds).toHaveLength(0);
    session.emit(idle(session));
    session.rewindResult = {
      outcome: 'files-rolled-back',
      restoredFiles: [],
      skippedFiles: [],
      error: 'disk full',
    };
    await expect(h.adapter.rewindSession('thread-1', turnId)).resolves.toEqual({
      kind: 'failed',
      message: 'Copilot could not rewind (files-rolled-back): disk full.',
    });
  });
});

describe('Copilot SDK adapter: which CLI file the SDK is given', () => {
  test('maps an npm .cmd shim to the package loader beside it, or to nothing', () => {
    const prefix = mkdtempSync(join(tmpdir(), 'copilot-cli-shim-'));
    try {
      const shim = join(prefix, 'copilot.cmd');
      writeFileSync(shim, '@echo off\r\n');
      // No package beside the shim: nothing the SDK could spawn.
      expect(resolveCopilotCliLaunchPath(shim)).toBeNull();
      const pkg = join(prefix, 'node_modules', '@github', 'copilot');
      mkdirSync(pkg, { recursive: true });
      writeFileSync(join(pkg, 'npm-loader.js'), '');
      expect(resolveCopilotCliLaunchPath(shim)).toBe(
        join(pkg, 'npm-loader.js'),
      );
      // An executable is handed over as found.
      const exe = join(prefix, 'copilot.exe');
      expect(resolveCopilotCliLaunchPath(exe)).toBe(exe);
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});

// Registration is a plain array entry and a preview bind in runtime
// composition; an omission is silent everywhere except here.
describe('Copilot SDK adapter: registration', () => {
  const read = (path: string) =>
    readFileSync(new URL(path, import.meta.url), 'utf8');

  test('the runtime registers the adapter and binds its preview', () => {
    const initialize = read('../../runtime/bootstrap/runtime-initialize.ts');
    const registration = initialize.match(
      /registerProviderAdapters\(\s*\[([\s\S]*?)\]/,
    );
    expect(registration).not.toBeNull();
    expect(registration![1].split(',').map((entry) => entry.trim())).toContain(
      'copilotSdkAdapter',
    );
    const runtime = read('../../runtime/bootstrap/station-runtime.ts');
    expect(runtime).toMatch(
      /this\.copilotSdkPreview = this\.featurePreviews\.bind\(\{\s*id: 'copilot-sdk-engine'/,
    );
    expect(runtime).toMatch(
      /id: 'copilot-sdk',\s*cli: 'copilot',\s*allowed: \(\) => this\.copilotSdkAdapter\.previewEnabled\(\)/,
    );
  });
});

describe('Copilot SDK adapter: MCP status and reroutes', () => {
  test('restarts one MCP server on request', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    await expect(
      h.adapter.reconnectMcpServer('thread-1', 'github', { startOAuth: false }),
    ).resolves.toEqual({ kind: 'answered', success: true });
    expect(session.restarted).toEqual(['github']);
  });

  test('an automatic model change is a reroute; a person’s is not', async () => {
    const h = harness();
    const { session } = await startedTurn(h);
    for (const source of ['automatic', 'model_picker'] as const) {
      session.emit({
        type: 'session.model_change',
        id: session.nextEventId(),
        parentId: null,
        timestamp: at(3),
        data: {
          previousModel: 'gpt-5',
          newModel: 'gpt-5-mini',
          source,
          cause: 'rate limit',
        },
      });
    }
    await h.settle();
    const reroutes = h.events.filter((e) => e.method === 'model.rerouted');
    expect(reroutes).toEqual([
      expect.objectContaining({
        fromModel: 'gpt-5',
        toModel: 'gpt-5-mini',
        trigger: 'availability',
        scope: 'session',
      }),
    ]);
  });
});
