import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
import { EventStore } from '../src-server/services/orchestration/event-store.js';
import { createMCPToolProvenanceGeneration } from '../src-server/services/orchestration/mcp-tool-provenance.js';
import { createSessionInventoryAppReadModule } from '../src-server/services/orchestration/session-inventory-app-read-module.js';
import { createSessionInventoryModule } from '../src-server/services/orchestration/session-inventory-module.js';
import { createSessionWorkItemModule } from '../src-server/services/orchestration/session-work-item-module.js';
import {
  mintWorkItemResultProjectorProvenanceForReviewedLoader,
  WorkItemResultProjector,
} from '../src-server/services/orchestration/work-item-result-projector.js';
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
const V2_APP_URI = 'ui://station/basis/session-inventory/v2';
const V2_SCOPE = {
  kind: 'whole-session' as const,
  sessionId: 'fixture-session',
};
const WORK_ITEM_URL = 'https://github.com/kontourai/station/issues/235';
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
    __sessionInventoryOpenedLinks: string[];
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

// This is deliberately an independent host, not a test-only rendering of the
// inventory view.  The View runs the checked-in v2 resource and reaches this
// host only through the official AppBridge openLinks capability.
const v2HostSource = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const iframe = document.querySelector('iframe');
let expected = null;
window.__sessionInventoryOpenedLinks = [];
const capture = (result) => {
  const meta = result?._meta?.['station.session-inventory-app/v2'];
  if (!meta || typeof meta.occurrenceId !== 'string' || !Array.isArray(meta.continuations)) { expected = null; return; }
  expected = meta;
};
const call = async (args) => {
  const response = await fetch('/call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  if (!response.ok) throw new Error('Session inventory unavailable');
  return response.json();
};
const bridge = new AppBridge(null, {name:'Official Session inventory v2 host fixture',version:'1'}, {serverTools:{},openLinks:{}}, {hostContext:{theme:'light'}});
bridge.oninitialized = async () => {
  const args = {version:'station.session-inventory-mcp/v2',operation:'open',scope:{kind:'whole-session',sessionId:'fixture-session'}};
  const result = await call(args);
  capture(result);
  await bridge.sendToolInput({arguments:args});
  await bridge.sendToolResult(result);
};
bridge.oncalltool = async ({name,arguments:args}) => {
  const continuation = expected?.continuations?.find((entry) => entry?.groupId === 'work-items');
  if (name !== 'get_session_inventory' || !continuation || !args ||
      Object.keys(args).length !== 6 || args.version !== 'station.session-inventory-mcp/v2' ||
      args.operation !== 'page' || JSON.stringify(args.scope) !== JSON.stringify({kind:'whole-session',sessionId:'fixture-session'}) ||
      args.occurrenceId !== expected.occurrenceId || args.groupId !== 'work-items' ||
      args.continuationToken !== continuation.continuationToken)
    throw new Error('Page escaped captured Session inventory v2 capability');
  const result = await call(args);
  capture(result);
  return result;
};
bridge.onopenlink = async ({url}) => {
  window.__sessionInventoryOpenedLinks.push(url);
  return {};
};
bridge.onreadresource = () => { throw new Error('No protected resource reads'); };
void bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
void fetch('/resource').then(r=>r.text()).then(html=>{iframe.srcdoc=html;});
`;

function persistFixtureWorkItem() {
  const directory = mkdtempSync(join(tmpdir(), 'station-inventory-mcp-v2-'));
  const store = new EventStore(join(directory, 'orchestration.sqlite'));
  store.upsertSession({
    provider: 'claude',
    threadId: V2_SCOPE.sessionId,
    status: 'ready',
    createdAt: '2026-08-28T12:00:00.000Z',
    updatedAt: '2026-08-28T12:00:00.000Z',
  });
  const generation = createMCPToolProvenanceGeneration();
  const provenance = mintWorkItemResultProjectorProvenanceForReviewedLoader(
    generation.mint({
      serverId: 'github',
      originalToolName: 'create_issue',
      runtimeName: 'github_createIssue',
      integrationId: 'github',
    }),
  );
  const candidate = new WorkItemResultProjector().project({
    associationId: 'interop-association-235',
    sessionId: V2_SCOPE.sessionId,
    conversationId: V2_SCOPE.sessionId,
    turnId: 'fixture-turn',
    toolCallId: 'fixture-tool-call',
    terminalStatus: 'success',
    provenance: provenance!,
    githubArguments: { owner: 'kontourai', repo: 'station', title: 'Fixture' },
    content: [
      { type: 'text', text: JSON.stringify({ id: '235', url: WORK_ITEM_URL }) },
    ],
  });
  if (!candidate) throw new Error('Fixture work item was not admitted');
  expect(
    store.stageSessionWorkItemCandidate({ candidate, current: () => true }),
  ).toEqual({ kind: 'staged' });
  store.appendEvent({
    eventId: 'fixture-work-item-completed',
    provider: 'claude',
    threadId: V2_SCOPE.sessionId,
    turnId: 'fixture-turn',
    createdAt: '2026-08-28T12:00:01.000Z',
    method: 'tool.completed',
    itemId: 'fixture-item',
    toolCallId: 'fixture-tool-call',
    toolName: 'github.create_issue',
    status: 'success',
  });
  return { directory, store };
}

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
    expect(tool?._meta).toMatchObject({
      ui: { resourceUri: 'ui://station/basis/session-inventory/v2' },
    });
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
    ).toContainText('No attention were recorded for this scope.');
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

test('v2 work-item inventory crosses the real MCP tool, durable projection, and AppBridge openLinks boundary', async ({
  page: browser,
}, testInfo) => {
  test.setTimeout(90_000);
  const { directory, store } = persistFixtureWorkItem();
  let authorized = true;
  const inventory = createSessionInventoryModule({
    sessionOutputs: {
      list: async () => ({
        status: 'found',
        page: { version: 'session-outputs/v1', items: [], partial: false },
      }),
    } as never,
    canReadSession: (sessionId) =>
      authorized && sessionId === V2_SCOPE.sessionId,
    conversationForSession: (sessionId) =>
      store.conversationForSession(sessionId),
    sessionWorkItems: createSessionWorkItemModule({
      eventStore: store,
      canReadSession: (sessionId) =>
        authorized && sessionId === V2_SCOPE.sessionId,
    }),
  });
  const readModule = createSessionInventoryAppReadModule({
    isEnabled: () => true,
    authorize: ({ scope, routeFamily }) =>
      authorized &&
      routeFamily === 'orchestration' &&
      JSON.stringify(scope) === JSON.stringify(V2_SCOPE),
    read: async ({ scope, authority, current }) => {
      const result = await inventory.read({ scope, authority, current });
      if (result.status !== 'found') return result;
      return {
        status: 'found',
        projection: {
          ...result.projection,
          groups: result.projection.groups.map((group) =>
            group.id === 'work-items'
              ? {
                  ...group,
                  count: { kind: 'at-least', value: group.count?.value ?? 1 },
                  continuation: 'fixture_work_items'.padEnd(24, 'a'),
                }
              : group,
          ),
        },
      };
    },
    page: async ({ scope, authority, current, groupId }) => {
      if (groupId !== 'work-items' || scope.kind !== 'whole-session')
        return { status: 'not-found' };
      const result = await inventory.read({ scope, authority, current });
      if (result.status !== 'found') return result;
      const first = result.projection.groups.find(
        (group) => group.id === 'work-items',
      );
      const row = first?.items[0];
      if (!first || !row || row.kind !== 'station-session-work-item')
        return { status: 'not-found' };
      return {
        status: 'found',
        page: {
          version: 'station.session-inventory/v2',
          scope,
          group: {
            ...first,
            count: { kind: 'exact', value: 2 },
            items: [
              {
                ...row,
                key: 'work-item:interop-association-236',
                workItemRef: 'github:kontourai/station#236',
                nativeId: '236',
                associationIds: ['interop-association-236'],
              },
            ],
            gaps: [],
          },
        },
      };
    },
  });
  const projectionRead = await inventory.read({
    scope: V2_SCOPE,
    authority: sessionReadAuthorityFromRequest(
      'fixture-user',
      undefined,
      undefined,
    ),
    current: () => true,
  });
  expect(projectionRead.status).toBe('found');
  const directRead = await readModule.open({
    version: 'station.session-inventory-mcp/v2',
    scope: V2_SCOPE,
    routeFamily: 'orchestration',
    callerBinding: 'direct_fixture_binding'.padEnd(24, 'a'),
    authority: sessionReadAuthorityFromRequest(
      'fixture-user',
      undefined,
      undefined,
    ),
  });
  expect(directRead.status).toBe('available');
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
  const sessionId = `session-inventory-v2-${testInfo.workerIndex}`;
  const { token } = mintStationControlMcpToken(sessionId, 'url-token');
  const client = new Client(
    { name: 'session-inventory-v2-interop', version: '1' },
    { capabilities: {} },
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(
      `http://127.0.0.1:${port}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`,
    ),
  );
  const restoreEnvironment = preserveBasisInteropEnvironment();
  const calls: unknown[] = [];
  let meta: 'valid' | 'missing' | 'malformed' = 'valid';
  try {
    await client.connect(transport);
    const resource = await client.readResource({ uri: V2_APP_URI });
    const content = resource.contents[0];
    if (!content || !('text' in content) || typeof content.text !== 'string')
      throw new Error('Real v2 MCP resource did not contain text');
    expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(480 * 1024);
    const initial = await client.callTool({
      name: 'get_session_inventory',
      arguments: {
        version: 'station.session-inventory-mcp/v2',
        operation: 'open',
        scope: V2_SCOPE,
      },
    });
    expect(initial.structuredContent).toMatchObject({
      version: 'station.session-inventory-mcp/v2',
      kind: 'projection',
      projection: { version: 'station.session-inventory/v2' },
    });
    expect(initial._meta).toMatchObject({
      'station.session-inventory-app/v2': {
        occurrenceId: expect.stringMatching(/^[A-Za-z0-9_-]{24,128}$/),
      },
    });
    expect(JSON.stringify(initial.structuredContent)).toContain(
      'interop-association-235',
    );
    const host = await build({
      stdin: {
        contents: v2HostSource,
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
        const result = await client.callTool({
          name: 'get_session_inventory',
          arguments: args,
        });
        const body =
          meta === 'missing'
            ? { ...result, _meta: {} }
            : meta === 'malformed'
              ? {
                  ...result,
                  _meta: {
                    'station.session-inventory-app/v2': {
                      occurrenceId: 'nope',
                      continuations: [],
                    },
                  },
                }
              : result;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(body),
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html><body><iframe title="Portable v2 Session inventory" sandbox="allow-scripts" style="width:100%;height:1400px;border:0"></iframe><script>${host.outputFiles[0]!.text.replaceAll('</', '<\\/')}</script></body></html>`,
      });
    });
    await browser.setViewportSize({ width: 390, height: 900 });
    await browser.goto(HOST);
    const app = browser.frameLocator('iframe');
    await app.getByRole('button', { name: 'Work items', exact: true }).click();
    await expect(
      app.getByText('kontourai/station#235', { exact: false }),
    ).toBeVisible();
    await app
      .getByRole('button', { name: 'Open work item', exact: true })
      .click();
    await expect
      .poll(() => browser.evaluate(() => window.__sessionInventoryOpenedLinks))
      .toEqual([WORK_ITEM_URL]);
    await app.getByRole('button', { name: 'Load more', exact: true }).click();
    await expect(
      app.getByText('kontourai/station#236', { exact: false }),
    ).toBeVisible();
    await app
      .getByRole('button', { name: 'Open work item', exact: true })
      .nth(1)
      .click();
    await expect
      .poll(() => browser.evaluate(() => window.__sessionInventoryOpenedLinks))
      .toEqual([
        WORK_ITEM_URL,
        'https://github.com/kontourai/station/issues/236',
      ]);
    expect(calls[0]).toEqual({
      version: 'station.session-inventory-mcp/v2',
      operation: 'open',
      scope: V2_SCOPE,
    });
    expect(calls[1]).toMatchObject({
      version: 'station.session-inventory-mcp/v2',
      operation: 'page',
      groupId: 'work-items',
    });
    expect(
      await app
        .locator('html')
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    meta = 'missing';
    await browser.reload();
    await expect(
      app.getByText('Session inventory is unavailable.', { exact: true }),
    ).toBeVisible();
    meta = 'malformed';
    await browser.reload();
    await expect(
      app.getByText('Session inventory is unavailable.', { exact: true }),
    ).toBeVisible();
    authorized = false;
    const revoked = await client.callTool({
      name: 'get_session_inventory',
      arguments: {
        version: 'station.session-inventory-mcp/v2',
        operation: 'open',
        scope: V2_SCOPE,
      },
    });
    expect(revoked.isError).toBe(false);
    expect(revoked.structuredContent).toBeUndefined();
    expect(revoked._meta).toBeUndefined();
  } finally {
    await client.close().catch(() => {});
    revokeStationControlMcpToken(sessionId);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    store.close();
    rmSync(directory, { recursive: true, force: true });
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
