import assert from 'node:assert/strict';
import { setClientCredentialResolver } from '@kontourai/station-sdk/client';
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

test('CLI follow closes its stream and SIGINT listener after interruption', async () => {
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
              `event: group-events\nid: group:g:1\ndata: ${JSON.stringify({ groupId: 'g', afterRevision: 0, nextRevision: 1, events: [], hasMore: false, unavailable: [] })}\n\n`,
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
      parseCoreArgs(['events', 'g', '--follow', '--json']),
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
});

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
