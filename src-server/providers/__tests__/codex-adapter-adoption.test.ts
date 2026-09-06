import { EventEmitter } from 'node:events';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import type { ProviderSessionSourceAffinity } from '@kontourai/station-contracts/provider';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { CodexAdapter } from '../adapters/codex-adapter.js';

class FakeWritable extends Writable {
  readonly lines: string[] = [];

  _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) this.lines.push(line);
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

  kill(signal: NodeJS.Signals = 'SIGTERM'): boolean {
    this.killed = true;
    this.signalCode = signal;
    this.emit('exit', 0);
    return true;
  }
}

const AFFINITY: ProviderSessionSourceAffinity = {
  kind: 'codex-config-home',
  ref: 'a'.repeat(64),
};
const SOURCE_ID = '0199a001-0000-7000-8000-000000000001';
const TURN_ID = 'turn/opaque:alpha';
const TARGET_ID = '0199a001-0000-7000-8000-000000000003';
const CHILD_ID = '01a07840-d5aa-7801-8c9a-aa8e6d585a56';
const OTHER_CHILD_ID = '0199a001-0000-7000-8000-000000000004';
const SECOND_CHILD_ID = '0199a001-0000-7000-8000-000000000005';
const OUTSIDE_CHILD_ID = '0199a001-0000-7000-8000-000000000006';
const SYMLINK_CHILD_ID = '0199a001-0000-7000-8000-000000000007';
const OVERSIZED_CHILD_ID = '0199a001-0000-7000-8000-000000000008';
const LATER_TURN_ID = 'turn/opaque:later';
const MARKER = `station-adoption:${TARGET_ID}`;
const tempRoots: string[] = [];

function sourceHomeWithRollout(
  id: string,
  options: { sourceId?: string; marker?: string; home?: string } = {},
): { home: string; path: string } {
  const home =
    options.home ?? mkdtempSync(join(tmpdir(), 'station-codex-adoption-'));
  if (!options.home) tempRoots.push(home);
  const directory = join(home, 'sessions', '2026', '09', '06');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `rollout-${id}.jsonl`);
  writeFileSync(
    path,
    `${JSON.stringify({
      timestamp: '2026-09-06T12:00:01.000Z',
      type: 'session_meta',
      payload: {
        id,
        session_id: id,
        cwd: '/workspace',
        forked_from_id: options.sourceId ?? SOURCE_ID,
        thread_source: options.marker ?? MARKER,
      },
    })}\n`,
  );
  return { home, path };
}

function calls(process: FakeCodexProcess): any[] {
  return process.stdin.lines.map((line) => JSON.parse(line));
}

async function waitForCall(
  process: FakeCodexProcess,
  method: string,
  occurrence = 0,
): Promise<any> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const matching = calls(process).filter((call) => call.method === method);
    if (matching[occurrence]) return matching[occurrence];
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error(`Timed out waiting for ${method} call ${occurrence}.`);
}

async function nextEvent(iterator: AsyncIterator<any>): Promise<any> {
  return await Promise.race([
    iterator.next().then((result) => result.value),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('Timed out waiting for event.')), 750),
    ),
  ]);
}

function respond(
  process: FakeCodexProcess,
  request: { id: string | number },
  result: unknown,
): void {
  process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
}

function forkResult(
  threadOverrides: Record<string, unknown> = {},
  responseOverrides: Record<string, unknown> = {},
): unknown {
  return {
    cwd: '/workspace',
    model: 'gpt-reported-alias',
    modelProvider: 'openai',
    approvalPolicy: 'never',
    approvalsReviewer: 'user',
    sandbox: { type: 'dangerFullAccess' },
    ...responseOverrides,
    thread: {
      id: CHILD_ID,
      forkedFromId: SOURCE_ID,
      threadSource: MARKER,
      turns: [{ id: TURN_ID, status: 'completed', items: [] }],
      ...threadOverrides,
    },
  };
}

function adoptInput(overrides: Record<string, unknown> = {}): any {
  return {
    provider: 'codex',
    threadId: TARGET_ID,
    sourceSessionId: SOURCE_ID,
    sourceKind: 'codex-rollout',
    sourceAffinity: AFFINITY,
    sourceBoundary: {
      kind: 'completed-turn',
      providerTurnId: TURN_ID,
      observedEventId: 'observed-completion',
    },
    cwd: '/workspace',
    ...overrides,
  };
}

function recovery(overrides: Record<string, unknown> = {}): any {
  return {
    adoptionKey: TARGET_ID,
    sourceKind: 'codex-rollout',
    sourceSessionId: SOURCE_ID,
    sourceAffinity: AFFINITY,
    createdAt: '2026-09-06T12:00:00.000Z',
    cwd: '/workspace',
    ...overrides,
  };
}

async function initialize(process: FakeCodexProcess): Promise<void> {
  const request = await waitForCall(process, 'initialize');
  respond(process, request, { userAgent: 'test' });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('Codex native attached-session adoption', () => {
  test('forks exactly once at the completed boundary and records the distinct child before returning it', async () => {
    const process = new FakeCodexProcess();
    const processFactory = vi.fn(() => process);
    const onProviderChildCreationStarted = vi.fn(async () => undefined);
    const onProviderChildCreated = vi.fn(async () => undefined);
    const adapter = new CodexAdapter({
      processFactory,
      resolveSourceHome: (affinity) =>
        affinity.ref === AFFINITY.ref ? '/source-home' : null,
    });
    const events = adapter.streamEvents()[Symbol.asyncIterator]();

    const input = adoptInput({
      modelId: 'gpt-requested',
      sourceAffinity: { ...AFFINITY },
      sourceBoundary: {
        kind: 'completed-turn',
        providerTurnId: TURN_ID,
        observedEventId: 'observed-completion',
      },
    });
    const adoption = adapter.adoptSession(input, {
      onProviderChildCreationStarted,
      onProviderChildCreated,
    });
    input.sourceAffinity.ref = 'b'.repeat(64);
    input.sourceBoundary.providerTurnId = 'mutated-after-admission';
    await initialize(process);
    const fork = await waitForCall(process, 'thread/fork');
    expect(onProviderChildCreationStarted).toHaveBeenCalledTimes(1);
    expect(fork.params).toEqual({
      threadId: SOURCE_ID,
      lastTurnId: TURN_ID,
      cwd: '/workspace',
      threadSource: MARKER,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      serviceTier: null,
      model: 'gpt-requested',
    });
    expect(
      calls(process).filter((call) => call.method === 'thread/fork'),
    ).toHaveLength(1);
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/resume' }),
    );
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/start' }),
    );
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'turn/start' }),
    );
    respond(process, fork, forkResult());

    await expect(adoption).resolves.toMatchObject({
      provider: 'codex',
      threadId: TARGET_ID,
      status: 'ready',
      model: 'gpt-reported-alias',
      resumeCursor: { codexThreadId: CHILD_ID, sourceAffinity: AFFINITY },
    });
    expect(onProviderChildCreated).toHaveBeenCalledWith({
      codexThreadId: CHILD_ID,
      sourceAffinity: AFFINITY,
    });
    expect(processFactory).toHaveBeenCalledWith(
      { CODEX_HOME: '/source-home' },
      undefined,
    );
    const lifecycle = [await nextEvent(events), await nextEvent(events)];
    expect(lifecycle).toContainEqual(
      expect.objectContaining({
        method: 'session.started',
        metadata: expect.objectContaining({
          usageAvailability: 'unavailable',
          usageUnavailableReason:
            'inherited-cumulative-counter-without-durable-baseline',
        }),
      }),
    );

    const discard = adapter.discardSession(
      TARGET_ID,
      recovery({
        resumeCursor: { codexThreadId: CHILD_ID, sourceAffinity: AFFINITY },
      }),
    );
    const deletion = await waitForCall(process, 'thread/delete');
    expect(deletion.params).toEqual({ threadId: CHILD_ID });
    respond(process, deletion, {});
    await expect(discard).resolves.toBeUndefined();
    expect(process.killed).toBe(true);
  });

  test.each([
    ['source kind', { sourceKind: 'claude-transcript' }, undefined],
    ['source affinity', { sourceAffinity: undefined }, undefined],
    [
      'source namespace',
      { sourceAffinity: { kind: 'claude-config-home', ref: 'a'.repeat(64) } },
      undefined,
    ],
    ['completed boundary', { sourceBoundary: undefined }, undefined],
    ['source identity', { sourceSessionId: TARGET_ID }, undefined],
    ['native source UUID', { sourceSessionId: 'legacy-id' }, undefined],
    [
      'bounded turn identity',
      {
        sourceBoundary: {
          kind: 'completed-turn',
          providerTurnId: '',
          observedEventId: 'observed-completion',
        },
      },
      undefined,
    ],
    ['creation-start hook', {}, { onProviderChildCreated: vi.fn() }],
  ])(
    'rejects invalid %s before spawning or forking',
    async (_label, patch, hooks) => {
      const processFactory = vi.fn(() => new FakeCodexProcess());
      const adapter = new CodexAdapter({
        processFactory,
        resolveSourceHome: () => '/source-home',
      });
      await expect(
        adapter.adoptSession(adoptInput(patch), hooks as any),
      ).rejects.toThrow();
      expect(processFactory).not.toHaveBeenCalled();
    },
  );

  test('rejects an unavailable source home before spawning or reporting creation', async () => {
    const processFactory = vi.fn(() => new FakeCodexProcess());
    const started = vi.fn();
    const adapter = new CodexAdapter({
      processFactory,
      resolveSourceHome: () => null,
    });
    await expect(
      adapter.adoptSession(adoptInput(), {
        onProviderChildCreationStarted: started,
        onProviderChildCreated: vi.fn(),
      }),
    ).rejects.toThrow(/affinity is no longer available/);
    expect(processFactory).not.toHaveBeenCalled();
    expect(started).not.toHaveBeenCalled();
  });

  test.each([
    ['same child', { id: SOURCE_ID }],
    ['wrong source', { forkedFromId: 'another-source' }],
    ['wrong marker', { threadSource: 'other-marker' }],
  ])(
    'rejects %s fork lineage without recording a child or retrying',
    async (_label, override) => {
      const process = new FakeCodexProcess();
      const created = vi.fn();
      const adapter = new CodexAdapter({
        processFactory: () => process,
        resolveSourceHome: () => '/source-home',
      });
      const adoption = adapter.adoptSession(adoptInput(), {
        onProviderChildCreationStarted: vi.fn(),
        onProviderChildCreated: created,
      });
      await initialize(process);
      const fork = await waitForCall(process, 'thread/fork');
      respond(process, fork, forkResult(override));

      await expect(adoption).rejects.toThrow(/independent child/);
      expect(created).not.toHaveBeenCalled();
      expect(
        calls(process).filter((call) => call.method === 'thread/fork'),
      ).toHaveLength(1);
      expect(process.killed).toBe(true);
    },
  );

  test.each([
    ['cwd', { cwd: '/wrong-workspace' }],
    ['approval policy', { approvalPolicy: 'on-request' }],
    ['sandbox posture', { sandbox: { type: 'workspaceWrite' } }],
  ])(
    'records the child then rejects mismatched returned %s',
    async (_label, responseOverride) => {
      const process = new FakeCodexProcess();
      const created = vi.fn();
      const adapter = new CodexAdapter({
        processFactory: () => process,
        resolveSourceHome: () => '/source-home',
      });
      const adoption = adapter.adoptSession(adoptInput(), {
        onProviderChildCreationStarted: vi.fn(),
        onProviderChildCreated: created,
      });
      await initialize(process);
      const fork = await waitForCall(process, 'thread/fork');
      respond(process, fork, forkResult({}, responseOverride));

      await expect(adoption).rejects.toThrow(/workspace and execution policy/);
      expect(created).toHaveBeenCalledWith({
        codexThreadId: CHILD_ID,
        sourceAffinity: AFFINITY,
      });
      expect(process.killed).toBe(true);
    },
  );

  test('records a proven child before rejecting a response that lacks the completed cutoff', async () => {
    const process = new FakeCodexProcess();
    const created = vi.fn();
    const adapter = new CodexAdapter({
      processFactory: () => process,
      resolveSourceHome: () => '/source-home',
    });
    const adoption = adapter.adoptSession(adoptInput(), {
      onProviderChildCreationStarted: vi.fn(),
      onProviderChildCreated: created,
    });
    await initialize(process);
    const fork = await waitForCall(process, 'thread/fork');
    respond(process, fork, forkResult({ turns: [] }));

    await expect(adoption).rejects.toThrow(/completed cutoff turn/);
    expect(created).toHaveBeenCalledWith({
      codexThreadId: CHILD_ID,
      sourceAffinity: AFFINITY,
    });
    expect(process.killed).toBe(true);
  });

  test.each([
    [
      'later completed turn',
      [
        { id: TURN_ID, status: 'completed', items: [] },
        { id: LATER_TURN_ID, status: 'completed', items: [] },
      ],
    ],
    [
      'in-progress tail',
      [
        { id: TURN_ID, status: 'completed', items: [] },
        { id: LATER_TURN_ID, status: 'inProgress', items: [] },
      ],
    ],
  ])(
    'rejects a fork response containing a %s after the cutoff',
    async (_label, turns) => {
      const process = new FakeCodexProcess();
      const created = vi.fn();
      const adapter = new CodexAdapter({
        processFactory: () => process,
        resolveSourceHome: () => '/source-home',
      });
      const adoption = adapter.adoptSession(adoptInput(), {
        onProviderChildCreationStarted: vi.fn(),
        onProviderChildCreated: created,
      });
      await initialize(process);
      const fork = await waitForCall(process, 'thread/fork');
      respond(process, fork, forkResult({ turns }));

      await expect(adoption).rejects.toThrow(/completed cutoff turn/);
      expect(created).toHaveBeenCalledTimes(1);
      expect(
        calls(process).filter((call) => call.method === 'thread/fork'),
      ).toHaveLength(1);
    },
  );

  test('treats process loss after one fork request as indeterminate and never retries or starts fresh', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process,
      resolveSourceHome: () => '/source-home',
    });
    const adoption = adapter.adoptSession(adoptInput(), {
      onProviderChildCreationStarted: vi.fn(),
      onProviderChildCreated: vi.fn(),
    });
    await initialize(process);
    const fork = await waitForCall(process, 'thread/fork');
    expect(fork.params).not.toHaveProperty('model');
    process.emit('exit', 1);

    await expect(adoption).rejects.toThrow(/exited before responding/);
    expect(
      calls(process).filter((call) => call.method === 'thread/fork'),
    ).toHaveLength(1);
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/start' }),
    );
  });

  test('stops before parsing an oversized fork response and records no child', async () => {
    const process = new FakeCodexProcess();
    const created = vi.fn();
    const adapter = new CodexAdapter({
      processFactory: () => process,
      resolveSourceHome: () => '/source-home',
    });
    const adoption = adapter.adoptSession(adoptInput(), {
      onProviderChildCreationStarted: vi.fn(),
      onProviderChildCreated: created,
    });
    await initialize(process);
    const fork = await waitForCall(process, 'thread/fork');
    process.stdout.write(
      `${JSON.stringify({
        id: fork.id,
        result: { padding: 'x'.repeat(2 * 1024 * 1024) },
      })}\n`,
    );

    await expect(adoption).rejects.toThrow(/stdout ingress exceeded/);
    expect(created).not.toHaveBeenCalled();
    expect(process.killed).toBe(true);
    expect(
      calls(process).filter((call) => call.method === 'thread/fork'),
    ).toHaveLength(1);
  });

  test('resumes an adopted child in its source home and preserves affinity through turn cursors', async () => {
    const process = new FakeCodexProcess();
    const getAppHomeEnv = vi.fn(async () => ({ CODEX_HOME: '/profile' }));
    const processFactory = vi.fn(() => process);
    const adapter = new CodexAdapter({
      processFactory,
      getAppHomeEnv,
      resolveSourceHome: () => '/source-home',
    });
    const events = adapter.streamEvents()[Symbol.asyncIterator]();
    const start = adapter.startSession({
      provider: 'codex',
      threadId: TARGET_ID,
      cwd: '/workspace',
      resumeCursor: { codexThreadId: CHILD_ID, sourceAffinity: AFFINITY },
      credentialProfileRef: 'profile-that-must-not-win',
    });
    await initialize(process);
    const resume = await waitForCall(process, 'thread/resume');
    expect(resume.params.threadId).toBe(CHILD_ID);
    respond(process, resume, {
      model: 'gpt-test',
      thread: { id: CHILD_ID },
    });
    await expect(start).resolves.toMatchObject({
      resumeCursor: { codexThreadId: CHILD_ID, sourceAffinity: AFFINITY },
    });
    expect(getAppHomeEnv).not.toHaveBeenCalled();
    expect(processFactory).toHaveBeenCalledWith(
      { CODEX_HOME: '/source-home' },
      undefined,
    );
    process.stdout.write(
      `${JSON.stringify({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: CHILD_ID,
          turnId: TURN_ID,
          tokenUsage: {
            total: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          },
        },
      })}\n`,
    );
    process.stdout.write(
      `${JSON.stringify({
        method: 'thread/tokenUsage/updated',
        params: {
          threadId: CHILD_ID,
          turnId: TURN_ID,
          tokenUsage: {
            total: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
          },
        },
      })}\n`,
    );
    const usageEvents = [
      await nextEvent(events),
      await nextEvent(events),
      await nextEvent(events),
    ];
    expect(usageEvents).toContainEqual(
      expect.objectContaining({
        method: 'runtime.warning',
        code: 'codex-inherited-usage-withheld',
      }),
    );
    expect(usageEvents).not.toContainEqual(
      expect.objectContaining({ method: 'token-usage.updated' }),
    );
    expect(
      usageEvents.filter(
        (event) => event.code === 'codex-inherited-usage-withheld',
      ),
    ).toHaveLength(1);

    const turn = adapter.sendTurn({ threadId: TARGET_ID, input: 'next' });
    const turnStart = await waitForCall(process, 'turn/start');
    respond(process, turnStart, { turn: { id: 'turn-next' } });
    await expect(turn).resolves.toMatchObject({
      resumeCursor: {
        codexThreadId: CHILD_ID,
        sourceAffinity: AFFINITY,
        turnId: 'turn-next',
      },
    });
    process.stdout.write(
      `${JSON.stringify({
        method: 'turn/completed',
        params: {
          threadId: CHILD_ID,
          turn: { id: 'turn-next', status: 'completed' },
        },
      })}\n`,
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(adapter.listSessions()).resolves.toContainEqual(
      expect.objectContaining({
        threadId: TARGET_ID,
        resumeCursor: {
          codexThreadId: CHILD_ID,
          sourceAffinity: AFFINITY,
          turnId: 'turn-next',
        },
      }),
    );
    await adapter.stopAll();
  });

  test('rejects a malformed affinity-bearing resume cursor instead of starting a fresh thread', async () => {
    const processFactory = vi.fn(() => new FakeCodexProcess());
    const adapter = new CodexAdapter({
      processFactory,
      resolveSourceHome: () => '/source-home',
    });
    await expect(
      adapter.startSession({
        provider: 'codex',
        threadId: TARGET_ID,
        resumeCursor: {
          codexThreadId: CHILD_ID,
          sourceAffinity: { kind: 'codex-config-home', ref: '' },
        },
      }),
    ).rejects.toThrow(/resume cursor is invalid/);
    expect(processFactory).not.toHaveBeenCalled();
  });

  test('deletes a known recovered child in a fresh same-home maintenance process', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process,
      resolveSourceHome: () => '/source-home',
    });
    const discard = adapter.discardSession(
      TARGET_ID,
      recovery({
        resumeCursor: { codexThreadId: CHILD_ID, sourceAffinity: AFFINITY },
      }),
    );
    await initialize(process);
    const deletion = await waitForCall(process, 'thread/delete');
    expect(deletion.params).toEqual({ threadId: CHILD_ID });
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/list' }),
    );
    respond(process, deletion, {});
    await expect(discard).resolves.toBeUndefined();
    expect(process.killed).toBe(true);
  });

  test('reconciles an unknown child through a bounded list and source-home rollout header', async () => {
    const process = new FakeCodexProcess();
    const child = sourceHomeWithRollout(CHILD_ID);
    const unrelated = sourceHomeWithRollout(OTHER_CHILD_ID, {
      home: child.home,
      sourceId: 'other-source',
      marker: 'other-marker',
    });
    const adapter = new CodexAdapter({
      processFactory: () => process,
      resolveSourceHome: () => child.home,
    });
    const discard = adapter.discardSession(TARGET_ID, recovery());
    await initialize(process);
    const list = await waitForCall(process, 'thread/list');
    respond(process, list, {
      data: [
        {
          id: CHILD_ID,
          path: child.path,
          cwd: '/workspace',
          createdAt: '2026-09-06T12:00:01.000Z',
          threadSource: null,
          forkedFromId: null,
        },
        {
          id: OTHER_CHILD_ID,
          path: unrelated.path,
          cwd: '/workspace',
          createdAt: '2026-09-06T12:00:01.000Z',
          threadSource: null,
          forkedFromId: null,
        },
      ],
      nextCursor: null,
    });
    const deletion = await waitForCall(process, 'thread/delete');
    expect(deletion.params).toEqual({ threadId: CHILD_ID });
    respond(process, deletion, {});

    await expect(discard).resolves.toBeUndefined();
    expect(
      calls(process).filter((call) => call.method === 'thread/fork'),
    ).toHaveLength(0);
    expect(
      calls(process).filter((call) => call.method === 'thread/read'),
    ).toHaveLength(0);
    expect(process.killed).toBe(true);
  });

  test.each([
    ['zero matches', []],
    [
      'multiple matches',
      [
        { id: CHILD_ID, match: true },
        { id: SECOND_CHILD_ID, match: true },
      ],
    ],
  ])(
    'keeps unknown cleanup indeterminate for %s',
    async (_label, candidates) => {
      const process = new FakeCodexProcess();
      const home = mkdtempSync(join(tmpdir(), 'station-codex-adoption-'));
      tempRoots.push(home);
      const listed = candidates.map((candidate: any) => {
        const rollout = sourceHomeWithRollout(candidate.id, {
          home,
          sourceId: candidate.match ? SOURCE_ID : 'other-source',
          marker: candidate.match ? MARKER : 'other-marker',
        });
        return {
          id: candidate.id,
          path: rollout.path,
          cwd: '/workspace',
          createdAt: '2026-09-06T12:00:01.000Z',
        };
      });
      const adapter = new CodexAdapter({
        processFactory: () => process,
        resolveSourceHome: () => home,
      });
      const discard = adapter.discardSession(TARGET_ID, recovery());
      await initialize(process);
      const list = await waitForCall(process, 'thread/list');
      respond(process, list, {
        data: listed,
        nextCursor: null,
      });

      await expect(discard).rejects.toThrow(/could not prove|more than one/);
      expect(calls(process)).not.toContainEqual(
        expect.objectContaining({ method: 'thread/delete' }),
      );
      expect(process.killed).toBe(true);
      expect(
        calls(process).filter((call) => call.method === 'thread/read'),
      ).toHaveLength(0);
    },
  );

  test('keeps a truncated unknown cleanup indeterminate without deletion', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process,
      resolveSourceHome: () => '/source-home',
    });
    const discard = adapter.discardSession(TARGET_ID, recovery());
    await initialize(process);
    for (let page = 0; page < 8; page += 1) {
      const list = await waitForCall(process, 'thread/list', page);
      respond(process, list, { data: [], nextCursor: `cursor-${page}` });
    }
    await expect(discard).rejects.toThrow(/truncated/);
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/delete' }),
    );
    expect(process.killed).toBe(true);
  });

  test('rejects outside, symlinked, and oversized rollout headers during unknown cleanup', async () => {
    const process = new FakeCodexProcess();
    const home = mkdtempSync(join(tmpdir(), 'station-codex-adoption-'));
    tempRoots.push(home);
    const sessions = join(home, 'sessions', '2026', '09', '06');
    mkdirSync(sessions, { recursive: true });
    const outside = sourceHomeWithRollout(OUTSIDE_CHILD_ID);
    const symlinkPath = join(sessions, 'rollout-symlink.jsonl');
    symlinkSync(outside.path, symlinkPath);
    const oversizedPath = join(sessions, 'rollout-oversized.jsonl');
    writeFileSync(oversizedPath, `${'x'.repeat(128 * 1024 + 1)}\n`);
    const adapter = new CodexAdapter({
      processFactory: () => process,
      resolveSourceHome: () => home,
    });
    const discard = adapter.discardSession(TARGET_ID, recovery());
    await initialize(process);
    const list = await waitForCall(process, 'thread/list');
    respond(process, list, {
      data: [
        {
          id: OUTSIDE_CHILD_ID,
          path: outside.path,
          cwd: '/workspace',
          createdAt: '2026-09-06T12:00:01.000Z',
        },
        {
          id: SYMLINK_CHILD_ID,
          path: symlinkPath,
          cwd: '/workspace',
          createdAt: '2026-09-06T12:00:01.000Z',
        },
        {
          id: OVERSIZED_CHILD_ID,
          path: oversizedPath,
          cwd: '/workspace',
          createdAt: '2026-09-06T12:00:01.000Z',
        },
      ],
      nextCursor: null,
    });

    await expect(discard).rejects.toThrow(/could not prove/);
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/delete' }),
    );
    expect(process.killed).toBe(true);
  });

  test('keeps unavailable unknown cleanup indeterminate without deletion or retry', async () => {
    const process = new FakeCodexProcess();
    const adapter = new CodexAdapter({
      processFactory: () => process,
      resolveSourceHome: () => '/source-home',
    });
    const discard = adapter.discardSession(TARGET_ID, recovery());
    await initialize(process);
    await waitForCall(process, 'thread/list');
    process.emit('exit', 1);

    await expect(discard).rejects.toThrow(/exited before responding/);
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/delete' }),
    );
    expect(calls(process)).not.toContainEqual(
      expect.objectContaining({ method: 'thread/fork' }),
    );
  });

  test('refuses cleanup bindings and cursors that could target the source or another home', async () => {
    const processFactory = vi.fn(() => new FakeCodexProcess());
    const adapter = new CodexAdapter({
      processFactory,
      resolveSourceHome: () => '/source-home',
    });
    await expect(
      adapter.discardSession(
        TARGET_ID,
        recovery({
          resumeCursor: { codexThreadId: SOURCE_ID, sourceAffinity: AFFINITY },
        }),
      ),
    ).rejects.toThrow(/source thread/);
    await expect(
      adapter.discardSession(
        TARGET_ID,
        recovery({
          resumeCursor: {
            codexThreadId: CHILD_ID,
            sourceAffinity: { ...AFFINITY, ref: 'b'.repeat(64) },
          },
        }),
      ),
    ).rejects.toThrow(/another source home/);
    expect(processFactory).not.toHaveBeenCalled();
  });
});
