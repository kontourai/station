import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  REMOTE_AUTH_PROTOCOL_VERSION,
  STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  STATION_COMPAT_PROTOCOL_VERSION,
} from '@kontourai/station-contracts/environment-security';
import { UNIFIED_SEARCH_V1 } from '@kontourai/station-contracts/unified-search';
import { StationHttpError } from '@kontourai/station-sdk/client';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  type MockInstance,
  test,
  vi,
} from 'vitest';
import { describeCliError } from '../cli.js';
import {
  SESSION_WAIT_EXIT_CODES,
  waitOnSession,
} from '../commands/session-reads.js';
import { readBody } from './helpers/http-test-helpers.js';

/**
 * #3427: `station sessions wait|digest|transcript|search` and `station
 * activity` over HTTP. Two layers, as `delegate-wait.test.ts`:
 *
 * 1. `waitOnSession` with an injected call and clock: outcome
 *    classification, the cursor carried between bounded calls, and the
 *    exit-code table.
 * 2. `runCli` against a real `http.createServer` that answers the public
 *    handshake and the person-facing routes, proving each verb reaches its
 *    one route as a person (no station-control caller header), passes its
 *    flags, prints the documented projection, and exits honestly.
 */

const handshake = (capabilities: Record<string, boolean>) => ({
  schemaVersion: PUBLIC_HANDSHAKE_SCHEMA_VERSION,
  environmentId: 'environment-fixture',
  authentication: {
    scheme: 'bearer',
    protocolVersion: REMOTE_AUTH_PROTOCOL_VERSION,
  },
  transports: {
    http: REMOTE_AUTH_PROTOCOL_VERSION,
    sse: REMOTE_AUTH_PROTOCOL_VERSION,
    websocket: REMOTE_AUTH_PROTOCOL_VERSION,
  },
  compatibility: {
    serverVersion: '0.4.1',
    protocolVersion: STATION_COMPAT_PROTOCOL_VERSION,
    minClientProtocol: STATION_COMPAT_MIN_CLIENT_PROTOCOL,
  },
  capabilities,
});

type WaitQuery = { timeoutMs: number; afterEventCursor?: number };

/** The route's refusal when Station as a whole is at its wait limit. */
const STATION_FULL =
  'Station is serving the most waits it allows at once. Wait again shortly.';

/** A wait answer in the route's shape. */
const answer = (fields: Record<string, unknown>) => ({
  sessionId: 'session-1',
  settled: false,
  timedOut: true,
  state: 'running',
  eventCursor: 1,
  ...fields,
});

describe('waitOnSession (the wait loop)', () => {
  test('the documented exit codes', () => {
    expect(SESSION_WAIT_EXIT_CODES).toEqual({
      completed: 0,
      idle: 0,
      'observation-lost': 2,
      failed: 3,
      'restart-interrupted': 3,
      'wait-timeout': 5,
      superseded: 6,
      unknown: 6,
      cancelled: 130,
    });
  });

  test('a timed-out call is followed by another carrying its cursor, until the turn completes', async () => {
    const answers = [
      answer({ eventCursor: 4 }),
      answer({ eventCursor: 7 }),
      answer({
        settled: true,
        timedOut: false,
        state: 'idle',
        eventCursor: 9,
        settledTurn: { turnId: 't', sequence: 9, outcome: 'completed' },
      }),
    ];
    const call = vi.fn(async (_query: WaitQuery) => answers.shift() as never);
    const result = await waitOnSession({
      sessionId: 'session-1',
      until: 'turn-settled',
      timeoutMs: 600_000,
      deps: { call },
    });
    expect(result).toMatchObject({
      outcome: 'completed',
      exitCode: 0,
      calls: 3,
      settledTurn: { turnId: 't', outcome: 'completed' },
    });
    // No cursor first (the turn running now), then each answer's cursor.
    expect(call.mock.calls.map(([query]) => query.afterEventCursor)).toEqual([
      undefined,
      4,
      7,
    ]);
    // Each call holds at most the route's 50 s.
    for (const [query] of call.mock.calls)
      expect(query.timeoutMs).toBeLessThanOrEqual(50_000);
  });

  test.each([
    [
      'a restart-interrupted turn is never settled',
      answer({
        settled: true,
        timedOut: false,
        state: 'idle',
        interruptedTurn: { turnId: 't', sequence: 3 },
      }),
      'restart-interrupted',
      3,
    ],
    [
      'a turn that failed',
      answer({
        settled: true,
        timedOut: false,
        state: 'idle',
        settledTurn: { turnId: 't', sequence: 3, outcome: 'error' },
      }),
      'failed',
      3,
    ],
    [
      'nothing running to wait on is idle, whatever an earlier turn did',
      answer({
        settled: true,
        timedOut: false,
        alreadyIdle: true,
        state: 'idle',
        settledTurn: { turnId: 'old', sequence: 1, outcome: 'aborted' },
      }),
      'idle',
      0,
    ],
    [
      'a superseded Session names its successor',
      answer({ superseded: true, currentSessionId: 'session-2' }),
      'superseded',
      6,
    ],
  ])('%s', async (_label, reply, outcome, exitCode) => {
    const result = await waitOnSession({
      sessionId: 'session-1',
      until: 'turn-settled',
      timeoutMs: 60_000,
      deps: { call: async () => reply as never },
    });
    expect([result.outcome, result.exitCode]).toEqual([outcome, exitCode]);
  });

  test('the budget running out with the Session still running is wait-timeout, not an outcome', async () => {
    let t = 0;
    const result = await waitOnSession({
      sessionId: 'session-1',
      until: 'idle',
      timeoutMs: 120_000,
      deps: {
        now: () => t,
        call: async (query) => {
          t += query.timeoutMs;
          return answer({}) as never;
        },
      },
    });
    expect(result).toMatchObject({
      outcome: 'wait-timeout',
      exitCode: 5,
      state: 'running',
      calls: 3,
    });
  });

  /** A clock the loop's sleeps advance, so retry windows run instantly. */
  function fakeTime() {
    let t = 0;
    return {
      now: () => t,
      sleep: async (ms: number) => {
        t += ms;
      },
    };
  }

  test('a Station that stops answering is reached for again with the cursor, and its interruption is seen', async () => {
    const time = fakeTime();
    const replies: Array<() => unknown> = [
      () => answer({ eventCursor: 3 }),
      () => {
        throw new TypeError('fetch failed');
      },
      () => {
        throw new StationHttpError(503, 'Service Unavailable');
      },
      () =>
        answer({
          settled: true,
          timedOut: false,
          state: 'idle',
          eventCursor: 4,
          interruptedTurn: { turnId: 't', sequence: 4 },
        }),
    ];
    const call = vi.fn(
      async (_query: WaitQuery) => replies.shift()!() as never,
    );
    const result = await waitOnSession({
      sessionId: 'session-1',
      until: 'turn-settled',
      timeoutMs: 600_000,
      deps: { ...time, call },
    });
    expect([result.outcome, result.exitCode]).toEqual([
      'restart-interrupted',
      3,
    ]);
    expect(call.mock.calls.map(([query]) => query.afterEventCursor)).toEqual([
      undefined,
      3,
      3,
      3,
    ]);
  });

  test('a Station unreachable past the reconnect window is observation-lost, never a turn outcome', async () => {
    const time = fakeTime();
    let calls = 0;
    const result = await waitOnSession({
      sessionId: 'session-1',
      until: 'turn-settled',
      timeoutMs: 600_000,
      deps: {
        ...time,
        call: async () => {
          calls += 1;
          if (calls === 1) return answer({}) as never;
          throw new TypeError('fetch failed');
        },
      },
    });
    expect(result).toMatchObject({
      outcome: 'observation-lost',
      exitCode: 2,
      lastError: 'the Station could not be reached',
      state: 'running',
    });
    // 60 s of 2 s retries, not one failure and not the whole budget.
    expect(calls).toBeGreaterThan(20);
    expect(time.now()).toBeLessThan(120_000);
  });

  test('a Station that is down when the wait starts is waited for, never called too old', async () => {
    // A port that refuses: listen, note it, close.
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const port = (probe.address() as AddressInfo).port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const time = fakeTime();
    const result = await waitOnSession({
      apiBase: `http://127.0.0.1:${port}`,
      sessionId: 'session-1',
      until: 'idle',
      timeoutMs: 600_000,
      deps: time,
    });
    expect(result).toMatchObject({
      outcome: 'observation-lost',
      exitCode: 2,
      lastError: 'the Station could not be reached',
    });
    expect(result.calls).toBeGreaterThan(20);
  });

  test('a proxy answering 503 for a restarting Station is waited for, not called too old', async () => {
    const proxy = createServer((_req, res) => {
      res.writeHead(503, { 'Content-Type': 'text/html' });
      res.end('<html>Service Unavailable</html>');
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    const port = (proxy.address() as AddressInfo).port;
    try {
      const time = fakeTime();
      const result = await waitOnSession({
        apiBase: `http://127.0.0.1:${port}`,
        sessionId: 'session-1',
        until: 'idle',
        timeoutMs: 600_000,
        deps: time,
      });
      expect(result).toMatchObject({
        outcome: 'observation-lost',
        exitCode: 2,
        lastError: 'wait call failed with HTTP 503',
      });
      expect(result.calls).toBeGreaterThan(20);
    } finally {
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  test('a capacity refusal waits for a slot within the budget; nothing was lost', async () => {
    const time = fakeTime();
    const notices: string[] = [];
    const replies: Array<() => unknown> = [
      () => {
        throw new StationHttpError(429, STATION_FULL, {
          code: 'wait_capacity',
        });
      },
      () => {
        throw new StationHttpError(429, STATION_FULL, {
          code: 'wait_capacity',
        });
      },
      () =>
        answer({
          settled: true,
          timedOut: false,
          state: 'idle',
          settledTurn: { turnId: 't', sequence: 2, outcome: 'completed' },
        }),
    ];
    const result = await waitOnSession({
      sessionId: 'session-1',
      until: 'turn-settled',
      timeoutMs: 600_000,
      onNotice: (message) => notices.push(message),
      deps: { ...time, call: async () => replies.shift()!() as never },
    });
    expect([result.outcome, result.exitCode, result.calls]).toEqual([
      'completed',
      0,
      3,
    ]);
    // Told once, not on every retry, in the route's own words for its limit.
    expect(notices).toEqual([`${STATION_FULL} Waiting for a free slot.`]);
  });

  test.each(['idle', 'turn-settled'] as const)(
    'an idle superseded Session is superseded (exit 6), never idle: --until=%s',
    async (until) => {
      const result = await waitOnSession({
        sessionId: 'session-1',
        until,
        timeoutMs: 60_000,
        deps: {
          call: async () =>
            answer({
              settled: true,
              timedOut: false,
              state: 'idle',
              ...(until === 'turn-settled' ? { alreadyIdle: true } : {}),
              superseded: true,
              currentSessionId: 'session-2',
            }) as never,
        },
      });
      expect(result).toMatchObject({
        outcome: 'superseded',
        exitCode: 6,
        superseded: true,
        currentSessionId: 'session-2',
      });
    },
  );

  test('an abort that races an answer reports cancelled, never the answer', async () => {
    const controller = new AbortController();
    const result = await waitOnSession({
      sessionId: 'session-1',
      until: 'turn-settled',
      timeoutMs: 600_000,
      signal: controller.signal,
      deps: {
        call: async () => {
          controller.abort();
          return answer({
            settled: true,
            settledTurn: { sequence: 2, outcome: 'completed' },
          }) as never;
        },
      },
    });
    expect([result.outcome, result.exitCode]).toEqual(['cancelled', 130]);
  });
});

describe('the session reads over HTTP', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let consoleLog: MockInstance;
  let capabilities: Record<string, boolean>;
  let waitReplies: Array<{ status: number; body: unknown }>;
  const requests: Array<{
    method: string;
    pathname: string;
    search: URLSearchParams;
    headers: IncomingMessage['headers'];
    body?: unknown;
  }> = [];

  beforeEach(async () => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    requests.length = 0;
    capabilities = { sessionPersonReads: true };
    waitReplies = [];
    server = createServer(async (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const body = await readBody(req).catch(() => undefined);
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === '/.well-known/station/v1')
        return send(200, handshake(capabilities));
      requests.push({
        method: req.method || 'GET',
        pathname: url.pathname,
        search: url.searchParams,
        headers: req.headers,
        ...(body && Object.keys(body).length > 0 ? { body } : {}),
      });
      if (
        /^\/api\/orchestration\/session-reads\/[^/]+\/wait$/.test(url.pathname)
      ) {
        const reply = waitReplies.shift() ?? {
          status: 200,
          body: { success: true, data: answer({}) },
        };
        return send(reply.status, reply.body);
      }
      if (url.pathname === '/api/orchestration/session-reads/s-1/digest')
        return send(200, {
          success: true,
          data: {
            session: {
              sessionId: 's-1',
              conversationId: 'c-1',
              title: 'Fix the flake',
              projectSlug: 'proj',
              engine: 'codex',
              status: 'Done',
              turnCount: 1,
              internalOnly: 'never printed',
            },
            turns: [{ request: 'fix it', outcome: 'completed' }],
            page: {
              turns: 1,
              bytes: 10,
              maxBytes: 8192,
              order: 'newest-first',
            },
            nextCursor: null,
          },
        });
      if (url.pathname === '/api/orchestration/session-reads/activity')
        return send(200, {
          success: true,
          data: {
            sessions: [
              {
                sessionId: 's-1',
                title: 'Fix the flake',
                projectSlug: 'proj',
                engine: 'codex',
                status: 'Running',
                turnRunning: true,
                lastActivityAt: '2026-10-28T00:00:00.000Z',
                worktree: { path: '/w', branch: 'fix/flake' },
              },
            ],
            nextCursor: null,
          },
        });
      if (url.pathname === '/api/conversations/c-1/read')
        return send(200, {
          success: true,
          data: {
            conversationId: 'c-1',
            access: 'person',
            notice: 'n',
            messageCount: 1,
            messages: [{ index: 0, id: 'm-1', role: 'user', text: 'hello' }],
            prevCursor: null,
            nextCursor: null,
          },
        });
      if (url.pathname === '/api/search')
        return send(200, {
          success: true,
          data: {
            version: UNIFIED_SEARCH_V1,
            state: 'partial',
            results: [
              {
                version: UNIFIED_SEARCH_V1,
                key: 'native-sessions:message:m-1',
                providerId: 'native-sessions',
                owner: { kind: 'station', stationId: 'station-1' },
                id: 'm-1',
                kind: 'message',
                scope: { sessionId: 's-1', projectId: 'p-1' },
                title: 'Fix the flake',
                snippet: 'the flaky test again',
                matchedFields: ['snippet'],
                currentness: {
                  state: 'current',
                  observedAt: '2026-10-28T00:00:00.000Z',
                },
                relevance: 0.8,
                openIntent: {
                  kind: 'session-message',
                  sessionId: 's-1',
                  messageId: 'm-1',
                  matchedEventId: 'e-1',
                },
              },
            ],
            sources: [
              {
                providerId: 'native-sessions',
                owner: { kind: 'station', stationId: 'station-1' },
                state: 'partial',
                reason: 'result-window',
                continuation: 'next-page',
              },
            ],
          },
        });
      send(404, { success: false, error: 'Unhandled route' });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    apiBase = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
  });

  async function runExpectingExit(args: string[]) {
    const { runCli } = await import('../cli.js');
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    await expect(
      runCli([...args, `--api-base=${apiBase}`, '--credential=test-person']),
    ).rejects.toThrow('exit');
    return exit.mock.calls[0]?.[0];
  }
  async function run(args: string[]) {
    const { runCli } = await import('../cli.js');
    await runCli([
      ...args,
      `--api-base=${apiBase}`,
      '--credential=test-person',
    ]);
  }
  const printed = () =>
    consoleLog.mock.calls.map((call) => String(call[0])).join('\n');

  test('wait reaches its one route as the person, carries the cursor, and exits 0 on completion', async () => {
    waitReplies = [
      {
        status: 200,
        body: { success: true, data: answer({ eventCursor: 5 }) },
      },
      {
        status: 200,
        body: {
          success: true,
          data: answer({
            settled: true,
            timedOut: false,
            state: 'idle',
            eventCursor: 6,
            settledTurn: { turnId: 't', sequence: 6, outcome: 'completed' },
          }),
        },
      },
    ];
    const code = await runExpectingExit([
      'sessions',
      'wait',
      'session-1',
      '--timeout=600',
      '--json',
    ]);
    expect(code).toBe(0);
    const payload = JSON.parse(printed());
    expect(payload).toMatchObject({
      ok: true,
      kind: 'sessions.wait',
      data: { outcome: 'completed', exitCode: 0, sessionId: 'session-1' },
    });
    expect(requests.map((r) => [r.method, r.pathname])).toEqual([
      ['GET', '/api/orchestration/session-reads/session-1/wait'],
      ['GET', '/api/orchestration/session-reads/session-1/wait'],
    ]);
    expect(requests[0]!.search.get('until')).toBe('turn-settled');
    expect(requests[0]!.search.get('afterEventCursor')).toBeNull();
    expect(requests[1]!.search.get('afterEventCursor')).toBe('5');
    for (const request of requests) {
      // A person's credential, never a station-control caller.
      expect(request.headers.authorization).toBe('Bearer test-person');
      expect(
        Object.keys(request.headers).filter((name) =>
          name.startsWith('x-station-control'),
        ),
      ).toEqual([]);
    }
  });

  test('wait reports a restart-interrupted turn as interrupted with exit 3', async () => {
    waitReplies = [
      {
        status: 200,
        body: {
          success: true,
          data: answer({
            settled: true,
            timedOut: false,
            state: 'idle',
            interruptedTurn: { turnId: 'turn-9', sequence: 4 },
          }),
        },
      },
    ];
    const code = await runExpectingExit(['sessions', 'wait', 'session-1']);
    expect(code).toBe(3);
    expect(printed()).toMatch(
      /turn-9 was interrupted when Station restarted, before it finished/,
    );
  });

  test('wait --until=idle sends no cursor and refuses one', async () => {
    waitReplies = [
      {
        status: 200,
        body: {
          success: true,
          data: answer({ settled: true, timedOut: false, state: 'idle' }),
        },
      },
    ];
    expect(
      await runExpectingExit(['sessions', 'wait', 'session-1', '--until=idle']),
    ).toBe(0);
    expect(requests[0]!.search.get('until')).toBe('idle');
    await expect(
      run([
        'sessions',
        'wait',
        'session-1',
        '--until=idle',
        '--after-cursor=3',
      ]),
    ).rejects.toThrow('--after-cursor applies only to --until=turn-settled.');
  });

  test('a refusal before anything was observed is the command’s error, with its message', async () => {
    waitReplies = [
      {
        status: 404,
        body: {
          success: false,
          code: 'feature_preview_disabled',
          error:
            'Enable Session reads from the station CLI in Settings → Advanced → Feature previews.',
          previewId: 'session-cli-reads',
          settingsPath: '/settings?view=feature-previews',
        },
      },
    ];
    const error = await run(['sessions', 'wait', 'session-1']).catch(
      (caught) => caught,
    );
    expect(describeCliError(error)).toMatch(
      /Settings → Advanced → Feature previews/,
    );
  });

  test('a failure after an answer is observation-lost, exit 2', async () => {
    waitReplies = [
      { status: 200, body: { success: true, data: answer({}) } },
      { status: 500, body: { success: false, error: 'boom' } },
    ];
    expect(await runExpectingExit(['sessions', 'wait', 'session-1'])).toBe(2);
    expect(printed()).toMatch(/HTTP 500/);
    expect(printed()).not.toMatch(/boom/);
  });

  test('an older Station without the reads is told apart from not found, and no read is sent', async () => {
    capabilities = {};
    // Were the gate skipped, a wait would run: a short budget and a throwing
    // exit keep that a prompt assertion failure, never a hang or a real exit.
    vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    for (const args of [
      ['sessions', 'wait', 'session-1', '--timeout=1'],
      ['sessions', 'digest', 's-1'],
      ['activity'],
    ]) {
      await expect(run(args)).rejects.toThrow(
        'This Station does not serve Session reads for a person. Update Station to use this command.',
      );
    }
    expect(requests).toEqual([]);
  });

  test('digest --json prints the documented projection only', async () => {
    await run(['sessions', 'digest', 's-1', '--turn-limit=3', '--json']);
    expect(requests[0]!.search.get('turnLimit')).toBe('3');
    const payload = JSON.parse(printed());
    expect(payload.session).toEqual({
      sessionId: 's-1',
      conversationId: 'c-1',
      title: 'Fix the flake',
      projectSlug: 'proj',
      engine: 'codex',
      status: 'Done',
      turnCount: 1,
    });
    expect(payload.turns).toEqual([
      { request: 'fix it', outcome: 'completed' },
    ]);
  });

  test('activity passes the Project and window and prints each row', async () => {
    await run(['activity', '--project=proj', '--active-within=60']);
    expect(requests[0]!.pathname).toBe(
      '/api/orchestration/session-reads/activity',
    );
    expect(requests[0]!.search.get('projectSlug')).toBe('proj');
    expect(requests[0]!.search.get('activeWithinMinutes')).toBe('60');
    expect(printed()).toMatch(
      /s-1 {2}Running \(turn running\) {2}proj {2}Fix the flake fix\/flake/,
    );
  });

  test('transcript reads the person-facing read route at a message', async () => {
    await run(['sessions', 'transcript', 'c-1', '--around=m-1', '--json']);
    expect(requests[0]!.pathname).toBe('/api/conversations/c-1/read');
    expect(requests[0]!.search.get('aroundMessageId')).toBe('m-1');
    expect(JSON.parse(printed()).messages).toEqual([
      { id: 'm-1', index: 0, role: 'user', text: 'hello' },
    ]);
  });

  test('search asks unified search for Session and message hits only', async () => {
    await run(['sessions', 'search', 'flaky', 'test', '--json']);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      pathname: '/api/search',
      body: {
        version: UNIFIED_SEARCH_V1,
        query: 'flaky test',
        filters: { kinds: ['session', 'message'] },
      },
    });
    const continuation = Buffer.from(
      JSON.stringify([{ providerId: 'native-sessions', token: 'next-page' }]),
    ).toString('base64url');
    expect(JSON.parse(printed())).toEqual({
      state: 'partial',
      results: [
        {
          kind: 'message',
          sessionId: 's-1',
          projectId: 'p-1',
          title: 'Fix the flake',
          snippet: 'the flaky test again',
          messageId: 'm-1',
        },
      ],
      incompleteSources: [
        {
          source: 'native-sessions',
          state: 'partial',
          reason: 'result-window',
        },
      ],
      continuation,
    });
    // The printed continuation reads the next page from its own source.
    consoleLog.mockClear();
    await run([
      'sessions',
      'search',
      'flaky test',
      `--continuation=${continuation}`,
      '--json',
    ]);
    expect(requests[1]!.body).toMatchObject({
      continuations: [{ providerId: 'native-sessions', token: 'next-page' }],
    });
  });

  test('--on is refused: these reads answer on the targeted Station', async () => {
    await expect(run(['activity', '--on=peer'])).rejects.toThrow(
      /--on selects where work runs/,
    );
    expect(requests).toEqual([]);
  });
});
