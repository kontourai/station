import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import {
  agent as agentApp,
  ndJsonStream,
} from '@agentclientprotocol/sdk/unstable';
import type { ACPConnectionConfig } from '@kontourai/station-contracts/acp';
import {
  inputRequestFromRequestEvent,
  validateInputRequestContent,
} from '@kontourai/station-shared/input-request';
import { describe, expect, test } from 'vitest';
import { GROK_LIVE_CAPTURE } from '../../../src-shared/extension-notification-bindings.js';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { createACPClientApp } from '../../services/acp/acp-bridge-client.js';
import type { ACPProcess } from '../../services/acp/acp-process.js';
import type { CanonicalRuntimeEvent } from '../adapter-shape.js';
import { AcpAdapter } from '../adapters/acp-adapter.js';
import { FakeAcpProcess } from './fake-acp-process.js';

/**
 * Grok Build over ACP, driven through the real AcpAdapter: its own Client
 * serves a real client app, and a real agent app sends frames taken verbatim
 * from the scrubbed grok 1.0.77 live capture (`GROK_LIVE_CAPTURE`) over
 * ndjson. The capture's session is mapped onto the fake process's session;
 * any other session in it (a subagent's own) stays foreign.
 */

const makeTempDir = trackTempDirs();

const CONNECTIONS: ACPConnectionConfig[] = [
  {
    id: 'grok-lab',
    name: 'Grok Lab',
    command: 'grok',
    args: ['agent', 'stdio'],
    enabled: true,
  },
];

/** What grok 1.0.77 puts in its `initialize` result's `_meta` that identifies it. */
const GROK_INITIALIZE_META = { grokShell: true, agentVersion: '1.0.77' };

type Frame = { method?: string; id?: unknown; params?: any; result?: any };

function captureFrames(capture: string): Frame[] {
  return readFileSync(
    new URL(`../../../${GROK_LIVE_CAPTURE}`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.capture === capture && entry.dir === 'E->C')
    .map((entry) => entry.msg as Frame);
}

/** The capture's own session id: the one its first session frame names. */
function captureSessionId(frames: Frame[]): string {
  const id = frames.find((msg) => typeof msg.params?.sessionId === 'string')
    ?.params.sessionId;
  if (!id) throw new Error('capture names no session');
  return id;
}

/** `value` with every `from` string replaced by `to`, at any depth. */
function renamed<T>(value: T, from: string, to: string): T {
  return JSON.parse(JSON.stringify(value).replaceAll(from, to));
}

async function startGrokSession(
  options: {
    grok?: boolean;
    unattended?: boolean;
    /** MCP servers Station passes the session (as an agent's tool servers). */
    toolServers?: Array<{ id: string; command: string }>;
  } = {},
) {
  let proc: FakeAcpProcess | undefined;
  const exits = new EventEmitter();
  const warnings: unknown[][] = [];
  const adapter = new AcpAdapter({
    getConnections: async () => CONNECTIONS,
    logger: {
      debug: () => {},
      warn: (...args: unknown[]) => warnings.push(args),
      error: () => {},
      info: () => {},
    },
    managedWorkspaceHomeDir: makeTempDir('station-acp-grok-test-'),
    processFactory: (opts) => {
      proc = new FakeAcpProcess(opts);
      // The adapter listens for the engine's own exit through `once`.
      Object.assign(proc, {
        once: (event: string, listener: () => void) =>
          exits.once(event, listener),
      });
      if (options.grok !== false)
        proc.initResult!._meta = { ...GROK_INITIALIZE_META };
      return proc as unknown as ACPProcess;
    },
  });
  const events: CanonicalRuntimeEvent[] = [];
  const drained = (async () => {
    for await (const event of adapter.streamEvents()) events.push(event);
  })();
  const threadId = `grok-${crypto.randomUUID()}`;
  await adapter.startSession({
    provider: 'acp',
    threadId,
    cwd: '/tmp/project',
    metadata: {
      connectionId: 'grok-lab',
      ...(options.unattended
        ? {
            delegation: {
              mode: 'isolated-child',
              depth: 1,
              maxDepth: 2,
              parentAgentSlug: 'parent',
              rootAgentSlug: 'parent',
              denyApprovals: true,
            },
          }
        : {}),
    },
    ...(options.toolServers
      ? {
          agent: {
            slug: 'grok-agent',
            toolServers: options.toolServers.map(({ id, command }) => ({
              id,
              transport: 'stdio' as const,
              command,
              args: [],
            })),
          },
        }
      : {}),
  });
  if (!proc?.client || !proc.sessionId)
    throw new Error('adapter did not build a Client and session');
  const clientToAgent = new TransformStream<Uint8Array, Uint8Array>();
  const agentToClient = new TransformStream<Uint8Array, Uint8Array>();
  createACPClientApp(proc.client).connect(
    ndJsonStream(clientToAgent.writable, agentToClient.readable),
  );
  const agent = agentApp().connect(
    ndJsonStream(agentToClient.writable, clientToAgent.readable),
  ).client;
  const sessionId = proc.sessionId;
  const fake = proc;

  async function waitFor<T extends CanonicalRuntimeEvent>(
    predicate: (event: CanonicalRuntimeEvent) => event is T,
    label: string,
  ): Promise<T> {
    // A deadline-bounded wait for the event itself; the bound only decides
    // how long a missing event takes to fail.
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const found = events.find(predicate);
      if (found) return found;
      // real-time: polls for the awaited event under a wall-clock deadline.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${label}`);
  }

  /**
   * Send a capture's engine notifications in order, as this session's. A
   * frame answering the capture's `session/prompt` resolves Station's open
   * prompt with the recorded stop reason; the engine's own requests are not
   * replayed.
   */
  async function replay(capture: string, promptRequestId?: number) {
    const frames = captureFrames(capture);
    const own = captureSessionId(frames);
    for (const raw of frames) {
      const msg = renamed(raw, own, sessionId);
      if (msg.id !== undefined) {
        if (msg.id === promptRequestId && msg.result) {
          await settle();
          fake.resolvePrompt(msg.result.stopReason);
          await settle();
        }
        continue;
      }
      if (msg.method) await agent.notify(msg.method, msg.params);
    }
    await settle();
  }

  return {
    adapter,
    agent,
    proc: fake,
    sessionId,
    events,
    threadId,
    waitFor,
    replay,
    warnings,
    /** The engine process exits on its own (a crash, an OOM kill). */
    exit: () => {
      fake.sessionId = null;
      exits.emit('exit');
    },
    of: <M extends CanonicalRuntimeEvent['method']>(method: M) =>
      events.filter(
        (event): event is Extract<CanonicalRuntimeEvent, { method: M }> =>
          event.method === method,
      ),
    stop: async () => {
      await adapter.stopAll();
      await drained;
    },
  };
}

/**
 * Lets in-flight wire traffic land before asserting what arrived. The wire is
 * an in-memory stream, so it drains in event-loop turns, not wall-clock time:
 * this yields turns instead of sleeping, and holds on a saturated runner.
 */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 50; turn += 1)
    await new Promise<void>((resolve) => setImmediate(resolve));
}

type RequestOpened = Extract<
  CanonicalRuntimeEvent,
  { method: 'request.opened' }
>;
const isRequestOpened = (
  event: CanonicalRuntimeEvent,
): event is RequestOpened => event.method === 'request.opened';

function within<T>(promise: Promise<T>, ms = 1000): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no response within ${ms}ms`)), ms),
    ),
  ]);
}

/** The live `_x.ai/ask_user_question` params, as this session's. */
function liveQuestion(sessionId: string): Record<string, unknown> {
  const frames = captureFrames('ask-user-question-answered');
  const ask = frames.find((msg) => msg.method === '_x.ai/ask_user_question');
  if (!ask) throw new Error('capture holds no question');
  return renamed(ask.params, captureSessionId(frames), sessionId);
}

describe('Grok `_x.ai/ask_user_question` reaches the harness-question contract', () => {
  test("the person's choice goes back keyed by question text, as the engine read it live", async () => {
    const session = await startGrokSession();
    const response = session.agent.request(
      '_x.ai/ask_user_question',
      liveQuestion(session.sessionId),
    );
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    const form = inputRequestFromRequestEvent(opened);
    expect(form).toMatchObject({
      source: 'harness:grok',
      requester: 'Grok Lab',
      body: {
        fields: [
          {
            kind: 'choice',
            title: 'Which color do you prefer?',
            options: [
              { value: '0', label: 'red' },
              { value: '1', label: 'blue' },
            ],
          },
        ],
      },
    });
    if (!form) throw new Error('no form');
    await session.adapter.respondToRequest(
      session.threadId,
      opened.requestId,
      'accept',
      {
        inputContent: validateInputRequestContent(form, {
          [form.body.fields[0]!.name]: '1',
        }),
        expectedRequestEventId: opened.eventId,
      },
    );
    await expect(within(response)).resolves.toEqual({
      outcome: 'accepted',
      answers: { 'Which color do you prefer?': ['blue'] },
    });
    await session.stop();
  });

  test('a declined question goes back cancelled, which Grok reads as a decline', async () => {
    const session = await startGrokSession();
    const response = session.agent.request(
      '_x.ai/ask_user_question',
      liveQuestion(session.sessionId),
    );
    const opened = await session.waitFor(isRequestOpened, 'request.opened');
    await session.adapter.respondToRequest(
      session.threadId,
      opened.requestId,
      'decline',
      { expectedRequestEventId: opened.eventId },
    );
    await expect(within(response)).resolves.toEqual({ outcome: 'cancelled' });
    await session.stop();
  });

  test('a question Station cannot show is answered cancelled at once, with a warning', async () => {
    const session = await startGrokSession();
    const question = liveQuestion(session.sessionId);
    const [only] = question.questions as unknown[];
    // Two questions with the same text could not be answered back apart.
    const response = session.agent.request('_x.ai/ask_user_question', {
      ...question,
      questions: [only, only],
    });
    await expect(within(response)).resolves.toEqual({ outcome: 'cancelled' });
    expect(session.events.some(isRequestOpened)).toBe(false);
    expect(session.of('runtime.warning')).toEqual([
      expect.objectContaining({ code: 'acp.extension-request-unreadable' }),
    ]);
    await session.stop();
  });

  test('a child no person may be asked for answers cancelled without a request', async () => {
    const session = await startGrokSession({ unattended: true });
    const response = session.agent.request(
      '_x.ai/ask_user_question',
      liveQuestion(session.sessionId),
    );
    await expect(within(response)).resolves.toEqual({ outcome: 'cancelled' });
    expect(session.events.some(isRequestOpened)).toBe(false);
    await session.stop();
  });
});

describe('Grok child work and its own session', () => {
  test('a Grok session reports child work; another ACP engine states not-reported once', async () => {
    const grok = await startGrokSession();
    const other = await startGrokSession({ grok: false });
    await settle();
    const notReported = (session: typeof grok) =>
      session
        .of('child-work.updated')
        .filter((event) => event.delta.kind === 'not-reported');
    expect(notReported(grok)).toEqual([]);
    expect(notReported(other)).toEqual([
      expect.objectContaining({
        threadId: other.threadId,
        delta: expect.objectContaining({
          kind: 'not-reported',
          reporterThreadId: other.threadId,
        }),
      }),
    ]);
    await grok.stop();
    await other.stop();
  });

  test("a background subagent is one child, and the child's own session never reaches this transcript", async () => {
    const session = await startGrokSession();
    const turn = await session.adapter.sendTurn({
      threadId: session.threadId,
      input: 'spawn',
    });
    await session.replay('background-subagent', 5);

    const deltas = session.of('child-work.updated').map((event) => event.delta);
    const snapshot = deltas.find((delta) => delta.kind === 'snapshot');
    expect(snapshot).toMatchObject({
      running: [
        expect.objectContaining({
          workKind: 'agent',
          kindLabel: 'general-purpose',
          title: 'Reply exact text sub-ok',
          model: { id: 'grok-4.5', source: 'spawn-result' },
          parent: { turnId: turn.turnId },
        }),
      ],
    });
    expect(deltas.find((delta) => delta.kind === 'settle')).toMatchObject({
      status: 'completed',
      result: { summary: 'sub-ok', source: 'child-message' },
      usage: { totalTokens: 12321, toolUses: 0, durationMs: 2136 },
    });
    // The child streams its own prompt and reply under its own session on
    // the same connection. None of it is this session's: every text delta is
    // one of the parent's own chunks, and no extension frame of the child's
    // is forwarded.
    const frames = captureFrames('background-subagent');
    const own = captureSessionId(frames);
    const child = frames.find(
      (msg) =>
        typeof msg.params?.sessionId === 'string' &&
        msg.params.sessionId !== own,
    )?.params.sessionId;
    expect(child).toBeDefined();
    const ownChunks = frames.filter(
      (msg) =>
        msg.method === 'session/update' &&
        msg.params.sessionId === own &&
        msg.params.update.sessionUpdate === 'agent_message_chunk',
    );
    const childChunks = frames.filter(
      (msg) =>
        msg.method === 'session/update' &&
        msg.params.sessionId === child &&
        msg.params.update.sessionUpdate === 'agent_message_chunk',
    );
    expect(childChunks.length).toBeGreaterThan(0);
    expect(session.of('content.text-delta')).toHaveLength(ownChunks.length);
    expect(
      session
        .of('extension.notification')
        .filter(
          (event) =>
            (event.payload as { sessionId?: unknown }).sessionId === child,
        ),
    ).toEqual([]);
    // Only the parent's turn cost is reported, never the child's on top.
    expect(
      session
        .of('token-usage.updated')
        .flatMap((event) => (event.reportedCost ? [event.reportedCost] : [])),
    ).toEqual([{ amount: 0.02747336, unit: 'USD', scope: 'turn' }]);
    await session.stop();
  });

  test('a background command is a backgrounded child that settles with its output', async () => {
    const session = await startGrokSession();
    await session.adapter.sendTurn({ threadId: session.threadId, input: 'bg' });
    await session.replay('background-bash-interject', 5);
    const deltas = session.of('child-work.updated').map((event) => event.delta);
    expect(deltas.find((delta) => delta.kind === 'snapshot')).toMatchObject({
      running: [
        expect.objectContaining({
          workKind: 'command',
          kindLabel: 'bash',
          backgrounded: true,
          title: 'Background sleep then echo finished',
        }),
      ],
    });
    expect(deltas.find((delta) => delta.kind === 'settle')).toMatchObject({
      status: 'completed',
      result: { summary: 'bg-finished', source: 'tool-return' },
    });
    // The turn's live cost, once; its token counts are not published.
    const usage = session.of('token-usage.updated');
    expect(usage).toEqual([
      expect.objectContaining({
        reportedCost: { amount: 0.022225392, unit: 'USD', scope: 'turn' },
      }),
    ]);
    expect(usage[0]).not.toHaveProperty('promptTokens');
    await session.stop();
  });
});

describe('frames naming another session', () => {
  test('are dropped for any ACP engine, and the first drop is logged once', async () => {
    const session = await startGrokSession({ grok: false });
    await session.adapter.sendTurn({ threadId: session.threadId, input: 'x' });
    const chunk = (sessionId: string, text: string) =>
      session.agent.notify('session/update', {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text },
        },
      });
    await chunk(session.sessionId, 'own');
    await chunk('another-session', 'foreign one');
    await chunk('another-session', 'foreign two');
    await settle();
    expect(
      session
        .of('content.text-delta')
        .map((event) => (event as { delta?: string }).delta),
    ).toEqual(['own']);
    expect(
      session.warnings.filter((args) =>
        String(args[0]).includes('another engine session'),
      ),
    ).toHaveLength(1);
    await session.stop();
  });
});

describe('Grok wake turns are provider turns', () => {
  test('each prompt Grok runs on its own after the turn opens and closes a provider turn its reply lands in', async () => {
    const session = await startGrokSession();
    const turn = await session.adapter.sendTurn({
      threadId: session.threadId,
      input: 'monitor',
    });
    await session.replay('monitor-wake-turns', 5);

    const started = session.of('turn.started');
    const provider = started.filter(
      (event) => event.metadata?.trigger === 'provider',
    );
    // Two monitor lines and the monitor's end each woke the engine; the
    // prompt Station sent is never one of them, though Grok restated it.
    expect(started.map((event) => event.turnId)).toEqual([
      turn.turnId,
      ...provider.map((event) => event.turnId),
    ]);
    expect(provider).toHaveLength(3);
    const completed = session.of('turn.completed');
    expect(completed.map((event) => event.turnId)).toEqual([
      turn.turnId,
      ...provider.map((event) => event.turnId),
    ]);
    for (const event of completed.slice(1))
      expect(event.metadata).toEqual({ trigger: 'provider' });
    // The engine's reply to a wake is in that wake's turn.
    const firstWake = provider[0]!.turnId;
    expect(
      session
        .of('content.text-delta')
        .filter((event) => event.turnId === firstWake)
        .map((event) => (event as { delta?: string }).delta)
        .join(''),
    ).toContain('tick 1 received');
    // The monitor is one child: its lines are its progress.
    const deltas = session.of('child-work.updated').map((event) => event.delta);
    expect(
      deltas.flatMap((delta) =>
        delta.kind === 'upsert' && delta.item.progress
          ? [delta.item.progress]
          : [],
      ),
    ).toEqual(['tick 1', 'tick 2']);
    expect(deltas.find((delta) => delta.kind === 'snapshot')).toMatchObject({
      running: [expect.objectContaining({ workKind: 'monitor' })],
    });
    expect(deltas.find((delta) => delta.kind === 'settle')).toMatchObject({
      status: 'completed',
    });
    // Each wake's cost is that wake's turn's.
    const costTurns = session
      .of('token-usage.updated')
      .filter((event) => event.reportedCost)
      .map((event) => event.turnId);
    expect(costTurns).toEqual([
      turn.turnId,
      ...provider.map((event) => event.turnId),
    ]);
    await session.stop();
  });

  test("a late restatement of Station's own prompt never opens a provider turn", async () => {
    const session = await startGrokSession();
    const turn = await session.adapter.sendTurn({
      threadId: session.threadId,
      input: 'hi',
    });
    const running = {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'station-prompt',
    };
    await session.agent.notify('_x.ai/queue/changed', running);
    await settle();
    session.proc.resolvePrompt('end_turn');
    await settle();
    await session.agent.notify('_x.ai/queue/changed', running);
    await settle();
    expect(session.of('turn.started').map((event) => event.turnId)).toEqual([
      turn.turnId,
    ]);
    await session.stop();
  });

  test('a wake whose engine exits ends as a failed provider turn and no longer holds the session', async () => {
    const session = await startGrokSession();
    await session.agent.notify('_x.ai/queue/changed', {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'notifications-crash',
    });
    await settle();
    const opened = session.of('turn.started')[0];
    expect(opened?.metadata).toEqual({ trigger: 'provider' });
    session.exit();
    await settle();
    expect(session.of('runtime.error')).toEqual([
      expect.objectContaining({
        turnId: opened?.turnId,
        metadata: { trigger: 'provider' },
        message: 'Grok Lab exited during a turn it started itself.',
      }),
    ]);
    await expect(
      session.adapter.sendTurn({ threadId: session.threadId, input: 'again' }),
    ).resolves.toMatchObject({ turnId: expect.any(String) });
    await session.stop();
  });

  test('a wake Grok restates after it was interrupted does not open a second turn', async () => {
    const session = await startGrokSession();
    const running = {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'notifications-restated',
    };
    await session.agent.notify('_x.ai/queue/changed', running);
    await settle();
    const opened = session.of('turn.started')[0]!;
    await session.adapter.interruptTurn(session.threadId, opened.turnId);
    await session.agent.notify('_x.ai/queue/changed', running);
    await settle();
    expect(session.of('turn.started')).toHaveLength(1);
    await session.stop();
  });

  test('an interrupted wake does not leave later turns unable to quote a co-reported cause', async () => {
    const session = await startGrokSession();
    await session.agent.notify('_x.ai/queue/changed', {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'notifications-quarantine',
    });
    await settle();
    const wake = session.of('turn.started')[0]!;
    await session.adapter.interruptTurn(session.threadId, wake.turnId);
    await session.adapter.sendTurn({ threadId: session.threadId, input: 'x' });
    // The one evidenced cause notification (`acp.turn-error-cause`).
    await session.agent.notify('_kiro.dev/error/rate_limit', {
      sessionId: session.sessionId,
      message: 'The monthly usage limit has been reached',
    });
    await settle();
    session.proc.rejectPrompt(new Error('Internal error'));
    await settle();
    expect(session.of('runtime.error').at(-1)?.message).toContain(
      'engine also reported during this turn: The monthly usage limit has been reached',
    );
    await session.stop();
  });

  test('a wake that ends while its interrupt waits on cancel still lifts its quarantine', async () => {
    const session = await startGrokSession();
    await session.agent.notify('_x.ai/queue/changed', {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'notifications-race',
    });
    await settle();
    const wake = session.of('turn.started')[0]!;
    let release!: () => void;
    session.proc.cancelPromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const interrupted = session.adapter.interruptTurn(
      session.threadId,
      wake.turnId,
    );
    await session.agent.notify('_x.ai/session_notification', {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'notifications-race',
        stop_reason: 'cancelled',
      },
    });
    await settle();
    release();
    await expect(interrupted).resolves.toMatchObject({
      outcome: 'target-mismatch',
    });
    session.proc.cancelPromise = undefined;
    await session.adapter.sendTurn({ threadId: session.threadId, input: 'x' });
    await session.agent.notify('_kiro.dev/error/rate_limit', {
      sessionId: session.sessionId,
      message: 'The monthly usage limit has been reached',
    });
    await settle();
    session.proc.rejectPrompt(new Error('Internal error'));
    await settle();
    expect(session.of('runtime.error').at(-1)?.message).toContain(
      'engine also reported during this turn',
    );
    await session.stop();
  });

  test('a wake whose cancel fails still lifts its quarantine', async () => {
    const session = await startGrokSession();
    await session.agent.notify('_x.ai/queue/changed', {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'notifications-cancel-fails',
    });
    await settle();
    const wake = session.of('turn.started')[0]!;
    session.proc.cancelPromise = Promise.reject(new Error('transport closed'));
    session.proc.cancelPromise.catch(() => {});
    await expect(
      session.adapter.interruptTurn(session.threadId, wake.turnId),
    ).rejects.toThrow('transport closed');
    session.proc.cancelPromise = undefined;
    // The wake ends on its own later.
    await session.agent.notify('_x.ai/session_notification', {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'notifications-cancel-fails',
        stop_reason: 'cancelled',
      },
    });
    await settle();
    await session.adapter.sendTurn({ threadId: session.threadId, input: 'x' });
    await session.agent.notify('_kiro.dev/error/rate_limit', {
      sessionId: session.sessionId,
      message: 'The monthly usage limit has been reached',
    });
    await settle();
    session.proc.rejectPrompt(new Error('Internal error'));
    await settle();
    expect(session.of('runtime.error').at(-1)?.message).toContain(
      'engine also reported during this turn',
    );
    await session.stop();
  });

  test('a question a wake asked is settled when the wake ends', async () => {
    const session = await startGrokSession();
    await session.agent.notify('_x.ai/queue/changed', {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'task-completed-q',
    });
    await settle();
    const response = session.agent.request(
      '_x.ai/ask_user_question',
      liveQuestion(session.sessionId),
    );
    await session.waitFor(isRequestOpened, 'request.opened');
    await session.agent.notify('_x.ai/session_notification', {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'task-completed-q',
        stop_reason: 'end_turn',
      },
    });
    await expect(within(response)).resolves.toEqual({ outcome: 'cancelled' });
    expect(session.of('turn.completed')).toEqual([
      expect.objectContaining({ metadata: { trigger: 'provider' } }),
    ]);
    await session.stop();
  });

  test('a send while a wake turn runs is refused busy, and interrupting the wake ends it as a provider turn', async () => {
    const session = await startGrokSession();
    await session.agent.notify('_x.ai/queue/changed', {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'task-completed-wake',
    });
    const opened = await session.waitFor(
      (
        event,
      ): event is Extract<CanonicalRuntimeEvent, { method: 'turn.started' }> =>
        event.method === 'turn.started',
      'turn.started',
    );
    expect(opened.metadata).toEqual({ trigger: 'provider' });
    await expect(
      session.adapter.sendTurn({ threadId: session.threadId, input: 'hi' }),
    ).rejects.toThrow(/already has an active turn/);
    await expect(
      session.adapter.interruptTurn(session.threadId, opened.turnId),
    ).resolves.toEqual({ outcome: 'cancelled', turnId: opened.turnId });
    expect(session.of('turn.aborted')).toEqual([
      expect.objectContaining({
        turnId: opened.turnId,
        metadata: { trigger: 'provider' },
      }),
    ]);
    // Its late end is not a second terminal.
    await session.agent.notify('_x.ai/session_notification', {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'task-completed-wake',
        stop_reason: 'cancelled',
      },
    });
    await settle();
    expect(session.of('turn.completed')).toEqual([]);
    expect(session.of('turn.aborted')).toHaveLength(1);
    await session.stop();
  });

  test('a wake that fails ends its provider turn with the engine’s own reason', async () => {
    const session = await startGrokSession();
    await session.agent.notify('_x.ai/queue/changed', {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'subagent-completed-x',
    });
    await settle();
    await session.agent.notify('_x.ai/session_notification', {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'subagent-completed-x',
        stop_reason: 'error',
        agent_result: 'API error (status 400 Bad Request): bad request',
      },
    });
    await settle();
    expect(session.of('runtime.error')).toEqual([
      expect.objectContaining({
        metadata: { trigger: 'provider' },
        message: 'API error (status 400 Bad Request): bad request',
      }),
    ]);
    await session.stop();
  });
});

describe('a failed prompt names the engine’s own reason', () => {
  test('`error.data.message` is quoted after the JSON-RPC message', async () => {
    const session = await startGrokSession();
    await session.adapter.sendTurn({ threadId: session.threadId, input: 'x' });
    // Grok's prompt failure shape: -32603 with the reason in `data.message`.
    session.proc.rejectPrompt(
      Object.assign(new Error('Internal error'), {
        code: -32603,
        data: {
          message:
            'API error (status 400 Bad Request): invalid_request_error: probe',
          http_status: 400,
        },
      }),
    );
    await settle();
    expect(session.of('runtime.error')).toEqual([
      expect.objectContaining({
        message:
          'Internal error: API error (status 400 Bad Request): invalid_request_error: probe',
      }),
    ]);
    await session.stop();
  });
});

/**
 * The capture's client requests (`method`, `params`) with the answer the
 * live engine gave each, in the order they were sent.
 */
function liveExchanges(
  capture: string,
): Array<{ method: string; params: any; result: unknown }> {
  const entries = readFileSync(
    new URL(`../../../${GROK_LIVE_CAPTURE}`, import.meta.url),
    'utf8',
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry.capture === capture);
  const answers = new Map(
    entries
      .filter((entry) => entry.dir === 'E->C' && entry.msg.method === undefined)
      .map((entry) => [entry.msg.id, entry.msg.result]),
  );
  return entries
    .filter((entry) => entry.dir === 'C->E' && entry.msg.method)
    .map((entry) => ({
      method: entry.msg.method,
      params: entry.msg.params,
      result: answers.get(entry.msg.id),
    }));
}

/** The live answers to `method` in `capture`, in order. */
function liveAnswers(capture: string, method: string): unknown[] {
  return liveExchanges(capture)
    .filter((exchange) => exchange.method === method)
    .map((exchange) => exchange.result);
}

/** The prompt texts the live capture sent, in order. */
function livePrompts(capture: string): string[] {
  return liveExchanges(capture)
    .filter((exchange) => exchange.method === 'session/prompt')
    .map((exchange) => exchange.params.prompt[0].text);
}

/** Run one Station turn the engine reports starting, as Grok does, and end it. */
async function grokTurn(
  session: Awaited<ReturnType<typeof startGrokSession>>,
  input: string,
  enginePromptId: string,
): Promise<string> {
  const turn = await session.adapter.sendTurn({
    threadId: session.threadId,
    input,
  });
  await session.agent.notify('_x.ai/queue/changed', {
    sessionId: session.sessionId,
    entries: [],
    runningPromptId: enginePromptId,
  });
  await settle();
  session.proc.resolvePrompt('end_turn');
  await settle();
  return turn.turnId;
}

describe('Grok rewind, fork and MCP reconnect, from the live answers', () => {
  const capture = 'rewind-preview-commit';
  const [points, ,] = liveAnswers(capture, '_x.ai/rewind/points');
  const [preview, commit] = liveAnswers(capture, '_x.ai/rewind/execute');
  const prompts = livePrompts(capture);

  /** Three Station turns sent as the live session sent them. */
  async function threeTurns(inputs = prompts.slice(0, 3)) {
    const session = await startGrokSession();
    const turns: string[] = [];
    for (const [position, input] of inputs.entries())
      turns.push(await grokTurn(session, input, `prompt-${position}`));
    return { session, turns };
  }

  /** Answer each extension request with the next live answer for its method. */
  function answerLive(
    session: Awaited<ReturnType<typeof startGrokSession>>,
    byMethod: Record<string, unknown[]>,
  ) {
    const queues = Object.fromEntries(
      Object.entries(byMethod).map(([method, list]) => [method, [...list]]),
    );
    session.proc.extMethodHandler = (method) => {
      const next = queues[method]?.shift();
      if (next === undefined) throw new Error(`no live answer for ${method}`);
      return next;
    };
  }

  test('a Grok session declares rewind in place and native fork; another engine neither', async () => {
    const grok = await startGrokSession();
    expect(grok.adapter.sessionContinuity(grok.threadId)).toEqual({
      live: true,
      fork: 'native',
      rewind: 'in-place',
    });
    await grok.stop();
    const other = await startGrokSession({ grok: false });
    expect(other.adapter.sessionContinuity(other.threadId)).toEqual({
      live: true,
      fork: 'none',
      rewind: 'none',
    });
    await other.stop();
  });

  test('a rewind names the turn by its prompt index, previews, then applies', async () => {
    const { session, turns } = await threeTurns();
    answerLive(session, {
      '_x.ai/rewind/points': [points],
      '_x.ai/rewind/execute': [preview, commit],
    });
    const outcome = await session.adapter.rewindSession(
      session.threadId,
      turns[1]!,
    );
    expect(outcome).toEqual({
      kind: 'rewound',
      beforeTurnId: turns[1],
      hiddenTurnIds: [turns[1], turns[2]],
      affectedFiles: { count: 1, paths: ['two.txt'] },
    });
    expect(
      session.proc.extMethodCalls.map(({ method, params }) => [
        method,
        params.targetPromptIndex,
        params.force,
      ]),
    ).toEqual([
      ['_x.ai/rewind/points', undefined, undefined],
      ['_x.ai/rewind/execute', 1, false],
      ['_x.ai/rewind/execute', 1, true],
    ]);
    // The ledger is cut: the hidden turns are no longer rewind points.
    expect(
      await session.adapter.rewindSession(session.threadId, turns[2]!),
    ).toEqual({ kind: 'refused', reason: 'unknown-turn' });
    await session.stop();
  });

  test('a wake between turns is no rewind point, so the turns still line up', async () => {
    const session = await startGrokSession();
    const first = await grokTurn(session, prompts[0]!, 'prompt-0');
    const second = await grokTurn(session, prompts[1]!, 'prompt-1');
    // The engine wakes itself: a provider turn, not a client prompt.
    await session.agent.notify('_x.ai/queue/changed', {
      sessionId: session.sessionId,
      entries: [],
      runningPromptId: 'task-completed-1',
    });
    await settle();
    await session.agent.notify('_x.ai/session_notification', {
      sessionId: session.sessionId,
      update: {
        sessionUpdate: 'turn_completed',
        prompt_id: 'task-completed-1',
        stop_reason: 'end_turn',
      },
    });
    await settle();
    const third = await grokTurn(session, prompts[2]!, 'prompt-2');
    answerLive(session, {
      '_x.ai/rewind/points': [points],
      '_x.ai/rewind/execute': [preview, commit],
    });
    expect(
      await session.adapter.rewindSession(session.threadId, second),
    ).toMatchObject({ kind: 'rewound', hiddenTurnIds: [second, third] });
    expect(session.proc.extMethodCalls[1]?.params.targetPromptIndex).toBe(1);
    expect(first).toBeDefined();
    await session.stop();
  });

  test('prompts from before this process count from the last point back, not from the first', async () => {
    // The live session's first prompt predates this process (a resume): the
    // ledger holds only the later two, yet they are points 1 and 2.
    const session = await startGrokSession();
    const second = await grokTurn(session, prompts[1]!, 'prompt-1');
    const third = await grokTurn(session, prompts[2]!, 'prompt-2');
    answerLive(session, {
      '_x.ai/rewind/points': [points],
      '_x.ai/rewind/execute': [preview, commit],
    });
    expect(
      await session.adapter.rewindSession(session.threadId, second),
    ).toMatchObject({ kind: 'rewound', hiddenTurnIds: [second, third] });
    expect(session.proc.extMethodCalls[1]?.params.targetPromptIndex).toBe(1);
    await session.stop();
  });

  test('files changed outside the engine since then refuse the rewind before it is applied', async () => {
    const { session, turns } = await threeTurns();
    answerLive(session, {
      '_x.ai/rewind/points': [points],
      '_x.ai/rewind/execute': [
        {
          ...(preview as Record<string, unknown>),
          clean_files: [],
          conflicts: [
            { path: 'two.txt', conflict_type: 'modified_externally' },
          ],
        },
      ],
    });
    const outcome = await session.adapter.rewindSession(
      session.threadId,
      turns[1]!,
    );
    expect(outcome).toEqual({
      kind: 'failed',
      message: expect.stringContaining('two.txt'),
    });
    expect(
      session.proc.extMethodCalls.filter(({ params }) => params.force === true),
    ).toEqual([]);
    await session.stop();
  });

  test('a turn whose text is not the point the count lands on rewinds nothing', async () => {
    const { session, turns } = await threeTurns([
      prompts[0]!,
      'a different request',
      prompts[2]!,
    ]);
    answerLive(session, { '_x.ai/rewind/points': [points] });
    expect(
      await session.adapter.rewindSession(session.threadId, turns[1]!),
    ).toEqual({
      kind: 'failed',
      message: expect.stringContaining('do not line up'),
    });
    expect(session.proc.extMethodCalls.map(({ method }) => method)).toEqual([
      '_x.ai/rewind/points',
    ]);
    await session.stop();
  });

  test('a wake takes an index but lists no point; later turns resolve to their own index', async () => {
    const wakeCapture = 'rewind-points-after-wake';
    const [wakePoints] = liveAnswers(wakeCapture, '_x.ai/rewind/points');
    // The engine's own replay of the session: each prompt with its index.
    const replayed = captureFrames(wakeCapture)
      .map((msg) => msg.params?.update)
      .filter((update) => update?.sessionUpdate === 'user_message_chunk')
      .map((update) => ({
        index: update._meta.promptIndex as number,
        text: update.content.text as string,
      }));
    const listed = (
      wakePoints as { rewind_points: Array<{ prompt_index: number }> }
    ).rewind_points.map(({ prompt_index }) => prompt_index);
    expect(listed).toEqual([0, 1, 2, 4]);
    expect(replayed.find(({ index }) => index === 3)?.text).toMatch(
      /^<system-reminder>/,
    );
    const clientPrompts = replayed.filter(({ index }) =>
      listed.includes(index),
    );
    const session = await startGrokSession();
    const turns: string[] = [];
    for (const [position, { text }] of clientPrompts.entries()) {
      turns.push(await grokTurn(session, text, `prompt-${position}`));
      if (position === 2) {
        await session.agent.notify('_x.ai/queue/changed', {
          sessionId: session.sessionId,
          entries: [],
          runningPromptId: 'task-completed-1',
        });
        await settle();
        await session.agent.notify('_x.ai/session_notification', {
          sessionId: session.sessionId,
          update: {
            sessionUpdate: 'turn_completed',
            prompt_id: 'task-completed-1',
            stop_reason: 'end_turn',
          },
        });
        await settle();
      }
    }
    answerLive(session, {
      '_x.ai/rewind/points': [wakePoints],
      '_x.ai/rewind/execute': [preview, commit],
    });
    expect(
      await session.adapter.rewindSession(session.threadId, turns[3]!),
    ).toMatchObject({ kind: 'rewound', hiddenTurnIds: [turns[3]] });
    expect(
      session.proc.extMethodCalls
        .filter(({ method }) => method === '_x.ai/rewind/execute')
        .map(({ params }) => params.targetPromptIndex),
    ).toEqual([4, 4]);
    await session.stop();
  });

  test('a turn after the chosen one that lists no point (a slash command Grok ran itself) refuses the rewind', async () => {
    const { session, turns } = await threeTurns();
    turns.push(await grokTurn(session, '/compact', 'prompt-3'));
    answerLive(session, { '_x.ai/rewind/points': [points] });
    expect(
      await session.adapter.rewindSession(session.threadId, turns[1]!),
    ).toEqual({
      kind: 'failed',
      message: expect.stringContaining('do not line up'),
    });
    expect(session.proc.extMethodCalls.map(({ method }) => method)).toEqual([
      '_x.ai/rewind/points',
    ]);
    await session.stop();
  });

  test('a repeated prompt that matches its neighbour still refuses when a later turn is out of step', async () => {
    // "continue" twice, then a slash command Grok ran without a point: the
    // second "continue" lines up with the first one's point by text alone.
    const session = await startGrokSession();
    await grokTurn(session, 'continue', 'p-0');
    const second = await grokTurn(session, 'continue', 'p-1');
    await grokTurn(session, '/compact', 'p-2');
    const [live] = (points as { rewind_points: Record<string, unknown>[] })
      .rewind_points;
    answerLive(session, {
      '_x.ai/rewind/points': [
        {
          rewind_points: [0, 1].map((index) => ({
            ...live,
            prompt_index: index,
            prompt_preview: 'continue',
          })),
        },
      ],
    });
    expect(
      await session.adapter.rewindSession(session.threadId, second),
    ).toEqual({
      kind: 'failed',
      message: expect.stringContaining('do not line up'),
    });
    expect(session.proc.extMethodCalls.map(({ method }) => method)).toEqual([
      '_x.ai/rewind/points',
    ]);
    await session.stop();
  });

  test("a point whose preview is only the start of the turn's text is not that turn", async () => {
    const session = await startGrokSession();
    const turn = await grokTurn(session, 'yes, apply the migration', 'p-0');
    const [live] = (points as { rewind_points: Record<string, unknown>[] })
      .rewind_points;
    answerLive(session, {
      '_x.ai/rewind/points': [
        {
          rewind_points: [{ ...live, prompt_index: 0, prompt_preview: 'yes' }],
        },
      ],
    });
    expect(await session.adapter.rewindSession(session.threadId, turn)).toEqual(
      {
        kind: 'failed',
        message: expect.stringContaining('do not line up'),
      },
    );
    await session.stop();
  });

  test('a points answer whose indexes do not rise rewinds nothing', async () => {
    const { session, turns } = await threeTurns();
    const listed = (points as { rewind_points: unknown[] }).rewind_points;
    answerLive(session, {
      '_x.ai/rewind/points': [{ rewind_points: [...listed].reverse() }],
    });
    expect(
      await session.adapter.rewindSession(session.threadId, turns[1]!),
    ).toEqual({
      kind: 'failed',
      message: expect.stringContaining('cannot read'),
    });
    expect(session.proc.extMethodCalls).toHaveLength(1);
    await session.stop();
  });

  test('a fork after a turn copies through that prompt into the session Grok names', async () => {
    const [forkPoints] = liveAnswers('fork-at-prompt', '_x.ai/rewind/points');
    const [forked] = liveAnswers('fork-at-prompt', '_x.ai/session/fork');
    const forkPrompts = (
      forkPoints as { rewind_points: Array<{ prompt_preview: string }> }
    ).rewind_points.map(({ prompt_preview }) =>
      prompt_preview.replace(/\.\.\.$/, ' and the rest of it'),
    );
    const session = await startGrokSession();
    const first = await grokTurn(session, forkPrompts[0]!, 'prompt-0');
    await grokTurn(session, forkPrompts[1]!, 'prompt-1');
    answerLive(session, {
      '_x.ai/rewind/points': [forkPoints],
      '_x.ai/session/fork': [forked],
    });
    const outcome = await session.adapter.forkSession(session.threadId, first);
    expect(outcome).toEqual({
      resumeCursor: expect.objectContaining({
        acpSessionId: (forked as { newSessionId: string }).newSessionId,
      }),
    });
    expect(session.proc.extMethodCalls.at(-1)).toEqual({
      method: '_x.ai/session/fork',
      params: {
        sourceSessionId: session.sessionId,
        sourceCwd: '/tmp/project',
        newCwd: '/tmp/project',
        targetPromptIndex: 0,
      },
    });
    await session.stop();
  });

  test('reconnecting a server Station passed drops it and passes it again', async () => {
    const session = await startGrokSession({
      toolServers: [
        { id: 'docs', command: process.execPath },
        { id: 'probe-broken', command: process.execPath },
      ],
    });
    const [dropped, restored] = liveAnswers(
      'mcp-reconnect',
      '_x.ai/session/update_mcp_servers',
    );
    answerLive(session, {
      '_x.ai/session/update_mcp_servers': [dropped, restored],
    });
    const outcome = await session.adapter.reconnectMcpServer(
      session.threadId,
      'probe-broken',
      { startOAuth: false },
    );
    expect(outcome).toEqual({
      kind: 'answered',
      success: true,
      text: "Grok Build restarted the MCP server 'probe-broken'.",
    });
    expect(
      session.proc.extMethodCalls.map(({ params }) =>
        (params.mcpServers as Array<{ name: string }>).map(({ name }) => name),
      ),
    ).toEqual([['docs'], ['docs', 'probe-broken']]);
    await session.stop();
  });

  test("a server from Grok's own configuration, or a sign-in, is refused before anything is sent", async () => {
    const session = await startGrokSession({
      toolServers: [{ id: 'docs', command: process.execPath }],
    });
    expect(
      await session.adapter.reconnectMcpServer(
        session.threadId,
        'example-docs',
        { startOAuth: false },
      ),
    ).toEqual({
      kind: 'failed',
      message: expect.stringContaining('own configuration'),
    });
    expect(
      await session.adapter.reconnectMcpServer(session.threadId, 'docs', {
        startOAuth: true,
      }),
    ).toEqual({ kind: 'failed', message: expect.stringContaining('sign-in') });
    expect(session.proc.extMethodCalls).toEqual([]);
    await session.stop();
  });

  test('when the second send fails the server is passed again and the failure reported', async () => {
    const session = await startGrokSession({
      toolServers: [{ id: 'docs', command: process.execPath }],
    });
    let sends = 0;
    session.proc.extMethodHandler = () => {
      sends += 1;
      if (sends === 2) throw new Error('session closed');
      return { result: { ok: true } };
    };
    expect(
      await session.adapter.reconnectMcpServer(session.threadId, 'docs', {
        startOAuth: false,
      }),
    ).toEqual({
      kind: 'failed',
      message: expect.stringContaining('session closed'),
    });
    expect(
      session.proc.extMethodCalls.map(({ params }) =>
        (params.mcpServers as Array<{ name: string }>).map(({ name }) => name),
      ),
    ).toEqual([[], ['docs'], ['docs']]);
    await session.stop();
  });

  test('when passing the list again fails too, the outcome says the server may be gone', async () => {
    const session = await startGrokSession({
      toolServers: [{ id: 'docs', command: process.execPath }],
    });
    let sends = 0;
    session.proc.extMethodHandler = () => {
      sends += 1;
      if (sends >= 2) throw new Error('session closed');
      return { result: { ok: true } };
    };
    expect(
      await session.adapter.reconnectMcpServer(session.threadId, 'docs', {
        startOAuth: false,
      }),
    ).toEqual({
      kind: 'failed',
      message: expect.stringContaining("without 'docs'"),
    });
    await session.stop();
  });
});
