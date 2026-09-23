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
import type { AgentConfigurationMutationRunner } from '../../../runtime/types.js';
import { getRuntimeAuthenticatedRequestPrincipal } from '../../../security/runtime-request-security.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  PrincipalUnresolvedError,
} from '../../../services/identity/principal-resolver.js';
import type { EventBus } from '../../../services/orchestration/event-bus.js';
import { PluginLifecycleProposalService } from '../../../services/plugins/plugin-lifecycle-proposals.js';
import { attestProposalSourceContext } from '../../../services/plugins/plugin-proposal-provenance.js';
import { LOCAL_SOURCE_DIGEST_MAX_ENTRIES as PROPOSAL_DIGEST_MAX_ENTRIES } from '../../../services/plugins/plugin-source-digest.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
} from '../../../utils/internal-api-token.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from '../plugin-lifecycle-routes.js';
import { PLUGIN_PERSON_APPROVAL_REQUIRED } from '../plugin-person-approval.js';
import { createPluginProposalRoutes } from '../plugin-proposal-routes.js';

const observeTree = vi.hoisted(() => vi.fn());
vi.mock(
  '@kontourai/station-shared/plugin-tree-digest',
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import('@kontourai/station-shared/plugin-tree-digest')
      >();
    observeTree.mockImplementation(actual.observePluginTreeAsync);
    return { ...actual, observePluginTreeAsync: observeTree };
  },
);
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
/** Another Station's delegation grant: not a person (review M5). */
const DELEGATION = 'delegation-device-credential-for-s5';
/** A person's paired device that is not the operator (review M6). */
const MEMBER_DEVICE = 'member-device-credential-for-s5';
/**
 * A paired device whose kind the auth boundary could not resolve (a
 * composition without `resolveCredentialDeviceKind`, or a registry read that
 * raced a revocation). Fails closed: not a person (delta review).
 */
const UNKINDED_DEVICE = 'unkinded-device-credential-for-s5';

const CREDENTIALS: Record<
  string,
  {
    authority: 'operator-credential' | 'device-credential';
    deviceId?: string;
    deviceKind?: 'device' | 'delegation';
  }
> = {
  [OPERATOR]: { authority: 'operator-credential' },
  [DELEGATION]: {
    authority: 'device-credential',
    deviceId: 'device-delegation',
    deviceKind: 'delegation',
  },
  [MEMBER_DEVICE]: {
    authority: 'device-credential',
    deviceId: 'device-member',
    deviceKind: 'device',
  },
  [UNKINDED_DEVICE]: {
    authority: 'device-credential',
    deviceId: 'device-unkinded',
  },
};

/**
 * Stand-in for the orchestration principal resolver, reading the principal
 * the real auth boundary bound: the internal caller and the operator
 * credential are the operator (as production resolves them, by
 * home-possession locality and verified operator credential); a paired
 * device is its own principal.
 */
function principalFor(request: Request) {
  const principal = getRuntimeAuthenticatedRequestPrincipal(request);
  if (
    principal?.kind === 'internal' ||
    principal?.authority === 'operator-credential'
  )
    return {
      id: LOCAL_OPERATOR_PRINCIPAL_ID,
      kind: 'human' as const,
      display: 'Operator',
    };
  if (principal?.deviceId)
    return {
      id: `human:device:${principal.deviceId}`,
      kind: 'human' as const,
      display: principal.deviceId,
    };
  throw new PrincipalUnresolvedError('no principal');
}

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

function createHarness(
  home: string,
  options: {
    applyConfigurationMutation?: AgentConfigurationMutationRunner;
  } = {},
) {
  const app = new Hono<{ Bindings: TestBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger,
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate: string) => candidate in CREDENTIALS,
      resolveGrantedScope: (candidate: string) =>
        candidate in CREDENTIALS ? DEFAULT_GRANT_PAIRING_SCOPE : undefined,
      resolveCredentialAuthority: (candidate: string) =>
        CREDENTIALS[candidate]?.authority,
      resolveCredentialDeviceId: (candidate: string) =>
        CREDENTIALS[candidate]?.deviceId,
      resolveCredentialDeviceKind: (candidate: string) =>
        CREDENTIALS[candidate]?.deviceKind,
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
    ...(options.applyConfigurationMutation
      ? { applyConfigurationMutation: options.applyConfigurationMutation }
      : {}),
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
      resolvePrincipal: (c) => principalFor(c.req.raw),
    }),
  );
  const request = (
    caller: 'internal' | 'person' | 'delegation' | 'member' | 'unkinded',
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
            : {
                Authorization: `Bearer ${
                  caller === 'delegation'
                    ? DELEGATION
                    : caller === 'member'
                      ? MEMBER_DEVICE
                      : caller === 'unkinded'
                        ? UNKINDED_DEVICE
                        : OPERATOR
                }`,
              }),
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
    // The principal is derived from the request, the rest is the report,
    // and a report with no runtime attestation is marked as the caller's.
    expect(proposal.author).toEqual({
      principal: 'agent',
      agentSlug: 'station',
      conversationId: 'conv-1',
      reportedBy: 'caller',
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
      principalId: LOCAL_OPERATOR_PRINCIPAL_ID,
    });
  });

  /**
   * Review M5: another Station's delegation grant is not a person. It is
   * refused on every verb exactly as Station's own agent caller is, while a
   * person's paired device reaches the handler.
   */
  test('a delegated Station, and a device whose kind is unresolved, is refused on install, recover, update and remove; a person’s device is not', async () => {
    const { home, pluginsDir, root } = makeHome();
    const source = join(root, 'src-plugin');
    writePlugin(source, 'proposed-plugin');
    writePlugin(join(pluginsDir, 'installed-plugin'), 'installed-plugin');
    const { request } = createHarness(home);
    const cases = [
      ['POST', '/api/plugins/install', { source, consent: CONSENT }],
      [
        'POST',
        '/api/plugins/installed-plugin/recover',
        {
          recoveryRevision: `sha256:${'b'.repeat(64)}`,
          consent: { ...CONSENT, grantRevision: 'grant-1' },
        },
      ],
      ['POST', '/api/plugins/installed-plugin/update', undefined],
      ['DELETE', '/api/plugins/installed-plugin', undefined],
    ] as const;
    for (const caller of ['delegation', 'unkinded'] as const) {
      for (const [method, path, body] of cases) {
        const refused = await request(caller, method, path, body);
        expect({ caller, path, status: refused.status }).toEqual({
          caller,
          path,
          status: 403,
        });
        expect((await readJson(refused)).code).toBe(
          PLUGIN_PERSON_APPROVAL_REQUIRED,
        );
      }
    }
    expect(installPluginFromSource).not.toHaveBeenCalled();
    expect(recoverInstalledPlugin).not.toHaveBeenCalled();
    expect(uninstallInstalledPlugin).not.toHaveBeenCalled();

    for (const [method, path, body] of cases) {
      const reached = await request('member', method, path, body);
      expect({ path, status: reached.status }).not.toEqual({
        path,
        status: 403,
      });
    }
    expect(installPluginFromSource).toHaveBeenCalledTimes(1);
    expect(uninstallInstalledPlugin).toHaveBeenCalledTimes(1);
  });

  /** Review M3: provenance says whether Station's runtime vouched for it. */
  test('an attested agent report is recorded as runtime; a forged or missing attestation as caller', async () => {
    const { home, pluginsDir } = makeHome();
    for (const name of ['plugin-a', 'plugin-b', 'plugin-c'])
      writePlugin(join(pluginsDir, name), name);
    const { request } = createHarness(home);
    const propose = async (
      kind: 'update' | 'remove',
      pluginName: string,
      context: object,
    ) =>
      (
        await readJson(
          await request('internal', 'POST', '/api/plugin-proposals', {
            kind,
            pluginName,
            rationale: 'r',
            _sourceContext: context,
          }),
        )
      ).proposal.author;
    const attestA = attestProposalSourceContext('station', 'c1', {
      kind: 'update',
      target: 'plugin-a',
    });

    expect(
      await propose('update', 'plugin-a', {
        agentSlug: 'station',
        conversationId: 'c1',
        attestation: attestA,
      }),
    ).toMatchObject({ agentSlug: 'station', reportedBy: 'runtime' });
    // An attestation for a different agent does not vouch for this one.
    expect(
      await propose('update', 'plugin-b', {
        agentSlug: 'impostor',
        conversationId: 'c1',
        attestation: attestProposalSourceContext('station', 'c1', {
          kind: 'update',
          target: 'plugin-b',
        }),
      }),
    ).toMatchObject({ agentSlug: 'impostor', reportedBy: 'caller' });
    expect(
      await propose('update', 'plugin-c', {
        agentSlug: 'station',
        conversationId: 'c1',
        attestation: 'x'.repeat(43),
      }),
    ).toMatchObject({ reportedBy: 'caller' });
  });

  /**
   * Delta review: the attestation is bound to the proposal it stamps. The
   * same agent and conversation's attestation for proposal A does not vouch
   * for a proposal of another plugin, or of another kind.
   */
  test('an attestation for one proposal does not vouch for another from the same conversation', async () => {
    const { home, pluginsDir } = makeHome();
    for (const name of ['plugin-a', 'plugin-b'])
      writePlugin(join(pluginsDir, name), name);
    const { request, proposals } = createHarness(home);
    const attestA = attestProposalSourceContext('station', 'c1', {
      kind: 'update',
      target: 'plugin-a',
    });
    const author = async (body: object) =>
      (
        await readJson(
          await request('internal', 'POST', '/api/plugin-proposals', {
            rationale: 'r',
            _sourceContext: {
              agentSlug: 'station',
              conversationId: 'c1',
              attestation: attestA,
            },
            ...body,
          }),
        )
      ).proposal.author;

    expect(
      await author({ kind: 'update', pluginName: 'plugin-b' }),
    ).toMatchObject({ agentSlug: 'station', reportedBy: 'caller' });
    expect(
      await author({ kind: 'remove', pluginName: 'plugin-a' }),
    ).toMatchObject({ agentSlug: 'station', reportedBy: 'caller' });
    expect(
      await author({
        kind: 'install',
        source: 'https://github.com/org/plugin-a',
      }),
    ).toMatchObject({ agentSlug: 'station', reportedBy: 'caller' });
    // The one it was minted for, padded as a model might send it: the
    // schema trims, and so does the binding.
    expect(
      await author({ kind: 'update', pluginName: ' plugin-a ' }),
    ).toMatchObject({ agentSlug: 'station', reportedBy: 'runtime' });
    // The same proposal, reported from another conversation, once the
    // attested one is closed (an open one would deduplicate).
    const attested = proposals
      .listOpen()
      .find((open) => open.pluginName === 'plugin-a' && open.kind === 'update');
    await proposals.dismiss(attested!.id);
    expect(
      (
        await readJson(
          await request('internal', 'POST', '/api/plugin-proposals', {
            kind: 'update',
            pluginName: 'plugin-a',
            rationale: 'r',
            _sourceContext: {
              agentSlug: 'station',
              conversationId: 'c2',
              attestation: attestA,
            },
          }),
        )
      ).proposal.author,
    ).toMatchObject({
      agentSlug: 'station',
      conversationId: 'c2',
      reportedBy: 'caller',
    });
  });
});

/**
 * Review M6: proposals are addressed to the operator. A person's paired
 * device that is not the operator cannot list, read, or dismiss them, and an
 * update or remove proposal answers it the same whether or not the plugin is
 * installed, so it cannot probe the installed inventory.
 */
describe('#2323 S5: proposals are the operator’s', () => {
  test('a non-operator gets 404 for the list and for one proposal; the operator reads both', async () => {
    const { home, pluginsDir } = makeHome();
    writePlugin(join(pluginsDir, 'installed-plugin'), 'installed-plugin');
    const { request } = createHarness(home);
    const { proposal } = await readJson(
      await request('internal', 'POST', '/api/plugin-proposals', {
        kind: 'remove',
        pluginName: 'installed-plugin',
        rationale: 'Unused.',
      }),
    );

    // Station's own agents resolve as the operator, and still read nothing:
    // an agent needs only the answer to its own create request (delta
    // review). Nor does a delegated Station or an unresolved device.
    for (const caller of [
      'member',
      'internal',
      'delegation',
      'unkinded',
    ] as const) {
      for (const path of [
        '/api/plugin-proposals',
        `/api/plugin-proposals/${proposal.id}`,
      ]) {
        const hidden = await request(caller, 'GET', path);
        expect({ caller, path, status: hidden.status }).toEqual({
          caller,
          path,
          status: 404,
        });
      }
    }
    const dismiss = await request(
      'member',
      'POST',
      `/api/plugin-proposals/${proposal.id}/dismiss`,
    );
    expect(dismiss.status).toBe(404);

    const list = await readJson(
      await request('person', 'GET', '/api/plugin-proposals'),
    );
    expect(list.proposals.map((entry: { id: string }) => entry.id)).toEqual([
      proposal.id,
    ]);
    expect(
      (
        await readJson(
          await request(
            'person',
            'GET',
            `/api/plugin-proposals/${proposal.id}`,
          ),
        )
      ).proposal.id,
    ).toBe(proposal.id);
  });

  test('a non-operator’s update or remove proposal answers identically for installed and absent plugins', async () => {
    const { home, pluginsDir } = makeHome();
    writePlugin(join(pluginsDir, 'installed-plugin'), 'installed-plugin');
    const { request, proposals } = createHarness(home);
    const answer = async (pluginName: string) => {
      const response = await request(
        'member',
        'POST',
        '/api/plugin-proposals',
        {
          kind: 'remove',
          pluginName,
          rationale: 'r',
        },
      );
      return { status: response.status, body: await readJson(response) };
    };
    const installed = await answer('installed-plugin');
    const absent = await answer('absent-plugin');
    expect(installed).toEqual(absent);
    expect(installed.status).toBe(404);
    expect(proposals.listOpen()).toEqual([]);
    // The operator still gets the precise answer.
    const operator = await request('person', 'POST', '/api/plugin-proposals', {
      kind: 'remove',
      pluginName: 'absent-plugin',
      rationale: 'r',
    });
    expect((await readJson(operator)).error).toContain(
      "No installed plugin is named 'absent-plugin'",
    );
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

  /**
   * A change the runtime accepted but has not activated yet (202, activation
   * `pending`) has not happened as far as the person can see: the proposal
   * stays open, in the response and in the store.
   */
  test('an install or removal whose activation is still pending leaves the proposal open', async () => {
    const { home, root, pluginsDir } = makeHome();
    const source = join(root, 'src-plugin');
    writePlugin(source, 'proposed-plugin');
    writePlugin(join(pluginsDir, 'installed-plugin'), 'installed-plugin');
    const applyConfigurationMutation: AgentConfigurationMutationRunner = async (
      operation,
    ) => operation(() => {}, { status: 'pending', reason: 'queued' });
    const { request, proposals } = createHarness(home, {
      applyConfigurationMutation,
    });
    const install = (
      await readJson(
        await request('internal', 'POST', '/api/plugin-proposals', {
          kind: 'install',
          source,
          rationale: 'Adds the pane.',
        }),
      )
    ).proposal;
    const remove = (
      await readJson(
        await request('internal', 'POST', '/api/plugin-proposals', {
          kind: 'remove',
          pluginName: 'installed-plugin',
          rationale: 'Unused.',
        }),
      )
    ).proposal;

    const installed = await request('person', 'POST', '/api/plugins/install', {
      source,
      consent: CONSENT,
      proposalId: install.id,
    });
    expect(installed.status).toBe(202);
    expect((await readJson(installed)).proposal).toEqual({
      id: install.id,
      status: 'open',
    });
    const removed = await request(
      'person',
      'DELETE',
      '/api/plugins/installed-plugin',
      { proposalId: remove.id },
    );
    expect(removed.status).toBe(202);
    expect((await readJson(removed)).proposal).toEqual({
      id: remove.id,
      status: 'open',
    });
    expect(installPluginFromSource).toHaveBeenCalledTimes(1);
    expect(uninstallInstalledPlugin).toHaveBeenCalledTimes(1);
    expect(proposals.get(install.id)?.status).toBe('open');
    expect(proposals.get(remove.id)?.status).toBe('open');
  });

  test('review L3: a removal names its proposal in the JSON body, as install does', async () => {
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
      '/api/plugins/installed-plugin',
      { proposalId: proposal.id },
    );
    expect((await readJson(removed)).proposal).toEqual({
      id: proposal.id,
      status: 'completed',
    });
    expect(proposals.get(proposal.id)?.status).toBe('completed');
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
    const refusedBody = await readJson(refused);
    expect(refusedBody.code).toBe('manifest-missing');
    // Review M4: the same code and words validate answers at the same tier,
    // so a proposal reveals nothing about a host path validate does not.
    expect(refusedBody.error).toBe(
      'Not a valid plugin: plugin.json not found in the folder.',
    );
  });

  test('review M4: a folder beyond the walk bounds records no digest and says why', async () => {
    const { home, root } = makeHome();
    const source = join(root, 'huge-plugin');
    writePlugin(source, 'huge-plugin');
    mkdirSync(join(source, 'many'));
    for (let index = 0; index <= PROPOSAL_DIGEST_MAX_ENTRIES; index++)
      writeFileSync(join(source, 'many', `f${index}`), '');
    const { request } = createHarness(home);
    const { proposal } = await readJson(
      await request('internal', 'POST', '/api/plugin-proposals', {
        kind: 'install',
        source,
        rationale: 'Big.',
      }),
    );
    expect(proposal).not.toHaveProperty('proposedContentDigest');
    expect(proposal.proposedContentDigestUnavailable).toBe('too-large');
  });

  test('review M4: a duplicate or capped proposal is answered before any digest walk', async () => {
    const { home, root } = makeHome();
    const source = join(root, 'src-plugin');
    writePlugin(source, 'digest-plugin');
    const { request } = createHarness(home);
    const body = { kind: 'install', source, rationale: 'r' };
    await request('internal', 'POST', '/api/plugin-proposals', body);
    observeTree.mockClear();
    const again = await readJson(
      await request('internal', 'POST', '/api/plugin-proposals', body),
    );
    expect(again.deduplicated).toBe(true);
    expect(observeTree).not.toHaveBeenCalled();
  });
});
