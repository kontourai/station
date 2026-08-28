import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import {
  encodeTaskToolResultReference,
  encodeTaskTurnReference,
} from '@kontourai/station-contracts/task-graph';
import { sessionReadAuthorityFromRequest } from '@kontourai/station-contracts/tenancy';
import { buildBasisPanelViewModel } from '@kontourai/surface/basis/view';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { expect, test } from '@playwright/test';
import { build } from 'esbuild';
import { Hono } from 'hono';
import {
  createStationControlMcpRoutes,
  STATION_CONTROL_MCP_PATH,
} from '../src-server/routes/mcp/station-control-mcp-route.js';
import { createTaskRoutes } from '../src-server/routes/orchestration/tasks.js';
import {
  mintStationControlMcpToken,
  revokeStationControlMcpToken,
} from '../src-server/runtime/mcp/station-control-mcp-token.js';
import {
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../src-server/security/runtime-request-security.js';
import { createTaskBasisAppReadModule } from '../src-server/services/projects/task-basis-app-read-module.js';
import type { TaskGraphService } from '../src-server/services/projects/task-graph-service.js';
import { INTERNAL_CONTROL_CALLER_BINDING_HEADER } from '../src-server/tools/station-control-shared.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  isTrustedInternalApiToken,
} from '../src-server/utils/internal-api-token.js';
import { expectNoBlockingAccessibilityViolations } from './helpers/accessibility';
import {
  basisInteropCollection,
  preserveBasisInteropEnvironment,
} from './helpers/basis-interop-fixture';

const HOST = 'http://basis-basic-host.test';
const APP_URI = 'ui://station/basis/task/v3';

declare global {
  interface Window {
    __setTaskBasisTheme(theme: 'light' | 'dark'): void;
  }
}

function dependencyVersion(name: string): string {
  const manifest = JSON.parse(
    readFileSync(
      new URL(`../node_modules/${name}/package.json`, import.meta.url),
      'utf8',
    ),
  ) as { version: string };
  return manifest.version;
}

const hostSource = `
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge';
const iframe = document.querySelector('iframe');
let expectedToken = null;
let occurrence = null;
let inFlight = false;
const capture = (result) => {
  const meta = result?._meta?.['station.task-basis-app/v1'];
  if (!meta || typeof meta.occurrenceId !== 'string' ||
      (occurrence !== null && occurrence !== meta.occurrenceId)) {
    expectedToken = null;
    return;
  }
  occurrence = meta.occurrenceId;
  expectedToken = typeof meta.continuationToken === 'string' ? meta.continuationToken : null;
};
const call = async (args) => {
  const response = await fetch('/call', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)});
  if (!response.ok) throw new Error('Read unavailable');
  return response.json();
};
const themes = {
  dark: {'--color-background-primary':'#101820','--color-background-secondary':'#15222d','--color-text-primary':'#eff5f0','--color-border-primary':'#657267','--color-ring-primary':'#38c98b'},
  light: {'--color-background-primary':'#fffcf1','--color-background-secondary':'#fff','--color-text-primary':'#17201b','--color-border-primary':'#657267','--color-ring-primary':'#0f8f66'},
};
const bridge = new AppBridge(null, {name:'Official basic-host fixture',version:'1'}, {serverTools:{}}, {hostContext:{theme:'dark',styles:{variables:themes.dark}}});
window.__setTaskBasisTheme = (theme) => bridge.setHostContext({theme,styles:{variables:themes[theme]}});
bridge.oninitialized = async () => {
  const result = await call({taskId:'fixture-task'});
  capture(result);
  await bridge.sendToolInput({arguments:{taskId:'fixture-task'}});
  await bridge.sendToolResult(result);
};
bridge.oncalltool = async ({name,arguments:args}) => {
  if (inFlight || name !== 'get_task_basis' || !expectedToken ||
      !args || Object.keys(args).length !== 2 || args.taskId !== 'fixture-task' ||
      args.continuationToken !== expectedToken) throw new Error('Read outside captured App scope');
  inFlight = true;
  expectedToken = null;
  try { const result = await call(args); capture(result); return result; }
  finally { inFlight = false; }
};
bridge.onreadresource = () => { throw new Error('No protected resource reads'); };
void bridge.connect(new PostMessageTransport(iframe.contentWindow, iframe.contentWindow));
void fetch('/resource').then(r=>r.text()).then(html=>{iframe.srcdoc=html;});
`;

test('Whole Task resource interoperates with an independent official AppBridge host', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);
  const collection = basisInteropCollection();
  const expected = buildBasisPanelViewModel(collection.answers[0]!.projection);
  const secondExpected = buildBasisPanelViewModel(
    collection.answers[1]!.projection,
  );
  let ownerReads = 0;
  let enabled = true;
  let pendingOwnerRead: Promise<void> | undefined;
  let ownerReadStarted: (() => void) | undefined;
  const readModule = createTaskBasisAppReadModule({
    isEnabled: () => enabled,
    read: async ({ taskId }) => {
      ownerReads += 1;
      ownerReadStarted?.();
      await pendingOwnerRead;
      return taskId === collection.taskId
        ? { status: 'found', data: collection }
        : { status: 'not-found' };
    },
  });
  const owner = new Hono();
  // Fixture authentication only: the production tool must perform its real
  // authenticated internal HTTP hop. No protected endpoint is exposed to App JS.
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
    readTaskTurnReferenceScope: () => ({ projectId: 'fixture-project' }),
    readTaskTurnReferenceLinks: () =>
      collection.answers.map((answer, index) => ({
        id: answer.answerReferenceId,
        targetId: encodeTaskTurnReference(
          'fixture-session',
          `fixture-turn-${index}`,
        ),
      })),
    readTaskToolResultReferenceLinks: () =>
      collection.keptToolResults.map((result) => ({
        id: result.referenceId,
        targetId: encodeTaskToolResultReference(
          result.ref.threadId,
          result.ref.resultId,
        ),
      })),
  } as unknown as TaskGraphService;
  owner.route(
    '/api/tasks',
    createTaskRoutes(taskGraph, {
      taskDispatcher: {
        dispatch: async () => {
          throw new Error(
            'Unexpected mutation in read-only interoperability fixture',
          );
        },
      },
      taskBasisAppRead: readModule,
      readAuthorityForRequest: () =>
        sessionReadAuthorityFromRequest('fixture-user', undefined, undefined),
      canReadSession: (sessionId) => sessionId === 'fixture-session',
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
  const sessionId = `basis-interop-${testInfo.workerIndex}`;
  const { token } = mintStationControlMcpToken(sessionId, 'url-token');
  const otherSessionId = `${sessionId}-other`;
  const { token: otherToken } = mintStationControlMcpToken(
    otherSessionId,
    'url-token',
  );
  const client = new Client(
    { name: 'basis-interop', version: '1' },
    { capabilities: {} },
  );
  const otherClient = new Client(
    { name: 'basis-other-host', version: '1' },
    { capabilities: {} },
  );
  const otherTransport = new StreamableHTTPClientTransport(
    new URL(
      `http://127.0.0.1:${port}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(otherToken)}`,
    ),
  );
  const transport = new StreamableHTTPClientTransport(
    new URL(
      `http://127.0.0.1:${port}${STATION_CONTROL_MCP_PATH}?token=${encodeURIComponent(token)}`,
    ),
  );
  const restoreEnvironment = preserveBasisInteropEnvironment();
  let successfulPages = 0;
  let appNetworkRequests = 0;
  let stripCapability = false;
  try {
    await client.connect(transport);
    await otherClient.connect(otherTransport);
    const tools = await client.listTools();
    const tool = tools.tools.find((entry) => entry.name === 'get_task_basis');
    expect(tool?._meta).toMatchObject({ ui: { resourceUri: APP_URI } });
    expect(tool?.annotations?.readOnlyHint).toBe(true);
    expect(tools.tools.some((entry) => entry.name === 'get_basis')).toBe(true);
    const resource = await client.readResource({ uri: APP_URI });
    const content = resource.contents[0];
    expect(content?.mimeType).toBe('text/html;profile=mcp-app');
    if (!content || !('text' in content) || typeof content.text !== 'string')
      throw new Error('Real MCP resource did not contain text');
    const html = content.text;
    // The production refusal remains 500 KiB. Keep a meaningful payload
    // margin here so a restored full Surface custom-element bundle cannot
    // silently consume the whole limit again.
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
    await page.route(`${HOST}/**`, async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/resource')
        return route.fulfill({ contentType: 'text/html', body: html });
      if (path === '/call') {
        const args = route.request().postDataJSON();
        const result = await client.callTool({
          name: 'get_task_basis',
          arguments: args,
        });
        expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(
          128 * 1024,
        );
        if (successfulPages === 0 && result.structuredContent) {
          const capability = result._meta?.['station.task-basis-app/v1'] as
            | { continuationToken?: string }
            | undefined;
          expect(capability?.continuationToken).toBeTruthy();
          const refused = await otherClient.callTool({
            name: 'get_task_basis',
            arguments: {
              taskId: collection.taskId,
              continuationToken: capability!.continuationToken!,
            },
          });
          expect(refused.structuredContent).toBeUndefined();
          // The owner confirms both the initial authorization and the
          // publication fence before a page can leave the read module.
          expect(ownerReads).toBe(2);
        }
        if (result.structuredContent) successfulPages += 1;
        return route.fulfill({
          contentType: 'application/json',
          body: JSON.stringify(
            stripCapability ? { ...result, _meta: {} } : result,
          ),
        });
      }
      return route.fulfill({
        contentType: 'text/html',
        body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Independent MCP Apps host</title></head><body><iframe title="Portable Whole Task Basis" sandbox="allow-scripts" style="width:100%;height:1500px;border:0"></iframe><script>${host.outputFiles[0]!.text.replaceAll('</', '<\\/')}</script></body></html>`,
      });
    });
    page.on('request', (request) => {
      if (
        request.frame().parentFrame() !== null &&
        /^https?:/u.test(request.url())
      )
        appNetworkRequests += 1;
    });
    await page.goto(HOST);
    const app = page.frameLocator('iframe');
    await expect(
      app.getByRole('heading', { name: 'Whole Task Basis', exact: true }),
    ).toBeVisible();
    await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(app.locator('body')).toHaveCSS(
      'background-color',
      'rgb(16, 24, 32)',
    );
    await page.evaluate(() => window.__setTaskBasisTheme('light'));
    await expect(app.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(app.locator('body')).toHaveCSS(
      'background-color',
      'rgb(255, 252, 241)',
    );
    await page.evaluate(() => window.__setTaskBasisTheme('dark'));
    await expect(app.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect(
      app.getByText('Whole Task has no aggregate standing.', { exact: true }),
    ).toBeVisible();
    await expect(
      app.getByText('Some kept Process context is restricted.', {
        exact: true,
      }),
    ).toBeVisible();
    expect(app.locator('surface-trust-panel')).toHaveCount(0);
    const panel = app.locator('section[aria-label="Basis"]');
    await expect(panel.getByRole('status')).toContainText(
      expected.standing.label,
    );
    for (const partition of expected.assessment?.evidence ?? [])
      await expect(
        panel.getByRole('heading', { name: partition.label, exact: true }),
      ).toBeVisible();
    await expect(
      panel.getByText(expected.contextNotice, { exact: false }),
    ).toBeVisible();
    await expect(
      panel
        .getByText('A visible owner-declared fixture gap.', { exact: false })
        .first(),
    ).toBeVisible();
    await expect(panel.locator('img')).toHaveCount(0);
    const nextPage = app.getByRole('button', {
      name: 'Next page',
      exact: true,
    });
    expect((await nextPage.boundingBox())?.height).toBeGreaterThanOrEqual(44);
    expect(
      (
        await app
          .getByRole('button', { name: /^fixture-answer-0/ })
          .boundingBox()
      )?.height,
    ).toBeGreaterThanOrEqual(44);
    const firstAnswer = app.getByRole('button', {
      name: 'fixture-answer-0',
      exact: true,
    });
    const secondAnswer = app.getByRole('button', {
      name: 'fixture-answer-1',
      exact: true,
    });
    await secondAnswer.click();
    await expect(firstAnswer).toHaveAttribute('aria-pressed', 'false');
    await expect(secondAnswer).toHaveAttribute('aria-pressed', 'true');
    await expect(panel.getByRole('status')).toContainText(
      secondExpected.standing.label,
    );
    await expect(
      panel.getByText('No Surface assessment is available.', { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText('A visible owner-declared fixture gap.', {
        exact: false,
      }),
    ).toHaveCount(0);
    await expect(
      panel.getByRole('heading', { name: 'Evidence', exact: true }),
    ).toHaveCount(0);
    await nextPage.click();
    await expect(
      app.getByRole('button', { name: /^fixture-answer-8/ }),
    ).toBeVisible();
    await expect(
      app.getByRole('button', { name: /^fixture-answer-0/ }),
    ).toHaveCount(0);
    await expect(
      app.getByText('Task output fixture-output', { exact: true }),
    ).toBeVisible();
    await expect(
      app.getByText(
        'Kept tool result fixture-kept-result-0: Not associated with an available answer.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      app.getByText(
        'Kept tool result fixture-kept-result-15: Not associated with an available answer.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      app.getByRole('listitem').filter({
        hasText:
          /^Kept tool result fixture-kept-result-\d+: Not associated with an available answer\.$/,
      }),
    ).toHaveCount(16);
    await app.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(
      app.getByText(
        'Kept tool result fixture-kept-result-16: Not associated with an available answer.',
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      app.getByText(
        'Kept tool result fixture-kept-result-0: Not associated with an available answer.',
        { exact: true },
      ),
    ).toHaveCount(0);
    await expect(
      app.getByRole('button', { name: /^fixture-answer-/ }),
    ).toHaveCount(0);
    await expect(
      app.getByRole('button', { name: 'Next page', exact: true }),
    ).toHaveCount(0);
    const processRegion = app.getByRole('region', {
      name: 'Process kept gate evaluations',
    });
    await expect(processRegion).toContainText(
      'Gate verification — original verdict pass. At last check: superseded;',
    );
    await processRegion
      .getByText('Process receipt details', { exact: true })
      .click();
    await expect(processRegion).toContainText('Retained immutable bundle');
    await expect(processRegion).toContainText('External revocation');
    await expect(processRegion).toContainText('Not observed');
    await expect(processRegion).toContainText('fixture-selected-evidence');
    const moreEvidence = processRegion.getByRole('button', {
      name: 'Show more selected evidence',
      exact: true,
    });
    await expect(processRegion).not.toContainText(
      'fixture-selected-evidence-20',
    );
    await moreEvidence.focus();
    await page.keyboard.press('Enter');
    await expect(processRegion).toContainText('fixture-selected-evidence-20');
    await expect(
      processRegion.getByRole('button', {
        name: 'All selected evidence shown',
        exact: true,
      }),
    ).toBeFocused();
    expect(ownerReads).toBe(6);
    expect(successfulPages).toBe(3);
    expect(appNetworkRequests).toBe(0);
    await expectNoBlockingAccessibilityViolations(page, 'basis-mcp-external');

    stripCapability = true;
    await page.reload();
    await expect(
      app.getByText('Whole Task Basis is unavailable.', { exact: true }),
    ).toBeVisible();
    await expect(
      app.getByRole('button', { name: /^fixture-answer-/ }),
    ).toHaveCount(0);
    stripCapability = false;

    // Reopen creates a fresh server read occurrence; revocation before the
    // next read must clear the prior protected page rather than retain it.
    await page.reload();
    await expect(
      app.getByRole('button', { name: /^fixture-answer-0/ }),
    ).toBeVisible();
    enabled = false;
    await app.getByRole('button', { name: 'Next page', exact: true }).click();
    await expect(
      app.getByText('Whole Task Basis is unavailable.', { exact: true }),
    ).toBeVisible();
    await expect(
      app.getByRole('button', { name: /^fixture-answer-/ }),
    ).toHaveCount(0);
    // Exercise the actual external bearer -> internal HTTP proxy boundary,
    // not just a direct route callback with a fixture credential. Revoking
    // the original bearer while owner I/O is pending must withhold the page.
    enabled = true;
    let releaseOwner!: () => void;
    const ownerStarted = new Promise<void>((resolve) => {
      ownerReadStarted = resolve;
    });
    pendingOwnerRead = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const pendingRevokedRead = otherClient.callTool({
      name: 'get_task_basis',
      arguments: { taskId: collection.taskId },
    });
    await ownerStarted;
    revokeStationControlMcpToken(otherSessionId);
    releaseOwner();
    const revokedResult = await pendingRevokedRead;
    expect(revokedResult.structuredContent).toBeUndefined();
    expect(revokedResult._meta).toBeUndefined();
    expect(JSON.stringify(revokedResult)).not.toContain('fixture-answer');
    expect(JSON.stringify(revokedResult)).not.toContain('fixture-output');
    expect(JSON.stringify(revokedResult)).not.toContain('fixture-kept-result');
    await testInfo.attach('basis-mcp-interoperability-receipt', {
      contentType: 'application/json',
      body: Buffer.from(
        JSON.stringify({
          version: 1,
          mcpAppsProtocol: '2026-01-26',
          versions: {
            extApps: dependencyVersion('@modelcontextprotocol/ext-apps'),
            mcpSdk: dependencyVersion('@modelcontextprotocol/sdk'),
            surface: dependencyVersion('@kontourai/surface'),
          },
          resourceUri: APP_URI,
          mimeType: content.mimeType,
          tool: 'get_task_basis',
          pages: 3,
          keptToolResults: 17,
          keptOnlyTerminalPage: true,
          connectDomains: [],
          resourceDomains: [],
          semanticEquivalence: true,
          missingContinuationMetadataIsUnavailable: true,
          revocationClearsPage: true,
          externalBearerRevocationDuringOwnerReadWithholdsPage: true,
          protectedAppNetworkRequests: appNetworkRequests,
          passed: true,
        }),
      ),
    });
  } finally {
    await client.close().catch(() => {});
    await otherClient.close().catch(() => {});
    revokeStationControlMcpToken(sessionId);
    revokeStationControlMcpToken(otherSessionId);
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    restoreEnvironment();
  }
});
