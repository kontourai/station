/**
 * `station operate`'s imperative shell (#168 Wave 2, Task 2A) — integration
 * coverage for the SSE lifecycle / keypress wiring / teardown discipline
 * that a pure `reduce()`/`render()` unit test cannot exercise. Modeled
 * directly on `core-http.test.ts`'s real-`node:http`-mock-server harness
 * (scripted `/api/orchestration/events` branch, `req.on('close')`
 * abort-observation pattern) plus a `node:stream` `PassThrough` fed raw
 * keypress bytes through `readline.emitKeypressEvents` — no PTY required
 * (Node's `emitKeypressEvents` accepts any readable stream, confirmed in
 * the plan's TUI-decision section).
 *
 * The mock server's `/api/orchestration/events` handler never ends its own
 * response on its own initiative — exactly like the real route
 * (`src-server/routes/orchestration/orchestration.ts:319-362`) — so every test that
 * expects the connection to close is proof the *shell* called
 * `AbortController.abort()` (the #165-lineage discipline AC-lifecycle
 * requires); if `shell.ts` ever drops one of its `abort()` calls, the
 * corresponding test here hangs until timeout and fails, rather than
 * passing vacuously.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  type OperateStdout,
  runOperateShell,
} from '../commands/operate/shell.js';
import type { OperateAction } from '../commands/operate/types.js';
import { readBody } from './helpers/http-test-helpers.js';

/**
 * #168 iteration-2 review finding L2: prove a throwing `reduce()` can never
 * bypass `teardown()`/terminal restore from a synchronous dispatch entry
 * point (`onKeypress`, the tick interval callback). `reduce` is the one
 * export mocked here — a single, deliberately-triggered keypress (`'!'`, an
 * unrecognized binding whose sequence value this mock alone checks for)
 * throws; every other action passes straight through to the real `reduce`,
 * so every other test in this file exercises unmodified behavior.
 */
const REDUCE_THROW_SEQUENCE = '!';
// #187 follow-up 2: a seeded-history event carrying this eventId makes the
// mocked `reduce()` throw during `seedFocus`'s replay loop — no live test
// ever pushes it over SSE, so only the replay path can trip it.
const REPLAY_THROW_EVENT_ID = 'evt-replay-reduce-throw';
vi.mock('../commands/operate/state.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../commands/operate/state.js')>();
  return {
    ...actual,
    reduce: (
      state: Parameters<typeof actual.reduce>[0],
      action: OperateAction,
    ) => {
      if (
        action.type === 'keypress' &&
        action.key.sequence === REDUCE_THROW_SEQUENCE
      ) {
        throw new Error(
          'boom: reduce() threw during keypress dispatch (L2 test)',
        );
      }
      if (
        action.type === 'event' &&
        (action.event as { eventId?: unknown }).eventId ===
          REPLAY_THROW_EVENT_ID
      ) {
        throw new Error(
          'boom: reduce() threw during seeded-history replay (#187 test)',
        );
      }
      return actual.reduce(state, action);
    },
  };
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

type TestStdin = PassThrough & {
  isTTY: boolean;
  setRawMode: ReturnType<typeof vi.fn<(mode: boolean) => void>>;
};

function createStdin(): TestStdin {
  const stream = new PassThrough();
  return Object.assign(stream, {
    isTTY: true,
    setRawMode: vi.fn<(mode: boolean) => void>(),
  });
}

function createStdout(): OperateStdout & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
  };
}

function pressKey(stdin: TestStdin, sequence: string): void {
  stdin.write(sequence);
}

describe('station operate shell — SSE lifecycle, keypress wiring, teardown (#168 Wave 2)', () => {
  let server: ReturnType<typeof createServer>;
  let apiBase = '';
  let eventsResponse: import('node:http').ServerResponse | null = null;
  let eventsClosed = false;
  let closeResolvers: Array<() => void> = [];
  let eventsRequestCount = 0;
  const orchestrationCommands: Array<Record<string, unknown>> = [];
  const sessionFetchCounts: Record<string, number> = {};
  const flowRunFetchCounts: Record<string, number> = {};
  const builderRunFetchCounts: Record<string, number> = {};

  const state: {
    sessions: Array<Record<string, unknown>>;
    sessionEvents: Record<string, Array<Record<string, unknown>>>;
    flowRunByThread: Record<string, Record<string, unknown> | undefined>;
    builderRunByThread: Record<string, Record<string, unknown> | undefined>;
  } = {
    sessions: [],
    sessionEvents: {},
    flowRunByThread: {},
    builderRunByThread: {},
  };

  beforeEach(async () => {
    eventsResponse = null;
    eventsClosed = false;
    closeResolvers = [];
    eventsRequestCount = 0;
    orchestrationCommands.length = 0;
    for (const key of Object.keys(sessionFetchCounts))
      delete sessionFetchCounts[key];
    for (const key of Object.keys(flowRunFetchCounts))
      delete flowRunFetchCounts[key];
    for (const key of Object.keys(builderRunFetchCounts))
      delete builderRunFetchCounts[key];
    state.sessions = [
      { threadId: 'thread-a', provider: 'codex', status: 'running' },
    ];
    state.sessionEvents = {};
    state.flowRunByThread = {};
    state.builderRunByThread = {};

    server = createServer(async (req, res) => {
      const method = req.method || 'GET';
      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const body = method === 'POST' ? await readBody(req) : undefined;

      const sendJson = (status: number, payload: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(payload));
      };

      if (method === 'GET' && url.pathname === '/api/orchestration/events') {
        eventsRequestCount += 1;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        // The real route's opening frame (`orchestration.ts:305-309`):
        // `{sessions}`, no `method`/`event` wrapper.
        res.write(`data: ${JSON.stringify({ sessions: state.sessions })}\n\n`);
        eventsResponse = res;
        // Matches the real route: never end this response voluntarily; it
        // only stops via `stream.onAbort()` (a client disconnect).
        req.on('close', () => {
          eventsClosed = true;
          if (eventsResponse === res) {
            eventsResponse = null;
          }
          const resolvers = closeResolvers.splice(0);
          for (const resolveFn of resolvers) resolveFn();
          res.end();
        });
        return;
      }

      const flowRunMatch = url.pathname.match(
        /^\/api\/orchestration\/sessions\/([^/]+)\/flow-run$/,
      );
      if (method === 'GET' && flowRunMatch) {
        const threadId = decodeURIComponent(flowRunMatch[1]);
        flowRunFetchCounts[threadId] = (flowRunFetchCounts[threadId] ?? 0) + 1;
        const run = state.flowRunByThread[threadId];
        if (!run) {
          sendJson(404, { success: false, error: 'Not found' });
          return;
        }
        sendJson(200, { success: true, data: run });
        return;
      }

      const builderRunMatch = url.pathname.match(
        /^\/api\/orchestration\/sessions\/([^/]+)\/builder-run$/,
      );
      if (method === 'GET' && builderRunMatch) {
        const threadId = decodeURIComponent(builderRunMatch[1]);
        builderRunFetchCounts[threadId] =
          (builderRunFetchCounts[threadId] ?? 0) + 1;
        const run = state.builderRunByThread[threadId];
        if (!run) {
          sendJson(404, { success: false, error: 'Not found' });
          return;
        }
        sendJson(200, { success: true, data: run });
        return;
      }

      const sessionMatch = url.pathname.match(
        /^\/api\/orchestration\/sessions\/([^/]+)$/,
      );
      if (method === 'GET' && sessionMatch) {
        const threadId = decodeURIComponent(sessionMatch[1]);
        sessionFetchCounts[threadId] = (sessionFetchCounts[threadId] ?? 0) + 1;
        const session = state.sessions.find(
          (entry) => entry.threadId === threadId,
        );
        if (!session) {
          sendJson(404, { success: false, error: 'Session not found' });
          return;
        }
        sendJson(200, {
          success: true,
          data: { session, events: state.sessionEvents[threadId] ?? [] },
        });
        return;
      }

      if (method === 'POST' && url.pathname === '/api/orchestration/commands') {
        orchestrationCommands.push(body);
        if (body.type === 'respondToRequest') {
          sendJson(200, {
            success: true,
            data: { ok: true },
            receipt: { commandId: `receipt-${body.requestId}` },
          });
          return;
        }
        sendJson(200, { success: true, data: { ok: true } });
        return;
      }

      sendJson(404, { success: false, error: 'Unhandled route' });
    });

    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as AddressInfo;
    apiBase = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    // If any test regresses `shell.ts`'s abort discipline, an open
    // `/api/orchestration/events` connection will keep this `server.close()`
    // pending forever — the deliberate "fails loud, not silent" property
    // AC-lifecycle's evidence requirement calls for.
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  });

  function waitForEventsClose(): Promise<void> {
    if (eventsClosed) return Promise.resolve();
    return new Promise((resolve) => closeResolvers.push(resolve));
  }

  function pushEvent(event: Record<string, unknown>): void {
    eventsResponse?.write(`data: ${JSON.stringify({ event })}\n\n`);
  }

  test('startup seeds the session board from the orchestration:snapshot frame', async () => {
    const stdin = createStdin();
    const stdout = createStdout();

    const shellPromise = runOperateShell({ apiBase, stdin, stdout });

    await waitFor(() =>
      stdout.writes.some((chunk) => chunk.includes('thread-a')),
    );
    expect(
      stdout.writes.some((chunk) => chunk.includes('provider=codex')),
    ).toBe(true);

    pressKey(stdin, 'q');
    await shellPromise;
    await waitForEventsClose();
  }, 5000);

  test('a live request.opened event reaches the approvals pane (toolName + toolInput) and a keypress posts the real respondToRequest body', async () => {
    const stdin = createStdin();
    const stdout = createStdout();

    const shellPromise = runOperateShell({
      apiBase,
      focusedThreadId: 'thread-a',
      stdin,
      stdout,
    });

    await waitFor(() => eventsResponse !== null);

    pushEvent({
      provider: 'codex',
      threadId: 'thread-a',
      eventId: 'evt-req-1',
      createdAt: new Date().toISOString(),
      method: 'request.opened',
      requestId: 'req-1',
      requestType: 'tool-permission',
      title: 'Run shell command',
      payload: { toolName: 'Bash', toolInput: { command: 'rm -rf /tmp/x' } },
    });

    await waitFor(() =>
      stdout.writes.some(
        (chunk) => chunk.includes('Bash') && chunk.includes('rm -rf /tmp/x'),
      ),
    );

    pressKey(stdin, 'a'); // accept the (only, selected-by-default) approval

    await waitFor(() =>
      orchestrationCommands.some(
        (command) => command.type === 'respondToRequest',
      ),
    );
    const respondCommand = orchestrationCommands.find(
      (command) => command.type === 'respondToRequest',
    );
    expect(respondCommand).toEqual(
      expect.objectContaining({
        type: 'respondToRequest',
        threadId: 'thread-a',
        requestId: 'req-1',
        decision: 'accept',
      }),
    );

    pressKey(stdin, 'q');
    await shellPromise;
    await waitForEventsClose();
  }, 5000);

  test('quit keypress (q) aborts the SSE connection and lets the mock server close cleanly', async () => {
    const stdin = createStdin();
    const stdout = createStdout();

    const shellPromise = runOperateShell({ apiBase, stdin, stdout });
    await waitFor(() => eventsResponse !== null);

    pressKey(stdin, 'q');

    await expect(shellPromise).resolves.toBeUndefined();
    await waitForEventsClose();
    expect(eventsClosed).toBe(true);
  }, 5000);

  test('Ctrl+C keypress (raw-mode intercepted) aborts the SSE connection the same way as q', async () => {
    const stdin = createStdin();
    const stdout = createStdout();

    const shellPromise = runOperateShell({ apiBase, stdin, stdout });
    await waitFor(() => eventsResponse !== null);

    pressKey(stdin, String.fromCharCode(3)); // Ctrl+C

    await expect(shellPromise).resolves.toBeUndefined();
    await waitForEventsClose();
    expect(eventsClosed).toBe(true);
  }, 5000);

  test('SIGINT/SIGTERM trigger the same clean teardown and connection close as the quit keypress', async () => {
    const stdin = createStdin();
    const stdout = createStdout();

    const shellPromise = runOperateShell({ apiBase, stdin, stdout });
    await waitFor(() => eventsResponse !== null);

    process.emit('SIGINT');

    await expect(shellPromise).resolves.toBeUndefined();
    await waitForEventsClose();
    expect(eventsClosed).toBe(true);
  }, 5000);

  test('an unrecoverable stream error aborts the connection and rejects the shell promise', async () => {
    const stdin = createStdin();
    const stdout = createStdout();

    const shellPromise = runOperateShell({ apiBase, stdin, stdout });
    await waitFor(() => eventsResponse !== null);

    // A malformed SSE data line makes `consumeSseFrames`'s `JSON.parse`
    // throw a genuine (non-abort) error — the connection is not closed by
    // the server, so the only way it observably closes is the shell's own
    // `abort()` call in its error-handling path.
    eventsResponse?.write('data: {not-json\n\n');

    await expect(shellPromise).rejects.toThrow();
    await waitForEventsClose();
    expect(eventsClosed).toBe(true);
  }, 5000);

  test('terminal state (raw mode + cursor visibility) is restored on both the clean-quit and the error exit path', async () => {
    const cleanStdin = createStdin();
    const cleanStdout = createStdout();
    const cleanShellPromise = runOperateShell({
      apiBase,
      stdin: cleanStdin,
      stdout: cleanStdout,
    });
    await waitFor(() => eventsResponse !== null);
    expect(cleanStdin.setRawMode).toHaveBeenCalledWith(true);

    pressKey(cleanStdin, 'q');
    await cleanShellPromise;
    expect(cleanStdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(
      cleanStdout.writes.some((chunk) => chunk.includes('\x1b[?25h')),
    ).toBe(true);
    await waitForEventsClose();

    // Fresh connection for the error-path half of this test.
    eventsClosed = false;
    closeResolvers = [];
    const errorStdin = createStdin();
    const errorStdout = createStdout();
    const errorShellPromise = runOperateShell({
      apiBase,
      stdin: errorStdin,
      stdout: errorStdout,
    });
    await waitFor(() => eventsResponse !== null);
    expect(errorStdin.setRawMode).toHaveBeenCalledWith(true);

    eventsResponse?.write('data: {not-json\n\n');

    await expect(errorShellPromise).rejects.toThrow();
    expect(errorStdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(
      errorStdout.writes.some((chunk) => chunk.includes('\x1b[?25h')),
    ).toBe(true);
    await waitForEventsClose();
  }, 8000);

  test('a throwing reduce() during a keypress dispatch still tears down (terminal restored, connection aborted) via the L2 dispatch safety net', async () => {
    const stdin = createStdin();
    const stdout = createStdout();

    const shellPromise = runOperateShell({ apiBase, stdin, stdout });
    await waitFor(() => eventsResponse !== null);
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);

    // `reduce()` is mocked (module-level, above) to throw specifically on
    // this keypress's sequence — proving `onKeypress`'s `safeDispatch()`
    // wrapper (not some other unrelated success path) is what routes this
    // to `finishErr()`/`teardown()`.
    pressKey(stdin, REDUCE_THROW_SEQUENCE);

    await expect(shellPromise).rejects.toThrow(/boom: reduce\(\) threw/);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdout.writes.some((chunk) => chunk.includes('\x1b[?25h'))).toBe(
      true,
    );
    await waitForEventsClose();
    expect(eventsClosed).toBe(true);
  }, 5000);

  test('a throwing reduce() during seedFocus history replay tears down (rejects, terminal restored, connection aborted) instead of degrading to a stderr warning (#187 follow-up 2)', async () => {
    // Seed the focused thread's persisted history with the marker event the
    // mocked `reduce()` throws on — the throw happens at replay time inside
    // `seedFocus`, the exact path #187 flags as asymmetric with the L2
    // dispatch safety net. Pre-fix, this throw was swallowed by the fetch's
    // catch as a "could not seed history" stderr warning and the shell kept
    // running (this test would time out waiting for the rejection).
    state.sessionEvents['thread-a'] = [
      {
        threadId: 'thread-a',
        provider: 'codex',
        eventId: REPLAY_THROW_EVENT_ID,
        createdAt: new Date().toISOString(),
        method: 'turn.completed',
      },
    ];

    const stdin = createStdin();
    const stdout = createStdout();
    // No `focusedThreadId`: auto-focus fires only after the snapshot frame
    // arrives, which guarantees the SSE connection is already open when the
    // replay throws — so the observed close below is provably the shell's
    // own teardown `abort()`.
    const shellPromise = runOperateShell({ apiBase, stdin, stdout });
    // Attach the rejection expectation immediately: snapshot → auto-focus →
    // seedFocus → replay-throw → finishErr can all land within a couple of
    // ticks of startup, and a late-attached handler would surface as an
    // unhandled rejection (and `eventsResponse` may already be nulled by
    // the server's close handler before a poll ever observes it non-null).
    const rejection = expect(shellPromise).rejects.toThrow(
      /boom: reduce\(\) threw during seeded-history replay/,
    );

    await rejection;
    expect(stdin.setRawMode).toHaveBeenCalledWith(true);
    expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
    expect(stdout.writes.some((chunk) => chunk.includes('\x1b[?25h'))).toBe(
      true,
    );
    await waitForEventsClose();
    expect(eventsClosed).toBe(true);
  }, 5000);

  test('focus-change (Tab) seeds exactly one getOrchestrationSession + one getSessionFlowRun call for the newly-focused thread, without opening a second SSE connection', async () => {
    state.sessions = [
      { threadId: 'thread-a', provider: 'codex', status: 'running' },
      { threadId: 'thread-b', provider: 'codex', status: 'running' },
    ];

    const stdin = createStdin();
    const stdout = createStdout();
    // No `focusedThreadId` — auto-focus-first-row (`thread-a`) once the
    // snapshot arrives.
    const shellPromise = runOperateShell({ apiBase, stdin, stdout });

    await waitFor(() => (sessionFetchCounts['thread-a'] ?? 0) >= 1);
    await waitFor(() => (flowRunFetchCounts['thread-a'] ?? 0) >= 1);
    expect(sessionFetchCounts['thread-a']).toBe(1);
    expect(flowRunFetchCounts['thread-a']).toBe(1);
    expect(sessionFetchCounts['thread-b']).toBeUndefined();
    expect(eventsRequestCount).toBe(1);

    pressKey(stdin, '\t'); // Tab -> cycle focus forward to thread-b

    await waitFor(() => (sessionFetchCounts['thread-b'] ?? 0) >= 1);
    await waitFor(() => (flowRunFetchCounts['thread-b'] ?? 0) >= 1);
    expect(sessionFetchCounts['thread-b']).toBe(1);
    expect(flowRunFetchCounts['thread-b']).toBe(1);
    // Focus-changes are client-side filtering of the one global stream —
    // never a fresh connection (the plan's N=1-SSE-connections resolution).
    expect(eventsRequestCount).toBe(1);

    pressKey(stdin, 'q');
    await shellPromise;
    await waitForEventsClose();
  }, 5000);

  /**
   * station#189 S4. The pull is separate from the Flow-run pull and must
   * survive that one 404-ing: after station-delivery's retirement, "a Builder
   * run and no delivery run" is the ordinary case, and a pane that only
   * fetched the Builder run when a delivery run existed would show nothing
   * at all for it.
   */
  test('seeding a focus pulls the Builder run independently of the Flow run and renders it as its own row', async () => {
    state.builderRunByThread['thread-a'] = {
      identityStatus: 'present',
      matchKind: 'correlation-matched',
      taskSlug: 'kontourai-station-1388',
      runRef: '.kontourai/flow/runs/kontourai-station-1388',
      flowRun: {
        run_id: 'kontourai-station-1388',
        definition_id: 'builder.build',
        definition_version: '1.3',
        status: 'active',
        current_step: 'verify',
        run_ref: '.kontourai/flow/runs/kontourai-station-1388',
        open_gate_ids: ['verify-gate'],
      },
    };
    // Deliberately no `flowRunByThread` entry: /flow-run 404s.

    const stdin = createStdin();
    const stdout = createStdout();
    const shellPromise = runOperateShell({ apiBase, stdin, stdout });

    await waitFor(() => (builderRunFetchCounts['thread-a'] ?? 0) >= 1);
    await waitFor(() =>
      stdout.writes.join('').includes('builder run: kontourai-station-1388'),
    );

    const painted = stdout.writes.join('');
    expect(painted).toContain('not Flow-bound');
    expect(painted).toContain('match=correlation-matched');
    expect(painted).toContain('builder.build  step=verify  status=active');

    pressKey(stdin, 'q');
    await shellPromise;
    await waitForEventsClose();
  }, 5000);
});
