/**
 * A Claude engine that dies, end to end: the real OrchestrationService, the
 * real ClaudeAdapter and the repository's fake `claude` process (no real
 * process can start). At every point at most one engine runs for the
 * conversation, and the person's next message runs in one new Session.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INTERNAL_SESSION_READ_SCOPE } from '@kontourai/station-contracts/tenancy';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockQuery, mockFindCliBinaryAsync, mockRunCliCommand } = vi.hoisted(
  () => ({
    mockQuery: vi.fn(),
    mockFindCliBinaryAsync: vi.fn(),
    mockRunCliCommand: vi.fn(),
  }),
);

vi.mock('../../../providers/adapters/claude-code-spawn.js', async (orig) => {
  const { fakeEngineProcessModule } = await import(
    '../../../providers/__tests__/claude-engine-process-test-utils.js'
  );
  return fakeEngineProcessModule(await orig<any>());
});
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  listSessions: vi.fn(),
  query: (args: unknown) => mockQuery(args),
}));
vi.mock('../../../providers/auth/cli-auth.js', () => ({
  buildCliRuntimePrerequisites: vi.fn().mockResolvedValue([]),
  augmentedSpawnEnv: vi.fn(),
  findCliBinaryAsync: mockFindCliBinaryAsync,
  runCliCommand: mockRunCliCommand,
}));

import {
  FakeClaudeChild,
  startFakeClaudeEngine,
} from '../../../providers/__tests__/claude-engine-process-test-utils.js';
import { ClaudeAdapter } from '../../../providers/adapters/claude-adapter.js';
import type { IProviderAdapterRegistry } from '../../../providers/provider-interfaces.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

function endableQuery() {
  const pending: unknown[] = [];
  let wake: (() => void) | null = null;
  let ended = false;
  let failure: Error | undefined;
  const end = () => {
    ended = true;
    wake?.();
    wake = null;
  };
  return {
    push(m: unknown) {
      pending.push(m);
      wake?.();
      wake = null;
    },
    end,
    crash(e: Error) {
      failure = e;
      end();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (pending.length === 0) {
          if (failure) throw failure;
          if (ended) return;
          await new Promise<void>((r) => {
            wake = r;
          });
        }
        yield pending.shift();
      }
    },
    stopTask: vi.fn(),
    interrupt: vi.fn().mockResolvedValue(undefined),
    supportedModels: vi.fn().mockResolvedValue([]),
    close: vi.fn().mockImplementation(() => end()),
    setModel: vi.fn().mockResolvedValue(undefined),
    setPermissionMode: vi.fn().mockResolvedValue(undefined),
    applyFlagSettings: vi.fn().mockResolvedValue(undefined),
    mcpServerStatus: vi.fn().mockResolvedValue([]),
  };
}

let dir: string;
let store: EventStore;
let service: OrchestrationService;
let adapter: ClaudeAdapter;
const warn = vi.fn();
const engines: FakeClaudeChild[] = [];

function startEngine() {
  const options = mockQuery.mock.calls.at(-1)?.[0]?.options;
  startFakeClaudeEngine(options);
  const child = FakeClaudeChild.newest!;
  engines.push(child);
  return child;
}
const alive = () =>
  engines.filter((c) => c.exitCode === null && c.signalCode === null);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'zz-verify-claude-'));
  store = new EventStore(join(dir, 'o.sqlite'));
  mockFindCliBinaryAsync.mockResolvedValue(null);
  mockRunCliCommand.mockResolvedValue(null);
  adapter = new ClaudeAdapter({ engineExitStreamGraceMs: 20 } as never);
  const registry: IProviderAdapterRegistry = {
    register() {},
    get: (p: string) => (p === 'claude' ? (adapter as never) : undefined),
    list: () => [adapter as never],
  } as never;
  warn.mockReset();
  service = new OrchestrationService({
    adapterRegistry: registry,
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn },
  });
  engines.length = 0;
});
afterEach(async () => {
  await service.shutdown().catch(() => undefined);
  store.close();
  rmSync(dir, { recursive: true, force: true });
  mockQuery.mockReset();
});

const T = 'conv-engine-exit';
const methods = (t = T) =>
  store.listEvents(t).map((e) => (e.payload as any).method as string);
const settle = async (n = 10) => {
  for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 5));
};
async function start(threadId = T) {
  const q = endableQuery();
  mockQuery.mockReturnValue(q);
  await service.dispatch({
    type: 'startSession',
    input: { threadId, provider: 'claude' },
  } as never);
  const child = startEngine();
  return { q, child };
}
let key = 0;
const send = (threadId: string, extra: Record<string, unknown> = {}) =>
  service
    .dispatch({
      type: 'sendTurn',
      input: { threadId, input: 'hi', clientTurnId: `k${++key}`, ...extra },
    } as never)
    .then(
      (r: any) => ({ ok: true as const, turnId: r.turnId }),
      (e: any) => ({
        ok: false as const,
        code: e?.code,
        message: String(e?.message),
      }),
    );
async function snapshot(threadId = T) {
  const d = await service.readSession(threadId, INTERNAL_SESSION_READ_SCOPE);
  return {
    status: d?.session.status,
    lifecycle: d?.session.lifecycleState,
    hasActiveTurn: d?.session.hasActiveTurn,
  };
}

type Continuation = {
  sessionId: string;
  startRequired: boolean;
  resumeCursor?: unknown;
  transcriptSeed?: string;
  contextSeed?: { pinDigest: string; seedDigest: string };
};

/** What the foreground continue seam does: resolve, start if needed, send. */
async function continueConversation(message: string) {
  const cont = (await service.resolveConversationContinuation(
    T,
    INTERNAL_SESSION_READ_SCOPE as never,
    { provider: 'claude' } as never,
  )) as Continuation;
  if (!cont.startRequired) return { cont, sent: await send(cont.sessionId) };
  const ck = `succ-${++key}`;
  mockQuery.mockReturnValue(endableQuery());
  await service.dispatch({
    type: 'startSession',
    input: {
      threadId: cont.sessionId,
      provider: 'claude',
      ...(cont.resumeCursor !== undefined
        ? { resumeCursor: cont.resumeCursor }
        : {}),
      persistSession: true,
      metadata: {
        conversationId: T,
        ...(cont.contextSeed
          ? {
              conversationStartSeedCarrier: {
                pinDigest: cont.contextSeed.pinDigest,
                seedDigest: cont.contextSeed.seedDigest,
                clientTurnId: ck,
              },
            }
          : {}),
      },
    },
  } as never);
  startEngine();
  const sent = await service
    .dispatch({
      type: 'sendTurn',
      input: {
        threadId: cont.sessionId,
        input: message,
        clientTurnId: ck,
        ...(cont.transcriptSeed ? { ambientContext: cont.transcriptSeed } : {}),
      },
    } as never)
    .then(
      (r: any) => ({ ok: true as const, turnId: r.turnId }),
      (e: any) => ({
        ok: false as const,
        code: e?.code,
        message: String(e?.message),
      }),
    );
  return { cont, sent };
}

const count = (method: string, t = T) =>
  methods(t).filter((m) => m === method).length;

/** The engine dies the way SIGTERM does: its kill is answered by an exit. */
function killExits(child: FakeClaudeChild) {
  child.kill = (signal?: NodeJS.Signals) => {
    child.killed = true;
    child.exit(null, signal ?? 'SIGTERM');
    child.closeStderr();
    return true;
  };
}

describe('a Claude engine that dies, through the real service and adapter', () => {
  test('a failed stream with the engine alive: the engine is stopped first, then the conversation continues in one new engine', async () => {
    const { q, child } = await start();
    await settle();
    killExits(child);
    q.crash(new Error('Unexpected token in JSON at position 0'));
    await vi.waitFor(() => expect(methods()).toContain('session.exited'), {
      timeout: 5000,
    });
    expect(child.killed).toBe(true);
    expect(alive()).toHaveLength(0);
    expect(count('runtime.error')).toBe(1);
    expect(count('session.exited')).toBe(1);
    const { cont, sent } = await continueConversation('are you there');
    expect(cont).toMatchObject({ startRequired: true });
    expect(cont.sessionId).not.toBe(T);
    expect(sent).toMatchObject({ ok: true });
    expect(alive()).toHaveLength(1);
  });

  test('a failed stream whose engine will not die: no second engine is started', async () => {
    const { q, child } = await start();
    await settle();
    // Signals are ignored: the process never exits.
    child.kill = () => true;
    q.crash(new Error('Unexpected token in JSON at position 0'));
    await vi.waitFor(() => expect(methods()).toContain('runtime.error'));
    // Past the bounded termination (grace plus forced kill).
    await new Promise((r) => setTimeout(r, 1_500));
    expect(adapter.engineEnded(T)).toBe(false);
    const starts = mockQuery.mock.calls.length;
    const refused = await continueConversation('are you there').then(
      () => undefined,
      (error: unknown) => error as { code?: string; message?: string },
    );
    expect(refused).toMatchObject({
      code: 'conversation_predecessor_engine_live',
    });
    expect(refused?.message).toMatch(
      /did not start a new one beside it and nothing was sent/,
    );
    expect(mockQuery.mock.calls.length).toBe(starts);
    expect(engines).toHaveLength(1);
    expect(alive()).toHaveLength(1);
  });

  test('a message sent after the exit is seen but before the Session ends is never accepted into the dead engine', async () => {
    const childWorkload = await import(
      '@kontourai/station-shared/child-workload'
    );
    let release: (v: undefined) => void = () => {};
    const outcome = vi
      .spyOn(childWorkload, 'childWorkloadOutcome')
      .mockReturnValue(new Promise((r) => (release = r)) as never);
    try {
      const { q, child } = await start();
      await settle();
      q.setModel.mockImplementation(async () => {
        child.exit(null, 'SIGTERM');
        child.closeStderr();
        throw new Error('Claude Code process terminated by signal SIGTERM');
      });
      const first = await send(T, { modelId: 'claude-other-model' });
      expect(first).toMatchObject({
        ok: false,
        code: 'foreground_message_indeterminate',
      });
      await vi.waitFor(() => expect(adapter.engineEnded(T)).toBe(true));
      expect(methods()).not.toContain('session.exited');
      // Inside the window: the held start settles, and this send is refused
      // before anything is queued into the exited engine.
      const second = await send(T);
      expect(second).toMatchObject({ ok: false });
      expect(second.ok ? '' : second.message).toMatch(
        /engine has exited and Station is closing the Session, so nothing was sent/,
      );
      expect(count('turn.started')).toBe(0);
      release(undefined);
      await vi.waitFor(() => expect(methods()).toContain('session.exited'), {
        timeout: 5000,
      });
      // Sent again, it runs in a new Session.
      const { cont, sent } = await continueConversation('are you there');
      expect(cont.sessionId).not.toBe(T);
      expect(sent).toMatchObject({ ok: true });
      expect(alive()).toHaveLength(1);
    } finally {
      outcome.mockRestore();
    }
  });

  test('the engine dies inside the turn start: that message is recorded as interrupted, with its banner', async () => {
    const { q, child } = await start();
    await settle();
    q.setModel.mockImplementation(async () => {
      child.exit(null, 'SIGTERM');
      child.closeStderr();
      throw new Error('Claude Code process terminated by signal SIGTERM');
    });
    const first = await send(T, { modelId: 'claude-other-model' });
    expect(first).toMatchObject({
      ok: false,
      code: 'foreground_message_indeterminate',
    });
    // No further message is sent: the exit alone must not leave it silent.
    await vi.waitFor(() => expect(methods()).toContain('session.exited'), {
      timeout: 5000,
    });
    const events = store.listEvents(T);
    const banner = events.find((e) => e.id.startsWith('turn-interrupted:'));
    expect(banner?.payload).toMatchObject({
      method: 'session.state-changed',
      interruptedTurnBoundary: { priorState: 'indeterminate' },
    });
    // Recorded before the Session's end, which then has nothing to retire.
    expect(events.indexOf(banner!)).toBeLessThan(
      events.findIndex((e) => (e.payload as any).method === 'session.exited'),
    );
    expect(count('session.exited')).toBe(1);
    const { cont, sent } = await continueConversation('are you there');
    expect(cont.sessionId).not.toBe(T);
    expect(sent).toMatchObject({ ok: true });
    expect(alive()).toHaveLength(1);
  });

  for (const during of ['a tool call', 'streaming'] as const) {
    test(`the engine dies during ${during}: one failure, one exit, then one new engine`, async () => {
      const { q, child } = await start();
      await settle();
      const turn = await send(T);
      expect(turn).toMatchObject({ ok: true });
      await vi.waitFor(() => expect(methods()).toContain('turn.started'));
      if (during === 'a tool call') {
        q.push({
          type: 'assistant',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'tool_use', id: 'toolu-open', name: 'Bash', input: {} },
            ],
          },
          uuid: 'assistant-1',
          session_id: T,
        });
        await vi.waitFor(() => expect(methods()).toContain('tool.started'));
      } else {
        q.push({
          type: 'stream_event',
          event: {
            type: 'content_block_delta',
            delta: { type: 'text_delta', text: 'half an ans' },
          },
          uuid: 'delta-1',
          session_id: T,
        });
        await vi.waitFor(() =>
          expect(methods()).toContain('content.text-delta'),
        );
      }
      // SIGKILL: the stream says nothing; the exit ends it.
      child.exit(null, 'SIGKILL');
      child.closeStderr();
      await vi.waitFor(() => expect(methods()).toContain('session.exited'), {
        timeout: 5000,
      });
      await settle();
      expect(count('runtime.error')).toBe(1);
      expect(count('session.exited')).toBe(1);
      const failure = store
        .listEvents(T)
        .find((e) => (e.payload as any).method === 'runtime.error')!
        .payload as any;
      expect(failure).toMatchObject({
        turnId: turn.ok ? turn.turnId : '',
        kind: 'engine_crashed',
      });
      if (during === 'a tool call')
        expect(
          store
            .listEvents(T)
            .map((e) => e.payload as any)
            .find((p) => p.method === 'tool.completed'),
        ).toMatchObject({ toolCallId: 'toolu-open' });
      expect((await snapshot()).hasActiveTurn).toBe(false);
      const { cont, sent } = await continueConversation('are you there');
      expect(cont.sessionId).not.toBe(T);
      expect(sent).toMatchObject({ ok: true });
      expect(alive()).toHaveLength(1);
    });
  }
});
