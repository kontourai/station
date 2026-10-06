/**
 * The Browser pane's page tools through the REAL routes (#90): a dialog the
 * page opens while a person is in control is held and answered by that
 * person; the page's console is readable, bounded, by anyone who may watch;
 * a screenshot comes back as image bytes.
 *
 * Composition: the real session registry, live-surface registry, surface
 * binder, live-surface routes (a person's input claims control through the
 * same route the canvas uses) and browser routes, over a fake browser host
 * whose CDP events each test emits in the shapes Chromium sends.
 */
import { describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../__test-utils__/temp-dirs.js';
import { isAgentOriginatedRequest } from '../../runtime/mcp/station-control-caller.js';
import type { BrowserProjectAuthorizer } from '../../services/browser/browser-access.js';
import { BROWSER_CONSOLE_LIMIT } from '../../services/browser/browser-console-log.js';
import {
  type BrowserHost,
  type CdpTransport,
  createLocalBrowserHostResolver,
} from '../../services/browser/browser-host.js';
import { BrowserLiveSurfaces } from '../../services/browser/browser-live-surfaces.js';
import { BrowserSessionRegistry } from '../../services/browser/browser-session-registry.js';
import { CdpProtocolError } from '../../services/browser/cdp-pipe-transport.js';
import { LiveSurfaceRegistry } from '../../services/live-surface/registry.js';
import {
  STATION_CONTROL_ORIGIN_AGENT_TOOL,
  STATION_CONTROL_ORIGIN_HEADER,
} from '../../tools/station-control-shared.js';
import { createBrowserRoutes } from '../browser.js';
import { createLiveSurfaceRoutes } from '../live-surface.js';

const PAGE = 'S1';
/** A 1×1 PNG, as `Page.captureScreenshot` returns it (base64). */
const PNG_1X1 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function fakeHost() {
  const listeners = new Map<string, Set<(p: unknown, s?: string) => void>>();
  const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const handlers = new Map<
    string,
    (params: Record<string, unknown>) => unknown
  >();
  const cdp: CdpTransport = {
    async send<R>(method: string, params?: object) {
      const p = (params ?? {}) as Record<string, unknown>;
      sent.push({ method, params: p });
      const handler = handlers.get(method);
      return (handler ? await handler(p) : {}) as R;
    },
    on(event, fn) {
      const set = listeners.get(event) ?? new Set();
      set.add(fn);
      listeners.set(event, set);
      return () => set.delete(fn);
    },
    close: async () => {},
    closed: new Promise(() => {}),
  };
  const host: BrowserHost = {
    kind: 'server-chromium',
    shutdown: async () => {},
    openTarget: async () => ({ targetId: 'T1', cdpSessionId: PAGE }),
    cdp: () => cdp,
    closeTarget: async () => {},
    onExit: () => () => {},
  };
  return {
    host,
    sent,
    handle(
      method: string,
      handler: (params: Record<string, unknown>) => unknown,
    ) {
      handlers.set(method, handler);
    },
    emit(event: string, params: unknown, sessionId = PAGE) {
      for (const fn of listeners.get(event) ?? []) fn(params, sessionId);
    },
    dialogAnswers: () =>
      sent.filter((s) => s.method === 'Page.handleJavaScriptDialog'),
  };
}

const makeTempDir = trackTempDirs();

type Role = 'operator' | 'nobody';
const roleOf = (request: Request) =>
  (request.headers.get('x-test-role') ?? 'nobody') as Role;

function harness(
  options: {
    screenshotMaxBytes?: number;
    screenshotDeadlineMs?: number;
    dispatchTimeoutMs?: number;
    /** The Project's `browserEvaluate` (D4); absent: no settings store. */
    browserEvaluate?: boolean;
    /** The live-surface lease's clock and holds (test seam). */
    lease?: { now: () => number; humanHoldMs?: number };
  } = {},
) {
  const stationHome = makeTempDir('station-browser-page-');
  const fake = fakeHost();
  let ids = 0;
  const sessions = new BrowserSessionRegistry({
    stationHome,
    hostResolver: createLocalBrowserHostResolver(() => fake.host),
    newId: () =>
      `bs_00000000-0000-4000-8000-${String(++ids).padStart(12, '0')}`,
    ...(options.screenshotMaxBytes !== undefined
      ? { screenshotMaxBytes: options.screenshotMaxBytes }
      : {}),
    ...(options.screenshotDeadlineMs !== undefined
      ? { screenshotDeadlineMs: options.screenshotDeadlineMs }
      : {}),
  });
  const authorizeProject: BrowserProjectAuthorizer = async (request) =>
    roleOf(request) === 'operator' ? { kind: 'operator' } : undefined;
  const surfaces = new LiveSurfaceRegistry(
    options.lease ? { lease: options.lease } : {},
  );
  const binder = new BrowserLiveSurfaces({
    sessions,
    surfaces,
    authorizeProject,
    ...(options.dispatchTimeoutMs !== undefined
      ? { dispatchTimeoutMs: options.dispatchTimeoutMs }
      : {}),
  });
  const surfaceRoutes = createLiveSurfaceRoutes(surfaces, {
    isRequestPrincipalCurrent: () => true,
    resolveHumanCaller: (c) =>
      roleOf(c.req.raw) === 'operator'
        ? { principal: 'human:local:operator', device: 'device:laptop' }
        : null,
  });
  const browserRoutes = createBrowserRoutes({
    registry: sessions,
    acquisition: {
      status: () => ({
        state: 'found-system',
        executablePath: '/fake/chrome',
        browser: 'google-chrome',
      }),
      startDownload: vi.fn(),
    } as never,
    localTargets: { list: () => [], add: vi.fn(), remove: vi.fn() } as never,
    surfaceIdFor: (id) => binder.surfaceIdFor(id),
    pendingDialogFor: (id) => binder.pendingDialogFor(id),
    answerDialog: (id, dialogId, answer, actor) =>
      binder.answerDialog(id, dialogId, answer, actor),
    consoleFor: (id, after) => binder.consoleFor(id, after),
    ...(options.browserEvaluate !== undefined
      ? {
          projectSettings: {
            get: () => ({ browserEvaluate: options.browserEvaluate === true }),
            setBrowserEvaluate: vi.fn(),
          } as never,
        }
      : {}),
    // The production predicate's agent-tool arm (the rest needs a runtime).
    isAgentRequest: isAgentOriginatedRequest,
    isStationInternalRequest: () => false,
    listeners: () => ({ ports: [], hostnames: [] }),
    suggestLocalTargets: async () => ({ state: 'ok', suggestions: [] }),
    authorizeProject,
    authorizeOperator: async (request) => roleOf(request) === 'operator',
    resolveProject: (slug) =>
      slug === 'alpha' ? { id: 'alpha', slug: 'alpha' } : undefined,
    isRequestPrincipalCurrent: () => true,
  });
  const browser = (
    method: string,
    path: string,
    options: { role?: Role; body?: unknown; agent?: boolean } = {},
  ): Promise<Omit<Response, 'json'> & { json(): Promise<any> }> =>
    Promise.resolve(
      browserRoutes.request(`http://station.test${path}`, {
        method,
        headers: {
          'x-test-role': options.role ?? 'operator',
          'content-type': 'application/json',
          ...(options.agent
            ? {
                [STATION_CONTROL_ORIGIN_HEADER]:
                  STATION_CONTROL_ORIGIN_AGENT_TOOL,
              }
            : {}),
        },
        ...(options.body === undefined
          ? {}
          : { body: JSON.stringify(options.body) }),
      }),
    ) as Promise<Omit<Response, 'json'> & { json(): Promise<any> }>;
  /** A person's click through the live-surface input route; its response. */
  const clickResponse = (browserSessionId: string) => {
    const surfaceId = binder.surfaceIdFor(browserSessionId)!;
    return surfaceRoutes.request(`http://station.test/${surfaceId}/input`, {
      method: 'POST',
      headers: {
        'x-test-role': 'operator',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        epoch: surfaces.get(surfaceId)!.lease.snapshot().epoch,
        events: [
          { kind: 'pointer', type: 'down', x: 5, y: 5, button: 'left' },
          { kind: 'pointer', type: 'up', x: 5, y: 5, button: 'left' },
        ],
      }),
    });
  };
  /** A person's click through the live-surface input route (claims control). */
  const personClicks = async (browserSessionId: string) => {
    const surfaceId = binder.surfaceIdFor(browserSessionId)!;
    const response = await surfaceRoutes.request(
      `http://station.test/${surfaceId}/input`,
      {
        method: 'POST',
        headers: {
          'x-test-role': 'operator',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          epoch: surfaces.get(surfaceId)!.lease.snapshot().epoch,
          events: [
            { kind: 'pointer', type: 'down', x: 5, y: 5, button: 'left' },
            { kind: 'pointer', type: 'up', x: 5, y: 5, button: 'left' },
          ],
        }),
      },
    );
    expect(response.status).toBe(200);
  };
  const open = () =>
    sessions.createSession({
      projectId: 'alpha',
      projectSlug: 'alpha',
      url: 'https://example.com/',
      actor: { kind: 'operator' },
    });
  return {
    fake,
    sessions,
    surfaces,
    binder,
    browser,
    personClicks,
    clickResponse,
    surfaceRoutes,
    open,
  };
}

describe('Browser pane: page dialogs a person answers', () => {
  test('a confirm the page opens while a person is in control is shown to them, not answered, and their answer reaches the page', async () => {
    const h = harness();
    const session = await h.open();
    const id = session.browserSessionId;
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      url: 'https://example.com/',
      message: 'Discard your changes?',
      type: 'confirm',
      hasBrowserHandler: false,
      defaultPrompt: '',
    });
    expect(h.fake.dialogAnswers()).toEqual([]);

    const view = await (
      await h.browser('GET', `/sessions/${id}?view=summary`)
    ).json();
    expect(view.data.pendingDialog).toMatchObject({
      dialogId: 'd1',
      type: 'confirm',
      message: 'Discard your changes?',
    });
    expect(Date.parse(view.data.pendingDialog.openedAt)).not.toBeNaN();

    const answered = await h.browser('POST', `/sessions/${id}/dialog`, {
      body: { dialogId: 'd1', accept: true },
    });
    expect(answered.status).toBe(200);
    expect((await answered.json()).data.pendingDialog).toBeUndefined();
    expect(h.fake.dialogAnswers()).toEqual([
      { method: 'Page.handleJavaScriptDialog', params: { accept: true } },
    ]);
    const last = h.sessions.getSession(id)!.history.entries.at(-1);
    expect(last).toMatchObject({
      kind: 'dialog-answered',
      actor: { kind: 'operator' },
      detail: 'confirm accepted: Discard your changes?',
    });
  });

  test("a prompt's typed answer is sent to the page but never written to the history", async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      url: 'https://example.com/',
      message: 'Project name?',
      type: 'prompt',
      hasBrowserHandler: false,
      defaultPrompt: 'untitled',
    });
    const response = await h.browser('POST', `/sessions/${id}/dialog`, {
      body: { dialogId: 'd1', accept: true, promptText: 'secret-launch' },
    });
    expect(response.status).toBe(200);
    expect(h.fake.dialogAnswers().at(-1)?.params).toEqual({
      accept: true,
      promptText: 'secret-launch',
    });
    expect(JSON.stringify(h.sessions.getSession(id)!.history)).not.toContain(
      'secret-launch',
    );
  });

  test('while the held dialog waits, a click on the page is refused page-dialog-open, not a generic failure', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'Sure?',
    });
    const response = await h.clickResponse(id);
    expect(response.status).toBe(409);
    expect(
      ((await response.json()) as { data: { code: string } }).data.code,
    ).toBe('page-dialog-open');
  });

  test('an agent-originated request may not answer a dialog shown to a person', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'hi',
    });
    const response = await h.browser('POST', `/sessions/${id}/dialog`, {
      body: { dialogId: 'd1', accept: true },
      agent: true,
    });
    expect(response.status).toBe(403);
    expect(h.fake.dialogAnswers()).toEqual([]);
    expect(h.binder.pendingDialogFor(id)).toMatchObject({ dialogId: 'd1' });
  });

  test('an answer for a dialog that is no longer held is refused (409), and malformed answers are 400', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    expect(
      (
        await h.browser('POST', `/sessions/${id}/dialog`, {
          body: { dialogId: 'd1', accept: true },
        })
      ).status,
    ).toBe(409);
    for (const body of [
      { dialogId: 'x1', accept: true },
      { dialogId: 'd1', accept: 'yes' },
      { dialogId: 'd1', accept: true, promptText: 'p'.repeat(4097) },
      { dialogId: 'd1', accept: true, extra: 1 },
    ])
      expect(
        (await h.browser('POST', `/sessions/${id}/dialog`, { body })).status,
      ).toBe(400);
    expect(
      (
        await h.browser('POST', `/sessions/${id}/dialog`, {
          body: { dialogId: 'd1', accept: true },
          role: 'nobody',
        })
      ).status,
    ).toBe(403);
  });

  test('with nobody in control the dialog is answered automatically, as before, and nothing is pending', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'saved',
    });
    expect(h.fake.dialogAnswers()).toEqual([
      { method: 'Page.handleJavaScriptDialog', params: { accept: false } },
    ]);
    const view = await (await h.browser('GET', `/sessions/${id}`)).json();
    expect(view.data.pendingDialog).toBeUndefined();
  });
});

describe('Browser pane: the page console', () => {
  const consoleCall = (
    type: string,
    text: string,
    url = 'https://example.com/app.js',
  ) => ({
    type,
    args: [{ type: 'string', value: text }],
    executionContextId: 1,
    timestamp: 1_700_000_000_000,
    stackTrace: {
      callFrames: [
        {
          functionName: '',
          scriptId: '5',
          url,
          lineNumber: 9,
          columnNumber: 2,
        },
      ],
    },
  });

  test('console calls, uncaught exceptions and browser log entries are captured with their levels and locations', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    // Capture turned itself on when the session went live.
    expect(h.fake.sent.map((s) => s.method)).toEqual(
      expect.arrayContaining(['Runtime.enable', 'Log.enable']),
    );
    h.fake.emit('Runtime.consoleAPICalled', consoleCall('log', 'booted'));
    h.fake.emit('Runtime.consoleAPICalled', {
      type: 'warning',
      args: [
        { type: 'string', value: 'slow' },
        { type: 'number', value: 42, description: '42' },
        { type: 'object', subtype: 'array', description: 'Array(2)' },
      ],
      executionContextId: 1,
      timestamp: 1,
    });
    h.fake.emit('Runtime.exceptionThrown', {
      timestamp: 1,
      exceptionDetails: {
        exceptionId: 1,
        text: 'Uncaught',
        lineNumber: 4,
        columnNumber: 7,
        url: 'https://example.com/boom.js',
        exception: {
          type: 'object',
          subtype: 'error',
          className: 'TypeError',
          description:
            "TypeError: Cannot read properties of undefined (reading 'x')\n    at boom.js:5:8",
        },
      },
    });
    h.fake.emit('Log.entryAdded', {
      entry: {
        source: 'network',
        level: 'error',
        text: 'Failed to load resource: the server responded with a status of 404 ()',
        timestamp: 1,
        url: 'https://example.com/missing.png',
      },
    });
    // Another page's console is not this session's.
    h.fake.emit(
      'Runtime.consoleAPICalled',
      consoleCall('log', 'elsewhere'),
      'S9',
    );

    const response = await h.browser('GET', `/sessions/${id}/console`);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data).toMatchObject({ capturing: true, dropped: 0, latestSeq: 4 });
    expect(
      data.entries.map(
        (e: {
          level: string;
          source: string;
          text: string;
          url?: string;
          line?: number;
        }) => [e.level, e.source, e.text.split('\n')[0], e.url, e.line],
      ),
    ).toEqual([
      ['info', 'console', 'booted', 'https://example.com/app.js', 10],
      ['warning', 'console', 'slow 42 Array(2)', undefined, undefined],
      [
        'error',
        'exception',
        "TypeError: Cannot read properties of undefined (reading 'x')",
        'https://example.com/boom.js',
        5,
      ],
      [
        'error',
        'browser',
        'Failed to load resource: the server responded with a status of 404 ()',
        'https://example.com/missing.png',
        undefined,
      ],
    ]);
    const newer = await (
      await h.browser('GET', `/sessions/${id}/console?after=3`)
    ).json();
    expect(newer.data.entries.map((e: { seq: number }) => e.seq)).toEqual([4]);
  });

  test('past the bound the OLDEST entries are dropped and counted, never the newest', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    const over = 7;
    for (let i = 1; i <= BROWSER_CONSOLE_LIMIT + over; i += 1)
      h.fake.emit('Runtime.consoleAPICalled', consoleCall('log', `line ${i}`));
    const { data } = await (
      await h.browser('GET', `/sessions/${id}/console`)
    ).json();
    expect(BROWSER_CONSOLE_LIMIT).toBe(500);
    expect(data.entries).toHaveLength(BROWSER_CONSOLE_LIMIT);
    expect(data.dropped).toBe(over);
    expect(data.entries[0].text).toBe(`line ${over + 1}`);
    expect(data.entries.at(-1).text).toBe(
      `line ${BROWSER_CONSOLE_LIMIT + over}`,
    );
  });

  test('reading the console needs standing to watch the session; a bad cursor is 400', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    expect(
      (await h.browser('GET', `/sessions/${id}/console`, { role: 'nobody' }))
        .status,
    ).toBe(403);
    expect(
      (await h.browser('GET', `/sessions/${id}/console?after=-1`)).status,
    ).toBe(400);
  });
});

describe('Browser pane: screenshots', () => {
  test("a screenshot is the page's PNG bytes, for anyone who may watch", async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    h.fake.handle('Page.captureScreenshot', () => ({ data: PNG_1X1 }));
    const response = await h.browser('GET', `/sessions/${id}/screenshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect(Buffer.from(bytes).toString('base64')).toBe(PNG_1X1);
    expect(
      h.fake.sent.find((s) => s.method === 'Page.captureScreenshot')?.params,
    ).toEqual({ format: 'png' });
    expect(
      (await h.browser('GET', `/sessions/${id}/screenshot`, { role: 'nobody' }))
        .status,
    ).toBe(403);
  });

  test('a closed session has no screenshot (409)', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    await h.sessions.closeSession(id, { kind: 'operator' });
    expect((await h.browser('GET', `/sessions/${id}/screenshot`)).status).toBe(
      409,
    );
  });
});

describe('Browser pane: review-round bounds', () => {
  const pngOf = (bytes: number) => Buffer.alloc(bytes, 1).toString('base64');

  test('two screenshot requests at once share one capture of the page', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.fake.handle('Page.captureScreenshot', async () => {
      await gate;
      return { data: PNG_1X1 };
    });
    const first = h.browser('GET', `/sessions/${id}/screenshot`);
    const second = h.browser('GET', `/sessions/${id}/screenshot`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    const [a, b] = await Promise.all([first, second]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(
      h.fake.sent.filter((call) => call.method === 'Page.captureScreenshot'),
    ).toHaveLength(1);
    // Once it settles, the next request captures afresh.
    await h.browser('GET', `/sessions/${id}/screenshot`);
    expect(
      h.fake.sent.filter((call) => call.method === 'Page.captureScreenshot'),
    ).toHaveLength(2);
  });

  test('a PNG over the byte bound is retaken as JPEG', async () => {
    const h = harness({ screenshotMaxBytes: 10 });
    const { browserSessionId: id } = await h.open();
    h.fake.handle('Page.captureScreenshot', (params) => ({
      data: pngOf(params.format === 'png' ? 11 : 10),
    }));
    const response = await h.browser('GET', `/sessions/${id}/screenshot`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/jpeg');
    expect(
      h.fake.sent
        .filter((call) => call.method === 'Page.captureScreenshot')
        .map((call) => call.params?.format),
    ).toEqual(['png', 'jpeg']);
  });

  test('a screenshot over the bound as JPEG too is refused 413, never cut', async () => {
    const h = harness({ screenshotMaxBytes: 10 });
    const { browserSessionId: id } = await h.open();
    h.fake.handle('Page.captureScreenshot', () => ({ data: pngOf(11) }));
    const response = await h.browser('GET', `/sessions/${id}/screenshot`);
    expect(response.status).toBe(413);
    expect((await response.json()).code).toBe('screenshot-too-large');
  });

  test('a page that does not answer the capture is 504 page-busy', async () => {
    const h = harness({ screenshotDeadlineMs: 30 });
    const { browserSessionId: id } = await h.open();
    h.fake.handle('Page.captureScreenshot', () => new Promise(() => {}));
    const response = await h.browser('GET', `/sessions/${id}/screenshot`);
    expect(response.status).toBe(504);
    expect((await response.json()).code).toBe('page-busy');
  });

  test("a request that may be an agent's reads the console only where the Project lets agents read page output", async () => {
    const off = harness({ browserEvaluate: false });
    const a = await off.open();
    const refused = await off.browser(
      'GET',
      `/sessions/${a.browserSessionId}/console`,
      {
        agent: true,
      },
    );
    expect(refused.status).toBe(403);
    // A person's request is unaffected.
    expect(
      (await off.browser('GET', `/sessions/${a.browserSessionId}/console`))
        .status,
    ).toBe(200);
    const on = harness({ browserEvaluate: true });
    const b = await on.open();
    expect(
      (
        await on.browser('GET', `/sessions/${b.browserSessionId}/console`, {
          agent: true,
        })
      ).status,
    ).toBe(200);
  });

  test('the console names the browser generation its entries came from', async () => {
    const h = harness();
    const { browserSessionId: id, generation } = await h.open();
    const { data } = await (
      await h.browser('GET', `/sessions/${id}/console`)
    ).json();
    expect(data.generation).toBe(generation);
  });

  test('an answer the browser refuses (the page navigated away) is 409 no-dialog, not a server error', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'x',
    });
    h.fake.handle('Page.handleJavaScriptDialog', () => {
      throw new CdpProtocolError(
        'Page.handleJavaScriptDialog',
        -32602,
        'No dialog is showing',
      );
    });
    const response = await h.browser('POST', `/sessions/${id}/dialog`, {
      body: { dialogId: 'd1', accept: true },
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('no-dialog');
  });

  test('an answer whose channel fails is 502, and the dialog stays answerable', async () => {
    const h = harness();
    const { browserSessionId: id } = await h.open();
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'x',
    });
    h.fake.handle('Page.handleJavaScriptDialog', () => {
      throw new Error('CDP transport closed');
    });
    const response = await h.browser('POST', `/sessions/${id}/dialog`, {
      body: { dialogId: 'd1', accept: true },
    });
    expect(response.status).toBe(502);
    expect(h.binder.pendingDialogFor(id)).toMatchObject({ dialogId: 'd1' });
  });

  test("when the person's control ends while their answer is in flight and the answer then fails, the dialog is dismissed, not restored", async () => {
    const h = harness({ dispatchTimeoutMs: 30 });
    const { browserSessionId: id } = await h.open();
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'confirm',
      message: 'x',
    });
    const surfaceId = h.binder.surfaceIdFor(id)!;
    let answers = 0;
    h.fake.handle('Page.handleJavaScriptDialog', () => {
      answers += 1;
      // The person's answer hangs; the automatic dismissal that follows lands.
      return answers === 1 ? new Promise(() => {}) : {};
    });
    const answer = h.browser('POST', `/sessions/${id}/dialog`, {
      body: { dialogId: 'd1', accept: true },
    });
    // Mid-flight, the person lets go (the same happens on a lapse).
    const released = await h.surfaceRoutes.request(
      `http://station.test/${surfaceId}/lease`,
      {
        method: 'POST',
        headers: {
          'x-test-role': 'operator',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'release',
          epoch: h.surfaces.get(surfaceId)!.lease.snapshot().epoch,
        }),
      },
    );
    expect(released.status).toBe(200);
    expect((await answer).status).toBe(504);
    // Not held for anyone: an agent would not be refused dialog-open.
    expect(h.binder.pendingDialogFor(id)).toBeUndefined();
    expect(
      h.fake.sent
        .filter((call) => call.method === 'Page.handleJavaScriptDialog')
        .map((call) => call.params),
    ).toEqual([{ accept: true }, { accept: false }]);
    expect(h.sessions.getSession(id)!.activity.lastDialog).toMatchObject({
      type: 'confirm',
      controlEnded: true,
    });
  });

  test('an answer the browser never acknowledges is 504 page-busy, and the dialog stays answerable', async () => {
    const h = harness({ dispatchTimeoutMs: 30 });
    const { browserSessionId: id } = await h.open();
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'x',
    });
    h.fake.handle('Page.handleJavaScriptDialog', () => new Promise(() => {}));
    const response = await h.browser('POST', `/sessions/${id}/dialog`, {
      body: { dialogId: 'd1', accept: true },
    });
    expect(response.status).toBe(504);
    expect(h.binder.pendingDialogFor(id)).toMatchObject({ dialogId: 'd1' });
  });
});

describe('Browser pane: the renewal cap end to end', () => {
  test('a page looping alert() cannot hold control past the cap: keep-alives are refused, control lapses, the held dialog is dismissed, and the next dialog is not held', async () => {
    const clock = { t: 1_000_000 };
    const h = harness({ lease: { now: () => clock.t, humanHoldMs: 1_000 } });
    const { browserSessionId: id } = await h.open();
    await h.personClicks(id);
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'again',
    });
    expect(h.binder.pendingDialogFor(id)).toBeDefined();
    const surfaceId = h.binder.surfaceIdFor(id)!;
    const keepAlive = () =>
      h.surfaceRoutes.request(`http://station.test/${surfaceId}/lease`, {
        method: 'POST',
        headers: {
          'x-test-role': 'operator',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          action: 'keep-alive',
          epoch: h.surfaces.get(surfaceId)!.lease.snapshot().epoch,
        }),
      });
    // The card renews every so often; the cap is 4 × the 1 s hold.
    for (const step of [900, 900, 900, 900]) {
      clock.t += step;
      expect((await keepAlive()).status).toBe(200);
    }
    clock.t += 500;
    // Past the cap the hold has lapsed: nothing is left to keep alive.
    const refused = await keepAlive();
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { data: { ok: boolean } }).data.ok).toBe(
      false,
    );
    expect(h.surfaces.get(surfaceId)!.lease.snapshot().holder).toBeNull();
    expect(h.binder.pendingDialogFor(id)).toBeUndefined();
    // With nobody in control, the page's next alert is answered at once.
    h.fake.emit('Page.javascriptDialogOpening', {
      type: 'alert',
      message: 'again',
    });
    expect(h.binder.pendingDialogFor(id)).toBeUndefined();
  });
});
