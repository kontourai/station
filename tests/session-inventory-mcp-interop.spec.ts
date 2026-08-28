import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  SESSION_INVENTORY_GROUP_IDS,
  type SessionInventoryGroupPage,
  type SessionInventoryProjection,
} from '@kontourai/station-contracts/session-inventory';
import { createStationAnswerBinding } from '@kontourai/station-contracts/task-basis';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { composeBasisProjection } from '@kontourai/surface/basis';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { Hono } from 'hono';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../src-server/routes/mcp/station-control-mcp-route.js';
import { createOrchestrationRoutes } from '../src-server/routes/orchestration/orchestration.js';
import { createTaskRoutes } from '../src-server/routes/orchestration/tasks.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../src-server/runtime/mcp/station-control-mcp-token.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../src-server/security/runtime-request-security.js';
import { createSessionInventoryAppReadModule } from '../src-server/services/orchestration/session-inventory-app-read-module.js';
import { INTERNAL_CONTROL_CALLER_BINDING_HEADER } from '../src-server/tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  isTrustedInternalApiToken,
} from '../src-server/utils/internal-api-token.js';
import { expectNoBlockingAccessibilityViolations } from './helpers/accessibility';
import { preserveBasisInteropEnvironment } from './helpers/basis-interop-fixture';

const HOST = 'http://session-inventory-basic-host.test';
const APP_URI = 'ui://station/basis/session-inventory/v1';
const SCOPE = {
  kind: 'current-answer' as const,
  sessionId: 'fixture-session',
  turnId: 'fixture-turn',
};
const hostile =
  'https://host.invalid/<img src=x>\u202e<script>alert(1)</script>';

declare global {
  interface Window {
    __setSessionInventoryTheme(theme: 'light' | 'dark'): void;
  }
}

function dependencyVersion(name: string): string {
  return (
    JSON.parse(
      readFileSync(
        new URL(`../node_modules/${name}/package.json`, import.meta.url),
        'utf8',
      ),
    ) as { version: string }
  ).version;
}

function input(key: string, inputKind: 'message' | 'steer' = 'message') {
  return {
    kind: 'thread-authored-input' as const,
    key,
    owner: { owner: 'thread', id: 'fixture-input/v1' },
    relations: ['contributed-to'] as const,
    sessionId: SCOPE.sessionId,
    eventId: `event-${key}`,
    turnId: SCOPE.turnId,
    inputKind,
    attachmentDescriptors: [
      {
        kind: 'attachment' as const,
        name: hostile,
        mediaType: 'text/html;\u202eimage/svg+xml',
        length: 1,
      },
    ],
  };
}

const initialInput = input('fixture-input-0');
const appendedInput = input('fixture-input-1', 'steer');

function projection(): SessionInventoryProjection {
  const binding = createStationAnswerBinding({
    sessionId: SCOPE.sessionId,
    turnId: SCOPE.turnId,
    messageId: 'fixture-answer',
  });
  const basis = composeBasisProjection({
    version: 'surface.basis-projection/v1',
    answer: {
      owner: { authority: '@kontourai/thread' },
      state: 'available',
      observedAt: '2026-08-28T00:00:00.000Z',
      value: {
        ref: binding.answer,
        fact: 'answer-observed',
        observedAt: '2026-08-28T00:00:00.000Z',
      },
    },
    assessment: {
      owner: { authority: '@kontourai/surface' },
      state: 'not-captured',
      observedAt: '2026-08-28T00:00:00.000Z',
    },
    contributions: [],
  });
  return {
    version: 'station.session-inventory/v1',
    scope: SCOPE,
    basis,
    basisBinding: binding,
    groups: SESSION_INVENTORY_GROUP_IDS.map((id) =>
      id === 'inputs'
        ? {
            id,
            owner: { owner: 'thread', id: 'fixture-input/v1' },
            state: 'available' as const,
            count: { kind: 'at-least' as const, value: 3 },
            continuation: 'first-owner-cursor',
            items: [initialInput],
            gaps: [{ kind: 'unavailable' as const }],
          }
        : {
            id,
            owner: { owner: 'station.inventory', id: 'fixture/v1' },
            state: 'empty' as const,
            count: { kind: 'exact' as const, value: 0 },
            items: [],
            gaps: [],
          },
    ),
  } as SessionInventoryProjection;
}

function page(
  mode: 'append' | 'terminal' | 'conflict',
): SessionInventoryGroupPage {
  const current = projection();
  const group =
    mode === 'append'
      ? {
          id: 'inputs' as const,
          owner: { owner: 'thread', id: 'fixture-input/v1' },
          state: 'available' as const,
          count: { kind: 'at-least' as const, value: 3 },
          continuation: 'second-owner-cursor',
          // Repeating an identical row is legal. The portable app must not
          // duplicate it while appending the distinct row.
          items: [initialInput, appendedInput],
          gaps: [],
        }
      : mode === 'terminal'
        ? {
            id: 'inputs' as const,
            owner: { owner: 'thread', id: 'fixture-input/v1' },
            state: 'available' as const,
            count: { kind: 'exact' as const, value: 2 },
            items: [appendedInput],
            gaps: [],
          }
        : {
            id: 'inputs' as const,
            owner: { owner: 'thread', id: 'fixture-input/v1' },
            state: 'available' as const,
            count: { kind: 'exact' as const, value: 2 },
            // Same key but a changed row: merge must fail closed.
            items: [input('fixture-input-0', 'steer')],
            gaps: [],
          };
  return {
    version: 'station.session-inventory/v1',
    scope: SCOPE,
    group,
    basis: current.basis,
    basisBinding: current.basisBinding,
  } as SessionInventoryGroupPage;
}

const KEPT_SCOPE = {
  kind: 'kept-in-task' as const,
  sessionId: 'fixture-session',
  taskId: 'fixture-task',
};

function keptProjection(): SessionInventoryProjection {
  return {
    version: 'station.session-inventory/v1',
    scope: KEPT_SCOPE,
    groups: SESSION_INVENTORY_GROUP_IDS.map((id) =>
      id === 'kept'
        ? {
            id,
            owner: { owner: 'station.task-graph', id: 'fixture/v1' },
            state: 'available' as const,
            count: { kind: 'exact' as const, value: 1 },
            items: [
              {
                kind: 'task-kept-result' as const,
                key: 'kept:fixture-result',
                owner: { owner: 'station.task-graph', id: 'fixture/v1' },
                relations: ['kept-in-task'] as const,
                taskId: KEPT_SCOPE.taskId,
                provenanceSessionId: KEPT_SCOPE.sessionId,
                referenceId: 'fixture-result',
              },
            ],
            gaps: [],
          }
        : {
            id,
            owner: { owner: 'station.inventory', id: 'fixture/v1' },
            state: 'empty' as const,
            count: { kind: 'exact' as const, value: 0 },
            items: [],
            gaps: [],
          },
    ),
  } as SessionInventoryProjection;
}

const hostSource = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const iframe = document.querySelector('iframe');
let expected = null;
const capture = (result) => {
  const meta = result?._meta?.['station.session-inventory-app/v1'];
  if (!meta || typeof meta.occurrenceId !== 'string' || !Array.isArray(meta.continuations)) { expected = null; return; }
  expected = meta;
};
const call = async (args) => {
  const response = await fetch('/call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  if (!response.ok) throw new Error('Session inventory unavailable');
  return response.json();
};
const themes = {
  dark: {'--color-background-primary':'#101820','--color-text-primary':'#eff5f0'},
  light: {'--color-background-primary':'#fffcf1','--color-text-primary':'#17201b'},
};
const bridge = new AppBridge(null, {name:'Official Session inventory host fixture',version:'1'}, {serverTools:{}}, {hostContext:{theme:'dark',styles:{variables:themes.dark}}});
window.__setSessionInventoryTheme = (theme) => bridge.setHostContext({theme,styles:{variables:themes[theme]}});
bridge.oninitialized = async () => {
  const args = {operation:'open',scope:{kind:'current-answer',sessionId:'fixture-session',turnId:'fixture-turn'}};
  const result = await call(args);
  capture(result);
  await bridge.sendToolInput({arguments:args});
  await bridge.sendToolResult(result);
};
bridge.oncalltool = async ({name,arguments:args}) => {
  const continuation = expected?.continuations?.find((entry) => entry?.groupId === 'inputs');
  if (name !== 'get_session_inventory' || !continuation || !args ||
      Object.keys(args).length !== 5 || args.operation !== 'page' ||
      JSON.stringify(args.scope) !== JSON.stringify({kind:'current-answer',sessionId:'fixture-session',turnId:'fixture-turn'}) ||
      args.occurrenceId !== expected.occurrenceId || args.groupId !== 'inputs' ||
      args.continuationToken !== continuation.continuationToken)
    throw new Error('Page escaped captured Session inventory capability');
  const result = await call(args);
  capture(result);
  return result;
};
bridge.onreadresource = () => { throw new Error('No protected resource reads'); };
void bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
void fetch('/resource').then(r=>r.text()).then(html=>{iframe.srcdoc=html;});
`;

const keptHostSource = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const iframe = document.querySelector('iframe');
const call = async (args) => {
  const response = await fetch('/call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  if (!response.ok) throw new Error('Session inventory unavailable');
  return response.json();
};
const bridge = new AppBridge(null, {name:'Official kept Session inventory host fixture',version:'1'}, {serverTools:{}}, {hostContext:{theme:'light'}});
bridge.oninitialized = async () => {
  const args = {operation:'open',scope:{kind:'kept-in-task',sessionId:'fixture-session',taskId:'fixture-task'}};
  const result = await call(args);
  await bridge.sendToolInput({arguments:args});
  await bridge.sendToolResult(result);
};
bridge.onreadresource = () => { throw new Error('No protected resource reads'); };
void bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
void fetch('/resource').then(r=>r.text()).then(html=>{iframe.srcdoc=html;});
`;

test('Session inventory resource interoperates with an independent official AppBridge host', async ({
  page: browser,
}, testInfo) => {
  test.setTimeout(90_000);
  let ownerReads = 0;
  let nextPage: 'append' | 'terminal' | 'conflict' = 'append';
  const readModule = createSessionInventoryAppReadModule({
    isEnabled: () => true,
    authorize: () => true,
    read: async () => {
      ownerReads += 1;
      return { status: 'found', projection: projection() };
    },
    page: async () => ({ status: 'found', page: page(nextPage) }),
  });
  const owner = new Hono();
  owner.use('/api/orchestration/*', async (c, next) => {
    if (c.req.header(INTERNAL_API_TOKEN_HEADER) !== getInternalApiToken())
      return c.json({ error: 'Unauthorized' }, 401);
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'internal',
      credential: getInternalApiToken(),
      authority: undefined,
      source: 'bearer',
    });
    await next();
  });
  owner.route(
    '/api/orchestration',
    createOrchestrationRoutes({ canUserReadSession: () => true } as never, {
      eventBus: { subscribe: () => () => {} },
      logger: { debug: () => {} },
      getUserId: () => 'fixture-user',
      sessionInventoryAppRead: readModule,
      isRequestPrincipalCurrent: (request) =>
        isTrustedInternalApiToken(
          getRuntimeAuthenticatedRequestPrincipal(request)?.credential,
        ),
      callerBindingForRequest: (request) =>
        request.headers.get(INTERNAL_CONTROL_CALLER_BINDING_HEADER) ??
        undefined,
    }),
  );
  const server = serve({ fetch: owner.fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening)
    await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  owner.route('/', createStationControlMcpRoutes({ port }));
  const sessionId = `session-inventory-interop-${testInfo.workerIndex}`;
  const { token } = mintStationControlMcpToken(sessionId, 'url-token');
  const transport = new StreamableHTTPClientTransport(
    new URL(
      `http://127.0.0.1:${port}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`,
    ),
  );
  const client = new Client(
    { name: 'session-inventory-interop', version: '1' },
    { capabilities: {} },
  );
  const restoreEnvironment = preserveBasisInteropEnvironment();
  const calls: unknown[] = [];
  let appNetworkRequests = 0;
  let invalidResult: 'none' | 'envelope' | 'capability' = 'none';
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const tool = tools.tools.find(
      (entry) => entry.name === 'get_session_inventory',
    );
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: APP_URI } });
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    const resource = await client.readResource({ uri: APP_URI });
    const content = resource.contents[0];
    expect(content?.mimeType).toBe('text/html;profile=mcp-app');
    if (!content || !('text' in content) || typeof content.text !== 'string')
      throw new Error('Real MCP resource did not contain text');
    const html = content.text;
    expect(Buffer.byteLength(html)).toBeLessThanOrEqual(480 * 1024);
    expect(content._meta).toMatchObject({
      ui: { csp: { connectDomains: [], resourceDomains: [] } },
    });
    const host = await build({
      stdin: { contents: hostSource, resolveDir: process.cwd(), loader: 'js' },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      minify: true,
    });
    await browser.route(`${HOST}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/resource')
        return route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/call') {
        const args = route.request().postDataJSON();
        calls.push(args);
        const result = await client.callTool({
          name: 'get_session_inventory',
          arguments: args,
        });
        const body =
          invalidResult === 'envelope'
            ? { ...result, structuredContent: {} }
            : invalidResult === 'capability'
              ? { ...result, _meta: {} }
              : result;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Independent Session inventory MCP Apps host</title></head><body><iframe title="Portable Session inventory" sandbox="allow-scripts" style="width:100%;height:1400px;border:0"></iframe><script>${host.outputFiles[0]!.text.replaceAll('</', '<\\/')}</script></body></html>`,
      });
    });
    browser.on('request', (request) => {
      if (
        request.frame().parentFrame() !== null &&
        /^https?:/u.test(request.url())
      )
        appNetworkRequests += 1;
    });
    await browser.setViewportSize({ width: 390, height: 900 });
    await browser.goto(HOST);
    const app = browser.frameLocator('iframe');
    await expect(
      app.getByRole('heading', { name: 'Current answer', exact: true }),
    ).toBeVisible();
    await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(app.locator('body')).toHaveCSS(
      'background-color',
      'rgb(16, 24, 32)',
    );
    await browser.evaluate(() => window.__setSessionInventoryTheme('light'));
    await expect(app.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(app.locator('body')).toHaveCSS(
      'background-color',
      'rgb(255, 252, 241)',
    );
    // Basis is supplied by the one initial inventory result. It must render
    // without a second owner-facing App tool call.
    await expect(
      app.getByRole('heading', { name: 'Basis', exact: true }),
    ).toBeVisible();
    expect(calls).toEqual([{ operation: 'open', scope: SCOPE }]);
    expect(ownerReads).toBeGreaterThan(0);
    await expect(
      app.getByRole('button', { name: 'compact', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await app.getByRole('button', { name: 'compact', exact: true }).focus();
    await browser.keyboard.press('Tab');
    await expect(
      app.getByRole('button', { name: 'full', exact: true }),
    ).toBeFocused();
    await browser.keyboard.press('Enter');
    await expect(
      app.getByRole('button', { name: 'full', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(app.locator('section[data-group-id="inputs"]')).toContainText(
      'This owner is unavailable.',
    );
    await app.getByRole('button', { name: 'Sources', exact: true }).focus();
    await browser.keyboard.press('Space');
    await expect(
      app.getByRole('button', { name: 'Sources', exact: true }),
    ).toHaveAttribute('aria-pressed', 'true');
    await expect(
      app.getByRole('heading', { name: 'Sources (0)', exact: true }),
    ).toBeVisible();
    await app.getByRole('button', { name: 'Attention', exact: true }).focus();
    await browser.keyboard.press('Space');
    await expect(
      app.locator('section[data-group-id="attention"]'),
    ).toContainText('Some owner context needs attention.');
    await app.getByRole('button', { name: 'Inputs', exact: true }).focus();
    await browser.keyboard.press('Space');
    const loadMore = app.getByRole('button', {
      name: 'Load more',
      exact: true,
    });
    await loadMore.click();
    await expect(
      app.getByRole('heading', { name: 'Inputs (3+)', exact: true }),
    ).toBeFocused();
    await expect(app.locator('section[data-group-id="inputs"] li')).toHaveCount(
      2,
    );
    expect(calls[1]).toEqual({
      operation: 'page',
      scope: SCOPE,
      occurrenceId: expect.stringMatching(/^[A-Za-z0-9_-]{24,128}$/),
      groupId: 'inputs',
      continuationToken: expect.stringMatching(/^[A-Za-z0-9_-]{24,128}$/),
    });
    const firstPage = calls[1] as { continuationToken: string };
    nextPage = 'terminal';
    await app.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(
      app.getByRole('button', { name: 'Load more', exact: true }),
    ).toHaveCount(0);
    const secondPage = calls[2] as { continuationToken: string };
    expect(secondPage.continuationToken).not.toBe(firstPage.continuationToken);
    await expect(app.locator('#session-inventory-app a')).toHaveCount(0);
    await expect(app.locator('#session-inventory-app img')).toHaveCount(0);
    await expect(app.locator('#session-inventory-app script')).toHaveCount(0);
    await expect(app.getByText(hostile, { exact: false })).toHaveCount(0);
    expect(
      await app
        .locator('html')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(appNetworkRequests).toBe(0);
    await expectNoBlockingAccessibilityViolations(
      browser,
      'session-inventory-mcp-external',
    );

    // A contradictory duplicate row cannot be merged into the already shown
    // projection; discard it rather than retaining potentially stale data.
    nextPage = 'conflict';
    await browser.reload();
    await app.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(
      app.getByText('Session inventory is unavailable.', { exact: true }),
    ).toBeVisible();

    invalidResult = 'envelope';
    await browser.reload();
    await expect(
      app.getByText('Session inventory is unavailable.', { exact: true }),
    ).toBeVisible();
    invalidResult = 'capability';
    await browser.reload();
    await expect(
      app.getByText('Session inventory is unavailable.', { exact: true }),
    ).toBeVisible();
    await testInfo.attach('session-inventory-mcp-interoperability-receipt', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          version: 1,
          mcpAppsProtocol: '2026-01-26',
          versions: {
            extApps: dependencyVersion('@modelcontextprotocol/ext-apps'),
            mcpSdk: dependencyVersion('@modelcontextprotocol/sdk'),
          },
          resourceUri: APP_URI,
          tool: 'get_session_inventory',
          resourceBytes: Buffer.byteLength(html),
          initialBasisToolCalls: 1,
          pageCapabilityRotated: true,
          terminalContinuationRemoved: true,
          conflictingDuplicateFailsClosed: true,
          invalidEnvelopeUnavailable: true,
          invalidCapabilityUnavailable: true,
          protectedAppNetworkRequests: appNetworkRequests,
          passed: true,
        }),
      ),
    });
  } finally {
    await client.close().catch(() => {});
    revokeStationControlMcpToken(sessionId);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    restoreEnvironment();
  }
});

test('kept-in-task inventory crosses the real Task app-read route into the portable App', async ({
  page: browser,
}, testInfo) => {
  test.setTimeout(90_000);
  let ownerReads = 0;
  const readModule = createSessionInventoryAppReadModule({
    isEnabled: () => true,
    authorize: ({ routeFamily, scope }) =>
      routeFamily === 'task' &&
      scope.kind === 'kept-in-task' &&
      scope.taskId === KEPT_SCOPE.taskId &&
      scope.sessionId === KEPT_SCOPE.sessionId,
    read: async ({ scope }) => {
      ownerReads += 1;
      return JSON.stringify(scope) === JSON.stringify(KEPT_SCOPE)
        ? { status: 'found', projection: keptProjection() }
        : { status: 'not-found' };
    },
    page: async () => ({ status: 'not-found' }),
  });
  const owner = new Hono();
  owner.use('/api/tasks/*', async (c, next) => {
    if (c.req.header(INTERNAL_API_TOKEN_HEADER) !== getInternalApiToken())
      return c.json({ error: 'Unauthorized' }, 401);
    setRuntimeAuthenticatedRequestPrincipal(c.req.raw, {
      kind: 'internal',
      credential: getInternalApiToken(),
      authority: undefined,
      source: 'bearer',
    });
    await next();
  });
  const taskGraph = {
    readTask: (taskId: string) =>
      taskId === KEPT_SCOPE.taskId ? { id: taskId } : undefined,
    readSessionRelations: (sessionId: string) => ({
      links:
        sessionId === KEPT_SCOPE.sessionId
          ? [
              {
                sourceType: 'task',
                sourceId: KEPT_SCOPE.taskId,
                targetType: 'session',
                targetId: KEPT_SCOPE.sessionId,
              },
            ]
          : [],
    }),
  };
  owner.route(
    '/api/tasks',
    createTaskRoutes(taskGraph as never, {
      taskDispatcher: {
        dispatch: async () => {
          throw new Error('Unexpected Task mutation in read-only fixture');
        },
      } as never,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('fixture-user', undefined, undefined),
      canReadSession: (sessionId) => sessionId === KEPT_SCOPE.sessionId,
      isRequestPrincipalCurrent: (request) =>
        isTrustedInternalApiToken(
          getRuntimeAuthenticatedRequestPrincipal(request)?.credential,
        ),
      callerBindingForRequest: (request) =>
        request.headers.get(INTERNAL_CONTROL_CALLER_BINDING_HEADER) ??
        undefined,
      sessionInventoryAppRead: readModule,
    }),
  );
  const server = serve({ fetch: owner.fetch, port: 0, hostname: '127.0.0.1' });
  if (!server.listening)
    await new Promise<void>((resolve) => server.once('listening', resolve));
  const port = (server.address() as AddressInfo).port;
  owner.route('/', createStationControlMcpRoutes({ port }));
  const sessionId = `session-inventory-kept-${testInfo.workerIndex}`;
  const { token } = mintStationControlMcpToken(sessionId, 'url-token');
  const client = new Client(
    { name: 'session-inventory-kept-interop', version: '1' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(
      `http://127.0.0.1:${port}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`,
    ),
  );
  const restoreEnvironment = preserveBasisInteropEnvironment();
  const calls: unknown[] = [];
  try {
    await client.connect(transport);
    const resource = await client.readResource({ uri: APP_URI });
    const content = resource.contents[0];
    if (!content || !('text' in content) || typeof content.text !== 'string')
      throw new Error('Real MCP resource did not contain text');
    expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(480 * 1024);
    const host = await build({
      stdin: {
        contents: keptHostSource,
        resolveDir: process.cwd(),
        loader: 'js',
      },
      bundle: true,
      platform: 'browser',
      format: 'iife',
      write: false,
      minify: true,
    });
    await browser.route(`${HOST}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/resource')
        return route.fulfill({ contentType: 'text/html', body: content.text });
      if (path === '/call') {
        const args = route.request().postDataJSON();
        calls.push(args);
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            await client.callTool({
              name: 'get_session_inventory',
              arguments: args,
            }),
          ),
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><title>Independent kept inventory host</title></head><body><iframe title="Portable kept Session inventory" sandbox="allow-scripts" style="width:100%;height:900px;border:0"></iframe><script>${host.outputFiles[0]!.text.replaceAll('</', '<\\/')}</script></body></html>`,
      });
    });
    await browser.goto(HOST);
    const app = browser.frameLocator('iframe');
    await expect(
      app.getByRole('heading', {
        name: 'Kept in Task “fixture-task”',
        exact: true,
      }),
    ).toBeVisible();
    await app.getByRole('button', { name: 'Kept', exact: true }).click();
    await expect(app.locator('section[data-group-id="kept"]')).toContainText(
      'Kept result — Context from this Session; Kept context',
    );
    expect(calls).toEqual([{ operation: 'open', scope: KEPT_SCOPE }]);
    expect(ownerReads).toBeGreaterThan(0);
  } finally {
    await client.close().catch(() => {});
    revokeStationControlMcpToken(sessionId);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    restoreEnvironment();
  }
});
