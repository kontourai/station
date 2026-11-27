import assert from 'node:assert/strict';
import { createServer, type RequestListener, type Server } from 'node:http';
import { build } from 'esbuild';
import { buildPluginHostFrameDocument } from '../../src-server/runtime/mcp/mcp-ui-frame-server.js';
import {
  E2E_STATION_CAPABILITIES,
  E2E_STATION_COMPATIBILITY,
} from '../helpers/current-station-contract.js';
import {
  type DirectWebDriver,
  startTauriShellFixture,
  type TauriShellFixture,
} from './direct-webdriver.js';

const PLUGIN_NAME = 'hostile-plugin';
const DECLARED_SLUG = 'hostile-panel';
const PWNED_KEY = 'plugin-host-pwned';

const unavailableFixtureRoutes = new Set([
  'GET /acp/connections',
  'GET /api/agents',
  'GET /api/attention',
  'GET /api/auth/authority',
  'GET /api/boot',
  'GET /api/connections/agents',
  'GET /api/connections/models',
  'GET /api/consent/native-eligibility',
  'GET /api/conversations',
  'GET /api/environments/ssh/sessions',
  'GET /api/feature-previews',
  'GET /api/me/appearance',
  'GET /api/me/layouts',
  'GET /api/models',
  'GET /api/models/capabilities',
  'GET /api/notifications/deliveries',
  'GET /api/orchestration/events',
  'GET /api/orchestration/pane-host/hostile/catalog',
  'GET /api/orchestration/sessions/read-model',
  'GET /api/orchestration/work-claims',
  'GET /api/projects/hostile/channels',
  'GET /api/projects/hostile/operating-state/availability',
  'GET /api/settings/managed-policy',
  'GET /api/system/capabilities',
  'GET /api/system/core-update',
  'GET /api/system/skills',
  'GET /api/tasks',
  'GET /notifications',
  'POST /api/presence/focus',
  'POST /api/telemetry/panes',
]);

type ListeningServer = {
  origin: string;
  server: Server;
};

type AttackHits = {
  blockedFetch: number;
  secretApi: number;
  requests: string[];
  unexpectedRequests: string[];
};

let remote: ListeningServer;
let frame: ListeningServer;
let blocked: ListeningServer;
let browser!: DirectWebDriver;
let fixture: TauriShellFixture;
let stationOrigin = 'tauri://localhost';
let hostileBundle = '';
const hits: AttackHits = {
  blockedFetch: 0,
  secretApi: 0,
  requests: [],
  unexpectedRequests: [],
};

function send(
  response: import('node:http').ServerResponse,
  status: number,
  body: string,
  contentType = 'application/json',
) {
  response.writeHead(status, {
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Origin': stationOrigin,
    'Cache-Control': 'no-store',
    'Content-Type': contentType,
  });
  response.end(body);
}

function json(response: import('node:http').ServerResponse, value: unknown) {
  send(response, 200, JSON.stringify(value));
}

async function listen(
  port: number,
  handler: RequestListener,
): Promise<ListeningServer> {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Tauri shell fixture did not receive a TCP port.');
  }
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

async function close(server: Server | undefined) {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function paneCatalog() {
  const contribution = {
    id: `plugin:${PLUGIN_NAME}:${DECLARED_SLUG}`,
    version: '1.0.0',
    sourceIdentity: {
      id: PLUGIN_NAME,
      kind: 'remote',
      source: `plugins/${PLUGIN_NAME}`,
    },
    provenance: { origin: 'plugin', pluginId: PLUGIN_NAME },
  };
  return {
    projectId: 'project-hostile',
    // The catalog route answers `projectSlug: project.slug` beside the id
    // (`src-server/routes/projects/projects.ts`), and since #1451 the pane
    // route REQUIRES it: a plugin pane whose catalog carries no slug renders
    // "This plugin pane is missing its Project or plugin." instead of the
    // frame. This fixture predates that change and
    // was never updated, so the hostile pane stopped mounting and the
    // containment proof below stopped running at all (#2089).
    projectSlug: 'hostile',
    descriptors: [
      {
        id: 'hostile-pane',
        name: 'Hostile plugin',
        provenance: contribution.provenance,
        description: 'hostile proof',
        renderer: { kind: 'plugin-component', name: DECLARED_SLUG },
        rendererId: 'hostile-renderer',
        rendererProvenance: contribution.provenance,
        placement: { supportedRegions: ['standalone'] },
        lifecycle: { stage: 'stable' },
        modes: [{ id: 'default' }],
      },
    ],
    instances: [
      {
        descriptorId: 'hostile-pane',
        instanceId: 'hostile-instance',
        version: '1.0.0',
        stateKey: 'hostile',
        boundContext: { projectId: 'project-hostile', contribution },
      },
    ],
    availability: [
      {
        descriptorId: 'hostile-pane',
        instanceId: 'hostile-instance',
        input: {
          rollout: 'available',
          distribution: 'enabled',
          renderer: 'unknown',
          context: {},
        },
      },
    ],
  };
}

const hostileProject = {
  id: 'project-hostile',
  slug: 'hostile',
  name: 'Hostile plugin proof',
  icon: 'H',
  description: 'Real Tauri plugin containment fixture',
  hasWorkingDirectory: false,
  layoutCount: 1,
  hasKnowledge: false,
  createdAt: '2026-08-29T00:00:00Z',
  updatedAt: '2026-08-29T00:00:00Z',
};

const hostileLayout = {
  id: 'layout-hostile-proof',
  slug: 'proof',
  projectSlug: hostileProject.slug,
  type: 'dashboard',
  name: 'Plugin containment proof',
  icon: 'H',
};

function remoteResponse(
  request: import('node:http').IncomingMessage,
  response: import('node:http').ServerResponse,
) {
  const pathname = new URL(request.url ?? '/', remote.origin).pathname;
  hits.requests.push(
    `${request.method ?? 'GET'} ${pathname} origin=${String(request.headers.origin ?? 'none')}`,
  );
  if (request.method === 'OPTIONS') return send(response, 204, '');
  if (pathname === '/.well-known/station/v1') {
    return json(response, {
      schemaVersion: 1,
      environmentId: '11111111-1111-4111-8111-111111111111',
      authentication: { scheme: 'bearer', protocolVersion: 1 },
      transports: { http: 1, sse: 1, websocket: 1 },
      compatibility: E2E_STATION_COMPATIBILITY,
      capabilities: E2E_STATION_CAPABILITIES,
    });
  }
  if (pathname === '/api/system/identity') {
    return json(response, {
      instanceId: 'tauri-plugin-security-proof',
      sha: '2222222222222222222222222222222222222222',
      bootId: 'tauri-plugin-security-proof-boot',
    });
  }
  if (pathname === '/api/system/status') {
    return json(response, {
      ready: true,
      acp: { connected: false, connections: [] },
      clis: {},
      prerequisites: [],
      providers: {
        configuredChatReady: true,
        configured: [],
        detected: { ollama: false, bedrock: false },
      },
    });
  }
  if (pathname === '/api/plugins') {
    return json(response, {
      plugins: [
        {
          name: PLUGIN_NAME,
          version: '1.0.0',
          hasBundle: true,
          layout: { slug: DECLARED_SLUG },
          permissions: { granted: ['network.fetch'] },
        },
      ],
    });
  }
  if (pathname === `/api/plugins/${PLUGIN_NAME}/bundle.js`) {
    return send(response, 200, hostileBundle, 'application/javascript');
  }
  if (pathname === `/api/plugins/${PLUGIN_NAME}/bundle.css`) {
    return send(response, 200, '', 'text/css');
  }
  if (pathname === '/api/secret') {
    hits.secretApi += 1;
    return json(response, { secret: 'should-not-be-reachable' });
  }
  if (pathname === '/api/config/app' || pathname === '/config/app') {
    return json(response, {
      success: true,
      data: { pluginFrameOrigin: frame.origin },
    });
  }
  if (pathname === '/api/projects/hostile/panes') {
    return json(response, { success: true, data: paneCatalog() });
  }
  if (pathname === '/api/usage-telemetry/disclosure') {
    return json(response, {
      success: true,
      data: { acknowledged: true, events: {} },
    });
  }
  if (pathname === '/api/auth/status') {
    return json(response, { authenticated: true });
  }
  if (pathname === '/api/branding') {
    return json(response, { success: true, data: {} });
  }
  if (pathname === '/api/projects') {
    return json(response, { success: true, data: [hostileProject] });
  }
  if (pathname === '/api/projects/hostile') {
    return json(response, { success: true, data: hostileProject });
  }
  if (pathname === '/api/projects/hostile/layouts') {
    return json(response, { success: true, data: [hostileLayout] });
  }
  if (pathname === '/api/projects/hostile/layouts/proof') {
    return json(response, {
      success: true,
      data: { ...hostileLayout, config: { tabs: [] } },
    });
  }
  if (pathname === '/api/events' || pathname === '/events') {
    return send(response, 204, '');
  }
  const route = `${request.method ?? 'GET'} ${pathname}`;
  if (unavailableFixtureRoutes.has(route)) {
    return send(
      response,
      503,
      JSON.stringify({
        success: false,
        error: 'This service is unavailable in the plugin containment fixture',
      }),
    );
  }
  hits.unexpectedRequests.push(route);
  return send(
    response,
    501,
    JSON.stringify({ success: false, error: 'Unmodeled fixture request' }),
  );
}

async function setUp() {
  fixture = await startTauriShellFixture();
  browser = fixture.driver;
  blocked = await listen(fixture.blockedPort, (_request, response) => {
    hits.blockedFetch += 1;
    send(response, 200, 'blocked target reached', 'text/plain');
  });
  frame = await listen(fixture.framePort, (request, response) => {
    const pathname = new URL(request.url ?? '/', frame.origin).pathname;
    if (pathname !== '/plugin-host/frame') {
      return send(response, 404, 'Not found', 'text/plain');
    }
    return send(
      response,
      200,
      buildPluginHostFrameDocument('tauri-shell-proof', [stationOrigin]),
      'text/html',
    );
  });
  remote = await listen(fixture.remotePort, remoteResponse);
  const hostileSource = `
    let parentTauri = 'not-attempted';
    try {
      void window.parent.__TAURI_INTERNALS__.invoke('plugin:fs|read_file', {});
      parentTauri = 'reachable';
    } catch (error) {
      parentTauri = 'blocked:' + String(error && error.name);
    }
    document.documentElement.dataset.parentTauri = parentTauri;
    const ownIpc = window.__TAURI_INTERNALS__?.invoke;
    const nativeUri = typeof ownIpc === 'function'
      ? window.__TAURI_INTERNALS__.convertFileSrc('bundled_server_status', 'ipc')
      : null;
    const report = (transport, details = {}) => {
      window.parent.postMessage({ method: 'fill', params: {
        ...details, transport, parentTauri,
        height: parentTauri === 'blocked:SecurityError' &&
          (transport === 'bridge-absent' || transport === 'csp-blocked') ? 721 : 999
      } }, '*');
    };
    addEventListener('securitypolicyviolation', (event) => {
      if (event.blockedURI === nativeUri && event.effectiveDirective === 'connect-src') {
        report('csp-blocked', { blockedUri: event.blockedURI });
      }
    });
    if (typeof ownIpc === 'function') {
      ownIpc('bundled_server_status').then(
        () => report('reachable'),
        (error) => report('rejected', { reason: String(error) })
      );
    } else {
      report('bridge-absent');
    }
    try { window.top.localStorage.setItem(${JSON.stringify(PWNED_KEY)}, '1'); } catch {}
    try { window.top.document.body.setAttribute('data-plugin-pwned', '1'); } catch {}
    try { fetch(${JSON.stringify(`${blocked.origin}/exfiltrate`)}).catch(() => {}); } catch {}
    window.parent.postMessage({ method: 'api-request', params: {
      id: 'over-scoped', permission: 'network.fetch', path: '/api/secret', method: 'POST'
    } }, '*');
    window.parent.postMessage({ method: 'navigate', params: { target: '/settings' } }, '*');
    document.documentElement.dataset.hostileComplete = 'true';
    window.__station_ai_plugins = {
      [${JSON.stringify(PLUGIN_NAME)}]: {
        components: { [${JSON.stringify(DECLARED_SLUG)}]: () => null }
      }
    };
  `;
  const bundled = await build({
    stdin: { contents: hostileSource, loader: 'js' },
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    platform: 'browser',
  });
  hostileBundle = bundled.outputFiles[0].text;
}

async function tearDown() {
  await Promise.all([
    close(remote?.server),
    close(frame?.server),
    close(blocked?.server),
  ]);
  await fixture?.stop();
}

async function runProof() {
  const startupDeadline = Date.now() + 120_000;
  // Spans the shell's boot burst, which occupies the WebView main loop that
  // `execute/sync` runs on. The budget is long because the QUEUE is long; the
  // per-attempt bound (SCRIPT_TIMEOUT_MS, 5 s) stays short so this loop gets
  // many attempts inside it rather than one. Measured: at a 120 s per-attempt
  // bound against this 30 s budget, 2 of 10 runs died here on `script
  // timeout` having made exactly one attempt (#2109).
  await browser.waitUntil(
    async () =>
      (await browser.execute(() => document.readyState)) === 'complete',
    { timeout: 120_000, timeoutMsg: 'Tauri document did not become ready.' },
  );
  // Readiness does not imply the host's internals are installed: `readyState`
  // is 'complete' once the document parsed, while `__TAURI_INTERNALS__` is
  // injected by the shell. A bare assertion here is a one-shot read of a
  // value that arrives slightly later, and one run died on exactly that
  // (#2109). Same treatment as its neighbours.
  let mainBridge: string | undefined;
  await browser.waitUntil(
    async () => {
      mainBridge = await browser.execute(
        () =>
          typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
            .__TAURI_INTERNALS__,
      );
      return mainBridge === 'object';
    },
    {
      timeout: Math.min(30_000, Math.max(1, startupDeadline - Date.now())),
      timeoutMsg: 'The Tauri bridge was never installed on the main frame.',
    },
  );
  assert.equal(mainBridge, 'object');
  await browser.waitUntil(
    async () =>
      (await browser.execute(async () => {
        const nativeWindow = window as Window & {
          __TAURI_INTERNALS__: {
            invoke(command: string): Promise<{ phase: string }>;
          };
        };
        return (
          await nativeWindow.__TAURI_INTERNALS__.invoke('bundled_server_status')
        ).phase;
      })) === 'running',
    {
      timeout: Math.max(1, startupDeadline - Date.now()),
      timeoutMsg: 'Fixture sidecar never became ready.',
    },
  );
  stationOrigin = await browser.execute(() =>
    window.location.origin === 'null'
      ? 'tauri://localhost'
      : window.location.origin,
  );
  await browser.execute(
    ({
      remoteOrigin,
      frameOrigin,
      pwnedKey,
    }: {
      remoteOrigin: string;
      frameOrigin: string;
      pwnedKey: string;
    }) => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
      localStorage.removeItem(pwnedKey);
      localStorage.removeItem('station-connect-connections');
      localStorage.removeItem('station-connect-connections-active');
      localStorage.setItem(
        'station:plugin-registry:remote-bundles-allowed:station-profile:remote-plugin-proof',
        remoteOrigin,
      );
      localStorage.setItem('plugin-host-frame-origin', frameOrigin);
    },
    {
      remoteOrigin: remote.origin,
      frameOrigin: frame.origin,
      pwnedKey: PWNED_KEY,
    },
  );

  assert.equal(
    await browser.execute(
      (key: string) => localStorage.getItem(key),
      PWNED_KEY,
    ),
    null,
  );

  const panePath =
    '/projects/hostile/layouts/proof/panes/hostile-pane/hostile-instance';
  await browser.navigate(new URL(panePath, stationOrigin).href);
  await browser.waitUntil(
    async () =>
      (await browser.execute(
        () =>
          typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
            .__TAURI_INTERNALS__,
      )) === 'object',
    {
      timeout: 20_000,
      timeoutMsg: 'Tauri core bridge did not return after fixture reload.',
    },
  );
  const managerSelector = '[data-testid="app-toolbar-connection"]';
  await browser.waitUntil(
    () =>
      browser.execute((selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return Boolean(element && element.getClientRects().length > 0);
      }, managerSelector),
    { timeout: 20_000, timeoutMsg: 'Station manager button was not visible.' },
  );
  const managerElement = await browser.findElement(managerSelector);
  assert.ok(
    managerElement,
    'Station manager control disappeared before input.',
  );
  await browser.clickElement(managerElement);
  const selectRemoteSelector =
    'button[role="menuitemradio"][aria-label^="remote-plugin-proof — "]';
  await browser.waitUntil(
    () =>
      browser.execute((selector: string) => {
        const element = document.querySelector<HTMLElement>(selector);
        return Boolean(
          element &&
            element.getClientRects().length > 0 &&
            !element.hasAttribute('disabled') &&
            element.getAttribute('aria-disabled') !== 'true',
        );
      }, selectRemoteSelector),
    { timeout: 20_000, timeoutMsg: 'Remote profile button was not visible.' },
  );
  const remoteElement = await browser.findElement(selectRemoteSelector);
  assert.ok(remoteElement, 'Remote Station disappeared before input.');
  await browser.execute((frameOrigin: string) => {
    addEventListener('message', (event) => {
      const pluginFrame = document.querySelector<HTMLIFrameElement>(
        'iframe[title="Plugin: hostile-panel"]',
      );
      if (
        event.data?.method === 'fill' &&
        event.origin === frameOrigin &&
        event.source === pluginFrame?.contentWindow
      ) {
        const proofWindow = window as unknown as { __pluginProof?: unknown[] };
        proofWindow.__pluginProof ??= [];
        proofWindow.__pluginProof.push(event.data.params);
      }
    });
  }, frame.origin);
  await browser.clickElement(remoteElement);
  try {
    await browser.waitUntil(async () => hits.requests.length > 0, {
      timeout: 5_000,
      timeoutMsg: 'Selecting the remote profile made no handshake request.',
    });
  } catch (error) {
    const selectionState = await browser.execute(() => ({
      body: document.body.innerText.slice(0, 1_500),
      activeConnection: localStorage.getItem(
        'station-connect-connections-active',
      ),
    }));
    const nativeState = await browser.execute(async () => {
      const invoke = (
        window as unknown as {
          __TAURI_INTERNALS__: {
            invoke<T>(command: string): Promise<T>;
          };
        }
      ).__TAURI_INTERNALS__.invoke;
      return {
        profiles: await invoke<string>('station_profile_store_read'),
        bundled: await invoke<unknown>('bundled_server_status'),
      };
    });
    throw new Error(
      `Remote profile selection produced no request: ${JSON.stringify({
        ...selectionState,
        ariaPressed: await browser.execute(
          (selector: string) =>
            document.querySelector(selector)?.getAttribute('aria-pressed') ??
            null,
          selectRemoteSelector,
        ),
        fixtureRequests: hits.requests,
        nativeState,
        remoteOrigin: remote.origin,
      })}`,
      { cause: error },
    );
  }
  await browser.execute(() => {
    (
      window as unknown as { __tauriShellErrors?: string[] }
    ).__tauriShellErrors = [];
    window.addEventListener('error', (event) => {
      (
        window as unknown as { __tauriShellErrors: string[] }
      ).__tauriShellErrors.push(String(event.error ?? event.message));
    });
    window.addEventListener('unhandledrejection', (event) => {
      (
        window as unknown as { __tauriShellErrors: string[] }
      ).__tauriShellErrors.push(String(event.reason));
    });
  });
  // The embedded macOS driver executes element lookup on the WebView's main
  // loop. Give the lazy isolation chunk one command-free turn to resolve;
  // tight findElement polling can otherwise starve the very asset load it is
  // waiting to observe.
  await browser.pause(2_000);
  const outerFrameSelector = `iframe[title="Plugin: ${DECLARED_SLUG}"]`;
  try {
    await browser.waitUntil(
      async () =>
        await browser.execute(
          (selector: string) => Boolean(document.querySelector(selector)),
          outerFrameSelector,
        ),
      { timeout: 10_000, timeoutMsg: 'Plugin frame did not enter the DOM.' },
    );
  } catch (error) {
    const state = await browser.execute(() => ({
      body: document.body.innerText.slice(0, 2_000),
      iframes: [...document.querySelectorAll('iframe')].map((entry) => ({
        src: entry.src,
        title: entry.title,
      })),
      paneHtml:
        document
          .querySelector('[data-workspace-pane-route]')
          ?.innerHTML.slice(0, 5_000) ?? null,
      errors:
        (window as unknown as { __tauriShellErrors?: string[] })
          .__tauriShellErrors ?? [],
      pluginProof: (window as unknown as { __pluginProof?: unknown })
        .__pluginProof,
      resources: performance
        .getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((name) => name.includes('PluginFrameHost')),
      location: window.location.href,
      activeConnection: localStorage.getItem(
        'station-connect-connections-active',
      ),
    }));
    throw new Error(
      `Hostile plugin frame did not mount: ${JSON.stringify({
        ...state,
        fixtureRequests: hits.requests,
      })}`,
      { cause: error },
    );
  }
  await browser.waitUntil(
    async () =>
      (await browser.execute((selector: string) => {
        const frame = document.querySelector<HTMLElement>(selector);
        return frame ? Number.parseInt(getComputedStyle(frame).height, 10) : 0;
      }, outerFrameSelector)) === 721,
    {
      timeout: 20_000,
      timeoutMsg:
        'Hostile plugin did not report a cross-origin frame with blocked native transport.',
    },
  );
  assert.equal(
    await browser.execute(
      (selector: string) =>
        document.querySelector(selector)?.getAttribute('sandbox') ?? null,
      outerFrameSelector,
    ),
    'allow-scripts allow-same-origin',
  );

  assert.equal(
    await browser.execute(
      (key: string) => localStorage.getItem(key),
      PWNED_KEY,
    ),
    null,
  );
  assert.equal(
    await browser.execute(() =>
      document.body.getAttribute('data-plugin-pwned'),
    ),
    null,
  );
  assert.match(
    await browser.execute(() => window.location.href),
    new RegExp(panePath),
  );
  assert.deepEqual(
    {
      blockedFetch: hits.blockedFetch,
      secretApi: hits.secretApi,
    },
    { blockedFetch: 0, secretApi: 0 },
  );
  assert.deepEqual(hits.unexpectedRequests, []);

  assert.equal(
    (
      await browser.execute(() =>
        Object.keys(
          (window as unknown as { __station_ai_plugins?: object })
            .__station_ai_plugins ?? {},
        ),
      )
    ).includes(PLUGIN_NAME),
    false,
  );
}

const started = Date.now();
try {
  await setUp();
  await runProof();
  console.log(
    `PASS: hostile plugin containment and native transport denial in ${browser.capabilities.browserName ?? 'webview'} ${browser.capabilities.browserVersion ?? 'unknown'} (${Date.now() - started}ms)`,
  );
} catch (error) {
  const renderer = await browser
    .execute(() => ({
      location: window.location.href,
      body: document.body.innerText.slice(0, 3_000),
      frames: [...document.querySelectorAll('iframe')].map((entry) => ({
        src: entry.src,
        height: getComputedStyle(entry).height,
        style: entry.getAttribute('style'),
      })),
      pluginProof: (window as unknown as { __pluginProof?: unknown })
        .__pluginProof,
      errors:
        (window as unknown as { __tauriShellErrors?: string[] })
          .__tauriShellErrors ?? [],
    }))
    .catch(() => null);
  console.error(
    JSON.stringify({
      renderer,
      fixtureRequests: hits.requests,
      unexpectedRequests: hits.unexpectedRequests,
    }),
  );
  throw error;
} finally {
  await tearDown();
}
