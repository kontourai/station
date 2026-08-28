import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createWorkspaceHomeRoleGrant,
  WORKSPACE_HOME_PROJECTION_FIELDS,
} from '@kontourai/station-contracts/workspace-home-role';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { createConsentApp } from '../../../runtime/consent/consent-listener.js';
import { bindRuntimeLocalOperator } from '../../../security/runtime-request-security.js';
import { ConsentChannelService } from '../../../services/consent/consent-channel.js';
import { DistributionProfileService } from '../../../services/plugins/distribution-profile-service.js';
import {
  computeWorkspaceHomeRoleInstallDigest,
  workspaceHomeRolePath,
  writeWorkspaceHomeRoleGrant,
} from '../../../services/plugins/workspace-home-role-service.js';
import { getInternalApiToken } from '../../../utils/internal-api-token.js';
import { registerPluginHomeRoleRoutes } from '../plugin-home-role-routes.js';

const PLUGIN = 'third-party-home';
const PANE_ID = `${PLUGIN}-home`;

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function writeHomePanePlugin(
  projectHomeDir: string,
  options: { version?: string; bundle?: string } = {},
): string {
  const pluginDir = join(projectHomeDir, 'plugins', PLUGIN);
  mkdirSync(join(pluginDir, 'dist'), { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name: PLUGIN,
      displayName: 'Third-party Home',
      version: options.version ?? '3.1.0',
      workspacePanes: [
        {
          version: '1.0',
          id: PANE_ID,
          name: 'Third-party Home Pane',
          rendererId: `renderer:plugin:${PLUGIN}:home`,
          renderer: { kind: 'plugin-component', name: `${PLUGIN}-surface` },
          requiredRendererCapabilities: ['trusted-plugin-react'],
          placement: { supportedRegions: ['standalone'] },
          modes: [{ id: 'default' }],
          provenance: { origin: 'plugin', pluginId: PLUGIN },
          lifecycle: { stage: 'stable' },
        },
      ],
    }),
  );
  writeFileSync(
    join(pluginDir, 'dist', 'bundle.js'),
    options.bundle ?? 'window.__station_ai_plugins = {};// original bytes',
  );
  return pluginDir;
}

const CONSENT_PORT = 4979;
const CONSENT_HOST = `localhost:${CONSENT_PORT}`;
const OPERATOR_CREDENTIAL = 'O'.repeat(43);

function setup(options: { withChannel?: boolean } = {}) {
  const projectHomeDir = mkdtempSync(join(tmpdir(), 'station-home-role-'));
  cleanup.push(projectHomeDir);
  const pluginsDir = join(projectHomeDir, 'plugins');
  writeHomePanePlugin(projectHomeDir);
  const withChannel = options.withChannel ?? false;
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
  registerPluginHomeRoleRoutes(app, {
    eventBus: { emit } as never,
    pluginsDir,
    projectHomeDir,
    consentChannel: channel,
  });
  return { app, consentApp, channel, emit, projectHomeDir, pluginsDir };
}

/**
 * Writes a grant through the service seam directly, bypassing the consent
 * channel. The channel exists now (the grant-channel suite below drives it
 * end to end); these direct writes keep the status/lapse/revocation tests
 * independent of it, so a channel regression cannot mask a derivation one.
 */
async function grantDirectly(
  projectHomeDir: string,
  pluginsDir: string,
): Promise<void> {
  const entry = new DistributionProfileService(projectHomeDir)
    .listPluginWorkspacePaneContributions()
    .find(
      (candidate) =>
        candidate.pluginName === PLUGIN && candidate.descriptor.id === PANE_ID,
    );
  expect(entry).toBeDefined();
  const digest = computeWorkspaceHomeRoleInstallDigest(pluginsDir, PLUGIN);
  expect(digest).not.toBeNull();
  const grant = createWorkspaceHomeRoleGrant({
    descriptor: entry!.descriptor,
    contribution: entry!.contribution,
    grantedAt: new Date().toISOString(),
    projectionFields: WORKSPACE_HOME_PROJECTION_FIELDS,
  });
  expect(grant).not.toBeNull();
  await writeWorkspaceHomeRoleGrant(projectHomeDir, grant!, digest!);
}

async function readStatus(app: Hono) {
  const response = await app.request('/home-role');
  expect(response.status).toBe(200);
  return ((await response.json()) as { status: Record<string, unknown> })
    .status;
}

describe('the read surface: standing is derived, never stored', () => {
  test('with no record, the status is none', async () => {
    const { app } = setup();
    expect(await readStatus(app)).toEqual({ state: 'none' });
  });

  test('a written grant whose install is unchanged derives granted', async () => {
    const { app, projectHomeDir, pluginsDir } = setup();
    await grantDirectly(projectHomeDir, pluginsDir);
    const status = await readStatus(app);
    expect(status.state).toBe('granted');
    const grant = status.grant as {
      descriptor: { id: string; provenance: { pluginId: string } };
      projectionFields: string[];
    };
    expect(grant.descriptor.id).toBe(PANE_ID);
    expect(grant.descriptor.provenance.pluginId).toBe(PLUGIN);
    expect(grant.projectionFields.length).toBeGreaterThan(10);
  });
});

describe('the grant does not outlive what it approved (derived on every read)', () => {
  test('uninstalling the plugin lapses the grant as plugin-missing', async () => {
    const { app, projectHomeDir, pluginsDir } = setup();
    await grantDirectly(projectHomeDir, pluginsDir);
    rmSync(join(pluginsDir, PLUGIN), { recursive: true, force: true });
    expect(await readStatus(app)).toEqual({
      state: 'lapsed',
      reason: 'plugin-missing',
      paneName: 'Third-party Home Pane',
      pluginId: PLUGIN,
    });
  });

  test('a version change lapses the grant — an update never inherits it', async () => {
    const { app, projectHomeDir, pluginsDir } = setup();
    await grantDirectly(projectHomeDir, pluginsDir);
    writeHomePanePlugin(projectHomeDir, { version: '3.2.0' });
    const status = await readStatus(app);
    expect(status).toMatchObject({
      state: 'lapsed',
      reason: 'version-changed',
    });
  });

  test('a SAME-VERSION byte replacement lapses the grant as code-changed', async () => {
    const { app, projectHomeDir, pluginsDir } = setup();
    await grantDirectly(projectHomeDir, pluginsDir);
    writeHomePanePlugin(projectHomeDir, {
      bundle:
        'window.__station_ai_plugins = {};// same id, same source, same version, different code',
    });
    const status = await readStatus(app);
    expect(status).toMatchObject({ state: 'lapsed', reason: 'code-changed' });
  });

  test('removing the pane from the manifest lapses the grant as pane-missing', async () => {
    const { app, projectHomeDir, pluginsDir } = setup();
    await grantDirectly(projectHomeDir, pluginsDir);
    writeFileSync(
      join(pluginsDir, PLUGIN, 'plugin.json'),
      JSON.stringify({
        name: PLUGIN,
        displayName: 'Third-party Home',
        version: '3.1.0',
        workspacePanes: [],
      }),
    );
    const status = await readStatus(app);
    expect(status).toMatchObject({ state: 'lapsed', reason: 'pane-missing' });
  });

  test('a record written around the constructor that the contract refuses reads as none', async () => {
    const { app, projectHomeDir } = setup();
    // Simulates any writer that is not the constructor: the stored grant is
    // structurally plausible but names an ineligible descriptor.
    writeFileSync(
      workspaceHomeRolePath(projectHomeDir),
      JSON.stringify({
        'home-role': {
          grant: {
            version: '1.0',
            descriptor: { id: PANE_ID, name: 'Forged' },
            instance: { boundContext: { contribution: { id: 'x' } } },
            grantedAt: new Date().toISOString(),
            projectionFields: ['id'],
          },
          installDigest: 'sha256:forged',
        },
      }),
    );
    expect(await readStatus(app)).toEqual({ state: 'none' });
  });

  test('revocation removes the record; what remains is none — the built-in floor', async () => {
    const { app, emit, projectHomeDir, pluginsDir } = setup();
    await grantDirectly(projectHomeDir, pluginsDir);
    const response = await app.request('/home-role', { method: 'DELETE' });
    expect(response.status).toBe(200);
    expect(await readStatus(app)).toEqual({ state: 'none' });
    expect(emit).toHaveBeenCalledWith('plugins:grants-changed', {
      name: 'workspace-home-role',
    });
  });
});

async function openRequest(app: Hono, host = 'localhost:3141') {
  const response = await app.request('/home-role/requests', {
    method: 'POST',
    headers: { 'content-type': 'application/json', host },
    body: JSON.stringify({ pluginName: PLUGIN, paneId: PANE_ID }),
  });
  const body = (await response.json()) as {
    request?: { id: string; status: string; reviewUrl: string };
    error?: string;
  };
  return { response, body };
}

async function decideThroughListener(
  consentApp: Hono,
  id: string,
  decision: 'approve' | 'deny',
) {
  const review = await consentApp.request(`/consent/${id}`, {
    headers: {
      host: CONSENT_HOST,
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
      cookie: `station-device=${OPERATOR_CREDENTIAL}`,
    },
  });
  const html = await review.text();
  const nonce = html.match(/name="nonce" value="([^"]+)"/)?.[1];
  const decided = await consentApp.request(`/consent/${id}/decide`, {
    method: 'POST',
    headers: {
      host: CONSENT_HOST,
      origin: `http://${CONSENT_HOST}`,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'navigate',
      // What a real approve click sends (archive#3752 live trace); the
      // decide guard requires it so "top-level" is derived, not assumed.
      'sec-fetch-dest': 'document',
      'sec-fetch-user': '?1',
      'content-type': 'application/x-www-form-urlencoded',
      cookie: `station-device=${OPERATOR_CREDENTIAL}`,
    },
    body: new URLSearchParams({ decision, nonce: nonce ?? '' }).toString(),
  });
  return { review, html, decided };
}

describe('the grant channel (station#3677 PR 2): distinct-origin consent only', () => {
  test('fails closed with 503 when no consent channel is configured, while read and revoke stay usable', async () => {
    const { app } = setup({ withChannel: false });
    const { response, body } = await openRequest(app);
    expect(response.status).toBe(503);
    expect(body.error).toMatch(/unavailable/i);
    expect(await readStatus(app)).toEqual({ state: 'none' });
  });

  test('fails closed with 503 when the listener is not listening and the caller needs it', async () => {
    const { app, channel } = setup({ withChannel: true });
    channel!.markUnavailable('port in use');
    const { response, body } = await openRequest(app);
    expect(response.status).toBe(503);
    expect(body.error).toMatch(/port in use/);
  });

  test('station#3731: a native-eligible caller still opens a request with the listener down, and gets no review URL', async () => {
    const { app, channel } = setup({ withChannel: true });
    channel!.markUnavailable('port in use');

    // The desktop app decides in native OS chrome, so it never needed the
    // browser review page. Refusing it left the native path with nothing to
    // decide whenever the listener was down.
    const request = new Request('http://station.test/home-role/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({ pluginName: PLUGIN, paneId: PANE_ID }),
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
      request?: { id: string; reviewUrl: string | null };
    };
    expect(body.request?.id).toEqual(expect.any(String));
    expect(body.request?.reviewUrl).toBeNull();
    // Nothing is granted by opening it: the role is still unheld.
    expect(await readStatus(app)).toEqual({ state: 'none' });
  });

  test('opening a request mints an ABSOLUTE review URL on the consent origin, preserving the request-visible hostname', async () => {
    const { app } = setup({ withChannel: true });
    const { response, body } = await openRequest(app, '192.168.1.20:3141');
    expect(response.status).toBe(200);
    expect(body.request?.status).toBe('pending');
    expect(body.request?.reviewUrl).toBe(
      `http://192.168.1.20:${CONSENT_PORT}/consent/${body.request?.id}`,
    );
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('station-consent=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/consent');
  });

  test('station#3752: through the UI proxy this consumer also mints for the BROWSER host', async () => {
    // The sibling of the host-approval test. Both consumers changed, so both
    // are pinned: the review URL must name the browser's host, or the
    // transaction cookie — scoped by host — never reaches the review page.
    const { app } = setup({ withChannel: true });
    const response = await app.request(
      '/home-role/requests',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          host: '127.0.0.1:3141',
          'x-station-proxy-forwarded-host': 'localhost:3000',
          'x-station-internal-token': getInternalApiToken(),
        },
        body: JSON.stringify({ pluginName: PLUGIN, paneId: PANE_ID }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as never,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      request?: { id: string; reviewUrl: string };
    };
    expect(body.request?.reviewUrl).toBe(
      `http://localhost:${CONSENT_PORT}/consent/${body.request?.id}`,
    );
  });

  test('an ineligible pane is refused before any transaction exists', async () => {
    const { app } = setup({ withChannel: true });
    const response = await app.request('/home-role/requests', {
      method: 'POST',
      headers: { 'content-type': 'application/json', host: 'localhost:3141' },
      body: JSON.stringify({ pluginName: PLUGIN, paneId: 'no-such-pane' }),
    });
    expect(response.status).toBe(400);
  });

  test('a second open for the same target reuses the pending transaction', async () => {
    const { app } = setup({ withChannel: true });
    const first = await openRequest(app);
    const second = await openRequest(app);
    expect(second.body.request?.id).toBe(first.body.request?.id);
  });

  test('the review page states what approving does — the pane, the plugin, and the projection fields — with no script', async () => {
    const { app, consentApp } = setup({ withChannel: true });
    const { body } = await openRequest(app);
    const review = await consentApp!.request(`/consent/${body.request!.id}`, {
      headers: {
        host: CONSENT_HOST,
        'sec-fetch-mode': 'navigate',
        'sec-fetch-dest': 'document',
        cookie: `station-device=${OPERATOR_CREDENTIAL}`,
      },
    });
    expect(review.status).toBe(200);
    const html = await review.text();
    expect(html).toContain('Third-party Home Pane');
    expect(html).toContain(PLUGIN);
    // Rider 3, per the projection contract's own consent-surface
    // requirement (workspace-home-role.ts): the list is framed as what the
    // BUILT-IN Home shows, and the granted code's access is stated plainly
    // as unbounded — never the reverse. The archive#3720 review caught the first
    // cut presenting the fields as "readable by the pane".
    expect(html).toContain('what the built-in Home shows today');
    expect(html).toContain('this list is not a limit on it');
    expect(html).not.toMatch(/readable by the home pane/i);
    // One concrete projection line rides through to the page.
    expect(html).toContain('Work item identifiers');
    expect(html).not.toContain('<script');
  });

  test('approving through the listener writes the grant, and status derives granted', async () => {
    const { app, consentApp, emit, projectHomeDir } = setup({
      withChannel: true,
    });
    const { body } = await openRequest(app);
    expect(await readStatus(app)).toEqual({ state: 'none' });

    const { decided } = await decideThroughListener(
      consentApp!,
      body.request!.id,
      'approve',
    );
    expect(decided.status).toBe(200);

    const status = await readStatus(app);
    expect(status.state).toBe('granted');
    expect(emit).toHaveBeenCalledWith('plugins:grants-changed', {
      name: 'workspace-home-role',
    });
    // The status poll the opening UI runs reflects the decision.
    const poll = await app.request(`/home-role/requests/${body.request!.id}`);
    expect(
      ((await poll.json()) as { request: { status: string } }).request,
    ).toMatchObject({ status: 'approved' });
    expect(projectHomeDir).toBeTruthy();
  });

  test('denying grants nothing', async () => {
    const { app, consentApp } = setup({ withChannel: true });
    const { body } = await openRequest(app);
    const { decided } = await decideThroughListener(
      consentApp!,
      body.request!.id,
      'deny',
    );
    expect(decided.status).toBe(200);
    expect(await readStatus(app)).toEqual({ state: 'none' });
  });

  test('TOCTOU: content replaced between review and decision refuses the grant (rider 1)', async () => {
    const { app, consentApp, projectHomeDir } = setup({ withChannel: true });
    const { body } = await openRequest(app);
    // The reviewed tree is no longer the decided tree: same pane, same
    // version, different bytes.
    writeHomePanePlugin(projectHomeDir, {
      bundle: 'window.__station_ai_plugins = {};// swapped after review',
    });
    const { decided } = await decideThroughListener(
      consentApp!,
      body.request!.id,
      'approve',
    );
    // The listener refuses the decision rather than granting the unreviewed
    // tree; nothing is written either way.
    expect(decided.status).not.toBe(200);
    expect(await readStatus(app)).toEqual({ state: 'none' });
  });

  test('digest coverage: a file OUTSIDE the pane bundle changing also refuses (rider 2)', async () => {
    const { app, consentApp, projectHomeDir } = setup({ withChannel: true });
    const { body } = await openRequest(app);
    // The bundle-scoped install digest cannot see this file; the whole-tree
    // consent fingerprint must.
    writeFileSync(
      join(projectHomeDir, 'plugins', PLUGIN, 'extra.mjs'),
      'export const smuggled = true;',
    );
    const { decided } = await decideThroughListener(
      consentApp!,
      body.request!.id,
      'approve',
    );
    expect(decided.status).not.toBe(200);
    expect(await readStatus(app)).toEqual({ state: 'none' });
  });

  test('a mutation landing BETWEEN revalidation and commit refuses (#3720 review HIGH)', async () => {
    // The content lock is a cooperative in-process mutex, so an external
    // writer can mutate the tree after revalidateTarget's derivation and
    // before commitApproval's. The commit-time fingerprint comparison is
    // what must refuse that. Deterministic interleave: the injected
    // contribution reader delegates to the real inventory, and mutates the
    // bundle bytes exactly on the SECOND read after arming — revalidate
    // reads the reviewed tree, commit reads the changed one.
    const projectHomeDir = mkdtempSync(join(tmpdir(), 'station-home-role-'));
    cleanup.push(projectHomeDir);
    const pluginsDir = join(projectHomeDir, 'plugins');
    writeHomePanePlugin(projectHomeDir);
    const channel = new ConsentChannelService();
    channel.markListening(CONSENT_PORT);
    const consentApp = createConsentApp({
      channel,
      credentials: {
        verifyOperatorCredential: (candidate) =>
          candidate === OPERATOR_CREDENTIAL,
        identifyDevice: () => null,
      },
    });
    const app = new Hono();
    let armedReadsUntilMutation = -1;
    registerPluginHomeRoleRoutes(app, {
      eventBus: { emit: vi.fn() } as never,
      pluginsDir,
      projectHomeDir,
      consentChannel: channel,
      listContributions: () => {
        if (armedReadsUntilMutation > 0) armedReadsUntilMutation -= 1;
        if (armedReadsUntilMutation === 0) {
          armedReadsUntilMutation = -1;
          writeHomePanePlugin(projectHomeDir, {
            bundle:
              'window.__station_ai_plugins = {};// swapped between revalidate and commit',
          });
        }
        return new DistributionProfileService(
          projectHomeDir,
        ).listPluginWorkspacePaneContributions();
      },
    });

    const { body } = await openRequest(app);
    // Arm: the next decide performs exactly two derivations — revalidate
    // (read 1, reviewed tree) then commit (read 2, mutated tree).
    armedReadsUntilMutation = 2;
    const { decided } = await decideThroughListener(
      consentApp,
      body.request!.id,
      'approve',
    );
    expect(decided.status).not.toBe(200);
    const status = await app.request('/home-role');
    expect(
      ((await status.json()) as { status: { state: string } }).status,
    ).toEqual({ state: 'none' });
  });

  test('no same-origin decision path exists on the main API', async () => {
    const { app } = setup({ withChannel: true });
    const { body } = await openRequest(app);
    for (const path of [
      `/home-role/requests/${body.request!.id}/approve`,
      `/home-role/requests/${body.request!.id}/deny`,
      `/home-role/requests/${body.request!.id}/review`,
    ]) {
      const response = await app.request(path, {
        method: 'POST',
        headers: { 'sec-fetch-mode': 'navigate', 'sec-fetch-user': '?1' },
      });
      expect(response.status).toBe(404);
    }
    expect(await readStatus(app)).toEqual({ state: 'none' });
  });

  test('the status poll answers only for home-role transactions, not other kinds', async () => {
    const { app, channel } = setup({ withChannel: true });
    const created = channel!.store.create({
      tenantId: channel!.tenantId,
      target: {
        kind: 'plugin-trusted-permissions',
        subject: 'x',
        fingerprint: '{}',
      },
      requester: { kind: 'plugin-ui', id: 'x' },
      rateKey: 'plugin-ui',
      description: {
        title: 't',
        summary: 's',
        items: [],
        approveLabel: 'a',
        denyLabel: 'd',
      },
      revalidateTarget: async () => null,
      commitApproval: async () => {},
    });
    expect(created.ok).toBe(true);
    const poll = await app.request(
      `/home-role/requests/${created.ok ? created.transaction.id : ''}`,
    );
    expect(poll.status).toBe(404);
  });

  test('candidates lists exactly the eligible enabled panes', async () => {
    const { app } = setup({ withChannel: true });
    const response = await app.request('/home-role/candidates');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      candidates: { pluginName: string; paneId: string; name: string }[];
    };
    expect(body.candidates).toEqual([
      {
        pluginName: PLUGIN,
        paneId: PANE_ID,
        name: 'Third-party Home Pane',
        version: '3.1.0',
      },
    ]);
  });
});
