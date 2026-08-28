/**
 * E2E: remote plugin host containment.
 *
 * A remote Station may execute an opted-in plugin only in the isolated plugin
 * frame. This hostile bundle completes by sending `fill`, after attempting
 * every forbidden operation; assertions therefore need no timing sleeps.
 */
import { expect, type Page, test } from '@playwright/test';
import { build } from 'esbuild';
import { buildPluginHostFrameDocument } from '../src-server/runtime/mcp/mcp-ui-frame-server.js';
import {
  E2E_STATION_CAPABILITIES,
  E2E_STATION_COMPATIBILITY,
} from './helpers/current-station-contract';

const REMOTE_ORIGIN = 'https://remote-plugin.station.test';
const FRAME_ORIGIN = 'http://127.0.0.1:9789';
const STATION_ORIGIN = new URL(
  process.env.PW_BASE_URL ?? 'http://127.0.0.1:5173',
).origin;
const BLOCKED_URL = 'https://blocked.plugin.test/exfiltrate';
const PWNED_KEY = 'plugin-host-pwned';
const PLUGIN_NAME = 'hostile-plugin';
const DECLARED_SLUG = 'hostile-panel';

const HOSTILE_PLUGIN_SOURCE = `
  try { window.parent.localStorage.setItem(${JSON.stringify(PWNED_KEY)}, '1'); } catch {}
  try { window.parent.document.body.setAttribute('data-plugin-pwned', '1'); } catch {}
  try { void window.parent.__station_ai_shared; } catch {}
  try { void window.parent.__TAURI__; } catch {}
  try { void window.parent.__TAURI_INTERNALS__.invoke('plugin:fs|read_file', {}); } catch {}
  try { fetch(${JSON.stringify(BLOCKED_URL)}).catch(() => {}); } catch {}
  // archive#4300 deleted the shell's \`api-request\` bridge. These two posts
  // are the message it used to answer, sent from real plugin bytes in a real
  // frame: \`hits.api\` staying 0 is the end-to-end proof that no handler
  // answers the name any more. (The DISCRIMINATING case — a path the bridge
  // authorized rather than refused — is asserted at the unit level, in
  // src-ui/src/__tests__/PluginFrameHost.test.tsx; from out here the fixture's
  // broad /api/** catch-all would swallow it before this counter saw it.)
  window.parent.postMessage({ method: 'api-request', params: {
    id: 'over-scoped', permission: 'network.fetch', path: '/api/secret', method: 'POST'
  } }, '*');
  window.parent.postMessage({ method: 'api-request', params: {
    id: 'traversal', permission: 'network.fetch',
    path: '/api/plugins/hostile-plugin/../../secret', method: 'POST'
  } }, '*');
  window.parent.postMessage({ method: 'navigate', params: { target: '/settings' } }, '*');
  window.parent.postMessage({ method: 'fill', params: { height: 720 } }, '*');
  window.__station_ai_plugins = {
    [${JSON.stringify(PLUGIN_NAME)}]: { components: { [${JSON.stringify(DECLARED_SLUG)}]: () => null } }
  };
`;

/**
 * A BENIGN bundle, written against the pane-host contract (archive#4201 step
 * 3). It raises the contract's one request/response intent and then reports
 * the answer it received back to the shell, so a single assertion covers the
 * whole loop: frame -> host -> Station's own modal -> the user's decision ->
 * back across the boundary -> the frame's own code observing it.
 *
 * That last leg is the one nothing else can prove. The plugin bootstrap
 * document relays plugin->host and, until this slice, dropped everything
 * going the other way -- so a `confirm` that resolves in the shell would look
 * completely implemented from the shell's side while never reaching the pane.
 */
const CONFIRM_PLUGIN_SOURCE = `
  addEventListener('message', (event) => {
    const data = event.data;
    if (!data || typeof data.method !== 'string') return;
    if (data.method === 'pane-host/confirm-result') {
      parent.postMessage({ method: 'toast', params: {
        message: 'answered ' + String(data.params && data.params.decision) +
          ' for ' + String(data.params && data.params.id),
      } }, '*');
    }
  });
  parent.postMessage({ method: 'pane-host/confirm', params: {
    id: 'e2e-confirm', title: 'Restart the runner',
    message: 'This stops the run that is in flight.',
  } }, '*');
  parent.postMessage({ method: 'fill', params: { height: 720 } }, '*');
  window.__station_ai_plugins = {
    [${JSON.stringify(PLUGIN_NAME)}]: { components: { [${JSON.stringify(DECLARED_SLUG)}]: () => null } }
  };
`;

let hostileBundle = '';
let confirmBundle = '';

async function bundleFor(source: string) {
  const result = await build({
    stdin: { contents: source, loader: 'js' },
    bundle: true,
    format: 'iife',
    minify: true,
    write: false,
    platform: 'browser',
  });
  return result.outputFiles[0].text;
}

test.beforeAll(async () => {
  hostileBundle = await bundleFor(HOSTILE_PLUGIN_SOURCE);
  expect(hostileBundle.length).toBeGreaterThan(200);
  confirmBundle = await bundleFor(CONFIRM_PLUGIN_SOURCE);
  expect(confirmBundle.length).toBeGreaterThan(200);
});

function json(data: unknown) {
  return {
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(data),
  };
}

const status = {
  ready: true,
  acp: { connected: false, connections: [] },
  clis: {},
  prerequisites: [],
  providers: {
    configuredChatReady: true,
    configured: [],
    detected: { ollama: false, bedrock: false },
  },
};

async function stageRemotePlugin(page: Page, bundle = hostileBundle) {
  const hits = { blocked: 0, api: 0, navigations: 0 };
  await page.addInitScript(
    ({ remoteOrigin, frameOrigin }) => {
      localStorage.setItem('station:onboarding-setup-dismissed', '1');
      localStorage.setItem(
        'station-connect-connections',
        JSON.stringify([
          {
            id: 'remote-plugin-proof',
            name: 'Remote plugin proof',
            url: remoteOrigin,
            credentialState: 'not-required',
            lastSuccessAt: Date.now(),
            endpoints: [
              { id: 'primary', kind: 'https', httpBaseUrl: remoteOrigin },
            ],
            selectedEndpointId: 'primary',
            environmentId: '11111111-1111-4111-8111-111111111111',
          },
        ]),
      );
      localStorage.setItem(
        'station-connect-connections-active',
        'remote-plugin-proof',
      );
      localStorage.setItem(
        'station:plugin-registry:remote-bundles-allowed:remote-plugin-proof',
        remoteOrigin,
      );
      localStorage.setItem('plugin-host-frame-origin', frameOrigin);
    },
    { remoteOrigin: REMOTE_ORIGIN, frameOrigin: FRAME_ORIGIN },
  );
  await Promise.all([
    // Playwright matches routes LAST-REGISTERED-FIRST, so these broad
    // catch-alls must be registered FIRST: every specific mock below is
    // registered later and therefore wins. Registered last, they swallowed
    // /api/system/status and the app never booted (blank page).
    page.route(`${REMOTE_ORIGIN}/api/projects/**`, (route) => {
      if (
        new URL(route.request().url()).pathname ===
        '/api/projects/hostile/panes'
      ) {
        return route.fallback();
      }
      return route.fulfill(json({ success: true, data: [] }));
    }),
    page.route(`${REMOTE_ORIGIN}/api/**`, (route) => {
      const pathname = new URL(route.request().url()).pathname;
      if (
        pathname === '/api/plugins' ||
        pathname === `/api/plugins/${PLUGIN_NAME}/bundle.js` ||
        pathname === `/api/plugins/${PLUGIN_NAME}/bundle.css` ||
        pathname === '/api/secret' ||
        pathname === '/api/config/app' ||
        pathname === '/api/projects/hostile/panes'
      ) {
        return route.fallback();
      }
      return route.fulfill(json({ success: true, data: [] }));
    }),
    page.route('**/api/system/status', (route) => route.fulfill(json(status))),
    page.route(`${REMOTE_ORIGIN}/.well-known/station/v1`, (route) =>
      route.fulfill({
        json: {
          schemaVersion: 1,
          environmentId: '11111111-1111-4111-8111-111111111111',
          authentication: { scheme: 'bearer', protocolVersion: 1 },
          transports: { http: 1, sse: 1, websocket: 1 },
          compatibility: E2E_STATION_COMPATIBILITY,
          capabilities: E2E_STATION_CAPABILITIES,
        },
      }),
    ),
    // archive#3102: `probeServerConnection` (`src-ui/src/lib/serverHealth.ts`)
    // does not consider the connection healthy on the `.well-known`
    // handshake alone — it also requires this endpoint to answer with a
    // `bootId`. Without it, the broad `/api/**` catch-all above answers
    // `{ success: true, data: [] }` (200, no `bootId`), which
    // `probeServerConnection` reads as `unsupported-capability-version`, so
    // the connection status never reaches `'connected'` and
    // `PluginRegistryGate` suppresses every capability banner. This mock is
    // what turns this fixture's handshake from unhealthy into genuinely
    // healthy — the missing half `archive#3102` was filed to add.
    page.route(`${REMOTE_ORIGIN}/api/system/identity`, (route) =>
      route.fulfill(
        json({
          instanceId: 'plugin-security-proof',
          sha: '2222222222222222222222222222222222222222',
          bootId: 'plugin-security-proof-boot',
        }),
      ),
    ),
    page.route(`${REMOTE_ORIGIN}/api/plugins`, (route) =>
      route.fulfill(
        json({
          plugins: [
            {
              name: PLUGIN_NAME,
              version: '1.0.0',
              hasBundle: true,
              layout: { slug: DECLARED_SLUG },
              // A REAL grant. With `granted: []` this fixture would only
              // ever prove that an ungranted plugin reaches nothing, which
              // was true of every earlier shape of this boundary too.
              permissions: { granted: ['network.fetch'] },
            },
          ],
        }),
      ),
    ),
    page.route(
      `${REMOTE_ORIGIN}/api/plugins/${PLUGIN_NAME}/bundle.js`,
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/javascript',
          body: bundle,
        }),
    ),
    page.route(
      `${REMOTE_ORIGIN}/api/plugins/${PLUGIN_NAME}/bundle.css`,
      (route) =>
        route.fulfill({ status: 200, contentType: 'text/css', body: '' }),
    ),
    page.route(`${REMOTE_ORIGIN}/api/secret`, (route) => {
      hits.api += 1;
      return route.fulfill(json({ secret: 'no' }));
    }),
    page.route(`${BLOCKED_URL}**`, (route) => {
      hits.blocked += 1;
      return route.fulfill({ status: 200, body: 'no' });
    }),
    page.route(`${FRAME_ORIGIN}/plugin-host/frame`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/html',
        body: buildPluginHostFrameDocument('plugin-security-proof', [
          STATION_ORIGIN,
        ]),
      }),
    ),
    page.route(`${REMOTE_ORIGIN}/config/app`, (route) =>
      route.fulfill(
        json({ success: true, data: { pluginFrameOrigin: FRAME_ORIGIN } }),
      ),
    ),
    page.route(`${REMOTE_ORIGIN}/api/config/app`, (route) =>
      route.fulfill(
        json({ success: true, data: { pluginFrameOrigin: FRAME_ORIGIN } }),
      ),
    ),
    page.route(`${REMOTE_ORIGIN}/api/projects/hostile/panes`, (route) =>
      route.fulfill(json({ success: true, data: paneCatalog() })),
    ),
    page.route(`${REMOTE_ORIGIN}/api/usage-telemetry/disclosure`, (route) =>
      route.fulfill(
        json({ success: true, data: { acknowledged: true, events: {} } }),
      ),
    ),
    page.route('**/api/branding', (route) =>
      route.fulfill(json({ success: true, data: {} })),
    ),
    page.route('**/api/auth/status', (route) =>
      route.fulfill(json({ authenticated: true })),
    ),
    page.route('**/api/events', (route) => route.abort()),
    page.route('**/events', (route) => route.abort()),
  ]);
  await page.exposeFunction('recordPluginNavigation', () => {
    hits.navigations += 1;
  });
  // archive#3323 routed plugin navigation to the real seam, so the containment
  // claim is now observed at the effect — a history entry for the hostile
  // bundle's target — rather than at a CustomEvent nothing consumed.
  await page.addInitScript(() => {
    const pushState = window.history.pushState.bind(window.history);
    window.history.pushState = ((
      data: unknown,
      unused: string,
      url?: string | URL | null,
    ) => {
      // An observer must never be able to break the app it observes: a URL
      // this wrapper cannot parse is not a reason for pushState to throw.
      try {
        if (
          url &&
          new URL(String(url), window.location.origin).pathname === '/settings'
        ) {
          void (window as any).recordPluginNavigation();
        }
      } catch {
        /* unparseable target: not the navigation under observation */
      }
      return pushState(data as never, unused, url as never);
    }) as typeof window.history.pushState;
  });
  return hits;
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
    projectId: 'hostile',
    descriptors: [
      {
        id: 'hostile-pane',
        name: 'Hostile plugin',
        // candidateFor() builds contributorProvenance from descriptor.provenance;
        // rendererProvenance is only read for ALTERNATIVE renderers.
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
        boundContext: { contribution },
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

async function openHostilePlugin(page: Page) {
  await page.goto('/');
  await expect
    .poll(() => page.getByTitle(`Plugin: ${DECLARED_SLUG}`).count(), {
      timeout: 10_000,
    })
    .toBe(0);
  await page.goto(
    '/projects/hostile/layouts/proof/panes/hostile-pane/hostile-instance',
  );
  const frame = page.getByTitle(`Plugin: ${DECLARED_SLUG}`);
  await expect(frame).toBeVisible({ timeout: 10_000 });
  await expect
    .poll(() =>
      frame.evaluate((el) =>
        Number.parseInt((el as HTMLIFrameElement).style.height || '0', 10),
      ),
    )
    .toBeGreaterThan(600);
  return frame;
}

test.describe('isolated remote plugin host security', () => {
  test('contains every hostile plugin attack and rejects spoofed host messages', async ({
    page,
  }) => {
    const hits = await stageRemotePlugin(page);
    const frame = await openHostilePlugin(page);
    await page.evaluate(() => {
      window.postMessage({ method: 'fill', params: { height: 1500 } }, '*');
    });
    expect(
      await frame.evaluate((el) => (el as HTMLIFrameElement).style.height),
    ).toBe('720px');
    expect(hits).toEqual({ blocked: 0, api: 0, navigations: 0 });
    expect(
      await page.evaluate((key) => localStorage.getItem(key), PWNED_KEY),
    ).toBeNull();
    expect(
      await page.locator('body').getAttribute('data-plugin-pwned'),
    ).toBeNull();
    // The parent legitimately hosts the shared runtime for TRUSTED plugins;
    // the property under proof is that the sandboxed frame cannot reach it.
    // The frame's attempt raises a cross-origin SecurityError (same mechanism
    // that denied window.parent.localStorage above), so the honest assertion
    // is that no isolated plugin ever executed in the parent realm.
    expect(
      await page.evaluate(() =>
        Object.keys((window as any).__station_ai_plugins ?? {}),
      ),
    ).not.toContain(PLUGIN_NAME);
    // A native-bridge assertion cannot be written from OUT here: reading the
    // frame's contentWindow across origins is itself blocked (SecurityError) -
    // which is the isolation working. The hostile bundle attempts
    // window.parent.__TAURI__ and __TAURI_INTERNALS__.invoke above; observing
    // that attempt fail requires running this suite INSIDE the real WebView,
    // tracked in archive#2495. Until that harness exists, native Stations stay
    // on the consent override rather than claiming an unproven boundary.
  });

  // archive#3102 (un-fixme'd — was `test.fixme` with no tracking issue).
  //
  // The mismatch CONTRACT (an undeclared export marks the plugin failed and is
  // never silently trusted) is proven in src-ui/src/__tests__/PluginFrameHost.test.tsx.
  // Proving its BANNER surface end-to-end additionally requires a fully healthy
  // staged remote connection: PluginRegistryGate deliberately suppresses
  // capability banners whenever the connection is unhealthy (archive#2455), and
  // this fixture's handshake used to leave the connection in a compat-error
  // state — `probeServerConnection` never got a `bootId` from
  // `/api/system/identity` (it fell through to the broad `/api/**` catch-all
  // above, which answers with no `bootId`), so it never reported
  // `'connected'`. `stageRemotePlugin` now mocks that endpoint with a real
  // `bootId`, which is what makes this test discriminating rather than
  // theatre: with the healthy handshake staged, "the banner never appears"
  // can only mean the mismatch went undetected, never "suppressed because
  // unhealthy". Negative control (run in the E2E lane, not from a unit-test
  // sandbox): comment out the `if (!exports.includes(plugin.declaredSlug))`
  // check in `PluginRegistry.ts`'s `onObservation` callback (~line 562) —
  // this test must go red. If it stays green, the healthy-handshake staging
  // above did not actually work and this is still theatre.
  test('turns a declaration-observation mismatch into a visible load failure', async ({
    page,
  }) => {
    const mismatch = hostileBundle.replace(DECLARED_SLUG, 'undeclared-export');
    await stageRemotePlugin(page, mismatch);
    await openHostilePlugin(page);
    // Several alerts can be live (connection/compat chrome); assert the
    // extension-load failure specifically rather than whichever renders first.
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'could not load the extension bundle' }),
    ).toContainText(
      `Station could not load the extension bundle for ${PLUGIN_NAME}`,
      // The gate suppresses capability banners for one cycle after a
      // connection settles (`justReconnected`), and connection status polls
      // every 10s - so this must outlast a poll cycle, not race it.
      { timeout: 20_000 },
    );
  });
});

/**
 * archive#4201 step 3: the pane-host contract, across the iframe boundary.
 *
 * The unit suites prove the shell's half — the adapter decodes, the modal is
 * Station's, the decision resolves. None of them can prove the answer is
 * DELIVERABLE, because none of them runs the real plugin bootstrap document
 * with a real sandboxed inner frame inside it. This does, in both viewports:
 * the confirm chrome is a shared responsive primitive and a phone is where a
 * full-viewport dialog is most likely to be unusable.
 */
function runFrameConfirmJourney(label: string) {
  test(`a frame's confirm is answered by Station's own modal (${label})`, async ({
    page,
  }) => {
    await stageRemotePlugin(page, confirmBundle);
    await openHostilePlugin(page);

    // Station's dialog, in Station's document, attributed to the plugin --
    // not a dialog the plugin drew for itself inside its own frame.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toContainText(`${PLUGIN_NAME}: Restart the runner`);
    await expect(dialog).toContainText('This stops the run that is in flight.');

    await dialog.getByRole('button', { name: 'Confirm' }).click();

    // The frame's own code saw the decision. Getting here means the answer
    // crossed back down through the bootstrap relay and the plugin acted on
    // it -- a leg that did not exist before this slice.
    await expect(
      page.getByText(`${PLUGIN_NAME}: answered confirmed for e2e-confirm`),
    ).toBeVisible({ timeout: 10_000 });
    await expect(dialog).toBeHidden();
  });
}

test.describe('the pane-host contract across the frame boundary', () => {
  runFrameConfirmJourney('desktop');

  test.describe('on a phone', () => {
    test.use({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    runFrameConfirmJourney('390x844');
  });
});
