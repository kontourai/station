/**
 * archive#3677 inverted this file's original claim. The old test modeled two
 * Sec-Fetch headers as SUFFICIENT to approve a trusted-permission grant from
 * the main origin — exactly the property that let same-origin plugin code
 * approve itself. The contract now: the main API only OPENS requests and
 * answers status polls; deciding requires the distinct-origin consent
 * listener (exact Origin + one-use nonce + authenticated consent session +
 * target revalidation), and the old same-origin review/approve/deny paths
 * are GONE, not fallback-preserved.
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { bindRuntimeLocalOperator } from '../../../security/runtime-request-security.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { ConsentCommitRefusedError } from '../../../services/consent/consent-transactions.js';
import { hasGrant } from '../../../services/plugins/plugin-permissions.js';
import { getInternalApiToken } from '../../../utils/internal-api-token.js';
import { registerPluginHostApprovalRoutes } from '../plugin-host-approval-routes.js';

const CONSENT_PORT = 4977;
const CONSENT_HOST = `localhost:${CONSENT_PORT}`;
const OPERATOR_CREDENTIAL = 'O'.repeat(43);

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function setup(options: { withChannel?: boolean } = {}) {
  const projectHomeDir = mkdtempSync(join(tmpdir(), 'station-host-approval-'));
  cleanup.push(projectHomeDir);
  const pluginsDir = join(projectHomeDir, 'plugins');
  const pluginDir = join(pluginsDir, 'server-plugin');
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name: 'server-plugin',
      displayName: 'Server Plugin',
      serverModule: './plugin.mjs',
      version: '1.0.0',
    }),
  );
  writeFileSync(
    join(pluginDir, 'plugin.mjs'),
    'export const behavior = "reviewed";\n',
  );
  const withChannel = options.withChannel ?? true;
  const channel = withChannel ? new ConsentChannelService() : undefined;
  channel?.markListening(CONSENT_PORT);
  const consentApp = channel
    ? createConsentApp({
        channel,
        credentials: {
          verifyOperatorCredential: (candidate) =>
            candidate === OPERATOR_CREDENTIAL,
          identifyDevice: () => null,
        },
      })
    : undefined;
  const app = new Hono();
  const emit = vi.fn();
  registerPluginHostApprovalRoutes(app, {
    eventBus: { emit } as any,
    pluginsDir,
    projectHomeDir,
    consentChannel: channel,
  });
  return { app, consentApp, channel, emit, projectHomeDir, pluginDir };
}

async function createApproval(app: Hono) {
  const response = await app.request('/host-approvals', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      host: 'localhost:3141',
    },
    body: JSON.stringify({
      pluginName: 'server-plugin',
      permissions: ['plugin.server'],
    }),
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    approval: { id: string; status: string; reviewUrl: string };
  };
  return { approval: body.approval, response };
}

describe('plugin host approval routes (consent-transaction consumer)', () => {
  test('opening a request mints an ABSOLUTE review URL on the consent origin, preserving the request-visible hostname', async () => {
    const { app } = setup();
    const { approval, response } = await createApproval(app);
    expect(approval.status).toBe('pending');
    expect(approval.reviewUrl).toBe(
      `http://localhost:${CONSENT_PORT}/consent/${approval.id}`,
    );
    // The transaction-bound consent session rides along for bearer-only UIs.
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('station-consent=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/consent');
  });

  test('station#3752: through the UI proxy, the review URL names the BROWSER host, not the upstream the proxy dialled', async () => {
    const { app } = setup();
    // Exactly what `proxyToBackend` sends: Host rewritten to the upstream,
    // the browser's own Host preserved in the attested header, the per-boot
    // internal token, and a loopback socket. The pre-#3752 code read `host`
    // and minted http://127.0.0.1:<port>/consent/<id> — a host the browser
    // holds no transaction cookie for (cookies are scoped by host), so the
    // review page refused every operator and no plugin could be granted
    // trusted access. The old fixture dialled the route directly and could
    // never see it.
    const response = await app.request(
      '/host-approvals',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: '127.0.0.1:3141',
          'x-station-proxy-forwarded-host': 'localhost:3000',
          'x-station-internal-token': getInternalApiToken(),
        },
        body: JSON.stringify({
          pluginName: 'server-plugin',
          permissions: ['plugin.server'],
        }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approval: { id: string; reviewUrl: string };
    };
    expect(body.approval.reviewUrl).toBe(
      `http://localhost:${CONSENT_PORT}/consent/${body.approval.id}`,
    );
  });

  test('station#3752: an UNATTESTED forwarded host is ignored — it is not x-forwarded-host', async () => {
    const { app } = setup();
    const response = await app.request(
      '/host-approvals',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost:3141',
          // No internal token: a direct caller spelling the header.
          'x-station-proxy-forwarded-host': 'attacker.example:3000',
        },
        body: JSON.stringify({
          pluginName: 'server-plugin',
          permissions: ['plugin.server'],
        }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approval: { id: string; reviewUrl: string };
    };
    expect(body.approval.reviewUrl).toBe(
      `http://localhost:${CONSENT_PORT}/consent/${body.approval.id}`,
    );
  });

  test('hostname fidelity: a LAN-visible hostname is preserved, only the port changes', async () => {
    const { app } = setup();
    const response = await app.request('/host-approvals', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        host: '192.168.1.20:3141',
      },
      body: JSON.stringify({
        pluginName: 'server-plugin',
        permissions: ['plugin.server'],
      }),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approval: { id: string; reviewUrl: string };
    };
    expect(body.approval.reviewUrl).toBe(
      `http://192.168.1.20:${CONSENT_PORT}/consent/${body.approval.id}`,
    );
  });

  test('INJECTION 6: the old same-origin approval path is GONE — the headers-only POST that used to grant now hits no route', async () => {
    const { app, projectHomeDir } = setup();
    const { approval } = await createApproval(app);
    // The exact request the retired test proved SUFFICIENT to grant.
    const oldApprove = await app.request(
      `/host-approvals/${approval.id}/approve`,
      {
        method: 'POST',
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' },
      },
    );
    expect(oldApprove.status).toBe(404);
    expect(hasGrant(projectHomeDir, 'server-plugin', 'plugin.server')).toBe(
      false,
    );
    const oldReview = await app.request(
      `/host-approvals/${approval.id}/review`,
    );
    expect(oldReview.status).toBe(404);
    const oldDeny = await app.request(`/host-approvals/${approval.id}/deny`, {
      method: 'POST',
      headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' },
    });
    expect(oldDeny.status).toBe(404);
  });

  test('the grant only happens through the consent listener: render, nonce, exact origin, authenticated decision', async () => {
    const { app, consentApp, emit, projectHomeDir } = setup();
    const { approval } = await createApproval(app);
    expect(hasGrant(projectHomeDir, 'server-plugin', 'plugin.server')).toBe(
      false,
    );

    const review = await consentApp!.request(`/consent/${approval.id}`, {
      headers: {
        host: CONSENT_HOST,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        cookie: `station-device=${OPERATOR_CREDENTIAL}`,
      },
    });
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html).toContain('Server Plugin');
    expect(html).toContain('plugin.server');
    expect(html).not.toContain('<script');
    const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
    expect(nonce).toBeTruthy();

    const decided = await consentApp!.request(
      `/consent/${approval.id}/decide`,
      {
        method: 'POST',
        headers: {
          host: CONSENT_HOST,
          origin: `http://${CONSENT_HOST}`,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-user': '?1',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `station-device=${OPERATOR_CREDENTIAL}`,
        },
        body: new URLSearchParams({
          decision: 'approve',
          nonce: nonce!,
        }).toString(),
      },
    );
    expect(decided.status).toBe(200);
    expect(hasGrant(projectHomeDir, 'server-plugin', 'plugin.server')).toBe(
      true,
    );
    // The broadcast carries what the commit DERIVED, not just the name
    // (archive#4288, delta review MEDIUM 2): an approval given against a
    // `changed` binding withdraws everything else the plugin held, and a
    // listener must not have to assume an approval only ever adds.
    expect(emit).toHaveBeenCalledWith('plugins:grants-changed', {
      name: 'server-plugin',
      granted: ['plugin.server'],
      withdrawn: [],
    });

    const status = await app.request(`/host-approvals/${approval.id}`);
    expect(await status.json()).toMatchObject({
      approval: { status: 'approved' },
    });
  });

  test('the TOCTOU refusal end to end: a manifest that changed after the request was reviewed grants nothing', async () => {
    const { app, consentApp, pluginDir, projectHomeDir } = setup();
    const { approval } = await createApproval(app);
    const review = await consentApp!.request(`/consent/${approval.id}`, {
      headers: {
        host: CONSENT_HOST,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        cookie: `station-device=${OPERATOR_CREDENTIAL}`,
      },
    });
    const nonce = (await review.text()).match(
      /name="nonce" value="([^"]+)"/,
    )?.[1];

    // The plugin is replaced between review and decision.
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'server-plugin',
        displayName: 'Server Plugin',
        serverModule: './plugin.mjs',
        version: '2.0.0',
      }),
    );

    const decided = await consentApp!.request(
      `/consent/${approval.id}/decide`,
      {
        method: 'POST',
        headers: {
          host: CONSENT_HOST,
          origin: `http://${CONSENT_HOST}`,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-user': '?1',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `station-device=${OPERATOR_CREDENTIAL}`,
        },
        body: new URLSearchParams({
          decision: 'approve',
          nonce: nonce!,
        }).toString(),
      },
    );
    expect(decided.status).toBe(409);
    expect(await decided.text()).toContain('Nothing was granted');
    expect(hasGrant(projectHomeDir, 'server-plugin', 'plugin.server')).toBe(
      false,
    );
  });

  test('INJECTION (review HIGH 1): serverModule content changed between request and decide is refused — and the OLD manifest-projection fingerprint would have passed it', async () => {
    const { app, consentApp, pluginDir, projectHomeDir } = setup();
    const manifestBefore = JSON.parse(
      readFileSync(join(pluginDir, 'plugin.json'), 'utf8'),
    );
    const { approval } = await createApproval(app);
    const review = await consentApp!.request(`/consent/${approval.id}`, {
      headers: {
        host: CONSENT_HOST,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        cookie: `station-device=${OPERATOR_CREDENTIAL}`,
      },
    });
    const nonce = (await review.text()).match(
      /name="nonce" value="([^"]+)"/,
    )?.[1];

    // The attack: while consent is pending, the EXECUTABLE content is
    // replaced (what a `git pull` through the update route can do) while
    // name, displayName, and version all stay byte-identical.
    writeFileSync(
      join(pluginDir, 'plugin.mjs'),
      'export const behavior = "swapped-after-review";\n',
    );

    // Independent proof that the pre-fix fingerprint (a projection of
    // name/displayName/version/permissions) is IDENTICAL across the swap —
    // i.e. the old revalidation would have granted consent to code the user
    // never reviewed.
    const manifestAfter = JSON.parse(
      readFileSync(join(pluginDir, 'plugin.json'), 'utf8'),
    );
    const oldStyleProjection = (manifest: {
      name: string;
      displayName?: string;
      version?: string;
    }) =>
      JSON.stringify({
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version ?? null,
        permissions: ['plugin.server'],
      });
    expect(oldStyleProjection(manifestAfter)).toBe(
      oldStyleProjection(manifestBefore),
    );

    const decided = await consentApp!.request(
      `/consent/${approval.id}/decide`,
      {
        method: 'POST',
        headers: {
          host: CONSENT_HOST,
          origin: `http://${CONSENT_HOST}`,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-user': '?1',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `station-device=${OPERATOR_CREDENTIAL}`,
        },
        body: new URLSearchParams({
          decision: 'approve',
          nonce: nonce!,
        }).toString(),
      },
    );
    expect(decided.status).toBe(409);
    expect(await decided.text()).toContain('Nothing was granted');
    expect(hasGrant(projectHomeDir, 'server-plugin', 'plugin.server')).toBe(
      false,
    );
  });

  test('INJECTION (review MED 5): varying the body-supplied pluginName does NOT mint a fresh rate budget', async () => {
    // The store keys creation on the authenticated surface, not the
    // caller-claimed plugin. Eleven distinct installed plugins: the first
    // ten consume the ONE shared budget, the eleventh refuses 429 — a
    // caller cannot manufacture budget by naming other plugins.
    const { app, projectHomeDir } = setup();
    const pluginsDir = join(projectHomeDir, 'plugins');
    for (let i = 0; i < 11; i += 1) {
      const dir = join(pluginsDir, `spam-${i}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'plugin.json'),
        JSON.stringify({
          name: `spam-${i}`,
          serverModule: './plugin.mjs',
          version: '1.0.0',
        }),
      );
      writeFileSync(join(dir, 'plugin.mjs'), `export const n = ${i};\n`);
    }
    for (let i = 0; i < 10; i += 1) {
      const response = await app.request('/host-approvals', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: 'localhost:3141',
        },
        body: JSON.stringify({
          pluginName: `spam-${i}`,
          permissions: ['plugin.server'],
        }),
      });
      expect(response.status).toBe(200);
    }
    const churned = await app.request('/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({
        pluginName: 'spam-10',
        permissions: ['plugin.server'],
      }),
    });
    expect(churned.status).toBe(429);
    expect(((await churned.json()) as { error: string }).error).toContain(
      'Too many approval requests',
    );
  });

  test('denial through the consent listener leaves the trusted permission ungranted', async () => {
    const { app, consentApp, projectHomeDir } = setup();
    const { approval } = await createApproval(app);
    const review = await consentApp!.request(`/consent/${approval.id}`, {
      headers: {
        host: CONSENT_HOST,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        cookie: `station-device=${OPERATOR_CREDENTIAL}`,
      },
    });
    const nonce = (await review.text()).match(
      /name="nonce" value="([^"]+)"/,
    )?.[1];
    const decided = await consentApp!.request(
      `/consent/${approval.id}/decide`,
      {
        method: 'POST',
        headers: {
          host: CONSENT_HOST,
          origin: `http://${CONSENT_HOST}`,
          'sec-fetch-site': 'same-origin',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
          'sec-fetch-user': '?1',
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `station-device=${OPERATOR_CREDENTIAL}`,
        },
        body: new URLSearchParams({
          decision: 'deny',
          nonce: nonce!,
        }).toString(),
      },
    );
    expect(decided.status).toBe(200);
    expect(hasGrant(projectHomeDir, 'server-plugin', 'plugin.server')).toBe(
      false,
    );
    const status = await app.request(`/host-approvals/${approval.id}`);
    expect(await status.json()).toMatchObject({
      approval: { status: 'denied' },
    });
  });

  test('re-requesting an identical pending target reuses the transaction', async () => {
    const { app } = setup();
    const first = await createApproval(app);
    const second = await createApproval(app);
    expect(second.approval.id).toBe(first.approval.id);
  });

  test('invalid requests still refuse: unknown plugin 404s, non-trusted permissions 400', async () => {
    const { app } = setup();
    const missing = await app.request('/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({
        pluginName: 'ghost',
        permissions: ['plugin.server'],
      }),
    });
    expect(missing.status).toBe(404);
    const untrusted = await app.request('/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({
        pluginName: 'server-plugin',
        permissions: ['navigation.dock'],
      }),
    });
    expect(untrusted.status).toBe(400);
  });

  test('INJECTION 5 (route half): with the consent listener unavailable, approvals refuse truthfully while status polling stays up', async () => {
    const { app, channel } = setup();
    const { approval } = await createApproval(app);
    channel!.markUnavailable('The consent listener failed to bind port 4977.');
    const refused = await app.request('/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({
        pluginName: 'server-plugin',
        permissions: ['plugin.server'],
      }),
    });
    expect(refused.status).toBe(503);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain('unavailable');
    expect(body.error).toContain('failed to bind');
    // The main surface stays usable: the existing transaction still polls.
    const status = await app.request(`/host-approvals/${approval.id}`);
    expect(status.status).toBe(200);
  });

  test('station#3731: a native-eligible caller can still ORIGINATE an approval with the listener down, and gets no review URL', async () => {
    const { app, channel } = setup();
    channel!.markUnavailable('The consent listener failed to bind port 4977.');

    // The desktop app: local-grant minted, so it decides in native OS chrome
    // and never needs the browser review page. Refusing it here was what
    // made the native path's listener-independence unreachable — nothing
    // could be created, so there was nothing to decide.
    const request = new Request('http://station.test/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({
        pluginName: 'server-plugin',
        permissions: ['plugin.server'],
      }),
    });
    bindRuntimeLocalOperator(request, {
      credential: 'desktop',
      authority: 'device-credential',
      source: 'bearer',
      locality: 'home-possession',
      mintKind: 'local-grant',
    });
    const response = await app.request(request);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      approval: { id: string; reviewUrl: string | null };
    };
    expect(body.approval.id).toEqual(expect.any(String));
    // No browser way in — stated, not faked. A client without the native
    // path must read this as a refusal rather than open a popup at nothing.
    expect(body.approval.reviewUrl).toBeNull();

    // The transaction is real and decidable: it polls like any other.
    const status = await app.request(`/host-approvals/${body.approval.id}`);
    expect(status.status).toBe(200);
  });

  test('station#3731: a browser caller is still refused with the listener down — it has no way to decide', async () => {
    const { app, channel } = setup();
    channel!.markUnavailable('The consent listener failed to bind port 4977.');

    // A ui-bootstrap mint proves home possession but lives in browser JS,
    // so it cannot use the native broker and must not be handed a
    // transaction it can never decide.
    const request = new Request('http://station.test/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({
        pluginName: 'server-plugin',
        permissions: ['plugin.server'],
      }),
    });
    bindRuntimeLocalOperator(request, {
      credential: 'host-browser',
      authority: 'device-credential',
      source: 'session',
      locality: 'home-possession',
      mintKind: 'ui-bootstrap',
    });
    const response = await app.request(request);
    expect(response.status).toBe(503);
    expect((await response.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining('unavailable'),
    });
  });

  test('a runtime with no consent channel at all refuses approvals truthfully', async () => {
    const { app } = setup({ withChannel: false });
    const response = await app.request('/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({
        pluginName: 'server-plugin',
        permissions: ['plugin.server'],
      }),
    });
    expect(response.status).toBe(503);
  });

  /**
   * archive#4288. The commit's `PluginContentUnavailableError` branch is
   * production-reachable: the target is revalidated when the operator decides
   * and the grant is committed immediately after, so a transient read failure
   * in that window (the tree removed, a permissions change, a disk error)
   * lands here. `deps.consentChannel` is an injected optional, so a stub that
   * captures `commitApproval` and invokes it after the tree is gone drives
   * the real callback, the real `grantPermissions`, and the real error
   * mapping — no mocking of the module under test.
   */
  test('station#4288: a tree that becomes unreadable between review and commit refuses the commit with a sentence, and grants nothing', async () => {
    const projectHomeDir = mkdtempSync(
      join(tmpdir(), 'station-host-approval-commit-'),
    );
    cleanup.push(projectHomeDir);
    const pluginsDir = join(projectHomeDir, 'plugins');
    const pluginDir = join(pluginsDir, 'server-plugin');
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name: 'server-plugin',
        displayName: 'Server Plugin',
        serverModule: './plugin.mjs',
        version: '1.0.0',
      }),
    );
    writeFileSync(join(pluginDir, 'plugin.mjs'), 'export const a = 1;\n');

    let commitApproval!: () => Promise<void>;
    const channel = {
      tenantId: 'local',
      state: () => ({ status: 'listening' }),
      reviewUrlFor: () => 'http://localhost:4977/consent/stub',
      store: {
        findPendingByTarget: () => undefined,
        decisionSessionSecretFor: () => undefined,
        create: (request: { commitApproval: () => Promise<void> }) => {
          commitApproval = request.commitApproval;
          return {
            ok: true,
            transaction: { id: 'stub', status: 'pending' },
          };
        },
      },
    };
    const app = new Hono();
    const emit = vi.fn();
    registerPluginHostApprovalRoutes(app, {
      eventBus: { emit } as any,
      pluginsDir,
      projectHomeDir,
      consentChannel: channel as any,
    });
    const opened = await app.request('/host-approvals', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({
        pluginName: 'server-plugin',
        permissions: ['plugin.server'],
      }),
    });
    expect(opened.status).toBe(200);

    // The transient failure: the tree stops being readable after the target
    // was derived and before the operator's decision commits.
    rmSync(pluginDir, { recursive: true, force: true });

    await expect(commitApproval()).rejects.toBeInstanceOf(
      ConsentCommitRefusedError,
    );
    await expect(commitApproval()).rejects.toThrow(
      /installed files could not be read, so nothing was granted/,
    );
    // Fail-closed, not fail-silent: nothing was recorded and nothing was
    // announced as changed.
    expect(hasGrant(projectHomeDir, 'server-plugin', 'plugin.server')).toBe(
      false,
    );
    expect(emit).not.toHaveBeenCalled();
  });
});
