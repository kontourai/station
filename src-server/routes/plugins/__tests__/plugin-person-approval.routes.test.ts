/**
 * #2323 S5: the plugin lifecycle verbs refuse Station's internal agent
 * caller at the ROUTE, not only in the tool, and a proposal a person
 * completes through those routes is marked completed.
 *
 * Every request here goes through the real auth boundary
 * (`configureRuntimeHttp`), so "internal" is the principal that boundary
 * binds for station-control's own headers (per-boot internal token,
 * `x-station-proxy-caller: local`, a direct loopback socket, no credential),
 * and "person" is an ordinary bearer credential — the CLI's and the
 * browser's shape. The installer is spied, so a refusal is proven by the
 * installer never being reached, not only by a status code.
 */

import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HttpBindings } from '@hono/node-server';
import { DEFAULT_GRANT_PAIRING_SCOPE } from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { configureRuntimeHttp } from '../../../runtime/bootstrap/runtime-http.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { PluginLifecycleProposalService } from '../../../services/plugins/plugin-lifecycle-proposals.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from '../plugin-lifecycle-routes.js';
import { PLUGIN_PERSON_APPROVAL_REQUIRED } from '../plugin-person-approval.js';
import { createPluginProposalRoutes } from '../plugin-proposal-routes.js';

const installPluginFromSource = vi.hoisted(() => vi.fn());
const uninstallInstalledPlugin = vi.hoisted(() => vi.fn());
const recoverInstalledPlugin = vi.hoisted(() => vi.fn());

vi.mock(
  '../../../services/plugins/plugin-install-transaction.js',
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import('../../../services/plugins/plugin-install-transaction.js')
    >()),
    installPluginFromSource,
    uninstallInstalledPlugin,
    recoverInstalledPlugin,
  }),
);

const OPERATOR = 'operator-credential-for-s5';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
  trace() {},
  fatal() {},
  child() {
    return this;
  },
  setLevel() {},
  getLevel() {
    return 'info' as const;
  },
};

const cleanup: string[] = [];

beforeEach(() => {
  installPluginFromSource.mockReset();
  installPluginFromSource.mockResolvedValue({
    success: true,
    plugin: {
      name: 'proposed-plugin',
      version: '1.0.0',
      hasBundle: false,
      agents: [],
    },
  });
  uninstallInstalledPlugin.mockReset();
  uninstallInstalledPlugin.mockResolvedValue({ success: true });
  recoverInstalledPlugin.mockReset();
  recoverInstalledPlugin.mockResolvedValue({ success: true });
});

afterEach(async () => {
  await Promise.all(
    cleanup
      .splice(0, cleanup.length)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'station-s5-person-approval-'));
  cleanup.push(root);
  const home = join(root, 'home');
  const pluginsDir = join(home, 'plugins');
  mkdirSync(pluginsDir, { recursive: true });
  return { root, home, pluginsDir };
}

function writePlugin(dir: string, name: string) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({ name, version: '1.0.0' }),
  );
}

function createHarness(home: string) {
  const app = new Hono<{ Bindings: TestBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) => candidate === OPERATOR,
      resolveGrantedScope: (candidate: string) =>
        candidate === OPERATOR ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);
  const proposals = new PluginLifecycleProposalService(home);
  const plugins = new Hono();
  const deps = {
    agentsDir: join(home, 'agents'),
    logger: logger as never,
    pluginsDir: join(home, 'plugins'),
    projectHomeDir: home,
    proposals,
  };
  registerPluginLifecycleRoutes(plugins, {
    ...deps,
    buildPlugin: async () => {},
  });
  registerPluginInstallRoutes(plugins, {
    ...deps,
    projectVisiblePlugins: () => (installed) => installed,
  });
  app.route('/api/plugins', plugins);
  app.route(
    '/api/plugin-proposals',
    createPluginProposalRoutes({
      proposals,
      pluginsDir: join(home, 'plugins'),
      logger,
    }),
  );
  const request = (
    caller: 'internal' | 'person',
    method: string,
    path: string,
    body?: unknown,
  ) =>
    app.request(
      path,
      {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(caller === 'internal'
            ? {
                [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
                [INTERNAL_PROXY_CALLER_HEADER]: 'local',
              }
            : { Authorization: `Bearer ${OPERATOR}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
      { incoming: { socket: { remoteAddress: '127.0.0.1' } } } as TestBindings,
    );
  return { request, proposals };
}

const CONSENT = {
  permissions: [],
  contentDigest: `sha256:${'a'.repeat(64)}`,
};

describe('#2323 S5: plugin lifecycle routes refuse Station’s agent caller', () => {
  test('POST /install: the internal caller is refused before anything is staged; a person reaches the installer', async () => {
    const { home, pluginsDir, root } = makeHome();
    const source = join(root, 'src-plugin');
    writePlugin(source, 'proposed-plugin');
    const { request } = createHarness(home);
    const body = { source, consent: CONSENT };

    const refused = await request(
      'internal',
      'POST',
      '/api/plugins/install',
      body,
    );
    expect(refused.status).toBe(403);
    expect(await readJson(refused)).toMatchObject({
      success: false,
      code: PLUGIN_PERSON_APPROVAL_REQUIRED,
      error: expect.stringContaining('A person must approve this in Station'),
    });
    expect(installPluginFromSource).not.toHaveBeenCalled();
    expect(readdirSync(pluginsDir)).toEqual([]);

    const allowed = await request(
      'person',
      'POST',
      '/api/plugins/install',
      body,
    );
    expect(allowed.status).toBe(200);
    expect(installPluginFromSource).toHaveBeenCalledTimes(1);
  });

  test('POST /:name/recover: refused for the internal caller, reached by a person', async () => {
    const { home } = makeHome();
    const { request } = createHarness(home);
    const body = {
      recoveryRevision: `sha256:${'b'.repeat(64)}`,
      consent: { ...CONSENT, grantRevision: 'grant-1' },
    };

    const refused = await request(
      'internal',
      'POST',
      '/api/plugins/some-plugin/recover',
      body,
    );
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).code).toBe(
      PLUGIN_PERSON_APPROVAL_REQUIRED,
    );
    expect(recoverInstalledPlugin).not.toHaveBeenCalled();

    const allowed = await request(
      'person',
      'POST',
      '/api/plugins/some-plugin/recover',
      body,
    );
    expect(allowed.status).not.toBe(403);
    expect(recoverInstalledPlugin).toHaveBeenCalledTimes(1);
  });

  test('POST /:name/update: refused for the internal caller; a person reaches the update handler', async () => {
    const { home } = makeHome();
    const { request } = createHarness(home);

    const refused = await request(
      'internal',
      'POST',
      '/api/plugins/missing-plugin/update',
    );
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).code).toBe(
      PLUGIN_PERSON_APPROVAL_REQUIRED,
    );

    // The handler runs and answers for the plugin itself: there is none.
    const allowed = await request(
      'person',
      'POST',
      '/api/plugins/missing-plugin/update',
    );
    expect(allowed.status).toBe(404);
    expect((await readJson(allowed)).code).toBeUndefined();
  });

  test('DELETE /:name: refused for the internal caller; a person removes the plugin', async () => {
    const { home, pluginsDir } = makeHome();
    writePlugin(join(pluginsDir, 'installed-plugin'), 'installed-plugin');
    const { request } = createHarness(home);

    const refused = await request(
      'internal',
      'DELETE',
      '/api/plugins/installed-plugin',
    );
    expect(refused.status).toBe(403);
    expect((await readJson(refused)).code).toBe(
      PLUGIN_PERSON_APPROVAL_REQUIRED,
    );
    expect(uninstallInstalledPlugin).not.toHaveBeenCalled();

    const allowed = await request(
      'person',
      'DELETE',
      '/api/plugins/installed-plugin',
    );
    expect(allowed.status).toBe(200);
    expect(uninstallInstalledPlugin).toHaveBeenCalledTimes(1);
  });

  test('dismissing a proposal is a person’s act; the internal caller can create one but not dismiss it', async () => {
    const { home, pluginsDir } = makeHome();
    writePlugin(join(pluginsDir, 'installed-plugin'), 'installed-plugin');
    const { request, proposals } = createHarness(home);

    const created = await request('internal', 'POST', '/api/plugin-proposals', {
      kind: 'remove',
      pluginName: 'installed-plugin',
      rationale: 'It is unused.',
      _sourceContext: { agentSlug: 'station', conversationId: 'conv-1' },
    });
    expect(created.status).toBe(201);
    const { proposal } = await readJson(created);
    // The principal is derived from the request, the rest is the report.
    expect(proposal.author).toEqual({
      principal: 'agent',
      agentSlug: 'station',
      conversationId: 'conv-1',
    });

    const refused = await request(
      'internal',
      'POST',
      `/api/plugin-proposals/${proposal.id}/dismiss`,
    );
    expect(refused.status).toBe(403);
    expect(proposals.get(proposal.id)?.status).toBe('open');

    const dismissed = await request(
      'person',
      'POST',
      `/api/plugin-proposals/${proposal.id}/dismiss`,
    );
    expect(dismissed.status).toBe(200);
    expect(proposals.get(proposal.id)?.status).toBe('dismissed');
  });

  test('a person’s proposal ignores a self-reported agent: the author is derived, not written', async () => {
    const { home, pluginsDir } = makeHome();
    writePlugin(join(pluginsDir, 'installed-plugin'), 'installed-plugin');
    const { request } = createHarness(home);

    const created = await request('person', 'POST', '/api/plugin-proposals', {
      kind: 'update',
      pluginName: 'installed-plugin',
      rationale: 'New version.',
      _sourceContext: { agentSlug: 'impostor' },
    });
    expect(created.status).toBe(201);
    expect((await readJson(created)).proposal.author).toEqual({
      principal: 'person',
    });
  });
});

describe('#2323 S5: completing a proposal through the ordinary routes', () => {
  test('an install that names the proposal and installs its source marks it completed', async () => {
    const { home, root } = makeHome();
    const source = join(root, 'src-plugin');
    writePlugin(source, 'proposed-plugin');
    const { request, proposals } = createHarness(home);
    const created = await request('internal', 'POST', '/api/plugin-proposals', {
      kind: 'install',
      source,
      rationale: 'Adds the pane you asked for.',
    });
    const { proposal } = await readJson(created);

    const installed = await request('person', 'POST', '/api/plugins/install', {
      source,
      consent: CONSENT,
      proposalId: proposal.id,
    });
    expect(installed.status).toBe(200);
    expect((await readJson(installed)).proposal).toEqual({
      id: proposal.id,
      status: 'completed',
    });
    expect(proposals.get(proposal.id)?.status).toBe('completed');
    expect(proposals.listOpen()).toEqual([]);
  });

  test('an install of a DIFFERENT source leaves the proposal open and says so', async () => {
    const { home, root } = makeHome();
    const source = join(root, 'src-plugin');
    const other = join(root, 'other-plugin');
    writePlugin(source, 'proposed-plugin');
    writePlugin(other, 'other-plugin');
    const { request, proposals } = createHarness(home);
    const { proposal } = await readJson(
      await request('internal', 'POST', '/api/plugin-proposals', {
        kind: 'install',
        source,
        rationale: 'Adds the pane.',
      }),
    );

    const installed = await request('person', 'POST', '/api/plugins/install', {
      source: other,
      consent: CONSENT,
      proposalId: proposal.id,
    });
    expect((await readJson(installed)).proposal).toEqual({
      id: proposal.id,
      status: 'mismatch',
    });
    expect(proposals.get(proposal.id)?.status).toBe('open');
  });

  test('a failed install does not complete the proposal', async () => {
    const { home, root } = makeHome();
    const source = join(root, 'src-plugin');
    writePlugin(source, 'proposed-plugin');
    installPluginFromSource.mockResolvedValue({
      success: false,
      error: 'build failed',
    });
    const { request, proposals } = createHarness(home);
    const { proposal } = await readJson(
      await request('internal', 'POST', '/api/plugin-proposals', {
        kind: 'install',
        source,
        rationale: 'Adds the pane.',
      }),
    );

    const installed = await request('person', 'POST', '/api/plugins/install', {
      source,
      consent: CONSENT,
      proposalId: proposal.id,
    });
    expect((await readJson(installed)).proposal).toEqual({
      id: proposal.id,
      status: 'open',
    });
    expect(proposals.get(proposal.id)?.status).toBe('open');
  });

  test('a removal that names the proposal marks it completed', async () => {
    const { home, pluginsDir } = makeHome();
    writePlugin(join(pluginsDir, 'installed-plugin'), 'installed-plugin');
    const { request, proposals } = createHarness(home);
    const { proposal } = await readJson(
      await request('internal', 'POST', '/api/plugin-proposals', {
        kind: 'remove',
        pluginName: 'installed-plugin',
        rationale: 'Unused.',
      }),
    );

    const removed = await request(
      'person',
      'DELETE',
      `/api/plugins/installed-plugin?proposalId=${proposal.id}`,
    );
    expect(removed.status).toBe(200);
    expect((await readJson(removed)).proposal).toEqual({
      id: proposal.id,
      status: 'completed',
    });
    expect(proposals.get(proposal.id)?.status).toBe('completed');
  });
});

describe('#2323 S5: the proposal digest is the preview digest', () => {
  test('a local install proposal records the digest the preview derives, and an edit afterwards changes the preview’s', async () => {
    const { home, root } = makeHome();
    const source = join(root, 'src-plugin');
    writePlugin(source, 'digest-plugin');
    writeFileSync(join(source, 'index.js'), 'export const version = 1;\n');
    const { request } = createHarness(home);

    const { proposal } = await readJson(
      await request('internal', 'POST', '/api/plugin-proposals', {
        kind: 'install',
        source,
        rationale: 'Digest parity.',
      }),
    );
    expect(proposal.proposedContentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);

    const preview = await readJson(
      await request('person', 'POST', '/api/plugins/preview', { source }),
    );
    expect(preview.valid).toBe(true);
    expect(preview.contentDigest).toBe(proposal.proposedContentDigest);

    writeFileSync(join(source, 'index.js'), 'export const version = 2;\n');
    const edited = await readJson(
      await request('person', 'POST', '/api/plugins/preview', { source }),
    );
    expect(edited.contentDigest).toMatch(/^sha256:/);
    expect(edited.contentDigest).not.toBe(proposal.proposedContentDigest);
  });

  test('a git install proposal records no digest, and a folder without plugin.json is refused', async () => {
    const { home, root } = makeHome();
    const { request } = createHarness(home);
    const git = await readJson(
      await request('internal', 'POST', '/api/plugin-proposals', {
        kind: 'install',
        source: 'https://github.com/example/plugin.git',
        rationale: 'Remote.',
      }),
    );
    expect(git.proposal.kind).toBe('install');
    expect(git.proposal).not.toHaveProperty('proposedContentDigest');

    mkdirSync(join(root, 'not-a-plugin'));
    const refused = await request('internal', 'POST', '/api/plugin-proposals', {
      kind: 'install',
      source: join(root, 'not-a-plugin'),
      rationale: 'Oops.',
    });
    expect(refused.status).toBe(400);
    expect((await readJson(refused)).code).toBe('manifest-missing');
  });
});
