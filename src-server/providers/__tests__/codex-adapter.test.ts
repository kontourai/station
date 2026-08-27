import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { builtinStationControlServerPath } from '../../runtime/bootstrap/station-control-runtime-env.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import {
  CodexAdapter,
  projectCodexQuotaSnapshot,
  projectCodexQuotaUpdate,
} from '../adapters/codex-adapter.js';
import {
  CodexAdapterTransport,
  createCodexSessionRecord,
} from '../adapters/codex-adapter-transport.js';
import { expectCanonicalSessionLifecycle } from './adapter-contract-test-utils.js';

const {
  mockProviderOpsAdd,
  mockAppHomeSessionsAdd,
  mockAgentCapabilityUndeliveredAdd,
  mockCodexToolServersDeliveredAdd,
  mockConnectionQuotaReadsAdd,
  mockOrchestrationCommandsDispatchedAdd,
  mockChatStartGateAdd,
  mockAdapterSessionStartDurationRecord,
} = vi.hoisted(() => ({
  mockProviderOpsAdd: vi.fn(),
  mockAppHomeSessionsAdd: vi.fn(),
  mockAgentCapabilityUndeliveredAdd: vi.fn(),
  mockCodexToolServersDeliveredAdd: vi.fn(),
  mockConnectionQuotaReadsAdd: vi.fn(),
  mockOrchestrationCommandsDispatchedAdd: vi.fn(),
  mockChatStartGateAdd: vi.fn(),
  mockAdapterSessionStartDurationRecord: vi.fn(),
}));

vi.mock('../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../telemetry/metrics.js')>()),
  appHomeSessions: { add: mockAppHomeSessionsAdd },
  providerOps: { add: mockProviderOpsAdd },
  agentCapabilityUndelivered: { add: mockAgentCapabilityUndeliveredAdd },
  codexToolServersDelivered: { add: mockCodexToolServersDeliveredAdd },
  connectionQuotaReads: { add: mockConnectionQuotaReadsAdd },
  orchestrationCommandsDispatched: {
    add: mockOrchestrationCommandsDispatchedAdd,
  },
  chatStartGate: { add: mockChatStartGateAdd },
  adapterSessionStartDuration: {
    record: mockAdapterSessionStartDurationRecord,
  },
}));

class FakeWritable extends Writable {
  readonly lines: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    const text = chunk.toString();
    for (const line of text.split('\n')) {
      if (line.trim()) {
        this.lines.push(line);
      }
    }
    callback();
  }
}

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new FakeWritable();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', 0);
    return true;
  }
}

class DeferredExitCodexProcess extends FakeCodexProcess {
  readonly killSignals: NodeJS.Signals[] = [];

  override kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    return false;
  }

  confirmExit(): void {
    this.signalCode = 'SIGKILL';
    this.emit('exit', null, 'SIGKILL');
  }
}

function parseLine(line: string): any {
  return JSON.parse(line);
}

async function flushIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

function writeServerMessage(
  adapter: CodexAdapter,
  threadId: string,
  message: unknown,
): void {
  const transport = (adapter as any).transport;
  const record = transport.requireSession(threadId);
  transport.handleStdoutLine(record, JSON.stringify(message));
}

async function respondToQuotaRead(
  process: FakeCodexProcess,
  payload: unknown,
): Promise<void> {
  await flushIo();
  process.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
  await flushIo();
  process.stdout.write(`${JSON.stringify({ id: '2', result: payload })}\n`);
}

async function startQuotaSession(options: {
  adapter: CodexAdapter;
  connectionId: string;
  process: FakeCodexProcess;
  threadId: string;
  credentialProfileRef?: string;
}): Promise<void> {
  const session = options.adapter.startSession({
    provider: 'codex',
    threadId: options.threadId,
    modelId: 'gpt-5-codex',
    metadata: { connectionId: options.connectionId },
    ...(options.credentialProfileRef
      ? { credentialProfileRef: options.credentialProfileRef }
      : {}),
  });
  await flushIo();
  options.process.stdout.write(
    `${JSON.stringify({ id: '1', result: { userAgent: 'test' } })}\n`,
  );
  await flushIo();
  options.process.stdout.write(
    `${JSON.stringify({
      id: '2',
      result: { thread: { id: `codex-${options.threadId}` } },
    })}\n`,
  );
  await session;
}

async function nextEvent(
  iterator: AsyncIterator<any>,
  label: string,
): Promise<any> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        750,
      ),
    ),
  ]);
  return result.value;
}

/**
 * Drains every currently-queued event without asserting on order or count —
 * used where several unrelated events (session lifecycle, tool activity)
 * precede the ones under test. Resolves once 100ms passes with nothing new
 * (the queue's `next()` resolves immediately for a buffered item, so a real
 * quiescence window only elapses when nothing is left).
 */
async function drainEvents(iterator: AsyncIterator<any>): Promise<any[]> {
  const results: any[] = [];
  for (;;) {
    const result = await Promise.race([
      iterator.next(),
      new Promise<{ done: true; value: undefined }>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 100),
      ),
    ]);
    if (result.done) break;
    results.push(result.value);
  }
  return results;
}

async function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        750,
      ),
    ),
  ]);
}

describe('CodexAdapter', () => {
  test('declares provider-response recovery settlement', () => {
    expect(new CodexAdapter().metadata.recovery).toMatchObject({
      dispatchSettlement: 'provider-response',
    });
  });

  let processHandle: FakeCodexProcess | undefined;
  const originalPath = process.env.PATH;
  const originalOpenAiKey = process.env.OPENAI_API_KEY;

  afterEach(() => {
    mockProviderOpsAdd.mockClear();
    mockAppHomeSessionsAdd.mockClear();
    processHandle?.stdout.end();
    processHandle?.stderr.end();
    processHandle = undefined;
    process.env.PATH = originalPath;
    delete process.env.STATION_DISABLE_LOGIN_PATH_RESOLVE;
    if (originalOpenAiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiKey;
    }
  });

  test('projects provider-reported quota without fabricating a missing secondary window', () => {
    const snapshot = projectCodexQuotaSnapshot(
      {
        rateLimits: {
          primary: {
            usedPercent: 42,
            windowDurationMins: 300,
            resetsAt: 1_786_300_800,
            limitName: '5h',
          },
          planType: 'pro',
        },
      },
      'codex-runtime',
      '2026-08-09T19:00:00.000Z',
    );

    expect(snapshot).toMatchObject({
      connectionId: 'codex-runtime',
      baselineAt: '2026-08-09T19:00:00.000Z',
      plan: { value: { type: 'pro' } },
      windows: [
        {
          id: 'primary',
          usedPercent: 42,
          windowDurationMins: 300,
          observedAt: '2026-08-09T19:00:00.000Z',
        },
      ],
    });
    expect(snapshot?.windows).toHaveLength(1);
    expect(snapshot?.credits).toBeUndefined();
  });

  test('returns provider-error when the quota transport fails', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({ processFactory: () => processHandle! });
    const read = adapter.readQuotaSnapshot({ connectionId: 'codex-runtime' });
    await flushIo();
    processHandle.emit('error', new Error('transport broken'));
    await expect(read).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'provider-error',
    });
  });

  test('returns timeout when the quota transport does not respond', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
      quotaTimeoutMs: 1,
    });
    await expect(
      adapter.readQuotaSnapshot({ connectionId: 'codex-runtime' }),
    ).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'timeout',
    });
  });

  test('rejects a present malformed quota subgroup instead of projecting a partial snapshot', () => {
    expect(() =>
      projectCodexQuotaSnapshot(
        {
          rateLimits: {
            primary: { usedPercent: 42 },
            credits: { hasCredits: 'yes', unlimited: false },
          },
        },
        'codex-runtime',
        '2026-08-09T19:00:00.000Z',
      ),
    ).toThrow('malformed credits');
    expect(() =>
      projectCodexQuotaUpdate(
        { rateLimits: { primary: { usedPercent: 100.5 } } },
        'codex-runtime',
        '2026-08-09T19:00:00.000Z',
      ),
    ).toThrow('malformed primary');
    for (const payload of [
      null,
      42,
      { rateLimits: null },
      { rateLimits: { primary: null } },
      { rateLimits: { secondary: 42 } },
    ]) {
      expect(() =>
        projectCodexQuotaSnapshot(
          payload,
          'codex-runtime',
          '2026-08-09T19:00:00.000Z',
        ),
      ).toThrow(/malformed (rate-limit envelope|primary|secondary)/);
    }
  });

  test('returns provider-error rather than a partial snapshot for a malformed present envelope or group', async () => {
    const first = new FakeCodexProcess();
    const second = new FakeCodexProcess();
    const processes = [first, second];
    const adapter = new CodexAdapter({
      processFactory: () => processes.shift()!,
    });
    for (const [process, payload] of [
      [first, { rateLimits: null }],
      [second, { rateLimits: { primary: null } }],
    ] as const) {
      const read = adapter.readQuotaSnapshot({ connectionId: 'codex' });
      await flushIo();
      process.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
      await flushIo();
      process.stdout.write(`${JSON.stringify({ id: '2', result: payload })}\n`);
      await expect(read).resolves.toEqual({
        kind: 'unavailable',
        reason: 'provider-error',
      });
    }
  });

  test('isolates cached pulls by global and profile account identity', async () => {
    const profileA = new FakeCodexProcess();
    const global = new FakeCodexProcess();
    const profileB = new FakeCodexProcess();
    const processes = [profileA, global, profileB];
    const processFactory = vi.fn(() => processes.shift()!);
    const adapter = new CodexAdapter({
      processFactory,
      getAppHomeEnv: vi.fn(async (ref) =>
        ref ? { CODEX_HOME: `/profiles/${ref}` } : undefined,
      ),
    });
    const respond = async (process: FakeCodexProcess, usedPercent: number) => {
      await flushIo();
      process.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
      await flushIo();
      process.stdout.write(
        `${JSON.stringify({ id: '2', result: { rateLimits: { primary: { usedPercent } } } })}\n`,
      );
    };
    const first = adapter.readQuotaSnapshot({
      connectionId: 'codex',
      credentialProfileRef: 'profile-a',
    });
    await respond(profileA, 10);
    await expect(first).resolves.toMatchObject({
      snapshot: { accountScope: 'profile', windows: [{ usedPercent: 10 }] },
    });
    const globalRead = adapter.readQuotaSnapshot({ connectionId: 'codex' });
    await respond(global, 20);
    await expect(globalRead).resolves.toMatchObject({
      snapshot: { accountScope: 'global', windows: [{ usedPercent: 20 }] },
    });
    const profileBRead = adapter.readQuotaSnapshot({
      connectionId: 'codex',
      credentialProfileRef: 'profile-b',
    });
    await respond(profileB, 30);
    await expect(profileBRead).resolves.toMatchObject({
      snapshot: { accountScope: 'profile', windows: [{ usedPercent: 30 }] },
    });
    await expect(
      adapter.readQuotaSnapshot({
        connectionId: 'codex',
        credentialProfileRef: 'profile-a',
      }),
    ).resolves.toMatchObject({ snapshot: { windows: [{ usedPercent: 10 }] } });
    expect(processFactory).toHaveBeenCalledTimes(3);
  });

  test('does not repopulate a cache entry when invalidated during its pull', async () => {
    const first = new FakeCodexProcess();
    const second = new FakeCodexProcess();
    const processes = [first, second];
    const processFactory = vi.fn(() => processes.shift()!);
    const adapter = new CodexAdapter({ processFactory });
    const pending = adapter.readQuotaSnapshot({ connectionId: 'codex' });
    await flushIo();
    adapter.invalidateQuotaSnapshot({ connectionId: 'codex' });
    first.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
    await flushIo();
    first.stdout.write(
      `${JSON.stringify({ id: '2', result: { rateLimits: { primary: { usedPercent: 10 } } } })}\n`,
    );
    await expect(pending).resolves.toMatchObject({ kind: 'snapshot' });
    const refreshed = adapter.readQuotaSnapshot({ connectionId: 'codex' });
    await flushIo();
    second.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
    await flushIo();
    second.stdout.write(
      `${JSON.stringify({ id: '2', result: { rateLimits: { primary: { usedPercent: 20 } } } })}\n`,
    );
    await expect(refreshed).resolves.toMatchObject({
      snapshot: { windows: [{ usedPercent: 20 }] },
    });
    expect(processFactory).toHaveBeenCalledTimes(2);
  });

  test('uses profile and global account scopes honestly, and bounds cache reuse', async () => {
    const profileProcess = new FakeCodexProcess();
    const globalProcess = new FakeCodexProcess();
    const refreshedProcess = new FakeCodexProcess();
    const processes = [profileProcess, globalProcess, refreshedProcess];
    const processFactory = vi.fn(() => processes.shift()!);
    const adapter = new CodexAdapter({
      processFactory,
      getAppHomeEnv: vi.fn(async (ref) =>
        ref ? { CODEX_HOME: '/profile' } : undefined,
      ),
      quotaCacheTtlMs: 0,
    });
    const respond = async (
      process: FakeCodexProcess,
      read: Promise<unknown>,
    ) => {
      await flushIo();
      process.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
      await flushIo();
      process.stdout.write(
        `${JSON.stringify({ id: '2', result: { rateLimits: { primary: { usedPercent: 42 } } } })}\n`,
      );
      return read;
    };
    await expect(
      respond(
        profileProcess,
        adapter.readQuotaSnapshot({
          connectionId: 'codex',
          credentialProfileRef: 'a',
        }),
      ),
    ).resolves.toEqual({
      kind: 'snapshot',
      snapshot: {
        connectionId: 'codex',
        provider: 'codex',
        source: 'provider-reported',
        accountScope: 'profile',
        observedAt: expect.any(String),
        baselineAt: expect.any(String),
        windows: [
          { id: 'primary', usedPercent: 42, observedAt: expect.any(String) },
        ],
      },
    });
    await expect(
      respond(
        globalProcess,
        adapter.readQuotaSnapshot({ connectionId: 'global' }),
      ),
    ).resolves.toEqual({
      kind: 'snapshot',
      snapshot: {
        connectionId: 'global',
        provider: 'codex',
        source: 'provider-reported',
        accountScope: 'global',
        observedAt: expect.any(String),
        baselineAt: expect.any(String),
        windows: [
          { id: 'primary', usedPercent: 42, observedAt: expect.any(String) },
        ],
      },
    });
    const refresh = adapter.readQuotaSnapshot({
      connectionId: 'codex',
      credentialProfileRef: 'a',
    });
    await respond(refreshedProcess, refresh);
    expect(processFactory).toHaveBeenCalledTimes(3);
    expect(processFactory).toHaveBeenNthCalledWith(1, {
      CODEX_HOME: '/profile',
    });
    expect(processFactory).toHaveBeenNthCalledWith(2, undefined);
  });

  test('merges a sparse rolling update onto its pull baseline without clearing null account metadata', async () => {
    const pull = new FakeCodexProcess();
    const session = new FakeCodexProcess();
    const processes = [pull, session];
    const adapter = new CodexAdapter({
      processFactory: vi.fn(() => processes.shift()!),
    });
    const read = adapter.readQuotaSnapshot({ connectionId: 'codex-a' });
    await respondToQuotaRead(pull, {
      rateLimits: {
        primary: { usedPercent: 10, windowDurationMins: 300 },
        secondary: { usedPercent: 20 },
        credits: { hasCredits: true, unlimited: false, balance: '12.34' },
      },
    });
    await expect(read).resolves.toMatchObject({ kind: 'snapshot' });
    await startQuotaSession({
      adapter,
      connectionId: 'codex-a',
      process: session,
      threadId: 'quota-merge',
    });

    session.stdout.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: {
          rateLimits: {
            primary: { usedPercent: 40 },
            credits: null,
          },
        },
      })}\n`,
    );
    await flushIo();

    await expect(
      adapter.readQuotaSnapshot({ connectionId: 'codex-a' }),
    ).resolves.toMatchObject({
      snapshot: {
        windows: [
          { id: 'primary', usedPercent: 40 },
          { id: 'secondary', usedPercent: 20 },
        ],
        credits: { value: { balance: '12.34' } },
      },
    });
    await adapter.stopAll();
  });

  test('keeps a rolling update in its emitting profile scope, never its sibling profile cache', async () => {
    const pull = new FakeCodexProcess();
    const session = new FakeCodexProcess();
    const processes = [pull, session];
    const adapter = new CodexAdapter({
      processFactory: vi.fn(() => processes.shift()!),
      getAppHomeEnv: vi.fn(async (ref) =>
        ref ? { CODEX_HOME: `/profiles/${ref}` } : undefined,
      ),
    });
    const read = adapter.readQuotaSnapshot({
      connectionId: 'codex',
      credentialProfileRef: 'profile-a',
    });
    await respondToQuotaRead(pull, {
      rateLimits: { primary: { usedPercent: 10 } },
    });
    await read;
    await startQuotaSession({
      adapter,
      connectionId: 'codex',
      credentialProfileRef: 'profile-b',
      process: session,
      threadId: 'profile-b-session',
    });
    session.stdout.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 90 } } },
      })}\n`,
    );
    await flushIo();

    await expect(
      adapter.readQuotaSnapshot({
        connectionId: 'codex',
        credentialProfileRef: 'profile-a',
      }),
    ).resolves.toMatchObject({ snapshot: { windows: [{ usedPercent: 10 }] } });
    const profileB = await adapter.readQuotaSnapshot({
      connectionId: 'codex',
      credentialProfileRef: 'profile-b',
    });
    expect(profileB).toEqual({
      kind: 'snapshot',
      snapshot: {
        connectionId: 'codex',
        provider: 'codex',
        source: 'provider-reported',
        accountScope: 'profile',
        observedAt: expect.any(String),
        windows: [
          {
            id: 'primary',
            usedPercent: 90,
            observedAt: expect.any(String),
          },
        ],
      },
    });
    expect(
      profileB.kind === 'snapshot' && 'baselineAt' in profileB.snapshot,
    ).toBe(false);
    await adapter.stopAll();
  });

  test('routes an account notification to its emitting connection even when its payload carries a sibling thread id', async () => {
    const pullA = new FakeCodexProcess();
    const pullB = new FakeCodexProcess();
    const sessionA = new FakeCodexProcess();
    const sessionB = new FakeCodexProcess();
    const processes = [pullA, pullB, sessionA, sessionB];
    const adapter = new CodexAdapter({
      processFactory: vi.fn(() => processes.shift()!),
    });
    const readA = adapter.readQuotaSnapshot({ connectionId: 'codex-a' });
    await respondToQuotaRead(pullA, {
      rateLimits: { primary: { usedPercent: 10 } },
    });
    await readA;
    const readB = adapter.readQuotaSnapshot({ connectionId: 'codex-b' });
    await respondToQuotaRead(pullB, {
      rateLimits: { primary: { usedPercent: 20 } },
    });
    await readB;
    await startQuotaSession({
      adapter,
      connectionId: 'codex-a',
      process: sessionA,
      threadId: 'connection-a-session',
    });
    await startQuotaSession({
      adapter,
      connectionId: 'codex-b',
      process: sessionB,
      threadId: 'connection-b-session',
    });

    sessionA.stdout.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: {
          threadId: 'codex-connection-b-session',
          rateLimits: { primary: { usedPercent: 77 } },
        },
      })}\n`,
    );
    await flushIo();

    await expect(
      adapter.readQuotaSnapshot({ connectionId: 'codex-a' }),
    ).resolves.toMatchObject({ snapshot: { windows: [{ usedPercent: 77 }] } });
    await expect(
      adapter.readQuotaSnapshot({ connectionId: 'codex-b' }),
    ).resolves.toMatchObject({ snapshot: { windows: [{ usedPercent: 20 }] } });
    await adapter.stopAll();
  });

  test('ignores a stopped process notification after a same-profile replacement is live', async () => {
    const retired = new FakeCodexProcess();
    const replacement = new FakeCodexProcess();
    const processes = [retired, replacement];
    const adapter = new CodexAdapter({
      processFactory: () => processes.shift()!,
      getAppHomeEnv: vi.fn(async () => ({ CODEX_HOME: '/profiles/canary' })),
    });
    await startQuotaSession({
      adapter,
      connectionId: 'codex-a',
      credentialProfileRef: 'canary',
      process: retired,
      threadId: 'retired-profile-session',
    });
    await startQuotaSession({
      adapter,
      connectionId: 'codex-a',
      credentialProfileRef: 'canary',
      process: replacement,
      threadId: 'replacement-profile-session',
    });
    replacement.stdout.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 40 } } },
      })}\n`,
    );
    await flushIo();

    // stopSession marks a record stopped before termination completes. Model
    // that buffered-stdout window while a same-profile replacement is live.
    const transport = (adapter as any).transport;
    transport.requireSession('retired-profile-session').stopped = true;
    retired.stdout.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 90 } } },
      })}\n`,
    );
    await flushIo();

    await expect(
      adapter.readQuotaSnapshot({
        connectionId: 'codex-a',
        credentialProfileRef: 'canary',
      }),
    ).resolves.toMatchObject({ snapshot: { windows: [{ usedPercent: 40 }] } });
    await adapter.stopAll();
  });

  test('logs and invalidates a corrupted cache baseline with another connection identity', async () => {
    const session = new FakeCodexProcess();
    const refresh = new FakeCodexProcess();
    const logger = { warn: vi.fn() };
    const processes = [session, refresh];
    const adapter = new CodexAdapter({
      processFactory: () => processes.shift()!,
      logger,
    });
    await startQuotaSession({
      adapter,
      connectionId: 'codex-a',
      process: session,
      threadId: 'identity-guard-notification',
    });
    const cache = (adapter as any).quotaSnapshots as Map<string, unknown>;
    const baseline = {
      connectionId: 'codex-b',
      provider: 'codex',
      source: 'provider-reported',
      accountScope: 'global',
      observedAt: '2026-08-10T12:00:00.000Z',
      baselineAt: '2026-08-10T12:00:00.000Z',
      windows: [
        {
          id: 'primary',
          usedPercent: 10,
          observedAt: '2026-08-10T12:00:00.000Z',
        },
      ],
    };
    const cached = { snapshot: baseline, cachedAt: Date.now() };
    cache.set('codex-a\u0000global', cached);

    session.stdout.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 90 } } },
      })}\n`,
    );
    await flushIo();

    expect(cache.get('codex-a\u0000global')).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'Codex quota cache identity violation',
      {
        provider: 'codex',
        connectionId: 'codex-a',
        accountScope: 'global',
      },
    );
    // The cache-owning read boundary can no longer serve the corrupted
    // snapshot after either the invalidation or the warning is removed.
    const reread = adapter.readQuotaSnapshot({ connectionId: 'codex-a' });
    await respondToQuotaRead(refresh, {
      rateLimits: { primary: { usedPercent: 12 } },
    });
    await expect(reread).resolves.toMatchObject({
      snapshot: { connectionId: 'codex-a', windows: [{ usedPercent: 12 }] },
    });
    await adapter.stopAll();
  });

  test('keeps live quota routing after a credential-profile session restart', async () => {
    const initial = new FakeCodexProcess();
    const restarted = new FakeCodexProcess();
    const processes = [initial, restarted];
    const adapter = new CodexAdapter({
      now: () => new Date('2026-08-10T12:00:00.000Z'),
      processFactory: vi.fn(() => processes.shift()!),
      getAppHomeEnv: vi.fn(async (ref) =>
        ref ? { CODEX_HOME: `/profiles/${ref}` } : undefined,
      ),
    });
    vi.spyOn(adapter, 'getPrerequisites').mockResolvedValue([]);
    const service = new OrchestrationService({
      adapterRegistry: {
        get: (provider) => (provider === 'codex' ? adapter : undefined),
        list: () => [adapter],
        register: () => {},
      },
      eventBus: new EventBus(),
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
    const threadId = 'credential-profile-quota-restart';
    const start = service.dispatch({
      type: 'startSession',
      input: {
        provider: 'codex',
        threadId,
        metadata: { connectionId: 'codex-a' },
      },
    });
    await vi.waitFor(() => {
      const transport = (adapter as any).transport;
      expect(transport.requireSession(threadId).process).toBe(initial);
    });
    writeServerMessage(adapter, threadId, {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, threadId, {
      id: '2',
      result: { thread: { id: `codex-${threadId}` } },
    });
    await start;

    const restart = (
      service as unknown as {
        restartCredentialProfileProviderSession(input: {
          threadId: string;
          signal: AbortSignal;
          credentialProfileRef: string;
        }): Promise<unknown>;
      }
    ).restartCredentialProfileProviderSession({
      threadId,
      signal: new AbortController().signal,
      credentialProfileRef: 'canary',
    });
    await vi.waitFor(() => {
      const transport = (adapter as any).transport;
      expect(transport.requireSession(threadId).process).toBe(restarted);
    });
    writeServerMessage(adapter, threadId, {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, threadId, {
      id: '2',
      result: { thread: { id: `codex-${threadId}-restarted` } },
    });
    await restart;

    restarted.stdout.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 42 } } },
      })}\n`,
    );
    await flushIo();

    await expect(
      adapter.readQuotaSnapshot({
        connectionId: 'codex-a',
        credentialProfileRef: 'canary',
      }),
    ).resolves.toEqual({
      kind: 'snapshot',
      snapshot: {
        connectionId: 'codex-a',
        provider: 'codex',
        source: 'provider-reported',
        accountScope: 'profile',
        observedAt: '2026-08-10T12:00:00.000Z',
        windows: [
          {
            id: 'primary',
            usedPercent: 42,
            observedAt: '2026-08-10T12:00:00.000Z',
          },
        ],
      },
    });
    await service.shutdown();
  });

  test('recovers persisted quota routing before a credential-profile restart', async () => {
    const recovered = new FakeCodexProcess();
    const restarted = new FakeCodexProcess();
    const processes = [recovered, restarted];
    const directory = mkdtempSync(join(tmpdir(), 'codex-quota-recovery-'));
    const eventStore = new EventStore(join(directory, 'orchestration.sqlite'));
    const adapter = new CodexAdapter({
      now: () => new Date('2026-08-10T12:00:00.000Z'),
      processFactory: () => processes.shift()!,
      getAppHomeEnv: vi.fn(async (ref) =>
        ref ? { CODEX_HOME: `/profiles/${ref}` } : undefined,
      ),
    });
    vi.spyOn(adapter, 'getPrerequisites').mockResolvedValue([]);
    const threadId = 'recovered-credential-profile-quota';
    eventStore.appendEvent({
      eventId: 'persisted-quota-route',
      provider: 'codex',
      threadId,
      createdAt: '2026-08-10T11:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
      initialState: 'created',
      metadata: { connectionId: 'codex-a' },
    } as any);
    eventStore.upsertSession({
      provider: 'codex',
      threadId,
      status: 'running',
      model: 'gpt-5-codex',
      persistSession: true,
      createdAt: '2026-08-10T11:00:00.000Z',
      updatedAt: '2026-08-10T11:00:01.000Z',
    });
    const service = new OrchestrationService({
      adapterRegistry: {
        get: (provider) => (provider === 'codex' ? adapter : undefined),
        list: () => [adapter],
        register: () => {},
      },
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });

    try {
      service.initialize();
      // station#3476: boot recovery restores the session's state and starts
      // no engine. This test's subject is the persisted quota ROUTING that
      // survives into the credential-profile restart, which still needs a
      // live session first — so materialise it the way the turn path does.
      // Not awaited: the codex handshake messages below are what let that
      // start settle, exactly as they did when boot recovery issued it.
      void (
        service as unknown as {
          materializeRecoveredSession(threadId: string): Promise<unknown>;
        }
      )
        .materializeRecoveredSession(threadId)
        .catch(() => undefined);
      await vi.waitFor(() => {
        const transport = (adapter as any).transport;
        expect(transport.requireSession(threadId).process).toBe(recovered);
      });
      writeServerMessage(adapter, threadId, {
        id: '1',
        result: { userAgent: 'test' },
      });
      await flushIo();
      writeServerMessage(adapter, threadId, {
        id: '2',
        result: { thread: { id: `codex-${threadId}` } },
      });
      await vi.waitFor(() =>
        expect(
          (adapter as any).transport.requireSession(threadId).codexThreadId,
        ).toBe(`codex-${threadId}`),
      );

      const restart = (
        service as unknown as {
          restartCredentialProfileProviderSession(input: {
            threadId: string;
            signal: AbortSignal;
            credentialProfileRef: string;
          }): Promise<unknown>;
        }
      ).restartCredentialProfileProviderSession({
        threadId,
        signal: new AbortController().signal,
        credentialProfileRef: 'canary',
      });
      await vi.waitFor(() => {
        const transport = (adapter as any).transport;
        expect(transport.requireSession(threadId).process).toBe(restarted);
      });
      writeServerMessage(adapter, threadId, {
        id: '1',
        result: { userAgent: 'test' },
      });
      await flushIo();
      writeServerMessage(adapter, threadId, {
        id: '2',
        result: { thread: { id: `codex-${threadId}-restarted` } },
      });
      await restart;

      restarted.stdout.write(
        `${JSON.stringify({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { primary: { usedPercent: 42 } } },
        })}\n`,
      );
      await flushIo();
      await expect(
        adapter.readQuotaSnapshot({
          connectionId: 'codex-a',
          credentialProfileRef: 'canary',
        }),
      ).resolves.toMatchObject({
        snapshot: { windows: [{ usedPercent: 42 }] },
      });
    } finally {
      await service.shutdown();
      eventStore.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('bounds notification cache inserts and evicts the oldest account entry', () => {
    const adapter = new CodexAdapter({ quotaCacheMaxEntries: 2 });
    const transport = (adapter as any).transport;
    for (const connectionId of ['codex-a', 'codex-b', 'codex-c']) {
      transport.handleStdoutLine(
        {
          quotaConnectionId: connectionId,
          quotaAccountScope: 'global',
          quotaCacheKey: `${connectionId}\u0000global`,
        },
        JSON.stringify({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { primary: { usedPercent: 10 } } },
        }),
      );
    }
    const cache = (adapter as any).quotaSnapshots as Map<string, unknown>;
    expect([...cache.keys()]).toEqual([
      'codex-b\u0000global',
      'codex-c\u0000global',
    ]);
  });

  test('logs a rolling notification that lacks quota routing identity', () => {
    const logger = { warn: vi.fn() };
    const adapter = new CodexAdapter({ logger });
    const transport = (adapter as any).transport;
    transport.handleStdoutLine(
      {},
      JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 10 } } },
      }),
    );

    expect(logger.warn).toHaveBeenCalledWith(
      'Codex quota notification dropped',
      { provider: 'codex', reason: 'missing-routing-identity' },
    );
  });

  test('drops a malformed rolling payload without throwing from transport or changing its cached baseline', async () => {
    const pull = new FakeCodexProcess();
    const session = new FakeCodexProcess();
    const logger = { warn: vi.fn() };
    const processes = [pull, session];
    const adapter = new CodexAdapter({
      processFactory: vi.fn(() => processes.shift()!),
      logger,
    });
    const read = adapter.readQuotaSnapshot({ connectionId: 'codex' });
    await respondToQuotaRead(pull, {
      rateLimits: { primary: { usedPercent: 10 } },
    });
    await read;
    await startQuotaSession({
      adapter,
      connectionId: 'codex',
      process: session,
      threadId: 'malformed-notification',
    });

    expect(() =>
      session.stdout.write(
        `${JSON.stringify({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { primary: { usedPercent: 101 } } },
        })}\n`,
      ),
    ).not.toThrow();
    await flushIo();
    await expect(
      adapter.readQuotaSnapshot({ connectionId: 'codex' }),
    ).resolves.toMatchObject({ snapshot: { windows: [{ usedPercent: 10 }] } });
    expect(logger.warn).toHaveBeenCalledWith(
      'Codex quota notification dropped',
      expect.objectContaining({ reason: 'invalid-rate-limit-notification' }),
    );
    await adapter.stopAll();
  });

  // The graceful-rejection test above never exercises the transport's
  // try/catch, because an out-of-range percent is REJECTED, not thrown. This
  // one forces a genuine throw from the quota handler and proves the readline
  // boundary survives it — removing the guard in codex-adapter-transport.ts
  // must redden this test, and previously reddened nothing.
  test('survives a throwing quota handler and keeps processing later notifications', async () => {
    const session = new FakeCodexProcess();
    const notificationErrors: string[] = [];
    const transport = new CodexAdapterTransport(
      () => new Date('2026-08-10T12:00:00.000Z'),
      async () => {},
      () => {
        throw new Error('synthetic quota handler failure');
      },
      (method) => notificationErrors.push(method),
    );
    const record = createCodexSessionRecord({
      externalThreadId: 'throwing-quota',
      process: session as never,
      provider: 'codex',
      threadId: 'throwing-quota',
      model: 'gpt-5.4-codex',
      nowIso: () => '2026-08-10T12:00:00.000Z',
    });
    transport.registerSession(record);
    transport.handleProcess(record);

    expect(() =>
      session.stdout.write(
        `${JSON.stringify({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { primary: { usedPercent: 42 } } },
        })}\n`,
      ),
    ).not.toThrow();
    await flushIo();
    expect(notificationErrors).toContain('account/rateLimits/updated');

    // The transport is not wedged: a subsequent notification still arrives.
    expect(() =>
      session.stdout.write(
        `${JSON.stringify({
          method: 'account/rateLimits/updated',
          params: { rateLimits: { primary: { usedPercent: 43 } } },
        })}\n`,
      ),
    ).not.toThrow();
    await flushIo();
    expect(notificationErrors).toHaveLength(2);
  });

  test('does not let a strictly older notification overwrite a newer quota observation', async () => {
    let now = new Date('2026-08-10T12:00:00.000Z');
    const pull = new FakeCodexProcess();
    const session = new FakeCodexProcess();
    const processes = [pull, session];
    const adapter = new CodexAdapter({
      now: () => now,
      processFactory: vi.fn(() => processes.shift()!),
    });
    const read = adapter.readQuotaSnapshot({ connectionId: 'codex' });
    await respondToQuotaRead(pull, {
      rateLimits: { primary: { usedPercent: 80 } },
    });
    await read;
    await startQuotaSession({
      adapter,
      connectionId: 'codex',
      process: session,
      threadId: 'older-notification',
    });
    now = new Date('2026-08-10T11:59:59.000Z');
    session.stdout.write(
      `${JSON.stringify({
        method: 'account/rateLimits/updated',
        params: { rateLimits: { primary: { usedPercent: 10 } } },
      })}\n`,
    );
    await flushIo();
    await expect(
      adapter.readQuotaSnapshot({ connectionId: 'codex' }),
    ).resolves.toMatchObject({ snapshot: { windows: [{ usedPercent: 80 }] } });
    await adapter.stopAll();
  });

  test('returns typed not-authenticated for a structured transport refusal and provider-error for synchronous spawn failure', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({ processFactory: () => process });
    const read = adapter.readQuotaSnapshot({ connectionId: 'codex' });
    await flushIo();
    process.stdout.write(
      `${JSON.stringify({ id: '1', error: { code: 'authentication_required', message: 'anything' } })}\n`,
    );
    await expect(read).resolves.toEqual({
      kind: 'unavailable',
      reason: 'not-authenticated',
    });
    await expect(
      new CodexAdapter({
        processFactory: () => {
          throw new Error('sync spawn');
        },
      }).readQuotaSnapshot({ connectionId: 'codex' }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'provider-error' });
  });

  test('rejects a duplicate session before creating a second process', async () => {
    processHandle = new FakeCodexProcess();
    const processFactory = vi.fn(() => processHandle!);
    const adapter = new CodexAdapter({ processFactory });
    const input = {
      provider: 'codex' as const,
      threadId: 'duplicate-thread',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    };

    const first = adapter.startSession(input);
    await expect(adapter.startSession(input)).rejects.toThrow('already exists');
    await flushIo();
    writeServerMessage(adapter, 'duplicate-thread', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'duplicate-thread', {
      id: '2',
      result: { thread: { id: 'codex-duplicate' }, model: 'gpt-5-codex' },
    });

    await expect(first).resolves.toMatchObject({
      threadId: 'duplicate-thread',
    });
    expect(processFactory).toHaveBeenCalledOnce();
    await adapter.stopAll();
  });

  // #903: `session.configured` is the only event that carries a model into the
  // read model and the persisted session row, and Codex published it once, at
  // session start — so a per-turn model change lived in adapter memory alone
  // and a rehydrated session reported the model it started with.
  test('restates session.configured when a turn changes the model, carrying cwd', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-remodel',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-remodel', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-remodel', {
      id: '2',
      result: { thread: { id: 'codex-thread-remodel' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-remodel',
      input: 'switch models',
      modelId: 'gpt-5.1-codex',
    });
    writeServerMessage(adapter, 'thread-remodel', {
      id: '3',
      result: { turn: { id: 'turn-remodel' } },
    });
    await withTimeout(sendTurnPromise, 'sendTurn');
    await flushIo();

    const seen: Array<{ method: string; model?: string; cwd?: string }> = [];
    for (let index = 0; index < 6; index++) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('timed out')), 1_000),
        ),
      ]).catch(() => null);
      if (!next || next.done) break;
      seen.push(next.value as { method: string; model?: string; cwd?: string });
      if (
        seen.filter((event) => event.method === 'session.configured').length ===
        2
      ) {
        break;
      }
    }

    const configured = seen.filter(
      (event) => event.method === 'session.configured',
    );
    expect(configured).toHaveLength(2);
    expect(configured[0].model).toBe('gpt-5-codex');
    expect(configured[1].model).toBe('gpt-5.1-codex');
    // `buildAgentRunSummary` reads cwd off the LATEST session.configured with
    // no fallback, so the restatement has to carry it forward.
    expect(configured[1].cwd).toBe('/tmp/project');

    await adapter.stopAll();
  });

  test('starts a Codex session, sends turns, and maps notifications to canonical events', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-1',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
      modelOptions: {
        reasoningEffort: 'high',
        fastMode: true,
      },
    });
    await flushIo();

    writeServerMessage(adapter, 'thread-1', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-1', {
      id: '2',
      result: {
        thread: {
          id: 'codex-thread-1',
        },
        model: 'gpt-5-codex',
      },
    });

    const session = await withTimeout(startSessionPromise, 'startSession');
    await flushIo();
    expect(session).toMatchObject({
      threadId: 'thread-1',
      status: 'ready',
      resumeCursor: { codexThreadId: 'codex-thread-1' },
    });

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-1',
      input: 'Inspect the repo',
      modelOptions: {
        reasoningEffort: 'high',
        fastMode: true,
      },
    });

    writeServerMessage(adapter, 'thread-1', {
      id: '3',
      result: {
        turn: {
          id: 'turn-1',
        },
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'thread/status/changed',
      params: {
        threadId: 'codex-thread-1',
        status: { type: 'active', activeFlags: [] },
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'item/started',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'tool-1',
          command: 'ls',
          cwd: '/tmp/project',
          status: 'inProgress',
          commandActions: [],
          aggregatedOutput: null,
          exitCode: null,
          durationMs: null,
          processId: 'pty-1',
          source: 'localShell',
        },
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'item/commandExecution/outputDelta',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        itemId: 'tool-1',
        delta: 'file-a\n',
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'item/completed',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        item: {
          type: 'commandExecution',
          id: 'tool-1',
          command: 'ls',
          cwd: '/tmp/project',
          status: 'completed',
          commandActions: [],
          aggregatedOutput: 'file-a\n',
          exitCode: 0,
          durationMs: 12,
          processId: 'pty-1',
          source: 'localShell',
        },
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'item/agentMessage/delta',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        itemId: 'msg-1',
        delta: 'Done.',
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'item/reasoning/textDelta',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        itemId: 'reason-1',
        delta: 'Need to check files first.',
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'thread/tokenUsage/updated',
      params: {
        threadId: 'codex-thread-1',
        turnId: 'turn-1',
        tokenUsage: {
          total: {
            inputTokens: 10,
            outputTokens: 5,
            totalTokens: 15,
            cachedInputTokens: 2,
          },
        },
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'thread/status/changed',
      params: {
        threadId: 'codex-thread-1',
        status: { type: 'idle' },
      },
    });
    writeServerMessage(adapter, 'thread-1', {
      method: 'turn/completed',
      params: {
        threadId: 'codex-thread-1',
        turn: {
          id: 'turn-1',
          status: 'completed',
          items: [],
          error: null,
        },
      },
    });

    const turn = await withTimeout(sendTurnPromise, 'sendTurn');
    expect(mockProviderOpsAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        operation: 'adapter-model-options',
        model_options: 'applied',
      }),
    );
    await flushIo();
    expect(turn).toEqual({
      threadId: 'thread-1',
      turnId: 'turn-1',
      resumeCursor: {
        codexThreadId: 'codex-thread-1',
        turnId: 'turn-1',
      },
    });

    const events = [
      await nextEvent(iterator, 'event 1'),
      await nextEvent(iterator, 'event 2'),
      await nextEvent(iterator, 'event 3'),
      await nextEvent(iterator, 'event 4'),
      await nextEvent(iterator, 'event 5'),
      await nextEvent(iterator, 'event 6'),
      await nextEvent(iterator, 'event 7'),
      await nextEvent(iterator, 'event 8'),
      await nextEvent(iterator, 'event 9'),
      await nextEvent(iterator, 'event 10'),
      await nextEvent(iterator, 'event 11'),
      await nextEvent(iterator, 'event 12'),
    ];
    const methods = events.map((event) => event.method);

    expectCanonicalSessionLifecycle(methods);
    expect(methods).toContain('session.state-changed');
    expect(methods).toContain('tool.started');
    expect(methods).toContain('tool.progress');
    expect(methods).toContain('tool.completed');
    expect(methods).toContain('content.text-delta');
    expect(methods).toContain('content.reasoning-delta');
    expect(methods).toContain('token-usage.updated');
    expect(methods).toContain('turn.completed');

    const usageEvent = events.find(
      (event) => event.method === 'token-usage.updated',
    );
    expect(usageEvent).toMatchObject({
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      cacheReadTokens: 2,
    });

    const idleEvent = events.find(
      (event) =>
        event.method === 'session.state-changed' &&
        event.from === 'running' &&
        event.to === 'idle',
    );
    const completedEvent = events.find(
      (event) => event.method === 'turn.completed',
    );

    expect(idleEvent).toBeTruthy();
    expect(completedEvent).toMatchObject({
      turnId: 'turn-1',
      finishReason: 'stop',
      outputText: 'Done.',
    });

    const writtenMethods = processHandle.stdin.lines.map(
      (line) => parseLine(line).method,
    );
    expect(writtenMethods).toEqual([
      'initialize',
      'initialized',
      'thread/start',
      'turn/start',
    ]);
  });

  // station#3451 fix round (H3): `interruptTurn` now matches claude/acp's
  // pattern exactly — `activeTurnId` and `terminalPublishedForTurnId` are
  // touched ONLY on a confirmed publish (after the RPC succeeds), never
  // eagerly before the await. The double-terminal guard for a later
  // `stopSession` (the cooperative-stop hard-teardown path calls it right
  // after attempting interrupt) is now the EXPLICIT
  // `terminalPublishedForTurnId` fact, not an inferred-from-clearing one.
  test('interruptTurn only clears activeTurnId and marks the terminal published AFTER a confirmed publish, and a later stopSession does not double-publish', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-interrupt',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-interrupt', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-interrupt', {
      id: '2',
      result: {
        thread: { id: 'codex-thread-interrupt' },
        model: 'gpt-5-codex',
      },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-interrupt',
      input: 'do something',
    });
    writeServerMessage(adapter, 'thread-interrupt', {
      id: '3',
      result: { turn: { id: 'turn-1' } },
    });
    await withTimeout(sendTurnPromise, 'sendTurn');
    await flushIo();

    const record = (adapter as any).transport.requireSession(
      'thread-interrupt',
    );
    expect(record.activeTurnId).toBe('turn-1');

    const interruptPromise = adapter.interruptTurn(
      'thread-interrupt',
      'turn-1',
    );
    await flushIo();
    // station#3451 (H3): NOT cleared yet — the RPC has not resolved. The
    // recovery interrupt hook and the accept-then-abort race cleanup
    // (orchestration-service.ts) both catch a rejected interruptTurn and
    // rely on a LATER canonical terminal to close the turn; clearing here
    // would have silently disarmed that fallback.
    expect(record.activeTurnId).toBe('turn-1');
    expect(record.terminalPublishedForTurnId).toBeUndefined();

    const pendingIds = [
      ...(record.pendingRpcRequests as Map<string, unknown>).keys(),
    ];
    expect(pendingIds).toHaveLength(1);
    writeServerMessage(adapter, 'thread-interrupt', {
      id: pendingIds[0],
      result: {},
    });
    const interruptResult = await withTimeout(
      interruptPromise,
      'interruptTurn',
    );
    expect(interruptResult).toEqual({ outcome: 'cancelled', turnId: 'turn-1' });
    // Now cleared/marked, right after the confirmed publish below.
    expect(record.activeTurnId).toBeUndefined();
    expect(record.terminalPublishedForTurnId).toBe('turn-1');

    // The hard-teardown path this guards: orchestration-service would
    // already have published its own turn.aborted for this turnId before
    // calling stopSession (see interruptUserTurnCooperatively's deadline
    // branch). This proves stopSession's own orphaned-turn synthesis does
    // NOT also fire for the same turn.
    await adapter.stopSession('thread-interrupt');

    const events = await drainEvents(iterator);
    const methods = events.map((event) => event.method);
    expect(methods).toContain('turn.aborted');
    expect(methods).toContain('session.exited');
    expect(
      events.filter(
        (event) =>
          event.method === 'runtime.error' && event.turnId === 'turn-1',
      ),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.method === 'turn.aborted'),
    ).toHaveLength(1);
  });

  // station#3451 finding B1 (fix #2): mirrors claude-adapter.ts's and
  // acp-adapter.ts's own target-mismatch guard, which codex previously
  // lacked. Given an explicit turnId that does not match the CURRENT
  // activeTurnId, refuse rather than blindly acting on a caller's stale id
  // (the exact shape a bounded fact-set-derived turnId can produce).
  test('interruptTurn returns target-mismatch for a stale explicit turnId, without touching activeTurnId', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-mismatch',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-mismatch', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-mismatch', {
      id: '2',
      result: { thread: { id: 'codex-thread-mismatch' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-mismatch',
      input: 'do something',
    });
    writeServerMessage(adapter, 'thread-mismatch', {
      id: '3',
      result: { turn: { id: 'turn-current' } },
    });
    await withTimeout(sendTurnPromise, 'sendTurn');
    await flushIo();

    const record = (adapter as any).transport.requireSession('thread-mismatch');
    expect(record.activeTurnId).toBe('turn-current');

    const result = await adapter.interruptTurn('thread-mismatch', 'turn-stale');
    expect(result).toEqual({
      outcome: 'target-mismatch',
      activeTurnId: 'turn-current',
    });
    // Refused before ever writing to the process — activeTurnId untouched.
    expect(record.activeTurnId).toBe('turn-current');
    expect(
      processHandle.stdin.lines.map((line) => parseLine(line).method),
    ).toEqual(['initialize', 'initialized', 'thread/start', 'turn/start']);
  });

  // station#3451 fix round: the double-terminal race H3's clear-on-success
  // change reopened for `runCooperativeStop`'s deadline path (the one caller
  // WITH an unconditional fallback) — closed by `rejectPendingRpcRequests`
  // detecting the in-flight `turn/interrupt` at the moment `stopSession`
  // force-rejects it.
  test('a turn/interrupt still in flight when stopSession force-rejects it does not get a duplicate synthesized terminal', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-race',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-race', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-race', {
      id: '2',
      result: { thread: { id: 'codex-thread-race' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-race',
      input: 'do something',
    });
    writeServerMessage(adapter, 'thread-race', {
      id: '3',
      result: { turn: { id: 'turn-race' } },
    });
    await withTimeout(sendTurnPromise, 'sendTurn');
    await flushIo();

    // Dispatch interrupt but never respond to its RPC — mirrors an
    // unresponsive engine, exactly the case runCooperativeStop's deadline
    // exists for. The deadline "wins" and calls stopSession while this is
    // still pending.
    const interruptPromise = adapter.interruptTurn('thread-race', 'turn-race');
    await flushIo();

    // orchestration-service's own turn.aborted, published BEFORE calling
    // stopSession in the real deadline branch — asserted separately below;
    // this test only proves the ADAPTER side does not ALSO publish one.
    await adapter.stopSession('thread-race');
    await interruptPromise.catch(() => undefined);

    const events = await drainEvents(iterator);
    const methods = events.map((event) => event.method);
    expect(methods).toContain('session.exited');
    expect(
      events.filter((event) => event.method === 'runtime.error'),
    ).toHaveLength(0);
    expect(
      events.filter((event) => event.method === 'turn.aborted'),
    ).toHaveLength(0);
  });

  // station#3451 finding H3 (the primary gap): interruptTurn's RPC rejects
  // for a reason OTHER than a concurrent teardown (e.g. codex returns a
  // JSON-RPC error for turn/interrupt — "no such turn", already gone) —
  // NOTHING marks the turn resolved. A LATER, INDEPENDENT stopSession must
  // still synthesize the missing terminal, exactly like the recovery
  // interrupt hook and the accept-then-abort race cleanup
  // (orchestration-service.ts) both implicitly rely on.
  test('interruptTurn RPC rejection (not a concurrent teardown) leaves activeTurnId intact, so a later independent stopSession still synthesizes', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-reject',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-reject', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-reject', {
      id: '2',
      result: { thread: { id: 'codex-thread-reject' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-reject',
      input: 'do something',
    });
    writeServerMessage(adapter, 'thread-reject', {
      id: '3',
      result: { turn: { id: 'turn-reject' } },
    });
    await withTimeout(sendTurnPromise, 'sendTurn');
    await flushIo();

    const record = (adapter as any).transport.requireSession('thread-reject');
    const interruptPromise = adapter.interruptTurn(
      'thread-reject',
      'turn-reject',
    );
    await flushIo();
    const pendingIds = [
      ...(record.pendingRpcRequests as Map<string, unknown>).keys(),
    ];
    expect(pendingIds).toHaveLength(1);
    // codex answers with a genuine JSON-RPC error — the interrupt RPC
    // settles (rejects) entirely on its own, with no teardown involved.
    writeServerMessage(adapter, 'thread-reject', {
      id: pendingIds[0],
      error: { code: -32000, message: 'No such turn' },
    });
    await expect(interruptPromise).rejects.toThrow('No such turn');

    // H3: nothing marked this turn resolved on the failed interrupt.
    expect(record.activeTurnId).toBe('turn-reject');
    expect(record.terminalPublishedForTurnId).toBeUndefined();

    // Later, unrelated: the app-server exits unexpectedly (the SAME safety
    // net finalizeUnexpectedExit provides for every other orphaned turn).
    processHandle.exitCode = 1;
    processHandle.emit('exit', 1);

    const events = await drainEvents(iterator);
    const orphanedErrors = events.filter(
      (event) =>
        event.method === 'runtime.error' && event.turnId === 'turn-reject',
    );
    expect(orphanedErrors).toHaveLength(1);
  });

  // station#3451 fix round D2: an ABANDONED interrupt for an EARLIER turn
  // must not disarm a LATER turn's synthesis. `pendingRpcRequests` has no
  // timeout eviction, so turn-1's turn/interrupt can still be pending when
  // turn-2 starts and later crashes — before D2, `rejectPendingRpcRequests`
  // returned a bare boolean ("was SOME turn/interrupt pending"), so turn-2's
  // process death would have incorrectly been treated as "some caller owns
  // this," skipping the orphaned-turn synthesis turn-2 actually needs.
  test('an abandoned interrupt for turn-1 does not suppress turn-2s orphaned-turn synthesis', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-cross-turn',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-cross-turn', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-cross-turn', {
      id: '2',
      result: {
        thread: { id: 'codex-thread-cross-turn' },
        model: 'gpt-5-codex',
      },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    // Turn 1 starts, then gets interrupted, and the interrupt RPC is left
    // unanswered — mirrors the accept-then-abort cleanup abandoning it after
    // its own budget, without ever cancelling the underlying RPC.
    const sendTurnOnePromise = adapter.sendTurn({
      threadId: 'thread-cross-turn',
      input: 'first turn',
    });
    writeServerMessage(adapter, 'thread-cross-turn', {
      id: '3',
      result: { turn: { id: 'turn-1' } },
    });
    await withTimeout(sendTurnOnePromise, 'sendTurn 1');
    await flushIo();
    const abandonedInterrupt = adapter
      .interruptTurn('thread-cross-turn', 'turn-1')
      .catch(() => undefined);
    await flushIo();

    // Turn 2 starts on the SAME thread — mirrors the record being reused
    // for a fresh turn while the old interrupt RPC is still outstanding.
    const record = (adapter as any).transport.requireSession(
      'thread-cross-turn',
    );
    // Confirms the premise: interruptTurn has not resolved (its RPC is
    // still pending), so it has not touched activeTurnId yet.
    expect(record.activeTurnId).toBe('turn-1');
    const sendTurnTwoPromise = adapter.sendTurn({
      threadId: 'thread-cross-turn',
      input: 'second turn',
    });
    writeServerMessage(adapter, 'thread-cross-turn', {
      id: '5',
      result: { turn: { id: 'turn-2' } },
    });
    await withTimeout(sendTurnTwoPromise, 'sendTurn 2');
    await flushIo();
    expect(record.activeTurnId).toBe('turn-2');
    expect(record.terminalPublishedForTurnId).toBeUndefined();

    // Turn 2's process now crashes, with turn-1's interrupt STILL pending.
    processHandle.exitCode = 1;
    processHandle.emit('exit', 1);
    await abandonedInterrupt;

    const events = await drainEvents(iterator);
    const turnTwoOrphaned = events.filter(
      (event) => event.method === 'runtime.error' && event.turnId === 'turn-2',
    );
    expect(turnTwoOrphaned).toHaveLength(1);
    const turnOneOrphaned = events.filter(
      (event) => event.method === 'runtime.error' && event.turnId === 'turn-1',
    );
    expect(turnOneOrphaned).toHaveLength(0);
  });

  test('sendTurn keeps the typed displayInput in turn.started while turn/start carries the composed model input (#685)', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-ambient',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-ambient', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-ambient', {
      id: '2',
      result: { thread: { id: 'codex-ambient' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-ambient',
      input: '[Timezone: Iceland]\nwhat time is it?',
      displayInput: 'what time is it?',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-ambient', {
      id: '3',
      result: { turn: { id: 'turn-ambient' } },
    });
    await withTimeout(sendTurnPromise, 'sendTurn');

    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');
    const turnStarted = await nextEvent(iterator, 'turn.started');
    // Transcript-facing event carries the typed text only.
    expect(turnStarted).toMatchObject({
      method: 'turn.started',
      prompt: 'what time is it?',
    });

    // Model boundary: the JSON-RPC turn/start request carries the composed
    // model input.
    const turnStart = processHandle.stdin.lines
      .map(parseLine)
      .find((line) => line.method === 'turn/start');
    expect(turnStart?.params?.input).toEqual([
      {
        type: 'text',
        text: '[Timezone: Iceland]\nwhat time is it?',
        text_elements: [],
      },
    ]);

    await adapter.stopAll();
  });

  test('maps validated image attachments to Codex app-server image inputs', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-attachments',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-attachments', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-attachments', {
      id: '2',
      result: { thread: { id: 'codex-attachments' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-attachments',
      input: 'Review this screenshot',
      attachments: [
        {
          kind: 'image',
          name: 'screen.png',
          mimeType: 'image/png',
          size: 3,
          dataUrl: 'data:image/png;base64,YWJj',
        },
      ],
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-attachments', {
      id: '3',
      result: { turn: { id: 'turn-attachments' } },
    });
    await withTimeout(sendTurnPromise, 'sendTurn');

    const turnStart = processHandle.stdin.lines
      .map(parseLine)
      .find((line) => line.method === 'turn/start');
    expect(turnStart?.params?.input).toEqual([
      {
        type: 'text',
        text: 'Review this screenshot',
        text_elements: [],
      },
      {
        type: 'image',
        url: 'data:image/png;base64,YWJj',
      },
    ]);

    await adapter.stopAll();
  });

  test('normalizes an empty effort override to the provider default', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-effort-reset',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-effort-reset', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-effort-reset', {
      id: '2',
      result: {
        thread: { id: 'codex-effort-reset' },
        model: 'gpt-5-codex',
      },
    });
    await withTimeout(startSessionPromise, 'startSession');

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-effort-reset',
      input: 'Use the provider default effort',
      modelOptions: { effort: '' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-effort-reset', {
      id: '3',
      result: { turn: { id: 'turn-effort-reset' } },
    });
    await withTimeout(sendTurnPromise, 'sendTurn');

    const turnStart = processHandle.stdin.lines
      .map(parseLine)
      .find((line) => line.method === 'turn/start');
    expect(turnStart?.params?.effort).toBeNull();
    expect(mockProviderOpsAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        operation: 'adapter-model-options',
        model_options: 'none',
      }),
    );

    await adapter.stopAll();
  });

  test('records option rejection only when a failed turn requested model options', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-option-telemetry',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-option-telemetry', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-option-telemetry', {
      id: '2',
      result: {
        thread: { id: 'codex-option-telemetry' },
        model: 'gpt-5-codex',
      },
    });
    await withTimeout(startSessionPromise, 'startSession');
    mockProviderOpsAdd.mockClear();

    const optionFailure = adapter.sendTurn({
      threadId: 'thread-option-telemetry',
      input: 'fail with options',
      modelOptions: { effort: 'high' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-option-telemetry', {
      id: '3',
      error: { code: -32_000, message: 'synthetic failure' },
    });
    await expect(optionFailure).rejects.toThrow('synthetic failure');
    expect(mockProviderOpsAdd).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        operation: 'adapter-model-options',
        model_options: 'rejected',
      }),
    );

    mockProviderOpsAdd.mockClear();
    const ordinaryFailure = adapter.sendTurn({
      threadId: 'thread-option-telemetry',
      input: 'fail without options',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-option-telemetry', {
      id: '4',
      error: { code: -32_000, message: 'ordinary failure' },
    });
    await expect(ordinaryFailure).rejects.toThrow('ordinary failure');
    expect(mockProviderOpsAdd).not.toHaveBeenCalledWith(
      1,
      expect.objectContaining({ model_options: 'rejected' }),
    );

    await adapter.stopAll();
  });

  test('rejects document attachments before writing a Codex turn request', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-document-rejected',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-document-rejected', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-document-rejected', {
      id: '2',
      result: {
        thread: { id: 'codex-document-rejected' },
        model: 'gpt-5-codex',
      },
    });
    await withTimeout(startSessionPromise, 'startSession');
    const turnRequestsBefore = processHandle.stdin.lines
      .map(parseLine)
      .filter((line) => line.method === 'turn/start').length;

    await expect(
      adapter.sendTurn({
        threadId: 'thread-document-rejected',
        input: 'Review this file',
        attachments: [
          {
            kind: 'file',
            name: 'notes.txt',
            mimeType: 'text/plain',
            size: 5,
            dataUrl: 'data:text/plain;base64,aGVsbG8=',
          },
        ],
      }),
    ).rejects.toThrow('Codex supports image attachments here');
    expect(
      processHandle.stdin.lines
        .map(parseLine)
        .filter((line) => line.method === 'turn/start'),
    ).toHaveLength(turnRequestsBefore);
    await adapter.stopAll();
  });

  test('resolves approval requests by writing JSON-RPC responses back to Codex', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-2',
      cwd: '/tmp/project',
    });
    await flushIo();

    writeServerMessage(adapter, 'thread-2', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-2', {
      id: '2',
      result: {
        thread: {
          id: 'codex-thread-2',
        },
        model: 'gpt-5-codex',
      },
    });

    await withTimeout(sessionPromise, 'startSession approval');
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    writeServerMessage(adapter, 'thread-2', {
      id: 'approval-1',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'codex-thread-2',
        turnId: 'turn-2',
        itemId: 'perm-1',
        reason: 'Needs network access',
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
    });

    await flushIo();
    const opened = await nextEvent(iterator, 'request.opened');
    expect(opened).toMatchObject({
      method: 'request.opened',
      requestType: 'permission',
      description: 'Needs network access',
    });

    await adapter.respondToRequest(
      'thread-2',
      opened.requestId,
      'acceptForSession',
    );

    const response = parseLine(
      processHandle.stdin.lines[processHandle.stdin.lines.length - 1],
    );
    expect(response).toEqual({
      jsonrpc: '2.0',
      id: 'approval-1',
      result: {
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
        scope: 'session',
      },
    });

    await flushIo();
    const resolved = await nextEvent(iterator, 'request.resolved');
    expect(resolved).toMatchObject({
      method: 'request.resolved',
      status: 'approved',
    });
  });

  test('declines a data-required MCP elicitation on the wire and in the canonical event', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-elicitation-data',
      cwd: '/tmp/project',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-elicitation-data', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-elicitation-data', {
      id: '2',
      result: { thread: { id: 'codex-elicitation-data' } },
    });
    await withTimeout(sessionPromise, 'startSession elicitation data');
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    writeServerMessage(adapter, 'thread-elicitation-data', {
      id: 'elicitation-data',
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'test-server',
        requestedSchema: {
          type: 'object',
          properties: { reason: { type: 'string' } },
          required: ['reason'],
        },
      },
    });
    await flushIo();
    const opened = await nextEvent(iterator, 'request.opened');

    await adapter.respondToRequest(
      'thread-elicitation-data',
      opened.requestId,
      'accept',
    );

    expect(parseLine(processHandle.stdin.lines.at(-1)!)).toMatchObject({
      id: 'elicitation-data',
      result: { action: 'decline' },
    });
    expect(await nextEvent(iterator, 'request.resolved')).toMatchObject({
      requestId: opened.requestId,
      status: 'denied',
    });
  });

  test('accepts an empty-schema MCP elicitation on the wire and in the canonical event', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();
    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-elicitation-empty',
      cwd: '/tmp/project',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-elicitation-empty', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-elicitation-empty', {
      id: '2',
      result: { thread: { id: 'codex-elicitation-empty' } },
    });
    await withTimeout(sessionPromise, 'startSession empty elicitation');
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    writeServerMessage(adapter, 'thread-elicitation-empty', {
      id: 'elicitation-empty',
      method: 'mcpServer/elicitation/request',
      params: {
        serverName: 'test-server',
        requestedSchema: { type: 'object', properties: {} },
      },
    });
    await flushIo();
    const opened = await nextEvent(iterator, 'request.opened');

    await adapter.respondToRequest(
      'thread-elicitation-empty',
      opened.requestId,
      'accept',
    );

    expect(parseLine(processHandle.stdin.lines.at(-1)!)).toMatchObject({
      id: 'elicitation-empty',
      result: { action: 'accept' },
    });
    expect(await nextEvent(iterator, 'request.resolved')).toMatchObject({
      requestId: opened.requestId,
      status: 'approved',
    });
  });

  test('reports missing Codex prerequisites when CLI or login are unavailable', async () => {
    process.env.PATH = '/definitely-missing-codex';
    // station#977: process.env.PATH alone is no longer the whole story --
    // findCliBinary now also falls back to the users login-shell PATH and
    // a handful of well-known install dirs, so a genuinely-missing-CLI
    // test needs the opt-out flag too, or a dev/user machine that happens
    // to have codex installed anywhere on those paths would make this
    // assertion flaky.
    process.env.STATION_DISABLE_LOGIN_PATH_RESOLVE = '1';
    const adapter = new CodexAdapter();

    await expect(adapter.getPrerequisites()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Codex CLI',
          status: 'missing',
        }),
        expect.objectContaining({
          name: 'Codex login',
          status: 'missing',
        }),
      ]),
    );
  });

  test('lists models from Codex app-server model/list', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });

    const listModelsPromise = adapter.listModels();
    await flushIo();

    processHandle!.stdout.write(
      `${JSON.stringify({
        id: '1',
        result: {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      })}\n`,
    );
    await flushIo();
    processHandle!.stdout.write(
      `${JSON.stringify({
        id: '2',
        result: {
          data: [
            {
              id: 'gpt-5.4',
              model: 'gpt-5.4',
              displayName: 'GPT-5.4',
              supportedReasoningEfforts: [
                { reasoningEffort: 'low', description: 'Fast' },
                { reasoningEffort: 'high', description: 'Thorough' },
              ],
              serviceTiers: [
                { id: 'standard', name: 'Standard', description: '' },
                { id: 'fast', name: 'Fast', description: '' },
              ],
            },
          ],
          nextCursor: 'next-page',
        },
      })}\n`,
    );
    await flushIo();
    processHandle!.stdout.write(
      `${JSON.stringify({
        id: '3',
        result: {
          data: [
            {
              model: 'gpt-5.5',
              displayName: 'GPT-5.5',
            },
          ],
          nextCursor: null,
        },
      })}\n`,
    );

    await expect(listModelsPromise).resolves.toEqual([
      {
        id: 'gpt-5.4',
        name: 'GPT-5.4',
        originalId: 'gpt-5.4',
        capabilities: {
          supportsEffort: true,
          supportedEffortLevels: ['low', 'high'],
          effortLabels: { low: 'Fast', high: 'Thorough' },
          supportsFastMode: true,
          fastModeLabel: 'Fast',
        },
      },
      {
        id: 'gpt-5.5',
        name: 'GPT-5.5',
        originalId: 'gpt-5.5',
      },
    ]);

    const writtenMessages = processHandle.stdin.lines.map(parseLine);
    expect(writtenMessages.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'model/list',
      'model/list',
    ]);
    expect(writtenMessages[3].params.cursor).toBe('next-page');
  });

  test('cancels one caller without terminating shared model discovery', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const controller = new AbortController();

    const cancelled = adapter.listModels({ signal: controller.signal });
    const shared = adapter.listModels();
    await flushIo();
    controller.abort(new Error('catalog cancelled'));

    await expect(cancelled).rejects.toThrow('catalog cancelled');
    expect(processHandle.killed).toBe(false);
    processHandle.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
    await flushIo();
    processHandle.stdout.write(
      `${JSON.stringify({
        id: '2',
        result: { data: [{ model: 'gpt-a', displayName: 'GPT A' }] },
      })}\n`,
    );

    await expect(shared).resolves.toEqual([
      { id: 'gpt-a', name: 'GPT A', originalId: 'gpt-a' },
    ]);
    expect(processHandle.killed).toBe(true);
  });

  test('does not settle adapter stop until discovery process exit is confirmed', async () => {
    const deferredExit = new DeferredExitCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => deferredExit as any,
    });
    const models = adapter.listModels();
    const modelFailure = expect(models).rejects.toThrow(
      'stopped during model discovery',
    );
    await flushIo();
    const stopped = adapter.stopAll();
    let settled = false;
    void stopped.then(() => {
      settled = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(deferredExit.killSignals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(settled).toBe(false);

    deferredExit.confirmExit();
    await expect(stopped).resolves.toBeUndefined();
    await modelFailure;
  });

  test('bounds each caller projection without requesting another page', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const models = adapter.listModels({ maxEntries: 1 });
    await flushIo();
    processHandle.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
    await flushIo();
    processHandle.stdout.write(
      `${JSON.stringify({
        id: '2',
        result: {
          data: [
            { model: 'gpt-a', displayName: 'GPT A' },
            { model: 'gpt-b', displayName: 'GPT B' },
          ],
        },
      })}\n`,
    );

    await expect(models).resolves.toEqual([
      { id: 'gpt-a', name: 'GPT A', originalId: 'gpt-a' },
    ]);
    expect(
      processHandle.stdin.lines
        .map(parseLine)
        .filter((item) => item.method === 'model/list'),
    ).toHaveLength(1);
  });

  test('marks a bounded model catalog incomplete when another page exists', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const catalog = (adapter as any).listModelCatalog({ maxEntries: 1 });
    await flushIo();
    processHandle.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
    await flushIo();
    processHandle.stdout.write(
      `${JSON.stringify({
        id: '2',
        result: {
          data: [{ model: 'gpt-a', displayName: 'GPT A' }],
          nextCursor: 'another-page',
        },
      })}\n`,
    );
    await flushIo();
    processHandle.stdout.write(
      `${JSON.stringify({
        id: '3',
        result: { data: [{ model: 'gpt-b', displayName: 'GPT B' }] },
      })}\n`,
    );

    await expect(catalog).resolves.toEqual({
      models: [{ id: 'gpt-a', name: 'GPT A', originalId: 'gpt-a' }],
      truncated: true,
    });
  });

  test('escalates cancellation until a SIGTERM-resistant child exits', async () => {
    let child: ChildProcessWithoutNullStreams | undefined;
    let ready: Promise<void> | undefined;
    const adapter = new CodexAdapter({
      processFactory: () => {
        child = spawn(
          process.execPath,
          [
            '-e',
            "process.on('SIGTERM',()=>{});process.stdin.resume();process.stdout.write('ready\\n')",
          ],
          { stdio: 'pipe' },
        );
        ready = new Promise((resolve) =>
          child!.stdout.once('data', () => resolve()),
        );
        return child;
      },
    });
    const controller = new AbortController();

    try {
      const models = adapter.listModels({ signal: controller.signal });
      await ready;
      controller.abort(new Error('catalog cancelled'));

      await expect(models).rejects.toThrow('catalog cancelled');
      expect(child?.exitCode !== null || child?.signalCode !== null).toBe(true);
    } finally {
      if (child?.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
      }
    }
  });

  test('rejects a non-advancing model pagination cursor', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const models = adapter.listModels();
    await flushIo();
    processHandle.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);
    await flushIo();
    processHandle.stdout.write(
      `${JSON.stringify({ id: '2', result: { data: [], nextCursor: 'same' } })}\n`,
    );
    await flushIo();
    processHandle.stdout.write(
      `${JSON.stringify({ id: '3', result: { data: [], nextCursor: 'same' } })}\n`,
    );

    await expect(models).rejects.toThrow('did not advance');
    expect(processHandle.killed).toBe(true);
  });

  test('rejects a partial model catalog when pagination exceeds its page limit', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const models = adapter.listModels();
    await flushIo();
    processHandle.stdout.write(`${JSON.stringify({ id: '1', result: {} })}\n`);

    for (let page = 0; page < 32; page += 1) {
      await flushIo();
      processHandle.stdout.write(
        `${JSON.stringify({
          id: String(page + 2),
          result: { data: [], nextCursor: `page-${page + 2}` },
        })}\n`,
      );
    }

    await expect(models).rejects.toThrow('exceeded the page limit');
    expect(processHandle.killed).toBe(true);
  });

  test('rejects and kills model discovery before parsing an oversized response', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const models = adapter.listModels();
    await flushIo();

    processHandle.stdout.write('x'.repeat(2 * 1024 * 1024 + 1));

    await expect(models).rejects.toThrow('exceeded the response limit');
    expect(processHandle.killed).toBe(true);
  });

  test('degrades a missing Codex binary without an uncaught process error', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });

    const models = adapter.listModels();
    processHandle.emit('error', new Error('spawn codex ENOENT'));

    await expect(models).rejects.toThrow(
      'Codex app-server failed to start: spawn codex ENOENT',
    );
    expect(processHandle.listenerCount('error')).toBeGreaterThan(0);
  });

  test('publishes a warning for malformed JSON-RPC payloads', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-3',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-3', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-3', {
      id: '2',
      result: {
        thread: { id: 'codex-thread-3' },
      },
    });

    await withTimeout(sessionPromise, 'startSession malformed payload');
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    const transport = (adapter as any).transport;
    transport.handleStdoutLine(
      transport.requireSession('thread-3'),
      '{not json',
    );

    expect(await nextEvent(iterator, 'runtime.warning')).toMatchObject({
      method: 'runtime.warning',
      code: 'codex-json-parse',
    });
  });

  test('retains a failed-start session until process exit is confirmed', async () => {
    const deferredExit = new DeferredExitCodexProcess();
    processHandle = deferredExit;
    const adapter = new CodexAdapter({
      processFactory: () => deferredExit,
    });
    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-failed-start',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-failed-start', {
      id: '1',
      result: {},
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-failed-start', {
      id: '2',
      result: {},
    });

    await expect(sessionPromise).rejects.toThrow(
      'process termination was not confirmed',
    );
    await expect(adapter.hasSession('thread-failed-start')).resolves.toBe(true);

    deferredExit.confirmExit();
    await expect(adapter.hasSession('thread-failed-start')).resolves.toBe(true);
    await vi.waitFor(async () =>
      expect(adapter.hasSession('thread-failed-start')).resolves.toBe(false),
    );
  });

  test('stopSession rejects a pending sendTurn RPC promise and emits a single session.exited', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-stop-rpc',
      cwd: '/tmp/project',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-stop-rpc', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-stop-rpc', {
      id: '2',
      result: {
        thread: { id: 'codex-thread-stop-rpc' },
      },
    });
    await withTimeout(sessionPromise, 'startSession stop-rpc');
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    // sendTurn issues a turn/start JSON-RPC request that never gets a
    // response — this is the pendingRpcRequests entry that must not hang.
    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-stop-rpc',
      input: 'Inspect the repo',
    });

    await adapter.stopSession('thread-stop-rpc');

    // The sendTurn awaiter must settle (reject), not hang forever.
    await expect(
      withTimeout(sendTurnPromise, 'sendTurn after stop'),
    ).rejects.toThrow(/codex session stopped/i);

    const exited = await nextEvent(iterator, 'session.exited');
    expect(exited).toMatchObject({
      method: 'session.exited',
      sessionId: 'thread-stop-rpc',
      reason: 'stopped',
    });

    // The process 'exit' handler (kill() emits it synchronously in the
    // fake process) must not re-fire settle-and-publish logic and produce
    // a second session.exited.
    await expect(
      Promise.race([
        iterator.next(),
        new Promise((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: false }), 50),
        ),
      ]),
    ).resolves.toMatchObject({ value: undefined });

    await expect(adapter.hasSession('thread-stop-rpc')).resolves.toBe(false);
  });

  test('stopSession settles a pending approval request with request.resolved before session.exited', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-stop-approval',
      cwd: '/tmp/project',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-stop-approval', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-stop-approval', {
      id: '2',
      result: {
        thread: { id: 'codex-thread-stop-approval' },
      },
    });
    await withTimeout(sessionPromise, 'startSession stop-approval');
    await nextEvent(iterator, 'session.started');
    await nextEvent(iterator, 'session.configured');

    writeServerMessage(adapter, 'thread-stop-approval', {
      id: 'approval-stop-1',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'codex-thread-stop-approval',
        turnId: 'turn-1',
        itemId: 'perm-1',
        reason: 'Needs network access',
        permissions: {
          network: { enabled: true },
          fileSystem: null,
        },
      },
    });
    await flushIo();

    const opened = await nextEvent(iterator, 'request.opened');
    expect(opened.method).toBe('request.opened');

    await adapter.stopSession('thread-stop-approval');

    const resolved = await nextEvent(iterator, 'request.resolved');
    expect(resolved).toMatchObject({
      method: 'request.resolved',
      requestId: opened.requestId,
      status: 'cancelled',
    });

    const exited = await nextEvent(iterator, 'session.exited');
    expect(exited).toMatchObject({
      method: 'session.exited',
      sessionId: 'thread-stop-approval',
      reason: 'stopped',
    });

    // A stale respondToRequest call after stop must not resurrect the
    // session or the (already-cleared) approval.
    await expect(
      adapter.respondToRequest(
        'thread-stop-approval',
        opened.requestId,
        'accept',
      ),
    ).rejects.toThrow(/codex session not found/i);
  });

  test('stopAll rejects pending RPC promises and settles pending approvals across sessions', async () => {
    const processA = new FakeCodexProcess();
    const processB = new FakeCodexProcess();
    const handles = [processA, processB];
    let handleIndex = 0;
    const adapter = new CodexAdapter({
      processFactory: () => handles[handleIndex++]!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    async function startAndConfigure(
      threadId: string,
      codexThreadId: string,
    ): Promise<void> {
      const sessionPromise = adapter.startSession({
        provider: 'codex',
        threadId,
        cwd: '/tmp/project',
      });
      await flushIo();
      writeServerMessage(adapter, threadId, {
        id: '1',
        result: {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      });
      await flushIo();
      writeServerMessage(adapter, threadId, {
        id: '2',
        result: {
          thread: { id: codexThreadId },
        },
      });
      await withTimeout(sessionPromise, `startSession ${threadId}`);
      await nextEvent(iterator, 'session.started');
      await nextEvent(iterator, 'session.configured');
    }

    await startAndConfigure('thread-stopall-a', 'codex-thread-stopall-a');
    await startAndConfigure('thread-stopall-b', 'codex-thread-stopall-b');

    const sendTurnPromise = adapter.sendTurn({
      threadId: 'thread-stopall-a',
      input: 'Inspect the repo',
    });

    writeServerMessage(adapter, 'thread-stopall-b', {
      id: 'approval-stopall-1',
      method: 'item/permissions/requestApproval',
      params: {
        threadId: 'codex-thread-stopall-b',
        turnId: 'turn-1',
        itemId: 'perm-1',
        reason: 'Needs network access',
        permissions: { network: { enabled: true }, fileSystem: null },
      },
    });
    await flushIo();
    const opened = await nextEvent(iterator, 'request.opened');

    await adapter.stopAll();

    await expect(
      withTimeout(sendTurnPromise, 'sendTurn after stopAll'),
    ).rejects.toThrow(/codex session stopped/i);

    // stopAll settles both sessions; thread-stopall-a has no pending
    // approval so it publishes session.exited immediately, while
    // thread-stopall-b's request.resolved precedes its own session.exited.
    // Collect the remaining events and assert the approval settled.
    const remaining = [
      await nextEvent(iterator, 'stopAll event 1'),
      await nextEvent(iterator, 'stopAll event 2'),
      await nextEvent(iterator, 'stopAll event 3'),
    ];
    const resolved = remaining.find(
      (event) => event.method === 'request.resolved',
    );
    expect(resolved).toMatchObject({
      requestId: opened.requestId,
      status: 'cancelled',
    });
    expect(
      remaining.filter((event) => event.method === 'session.exited'),
    ).toHaveLength(2);

    await expect(adapter.listSessions()).resolves.toEqual([]);
  });

  test('rejects approval responses for unknown requests', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });

    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-4',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-4', {
      id: '1',
      result: {
        userAgent: 'test',
        codexHome: '/tmp/.codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-4', {
      id: '2',
      result: {
        thread: { id: 'codex-thread-4' },
      },
    });
    await withTimeout(sessionPromise, 'startSession unknown approval');

    await expect(
      adapter.respondToRequest('thread-4', 'missing-request', 'accept'),
    ).rejects.toThrow(/unknown codex approval request/i);
  });

  test('maps a session-level approvalMode to Codex approvalPolicy/sandbox on thread/start, and re-resolves it fresh on each turn/start (#727)', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });

    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-approval',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
      modelOptions: { approvalMode: 'ask' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-approval', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-approval', {
      id: '2',
      result: { thread: { id: 'codex-thread-approval' }, model: 'gpt-5-codex' },
    });
    await withTimeout(sessionPromise, 'startSession approvalMode');
    await flushIo();

    const threadStart = processHandle.stdin.lines
      .map(parseLine)
      .find((line) => line.method === 'thread/start');
    expect(threadStart.params).toMatchObject({
      approvalPolicy: 'untrusted',
      sandbox: 'workspace-write',
    });

    // First turn carries no override — falls back to the pre-existing
    // hardcoded default rather than "remembering" the session-start mode.
    const firstTurnPromise = adapter.sendTurn({
      threadId: 'thread-approval',
      input: 'first turn',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-approval', {
      id: '3',
      result: { turn: { id: 'turn-approval-1' } },
    });
    await withTimeout(firstTurnPromise, 'sendTurn 1');
    await flushIo();

    // Second turn carries an explicit override — the override reaches the
    // adapter's native knob starting with this next turn.
    const secondTurnPromise = adapter.sendTurn({
      threadId: 'thread-approval',
      input: 'second turn',
      modelOptions: { approvalMode: 'auto' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-approval', {
      id: '4',
      result: { turn: { id: 'turn-approval-2' } },
    });
    await withTimeout(secondTurnPromise, 'sendTurn 2');
    await flushIo();

    const turnStartCalls = processHandle.stdin.lines
      .map(parseLine)
      .filter((line) => line.method === 'turn/start');
    expect(turnStartCalls).toHaveLength(2);
    expect(turnStartCalls[0].params).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    expect(turnStartCalls[1].params).toMatchObject({
      approvalPolicy: 'on-request',
      sandbox: 'workspace-write',
    });

    await adapter.stopAll();
  });

  test('native review isolation overrides writable approval modes on thread/start and every turn/start', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({ processFactory: () => processHandle! });
    const reviewIsolation = {
      workspaceAccess: 'read-only' as const,
      requestId: 'review-request-1',
      reviewerId: 'reviewer-1',
    };

    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-review-isolation',
      cwd: '/tmp/project',
      modelOptions: { approvalMode: 'auto' },
      reviewIsolation,
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-review-isolation', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-review-isolation', {
      id: '2',
      result: { thread: { id: 'codex-thread-review-isolation' } },
    });
    await withTimeout(sessionPromise, 'startSession review isolation');

    const turnPromise = adapter.sendTurn({
      threadId: 'thread-review-isolation',
      input: 'review',
      modelOptions: { approvalMode: 'ask' },
      reviewIsolation,
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-review-isolation', {
      id: '3',
      result: { turn: { id: 'turn-review-isolation' } },
    });
    await withTimeout(turnPromise, 'sendTurn review isolation');

    const calls = processHandle.stdin.lines.map(parseLine);
    expect(
      calls.find((line) => line.method === 'thread/start')?.params,
    ).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });
    expect(
      calls.find((line) => line.method === 'turn/start')?.params,
    ).toMatchObject({
      approvalPolicy: 'never',
      sandbox: 'read-only',
    });

    await adapter.stopAll();
  });

  test('session.configured and turn.started carry the resolved approvalMode, not just the raw knobs (#727 review round 3, item 1)', async () => {
    processHandle = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => processHandle!,
    });
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const sessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-applied-mode',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
      modelOptions: { approvalMode: 'auto' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-applied-mode', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-applied-mode', {
      id: '2',
      result: {
        thread: { id: 'codex-thread-applied-mode' },
        model: 'gpt-5-codex',
      },
    });
    await withTimeout(sessionPromise, 'startSession applied-mode');
    await flushIo();

    const started = await nextEvent(iterator, 'session.started');
    expect(started.method).toBe('session.started');
    const configured = await nextEvent(iterator, 'session.configured');
    expect(configured).toMatchObject({
      method: 'session.configured',
      metadata: { approvalMode: 'auto' },
    });

    const turnPromise = adapter.sendTurn({
      threadId: 'thread-applied-mode',
      input: 'go',
      modelOptions: { approvalMode: 'never' },
      recoveryCorrelationId: 'recovery-correlation-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-applied-mode', {
      id: '3',
      result: { turn: { id: 'turn-applied-mode' } },
    });
    await withTimeout(turnPromise, 'sendTurn applied-mode');

    const turnStarted = await nextEvent(iterator, 'turn.started');
    expect(turnStarted).toMatchObject({
      method: 'turn.started',
      metadata: {
        approvalMode: 'never',
        recoveryCorrelationId: 'recovery-correlation-codex',
      },
    });

    await adapter.stopAll();
  });

  describe('#896 wave 2: app-home profile env layering', () => {
    test('uses the server-only credential profile ref for app-home lookup without emitting it in canonical events', async () => {
      processHandle = new FakeCodexProcess();
      const getAppHomeEnv = vi.fn(async (ref?: string) => {
        expect(ref).toBe('canary-profile-ref');
        return { CODEX_HOME: '/private/station/canary-profile-home' };
      });
      const adapter = new CodexAdapter({
        processFactory: () => processHandle!,
        getAppHomeEnv,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const startSessionPromise = adapter.startSession({
        provider: 'codex',
        threadId: 'thread-profile-ref-private',
        cwd: '/tmp/project',
        modelId: 'gpt-5-codex',
        credentialProfileRef: 'canary-profile-ref',
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-profile-ref-private', {
        id: '1',
        result: { userAgent: 'test' },
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-profile-ref-private', {
        id: '2',
        result: {
          thread: { id: 'codex-thread-profile-ref-private' },
          model: 'gpt-5-codex',
        },
      });
      await withTimeout(
        startSessionPromise,
        'startSession private profile ref',
      );
      await flushIo();

      const started = await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      const canonicalEvents = JSON.stringify([started, configured]);
      expect(getAppHomeEnv).toHaveBeenCalledWith('canary-profile-ref');
      expect(canonicalEvents).not.toContain('canary-profile-ref');
      expect(canonicalEvents).not.toContain('/private/station');
      await adapter.stopAll();
    });

    test('fails closed without logging the credential ref when its app-home lookup fails', async () => {
      processHandle = new FakeCodexProcess();
      const logger = { warn: vi.fn() };
      const processFactory = vi.fn(() => processHandle!);
      const adapter = new CodexAdapter({
        processFactory,
        logger,
        getAppHomeEnv: async () => {
          throw new Error(
            'canary-profile-ref could not load /private/station/canary-profile-home',
          );
        },
      });

      await expect(
        adapter.startSession({
          provider: 'codex',
          threadId: 'thread-profile-ref-failure',
          credentialProfileRef: 'canary-profile-ref',
        }),
      ).rejects.toThrow(
        'Credential profile environment could not be prepared.',
      );
      expect(processFactory).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('startSession passes the resolved app-home env to the process factory', async () => {
      processHandle = new FakeCodexProcess();
      const processFactory = vi.fn(() => processHandle!);
      const adapter = new CodexAdapter({
        processFactory,
        getAppHomeEnv: async () => ({
          CODEX_HOME: '/station/app-homes/codex-runtime',
        }),
      } as any);

      const startSessionPromise = adapter.startSession({
        provider: 'codex',
        threadId: 'thread-app-home',
        cwd: '/tmp/project',
        modelId: 'gpt-5-codex',
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-app-home', {
        id: '1',
        result: { userAgent: 'test' },
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-app-home', {
        id: '2',
        result: {
          thread: { id: 'codex-thread-app-home' },
          model: 'gpt-5-codex',
        },
      });
      await withTimeout(startSessionPromise, 'startSession');

      // station#1195: processFactory now also receives the resolved
      // toolServers config args (undefined here — this session authors no
      // toolServers, so the spawn argv stays byte-identical to before).
      expect(processFactory).toHaveBeenCalledWith(
        { CODEX_HOME: '/station/app-homes/codex-runtime' },
        undefined,
      );
      await adapter.stopAll();
    });

    test('composes a selected credential profile with authenticated station-control MCP delivery', async () => {
      processHandle = new FakeCodexProcess();
      const processFactory = vi.fn(() => processHandle!);
      const profileHome = '/station/app-homes/codex-profile';
      const profileRef = 'profile-ref-secret';
      const token = 'opaque-session-token';
      const adapter = new CodexAdapter({
        processFactory,
        getAppHomeEnv: async (requestedRef?: string) => {
          expect(requestedRef).toBe(profileRef);
          return { CODEX_HOME: profileHome };
        },
        mintStationControlMcpAuth: () =>
          `http://127.0.0.1:3141/mcp/station-control?token=${token}`,
      } as any);
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const started = adapter.startSession({
        provider: 'codex',
        threadId: 'thread-profile-with-tools',
        cwd: '/tmp/project',
        credentialProfileRef: profileRef,
        agent: {
          slug: 'combined-agent',
          toolServers: [
            {
              id: 'station-control',
              transport: 'stdio',
              command: 'node',
              args: [builtinStationControlServerPath()],
            },
          ],
        },
      } as any);
      await flushIo();
      writeServerMessage(adapter, 'thread-profile-with-tools', {
        id: '1',
        result: { userAgent: 'test' },
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-profile-with-tools', {
        id: '2',
        result: { thread: { id: 'codex-combined' } },
      });
      await withTimeout(started, 'startSession');

      expect(processFactory).toHaveBeenCalledWith({ CODEX_HOME: profileHome }, [
        '-c',
        `mcp_servers.station-control.url="http://127.0.0.1:3141/mcp/station-control?token=${token}"`,
      ]);
      const events = [
        await nextEvent(iterator, 'session.started'),
        await nextEvent(iterator, 'session.configured'),
      ];
      const canonicalBytes = JSON.stringify(events);
      expect(canonicalBytes).not.toContain(profileRef);
      expect(canonicalBytes).not.toContain(profileHome);
      expect(canonicalBytes).not.toContain(token);
      await adapter.stopAll();
    });

    test('session.configured reports appHome: profile when the connection opts in', async () => {
      processHandle = new FakeCodexProcess();
      const adapter = new CodexAdapter({
        processFactory: () => processHandle!,
        getAppHomeEnv: async () => ({
          CODEX_HOME: '/station/app-homes/codex-runtime',
        }),
      } as any);
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const startSessionPromise = adapter.startSession({
        provider: 'codex',
        threadId: 'thread-app-home-profile',
        cwd: '/tmp/project',
        modelId: 'gpt-5-codex',
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-app-home-profile', {
        id: '1',
        result: { userAgent: 'test' },
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-app-home-profile', {
        id: '2',
        result: {
          thread: { id: 'codex-thread-app-home-profile' },
          model: 'gpt-5-codex',
        },
      });
      await withTimeout(startSessionPromise, 'startSession');
      await flushIo();

      await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      expect(configured.metadata.appHome).toBe('profile');
      // LOW (security review 1a028fde): pin the receipted metric, not just
      // the session.configured field.
      expect(mockAppHomeSessionsAdd).toHaveBeenCalledWith(1, {
        provider: 'codex',
        applied: 'profile',
      });
      await adapter.stopAll();
    });

    test('session.configured reports appHome: global when getAppHomeEnv resolves undefined', async () => {
      processHandle = new FakeCodexProcess();
      const adapter = new CodexAdapter({
        processFactory: () => processHandle!,
        getAppHomeEnv: async () => undefined,
      } as any);
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const startSessionPromise = adapter.startSession({
        provider: 'codex',
        threadId: 'thread-app-home-global',
        cwd: '/tmp/project',
        modelId: 'gpt-5-codex',
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-app-home-global', {
        id: '1',
        result: { userAgent: 'test' },
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-app-home-global', {
        id: '2',
        result: {
          thread: { id: 'codex-thread-app-home-global' },
          model: 'gpt-5-codex',
        },
      });
      await withTimeout(startSessionPromise, 'startSession');
      await flushIo();

      await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      expect(configured.metadata.appHome).toBe('global');
      // LOW (security review 1a028fde): pin the receipted metric, not just
      // the session.configured field.
      expect(mockAppHomeSessionsAdd).toHaveBeenCalledWith(1, {
        provider: 'codex',
        applied: 'global',
      });
      await adapter.stopAll();
    });

    test('an app-home lookup failure degrades to global and never blocks codex session start', async () => {
      processHandle = new FakeCodexProcess();
      const adapter = new CodexAdapter({
        processFactory: () => processHandle!,
        getAppHomeEnv: async () => {
          throw new Error('lookup exploded');
        },
      } as any);
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const startSessionPromise = adapter.startSession({
        provider: 'codex',
        threadId: 'thread-app-home-failure',
        cwd: '/tmp/project',
        modelId: 'gpt-5-codex',
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-app-home-failure', {
        id: '1',
        result: { userAgent: 'test' },
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-app-home-failure', {
        id: '2',
        result: {
          thread: { id: 'codex-thread-app-home-failure' },
          model: 'gpt-5-codex',
        },
      });
      await withTimeout(startSessionPromise, 'startSession');
      await flushIo();

      await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      expect(configured.metadata.appHome).toBe('global');
      await adapter.stopAll();
    });

    test('model discovery never receives the app-home env', async () => {
      processHandle = new FakeCodexProcess();
      const processFactory = vi.fn(() => processHandle!);
      const adapter = new CodexAdapter({
        processFactory,
        getAppHomeEnv: async () => ({
          CODEX_HOME: '/station/app-homes/codex-runtime',
        }),
      } as any);

      const discoveryPromise = adapter.listModelCatalog();
      await flushIo();
      // model discovery uses its own handshake over the same fake process;
      // reply directly on the process stdin/stdout pair (not the transport).
      processHandle!.stdout.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: '1', result: { userAgent: 'test' } })}\n`,
      );
      await flushIo();
      processHandle!.stdout.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: '2',
          result: { data: [], nextCursor: null },
        })}\n`,
      );
      await withTimeout(discoveryPromise, 'listModelCatalog');

      expect(processFactory).toHaveBeenCalledWith();
      expect(processFactory).not.toHaveBeenCalledWith({
        CODEX_HOME: '/station/app-homes/codex-runtime',
      });
    });
  });

  describe('station#1182: runtime-reported model', () => {
    test('thread/start response model is captured as reportedModel — the ONLY place the resolved model appears when Station left modelId unset (station#977: Station deliberately omits a default so Codex applies its own)', async () => {
      processHandle = new FakeCodexProcess();
      const adapter = new CodexAdapter({
        processFactory: () => processHandle!,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const startSessionPromise = adapter.startSession({
        provider: 'codex',
        threadId: 'thread-reported-default',
        cwd: '/tmp/project',
        // modelId deliberately omitted.
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-reported-default', {
        id: '1',
        result: {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-reported-default', {
        id: '2',
        result: {
          thread: { id: 'codex-thread-reported-default' },
          // The app-server's own resolved default — never requested by
          // Station, only ever knowable from this response.
          model: 'gpt-5.1-codex-engine-default',
        },
      });
      await withTimeout(startSessionPromise, 'startSession');
      await flushIo();

      await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      expect(configured.model).toBe('gpt-5.1-codex-engine-default');
      expect(configured.metadata.reportedModel).toBe(
        'gpt-5.1-codex-engine-default',
      );

      await adapter.stopAll();
    });

    test('a thread/start response with no model field leaves reportedModel absent — never defaulted to the requested modelId', async () => {
      processHandle = new FakeCodexProcess();
      const adapter = new CodexAdapter({
        processFactory: () => processHandle!,
      });
      const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

      const startSessionPromise = adapter.startSession({
        provider: 'codex',
        threadId: 'thread-no-report',
        cwd: '/tmp/project',
        modelId: 'gpt-5-codex',
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-no-report', {
        id: '1',
        result: {
          userAgent: 'test',
          codexHome: '/tmp/.codex',
          platformFamily: 'unix',
          platformOs: 'linux',
        },
      });
      await flushIo();
      writeServerMessage(adapter, 'thread-no-report', {
        id: '2',
        // No `model` field in the response at all.
        result: { thread: { id: 'codex-thread-no-report' } },
      });
      await withTimeout(startSessionPromise, 'startSession');
      await flushIo();

      await nextEvent(iterator, 'session.started');
      const configured = await nextEvent(iterator, 'session.configured');
      // Back-compat display value still falls back to the request.
      expect(configured.model).toBe('gpt-5-codex');
      expect(configured.metadata.effectiveModel).toBe('gpt-5-codex');
      // But nothing was actually confirmed by the runtime — honest absence.
      expect(configured.metadata.reportedModel).toBeUndefined();

      await adapter.stopAll();
    });
  });
});

describe('station#1195: toolServers wire delivery (mcp_servers -c config args)', () => {
  test('an unauthored toolServers list never mints a station-control token and passes no extra config args', async () => {
    const processHandle = new FakeCodexProcess();
    const mintStationControlMcpAuth = vi.fn();
    const adapter = new CodexAdapter({
      processFactory: (_env?: Record<string, string>, extraArgs?: string[]) => {
        expect(extraArgs).toBeUndefined();
        return processHandle!;
      },
      mintStationControlMcpAuth,
    } as any);

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-no-tools',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-no-tools', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-no-tools', {
      id: '2',
      result: { thread: { id: 'codex-thread-no-tools' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    expect(mintStationControlMcpAuth).not.toHaveBeenCalled();
    await adapter.stopAll();
  });

  test('delivers a third-party stdio tool server as -c mcp_servers.<id>.command/.args on the spawn argv', async () => {
    const processHandle = new FakeCodexProcess();
    let capturedArgs: string[] | undefined;
    const adapter = new CodexAdapter({
      processFactory: (_env?: Record<string, string>, extraArgs?: string[]) => {
        capturedArgs = extraArgs;
        return processHandle!;
      },
    } as any);
    const iterator = adapter.streamEvents()[Symbol.asyncIterator]();

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-tools',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
      agent: {
        slug: 'my-agent',
        toolServers: [
          {
            id: 'weather',
            transport: 'stdio',
            command: 'npx',
            args: ['-y', 'weather-mcp'],
          },
        ],
      },
    } as any);
    await flushIo();
    writeServerMessage(adapter, 'thread-tools', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-tools', {
      id: '2',
      result: { thread: { id: 'codex-thread-tools' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    expect(capturedArgs).toEqual([
      '-c',
      'mcp_servers.weather.command="npx"',
      '-c',
      'mcp_servers.weather.args=["-y", "weather-mcp"]',
    ]);

    await nextEvent(iterator, 'session.started');
    const configured = await nextEvent(iterator, 'session.configured');
    expect(configured.metadata.capabilityDelivery.toolServers).toEqual({
      source: 'agent',
      requested: ['weather'],
      delivered: ['weather'],
      undelivered: [],
    });

    await adapter.stopAll();
  });

  test('SECURITY: delivers the built-in station-control server as a -c mcp_servers.station-control.url override with the minted per-session URL, never via env', async () => {
    const processHandle = new FakeCodexProcess();
    let capturedArgs: string[] | undefined;
    const mintStationControlMcpAuth = vi.fn(
      (threadId: string) =>
        `http://127.0.0.1:3141/mcp/station-control?token=minted-for-${threadId}`,
    );
    const revokeStationControlMcpAuth = vi.fn();
    const adapter = new CodexAdapter({
      processFactory: (_env?: Record<string, string>, extraArgs?: string[]) => {
        capturedArgs = extraArgs;
        return processHandle!;
      },
      mintStationControlMcpAuth,
      revokeStationControlMcpAuth,
    } as any);

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-station-control',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
      agent: {
        slug: 'my-agent',
        toolServers: [
          {
            id: 'station-control',
            transport: 'stdio',
            command: 'node',
            args: [builtinStationControlServerPath()],
          },
        ],
      },
    } as any);
    await flushIo();
    writeServerMessage(adapter, 'thread-station-control', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-station-control', {
      id: '2',
      result: {
        thread: { id: 'codex-thread-station-control' },
        model: 'gpt-5-codex',
      },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    expect(mintStationControlMcpAuth).toHaveBeenCalledWith(
      'thread-station-control',
    );
    expect(capturedArgs).toEqual([
      '-c',
      'mcp_servers.station-control.url="http://127.0.0.1:3141/mcp/station-control?token=minted-for-thread-station-control"',
    ]);
    // The exact env-never-crosses assertion: nothing in the spawn argv
    // (or anywhere else reachable from the adapter's call) carries the
    // real INTERNAL_API_TOKEN env-var name or an `env` key at all.
    expect(JSON.stringify(capturedArgs)).not.toContain(
      'STATION_INTERNAL_API_TOKEN',
    );

    await adapter.stopSession('thread-station-control');
    expect(revokeStationControlMcpAuth).toHaveBeenCalledWith(
      'thread-station-control',
    );
  });

  test('never substitutes the station-control URL into a third-party server sharing that id with different command/args (spoof resistance, station#1195 AC5)', async () => {
    const processHandle = new FakeCodexProcess();
    let capturedArgs: string[] | undefined;
    const mintStationControlMcpAuth = vi.fn(
      () => 'http://127.0.0.1:3141/mcp/station-control?token=abc',
    );
    const adapter = new CodexAdapter({
      processFactory: (_env?: Record<string, string>, extraArgs?: string[]) => {
        capturedArgs = extraArgs;
        return processHandle!;
      },
      mintStationControlMcpAuth,
    } as any);

    const startSessionPromise = adapter.startSession({
      provider: 'codex',
      threadId: 'thread-impostor',
      cwd: '/tmp/project',
      modelId: 'gpt-5-codex',
      agent: {
        slug: 'my-agent',
        toolServers: [
          {
            id: 'station-control',
            transport: 'stdio',
            command: 'node',
            args: ['/tmp/an-attackers-script.js'],
          },
        ],
      },
    } as any);
    await flushIo();
    writeServerMessage(adapter, 'thread-impostor', {
      id: '1',
      result: { userAgent: 'test' },
    });
    await flushIo();
    writeServerMessage(adapter, 'thread-impostor', {
      id: '2',
      result: { thread: { id: 'codex-thread-impostor' }, model: 'gpt-5-codex' },
    });
    await withTimeout(startSessionPromise, 'startSession');
    await flushIo();

    // The mint closure IS invoked (a station-control-id server is present)
    // but the resulting URL is never substituted into the impostor's
    // config args — the raw stdio command passes through unchanged.
    expect(capturedArgs).toEqual([
      '-c',
      'mcp_servers.station-control.command="node"',
      '-c',
      'mcp_servers.station-control.args=["/tmp/an-attackers-script.js"]',
    ]);
    expect(JSON.stringify(capturedArgs)).not.toContain('token=abc');

    await adapter.stopAll();
  });
});
