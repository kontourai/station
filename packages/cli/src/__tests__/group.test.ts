import assert from 'node:assert/strict';
import {
  StationRequestTimeoutError,
  setClientCredentialResolver,
  setClientRequestTimeout,
} from '@kontourai/station-sdk/client';
import { afterEach, test, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs';
import { reportCliError, runCli } from '../cli';
import { parseCoreArgs } from '../commands/core-api';
import { runGroupCommand } from '../commands/group';

const sessionGroupTemp = trackTempDirs();

test('registered group command reaches the SDK with explicit target credentials', async () => {
  const original = globalThis.fetch;
  const log = console.log;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  console.log = () => {};
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ success: true, data: groupView() }));
  };
  try {
    await runCli([
      'group',
      'get',
      'g',
      '--api-base=https://station.test',
      '--credential=fixture',
      '--json',
    ]);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://station.test/api/orchestration/groups/g',
    );
    assert.equal(
      new Headers(calls[0].init?.headers).get('Authorization'),
      'Bearer fixture',
    );
  } finally {
    globalThis.fetch = original;
    console.log = log;
    setClientCredentialResolver(undefined);
  }
});

test('CLI group write carries explicit operation and revision and never invents a retry', async () => {
  const original = globalThis.fetch;
  const log = console.log;
  const output: string[] = [];
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  console.log = (value) => {
    output.push(String(value));
  };
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        success: true,
        data: { replayed: false, group: groupView() },
      }),
    );
  };
  try {
    await runGroupCommand(
      'https://station.test',
      parseCoreArgs(['run', 'g', '--operation=op', '--revision=7', '--json']),
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      'https://station.test/api/orchestration/groups/g/run',
    );
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      operationId: 'op',
      expectedRevision: 7,
    });
    assert.equal(JSON.parse(output[0]).group.groupId, 'g');
    await assert.rejects(
      runGroupCommand(
        'https://station.test',
        parseCoreArgs(['run', 'g', '--operation=op']),
      ),
      /revision/,
    );
    await assert.rejects(
      runGroupCommand(
        'https://station.test',
        parseCoreArgs([
          'run',
          'g',
          '--operation=op',
          '--revision=7',
          '--authority=forged',
        ]),
      ),
      /Unsupported/,
    );
    assert.equal(calls.length, 1);
    globalThis.fetch = async () => {
      calls.push({ url: 'refusal' });
      return new Response(
        JSON.stringify({ success: false, code: 'group_stale' }),
        { status: 409 },
      );
    };
    await assert.rejects(
      runGroupCommand(
        'https://station.test',
        parseCoreArgs(['run', 'g', '--operation=op', '--revision=7']),
      ),
      { code: 'group_stale' },
    );
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = original;
    console.log = log;
  }
});

test.each([
  ['g', '--after-revision=-1'],
  ['invalid/group', '--after-revision=0'],
])(
  'CLI session follow validation releases SIGINT for %s %s without fetching',
  async (groupId, revision) => {
    const listeners = process.listeners('SIGINT');
    const fetch = vi.spyOn(globalThis, 'fetch');
    try {
      await assert.rejects(
        runGroupCommand(
          'https://station.test',
          parseCoreArgs(['session-events', groupId, revision, '--follow']),
        ),
      );
      assert.deepEqual(process.listeners('SIGINT'), listeners);
      assert.equal(fetch.mock.calls.length, 0);
    } finally {
      for (const listener of process.listeners('SIGINT')) {
        if (!listeners.includes(listener))
          process.removeListener('SIGINT', listener);
      }
      fetch.mockRestore();
    }
  },
);

test.each(['events', 'session-events', 'report-events'])(
  'CLI %s follow closes its stream and SIGINT listener after interruption',
  async (action) => {
    const original = globalThis.fetch;
    const log = console.log;
    const listeners = process.listenerCount('SIGINT');
    let cancelled = false;
    let emitted!: () => void;
    const printed = new Promise<void>((resolve) => {
      emitted = resolve;
    });
    console.log = () => {
      emitted();
    };
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `event: ${action === 'events' ? 'group-events' : action === 'report-events' ? 'report-group-events' : 'cli-group-events'}\nid: ${action === 'events' ? 'group:g:1' : action === 'report-events' ? 'report:g:1' : 'cli-group:g:1'}\ndata: ${JSON.stringify({ groupId: 'g', afterRevision: 0, nextRevision: 1, ...(action === 'report-events' ? { revision: 1 } : {}), events: action === 'events' ? [] : action === 'report-events' ? [{ revision: 1, kind: 'command', commandKind: 'create' }] : [{ revision: 1, members: [], schedule: [] }], hasMore: false, unavailable: [] })}\n\n`,
              ),
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    try {
      const running = runGroupCommand(
        'https://station.test',
        parseCoreArgs([action, 'g', '--follow', '--json']),
      );
      await printed;
      assert.equal(process.listenerCount('SIGINT'), listeners + 1);
      process.emit('SIGINT');
      await running;
      assert.equal(cancelled, true);
      assert.equal(process.listenerCount('SIGINT'), listeners);
    } finally {
      globalThis.fetch = original;
      console.log = log;
    }
  },
);

function groupView() {
  return {
    version: 'station.delegation-group/v1',
    groupId: 'g',
    revision: 0,
    execution: 'idle',
    cancellation: 'none',
    terminal: 'unproven',
    acceptance: 'unassessed',
    executionCapability: {
      status: 'unavailable',
      code: 'physical_adapter_unqualified',
    },
    topology: { kind: 'independent-advisory' },
    members: [],
  };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  setClientCredentialResolver(undefined);
  setClientRequestTimeout(undefined);
  vi.useRealTimers();
});

test('CLI follow reconnects normal rotation with its checkpoint; SIGINT remains local', async () => {
  vi.useFakeTimers();
  const listeners = process.listenerCount('SIGINT');
  const requests: { url: string; headers: Headers }[] = [];
  const cancel = vi.fn();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url, init) => {
      requests.push({ url: String(url), headers: new Headers(init?.headers) });
      const revision = requests.length;
      const bytes = new TextEncoder().encode(
        `event: group-events\nid: group:g:${revision}\ndata: ${JSON.stringify({ groupId: 'g', afterRevision: revision - 1, nextRevision: revision, events: [], hasMore: false, unavailable: [] })}\n\n`,
      );
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(bytes);
            if (revision === 1) c.close();
          },
          cancel,
        }),
      );
    }),
  );
  const running = runCli([
    'group',
    'events',
    'g',
    '--follow',
    '--json',
    '--api-base=https://station.test',
    '--credential=fixture',
  ]);
  const settled = running.then(
    () => 'done',
    (error) => error,
  );
  try {
    await vi.advanceTimersByTimeAsync(1100);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].headers.get('Last-Event-ID'), 'group:g:1');
    assert.equal(
      requests.every((r) => r.url.includes('/events/stream')),
      true,
    );
    process.emit('SIGINT');
    assert.equal(await settled, 'done');
    assert.equal(cancel.mock.calls.length, 1);
    assert.equal(process.listenerCount('SIGINT'), listeners);
  } finally {
    process.emit('SIGINT');
    await settled;
  }
});

test('top-level group JSON reports refusal codes and ambiguous write timeout without resend', async () => {
  const stderr: string[] = [];
  const stdout: string[] = [];
  const exitCode = process.exitCode;
  vi.spyOn(console, 'error').mockImplementation((...args) =>
    stderr.push(args.join(' ')),
  );
  vi.spyOn(console, 'log').mockImplementation((...args) =>
    stdout.push(args.join(' ')),
  );
  try {
    for (const failure of ['refusal', 'timeout']) {
      stderr.length = 0;
      const fetch = vi.fn(async (_url, init) => {
        if (failure === 'refusal')
          return new Response(
            JSON.stringify({ success: false, code: 'group_stale' }),
            { status: 409 },
          );
        return new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener(
            'abort',
            () => reject(init.signal.reason),
            { once: true },
          );
        });
      });
      vi.stubGlobal('fetch', fetch);
      if (failure === 'timeout') vi.stubEnv('STATION_REQUEST_TIMEOUT_MS', '5');
      const operation = runCli([
        'group',
        'run',
        'g',
        '--operation=o',
        '--revision=2',
        '--json',
        '--api-base=https://station.test',
        '--credential=fixture',
      ]).catch(reportCliError);

      await operation;
      assert.equal(stderr.length, 1);
      const result = JSON.parse(stderr[0]);
      assert.equal(result.success, false);
      if (failure === 'refusal') {
        assert.equal(result.code, 'group_stale');
        assert.equal(result.status, 409);
      } else {
        assert.equal(result.code, 'request_timeout');
        assert.equal(result.mutation, true);
        assert.equal(result.retryable, false);
      }
      assert.equal(process.exitCode, 1);
      assert.equal(fetch.mock.calls.length, 1);
      assert.equal(stdout.length, 0);
      vi.useRealTimers();
    }
  } finally {
    process.exitCode = exitCode;
  }
});

test('session-group commands validate selected engines and refuse invented cost guarantees', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = sessionGroupTemp('station-cli-group-input-');
  const file = join(root, 'group.json');
  writeFileSync(
    file,
    JSON.stringify({
      operationId: 'op',
      maxConcurrent: 1,
      deadlineAt: Date.now() + 60_000,
      members: [
        { seatId: 'one', prompt: 'Review this', target: { agent: 'reviewer' } },
      ],
    }),
  );
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  await assert.rejects(
    runGroupCommand(
      'https://station.test',
      parseCoreArgs(['session-create', `--file=${file}`]),
    ),
  );
  assert.equal(fetch.mock.calls.length, 0);
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        success: true,
        data: {
          ...sessionGroupView(),
          guarantees: {
            ...sessionGroupView().guarantees,
            dollarCap: 'enforced',
          },
        },
      }),
    );
  await assert.rejects(
    runGroupCommand(
      'https://station.test',
      parseCoreArgs(['session-get', 'cli-group']),
    ),
  );
});

function sessionGroupView() {
  return {
    version: 'station.cli-session-group/v1',
    groupId: 'cli-group',
    revision: 0,
    supervision: 'not-running',
    cancelled: false,
    deadlineAt: Date.now() + 60_000,
    maxConcurrent: 1,
    dispatchCount: 0,
    guarantees: {
      authority: 'station-session',
      portableFlowLineage: 'unbound',
      dollarCap: 'unavailable',
      tokenCap: 'unavailable',
      physicalAttemptCap: 'unavailable',
      deadline: 'stop-admission-and-request-interruption',
    },
    flow: null,
    acceptance: 'unassessed',
    members: [{ seatId: 'one', needs: [], state: 'pending' }],
  };
}

test('registered preset-group creation submits exact receiver bindings and refuses model injection', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const file = join(
    sessionGroupTemp('station-cli-preset-group-'),
    'input.json',
  );
  const target = {
    agent: 'reviewer',
    expectedEngine: { kind: 'connection', connectionId: 'opencode' },
    workspace: { kind: 'directory', cwd: '/work' },
  };
  const input = {
    path: '/work/team.json',
    expectedPresetHash: `sha256:${'a'.repeat(64)}`,
    brief: 'Review',
    operationId: 'preset',
    maxConcurrent: 1,
    deadlineAt: Date.now() + 60_000,
    bindings: { lead: { target, needs: [] } },
  };
  writeFileSync(file, JSON.stringify(input));
  const fetch = vi.fn(
    async (_url: Parameters<typeof globalThis.fetch>[0], _init?: RequestInit) =>
      new Response(JSON.stringify({ success: true, data: sessionGroupView() })),
  );
  vi.stubGlobal('fetch', fetch);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await runCli([
    'group',
    'session-from-ensemble',
    `--file=${file}`,
    '--api-base=https://station.test',
    '--credential=fixture',
    '--json',
  ]);
  assert.equal(fetch.mock.calls.length, 1);
  const [url, init] = fetch.mock.calls[0];
  assert.equal(
    String(url),
    'https://station.test/api/orchestration/session-groups/from-ensemble',
  );
  assert.deepEqual(JSON.parse(String(init?.body)), input);
  writeFileSync(
    file,
    JSON.stringify({
      ...input,
      bindings: {
        lead: {
          needs: [],
          target: { ...target, model: { override: 'injected' } },
        },
      },
    }),
  );
  await assert.rejects(
    runGroupCommand(
      'https://station.test',
      parseCoreArgs(['session-from-ensemble', `--file=${file}`]),
    ),
  );
  assert.equal(fetch.mock.calls.length, 1);
});

function reportView() {
  return {
    version: 'station.report-group/v1',
    groupId: 'report',
    operationId: 'op',
    revision: 0,
    topology: { kind: 'independent-advisory' },
    execution: 'idle',
    cancellation: 'none',
    authorityRevoked: false,
    acceptance: 'unassessed',
    members: [
      {
        seatId: 'one',
        agentId: 'reviewer',
        taskId: 'task',
        clientTurnId: 'turn',
        requestedModelId: 'model',
        attempts: [],
      },
    ],
  };
}
test('registered report CLI resolves SDK operations with explicit credentials and no repeated mutation', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const root = sessionGroupTemp('station-cli-report-');
  const file = join(root, 'report.json');
  const input = {
    operationId: 'op',
    projectSlug: 'p',
    deadlineAt: Date.now() + 60000,
    maxConcurrent: 1,
    budget: { inputTokens: 100, outputTokens: 10, costMicros: 450 },
    members: [
      {
        seatId: 'one',
        agentId: 'reviewer',
        brief: 'Report',
        maxOutputTokens: 10,
      },
    ],
  };
  writeFileSync(file, JSON.stringify(input));
  const syncFile = join(root, 'sync.json');
  const syncInput = {
    operationKey: 'sync',
    expectedRevision: 0,
    seatId: 'one',
    flowHead: 'a'.repeat(64),
    text: '\0'.repeat(65_536),
  };
  writeFileSync(syncFile, JSON.stringify(syncInput));
  const preparedDigest = `sha256:${'b'.repeat(64)}`;
  const synced = {
    ...reportView(),
    topology: { kind: 'flow', runId: 'run' },
    contextSyncs: [
      {
        operationKey: 'sync',
        seatId: 'one',
        flowHead: syncInput.flowHead,
        state: 'acknowledged',
        reason: 'exact_ack',
        preparedDigest,
        attempts: [
          {
            invocationId: 'sync-attempt',
            allocation: { inputTokens: 10, outputTokens: 10, costMicros: 10 },
            usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
            accountingTerminal: true,
            terminal: {
              id: 'proof',
              domain: 'station.report-observation.v1',
              digest: `sha256:${'c'.repeat(64)}`,
            },
          },
        ],
      },
    ],
  };
  const output: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((value) => {
    output.push(String(value));
  });
  const fetch = vi.fn<typeof globalThis.fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const data =
      path.endsWith('/report-groups') && (init?.method ?? 'GET') === 'GET'
        ? { groups: [reportView()], hasMore: false, nextGroupId: null }
        : path.endsWith('/sync') || path.endsWith('/sync/finalize')
          ? { replayed: false, group: synced }
          : path.endsWith('/cancel') || path.endsWith('/cancel/finalize')
            ? { replayed: false, revision: 1, cancellation: 'requested' }
            : path.includes('/results/')
              ? {
                  kind: 'result',
                  groupId: 'report',
                  seatId: 'one',
                  invocationId: 'attempt',
                  modelId: 'model',
                  text: '\u001b[31moutput',
                  afterOffset: 0,
                  nextOffset: 11,
                  hasMore: false,
                  usage: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
                }
              : path.endsWith('/events')
                ? {
                    groupId: 'report',
                    afterRevision: 0,
                    nextRevision: 0,
                    revision: 0,
                    events: [],
                    unavailable: [],
                    hasMore: false,
                  }
                : path.endsWith('/report')
                  ? reportView()
                  : { replayed: false, group: reportView() };
    return new Response(JSON.stringify({ success: true, data }));
  });
  vi.stubGlobal('fetch', fetch);
  const listeners = process.listeners('SIGINT');
  const commands = [
    ['report-create', `--file=${file}`],
    ['report-list'],
    ['report-get', 'report'],
    ['report-events', 'report'],
    ['report-result', 'report', 'one', 'attempt'],
    ['report-cancel', 'report', '--operation=stop', '--revision=0'],
    [
      'report-finalize-cancel',
      'report',
      '--operation=finish',
      '--cancel-operation=stop',
      '--revision=1',
    ],
    ['report-sync', 'report', `--file=${syncFile}`],
    [
      'report-finalize-sync',
      'report',
      '--operation=finish-sync',
      '--revision=1',
      '--sync-operation=sync',
      `--prepared-digest=${preparedDigest}`,
    ],
  ];
  for (const command of commands)
    await runCli([
      'group',
      ...command,
      '--api-base=https://station.test',
      '--credential=fixture',
      '--json',
    ]);
  assert.deepEqual(process.listeners('SIGINT'), listeners);
  assert.equal(fetch.mock.calls.length, 9);
  assert.equal(output.length, 9);
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[0][1]?.body)), input);
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[5][1]?.body)), {
    operationKey: 'stop',
    expectedRevision: 0,
  });
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[6][1]?.body)), {
    operationKey: 'finish',
    expectedRevision: 1,
    cancelOperationKey: 'stop',
  });
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[7][1]?.body)), syncInput);
  assert.deepEqual(JSON.parse(String(fetch.mock.calls[8][1]?.body)), {
    operationKey: 'finish-sync',
    expectedRevision: 1,
    syncOperationKey: 'sync',
    preparedDigest,
  });
  for (const [, init] of fetch.mock.calls)
    assert.equal(
      new Headers(init?.headers).get('Authorization'),
      'Bearer fixture',
    );
  assert.ok(output.every((value) => !value.includes('\u001b')));
});
test.each([
  ['report-events', 'report', '--after-revision=-1', '--follow'],
  ['report-result', 'report', 'one'],
  ['report-cancel', 'report', '--operation=stop'],
  ['report-get', 'report', '--file=unexpected'],
  [
    'report-cancel',
    'report',
    '--operation=stop',
    '--revision=0',
    '--revision=1',
  ],
])(
  'report CLI rejects malformed command %j without fetching or retaining SIGINT',
  async (...args) => {
    const fetch = vi.fn<typeof globalThis.fetch>();
    vi.stubGlobal('fetch', fetch);
    const listeners = process.listeners('SIGINT');
    await assert.rejects(
      runGroupCommand('https://station.test', parseCoreArgs(args)),
    );
    assert.equal(fetch.mock.calls.length, 0);
    assert.deepEqual(process.listeners('SIGINT'), listeners);
  },
);
test('report create refuses non-UTF8 and oversized files before a request', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const file = join(
    sessionGroupTemp('station-cli-report-invalid-'),
    'input.json',
  );
  const fetch = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal('fetch', fetch);
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(262145)]) {
    writeFileSync(file, bytes);
    await assert.rejects(
      runGroupCommand(
        'https://station.test',
        parseCoreArgs(['report-create', `--file=${file}`]),
      ),
    );
  }
  assert.equal(fetch.mock.calls.length, 0);
});

test('report create SIGINT aborts one request without sending cancel or retry and releases its listener', async () => {
  const { writeFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const file = join(
    sessionGroupTemp('station-cli-report-abort-'),
    'input.json',
  );
  writeFileSync(
    file,
    JSON.stringify({
      operationId: 'op',
      projectSlug: 'p',
      deadlineAt: Date.now() + 60000,
      maxConcurrent: 1,
      budget: { inputTokens: 1, outputTokens: 1, costMicros: 1 },
      members: [
        { seatId: 'one', agentId: 'a', brief: 'Report', maxOutputTokens: 1 },
      ],
    }),
  );
  let ready!: () => void;
  const dispatched = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const fetch = vi.fn<typeof globalThis.fetch>(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const stop = () => reject(new DOMException('Aborted', 'AbortError'));
        init?.signal?.addEventListener('abort', stop, { once: true });
        ready();
      }),
  );
  vi.stubGlobal('fetch', fetch);
  const listeners = process.listenerCount('SIGINT');
  const running = runGroupCommand(
    'https://station.test',
    parseCoreArgs(['report-create', `--file=${file}`]),
  );
  const refused = assert.rejects(running, { name: 'AbortError' });
  await dispatched;
  process.emit('SIGINT');
  await refused;
  assert.equal(fetch.mock.calls.length, 1);
  assert.equal(
    String(fetch.mock.calls[0][0]),
    'https://station.test/api/orchestration/report-groups',
  );
  assert.equal(process.listenerCount('SIGINT'), listeners);
});

test.each([
  ['report-list'],
  ['report-get', 'report'],
  ['report-events', 'report'],
  ['report-result', 'report', 'one', 'attempt'],
])(
  'finite report read %s retains its configured deadline with SIGINT installed',
  async (...args) => {
    setClientRequestTimeout(20);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let dispatched!: () => void;
    const started = new Promise<void>((resolve) => {
      dispatched = resolve;
    });
    const request = vi.fn<typeof fetch>(
      async (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener(
            'abort',
            () => reject(init!.signal!.reason),
            { once: true },
          );
          dispatched();
        }),
    );
    vi.stubGlobal('fetch', request);
    const listeners = process.listenerCount('SIGINT');
    let settled = false;
    const running = runGroupCommand(
      'https://station.test',
      parseCoreArgs(args),
    ).then(
      () => {
        settled = true;
        return undefined;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    let guard: ReturnType<typeof setTimeout> | undefined;
    try {
      await started;
      const outcome = await Promise.race([
        running,
        new Promise<'pending'>((resolve) => {
          guard = setTimeout(() => resolve('pending'), 500);
        }),
      ]);
      assert.ok(outcome instanceof StationRequestTimeoutError, String(outcome));
      assert.equal(outcome.mutation, false);
      assert.equal(request.mock.calls.length, 1);
      assert.equal(process.listenerCount('SIGINT'), listeners);
    } finally {
      if (guard) clearTimeout(guard);
      if (!settled) process.emit('SIGINT');
      await running;
    }
  },
);

test('a finite report read respects a disabled host deadline while retaining SIGINT cancellation', async () => {
  vi.useFakeTimers();
  setClientRequestTimeout(undefined);
  let dispatched!: () => void;
  const started = new Promise<void>((resolve) => {
    dispatched = resolve;
  });
  let settled = false;
  const request = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init!.signal!.addEventListener(
          'abort',
          () => reject(init!.signal!.reason),
          { once: true },
        );
        dispatched();
      }),
  );
  vi.stubGlobal('fetch', request);
  const listeners = process.listenerCount('SIGINT');
  const running = runGroupCommand(
    'https://station.test',
    parseCoreArgs(['report-get', 'report']),
  ).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  try {
    await started;
    await vi.advanceTimersByTimeAsync(60_000);
    assert.equal(settled, false);
    process.emit('SIGINT');
    const outcome = await running;
    assert.ok(outcome instanceof Error);
    assert.equal(outcome instanceof StationRequestTimeoutError, false);
    assert.equal(request.mock.calls.length, 1);
    assert.equal(process.listenerCount('SIGINT'), listeners);
  } finally {
    if (!settled) process.emit('SIGINT');
    await running;
  }
});
