import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { REQUIRED_SLOT_DEFAULTS } from '@kontourai/station-contracts/required-slots';
import {
  createWorkspaceHomeRoleGrant,
  WORKSPACE_HOME_PROJECTION_FIELDS,
} from '@kontourai/station-contracts/workspace-home-role';
import { Hono } from 'hono';
import { describe, expect, test } from 'vitest';
import { bindOperatorPrincipal } from '../../../__test-utils__/operator-principal.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import {
  DistributionProfileService,
  resolveDistributionProfile,
} from '../../../services/plugins/distribution-profile-service.js';
import {
  installPluginFromSource,
  uninstallInstalledPlugin,
} from '../../../services/plugins/plugin-install-transaction.js';
import { parsePluginManifestDocument } from '../../../services/plugins/plugin-manifest-loader.js';
import { readInstallationRequiredSlots } from '../../../services/plugins/required-slot-service.js';
import {
  computeWorkspaceHomeRoleInstallDigest,
  workspaceHomeRolePath,
} from '../../../services/plugins/workspace-home-role-service.js';
import { createLogger } from '../../../utils/logger.js';
import { registerPluginConfigRoutes } from '../plugin-config-routes.js';
import { registerPluginHomeRoleRoutes } from '../plugin-home-role-routes.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import { registerPluginLifecycleRoutes } from '../plugin-lifecycle-routes.js';

const temp = trackTempDirs();
const logger = createLogger({ name: 'required-slots-test', level: 'error' });

function fixture() {
  const projectHomeDir = temp('station-required-slots-');
  const pluginsDir = join(projectHomeDir, 'plugins');
  const deps = {
    projectHomeDir,
    pluginsDir,
    agentsDir: join(projectHomeDir, 'agents'),
    logger,
    buildPlugin: async () => undefined,
  };
  const app = new Hono();
  bindOperatorPrincipal(app);
  registerPluginHomeRoleRoutes(app, {
    ...deps,
    projectVisiblePlugins: () => (names) => names,
  });
  registerPluginInstallRoutes(app, {
    ...deps,
    projectVisiblePlugins: () => (names) => names,
  });
  registerPluginConfigRoutes(app, deps);
  registerPluginLifecycleRoutes(app, deps);
  return { app, deps };
}

function writeManifest(directory: string, manifest: Record<string, unknown>) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'plugin.json'), JSON.stringify(manifest));
}

const emptyFillers = [null, '', 'none'] as const;

describe('required-slot boundaries', () => {
  test.each(emptyFillers)(
    'parser, installer and configuration reject slot filler %j',
    async (value) => {
      for (const slot of ['home', 'chat']) {
        const { app, deps } = fixture();
        const manifest = {
          name: 'slot-test',
          version: '1.0.0',
          requiredSlots: { [slot]: value },
        };
        expect(() =>
          parsePluginManifestDocument(JSON.stringify(manifest), 'plugin.json'),
        ).toThrow(/non-empty filler/);
        const source = join(deps.projectHomeDir, 'source');
        writeManifest(source, manifest);
        await expect(installPluginFromSource(source, [], deps)).rejects.toThrow(
          /non-empty filler/,
        );
        expect(existsSync(join(deps.pluginsDir, 'slot-test'))).toBe(false);
        const install = await app.request('/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            source,
            consent: {
              permissions: [],
              dependencies: [],
              contentDigest: 'sha256:unusable-with-invalid-manifest',
            },
          }),
        });
        expect(install.status).toBe(400);
        expect(await install.json()).toMatchObject({
          success: false,
          error: expect.stringMatching(/non-empty filler/),
        });
        expect(existsSync(join(deps.pluginsDir, 'slot-test'))).toBe(false);
        expect(() =>
          resolveDistributionProfile({
            id: 'test',
            registrySources: [],
            requiredSlots: JSON.parse(JSON.stringify({ [slot]: value })),
          }),
        ).toThrow(/non-empty filler/);
        writeManifest(join(deps.pluginsDir, 'slot-test'), {
          name: 'slot-test',
          version: '1.0.0',
        });
        const response = await app.request('/slot-test/overrides', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requiredSlots: { [slot]: value } }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          error: expect.stringMatching(/non-empty filler/),
        });
      }
    },
  );

  test('installing a valid slot preference does not grant a Home role', async () => {
    const { app, deps } = fixture();
    const source = join(deps.projectHomeDir, 'source');
    writeManifest(source, {
      name: 'preferred-home',
      version: '1.0.0',
      requiredSlots: { home: 'preferred-home-pane' },
    });
    await installPluginFromSource(source, [], deps);
    expect(
      existsSync(join(deps.pluginsDir, 'preferred-home', 'plugin.json')),
    ).toBe(true);
    const response = await app.request('/home-role');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: { state: 'none' },
      slots: { home: { source: 'default' } },
    });
  });

  test.each(Object.values(REQUIRED_SLOT_DEFAULTS))(
    'service and routes refuse removal or disabling of %s',
    async (id) => {
      const { app, deps } = fixture();
      await expect(uninstallInstalledPlugin(id, deps)).rejects.toThrow(
        /Cannot uninstall required-slot default/,
      );
      const catalog = new DistributionProfileService(deps.projectHomeDir);
      expect(() => catalog.setEnabled(id, false)).toThrow(
        /Cannot disable required-slot default/,
      );
      expect(() => catalog.removeBuiltin(id)).toThrow(
        /Cannot uninstall required-slot default/,
      );
      const response = await app.request(`/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        error: expect.stringMatching(/Cannot uninstall required-slot default/),
      });
      const disabled = await app.request(
        `/${encodeURIComponent(id)}/overrides`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ disabled: ['workspacePanes'] }),
        },
      );
      expect(disabled.status).toBe(400);
      expect(await disabled.json()).toMatchObject({
        error: expect.stringMatching(/Cannot disable required-slot default/),
      });
      await expect(
        new ConfigLoader({
          projectHomeDir: deps.projectHomeDir,
        }).savePluginOverrides({ [id]: { disabled: ['workspacePanes'] } }),
      ).rejects.toThrow(/Cannot disable required-slot default/);
      for (const policy of [{ enabled: false }, { preinstalled: false }]) {
        expect(() =>
          resolveDistributionProfile({
            id: 'test',
            registrySources: [],
            itemPolicies: { [id]: policy },
          }),
        ).toThrow(/required-slot default/);
      }
    },
  );

  test('rejects Agent Plugins extension slot erasure before disabling the extension', () => {
    expect(() =>
      parsePluginManifestDocument(
        JSON.stringify({
          $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
          name: 'portable-plugin',
          version: '1.0.0',
          extensions: {
            'io.kontourai.station': {
              schemaVersion: '1.0',
              requiredSlots: { home: null },
            },
          },
        }),
        'plugin.json',
      ),
    ).toThrow(/non-empty filler/);
  });
});

// These are the current writer's manifest, grant envelope and lifecycle shapes.
// Read-through migration leaves the consent record and Inbox/Chat state intact.
test('migrates today’s exact Home grant and lifecycle shapes on every route/service read', async () => {
  const { app, deps } = fixture();
  const pluginDir = join(deps.pluginsDir, 'existing-home');
  writeManifest(pluginDir, {
    name: 'existing-home',
    version: '3.1.0',
    workspacePanes: [
      {
        version: '1.0',
        id: 'existing-home-pane',
        name: 'Existing Home',
        rendererId: 'renderer:plugin:existing-home:home',
        renderer: { kind: 'plugin-component', name: 'existing-home-surface' },
        requiredRendererCapabilities: ['trusted-plugin-react'],
        placement: { supportedRegions: ['standalone'] },
        modes: [{ id: 'default' }],
        provenance: { origin: 'plugin', pluginId: 'existing-home' },
        lifecycle: { stage: 'stable' },
      },
    ],
  });
  mkdirSync(join(pluginDir, 'dist'));
  writeFileSync(join(pluginDir, 'dist', 'bundle.js'), 'export const home = 1;');
  const catalog = new DistributionProfileService(deps.projectHomeDir);
  const entry = catalog.listPluginWorkspacePaneContributions()[0];
  if (!entry) throw new Error('Existing pane was not discovered');
  const grant = createWorkspaceHomeRoleGrant({
    descriptor: entry.descriptor,
    contribution: entry.contribution,
    grantedAt: '2026-10-20T00:00:00Z',
    projectionFields: WORKSPACE_HOME_PROJECTION_FIELDS,
  });
  if (!grant) throw new Error('Existing Home grant was refused');
  const stored = JSON.stringify({
    'home-role': {
      grant,
      installDigest: computeWorkspaceHomeRoleInstallDigest(
        deps.pluginsDir,
        'existing-home',
      ),
    },
  });
  writeFileSync(workspaceHomeRolePath(deps.projectHomeDir), stored);
  const read = () =>
    readInstallationRequiredSlots({
      ...deps,
      listContributions: () => catalog.listPluginWorkspacePaneContributions(),
    });
  const route = async () => {
    const response = await app.request('/home-role');
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(read()).toMatchObject({
    status: { state: 'granted', grant },
    slots: {
      home: { source: 'override', safeMode: false },
      chat: { source: 'default', filler: { id: 'builtin:workspace-chat' } },
    },
  });
  expect(await route()).toMatchObject({
    status: { state: 'granted' },
    slots: { home: { source: 'override' } },
  });
  mkdirSync(join(deps.projectHomeDir, 'config'), { recursive: true });
  writeFileSync(
    join(deps.projectHomeDir, 'config', 'distribution-lifecycle.json'),
    JSON.stringify({
      version: 1,
      items: { [entry.id]: { enabled: false } },
      revisions: {
        epoch: '11111111111111111111111111111111',
        items: { [entry.id]: 1 },
      },
    }),
  );
  expect(read()).toMatchObject({
    status: { state: 'lapsed', reason: 'pane-disabled' },
    slots: { home: { source: 'default', safeMode: false } },
  });
  expect(await route()).toMatchObject({
    slots: { home: { source: 'default', safeMode: false } },
  });
  rmSync(join(deps.projectHomeDir, 'config', 'distribution-lifecycle.json'));
  writeFileSync(join(pluginDir, 'dist', 'bundle.js'), 'broken replacement');
  expect(read()).toMatchObject({
    status: { state: 'lapsed', reason: 'code-changed' },
    slots: { home: { source: 'default', safeMode: false } },
  });
  expect(await route()).toMatchObject({
    slots: { home: { source: 'default', safeMode: false } },
  });
  rmSync(pluginDir, { recursive: true });
  expect(read()).toMatchObject({
    status: { state: 'lapsed', reason: 'plugin-missing' },
    slots: { home: { source: 'default', safeMode: false } },
  });
  expect(await route()).toMatchObject({
    slots: { home: { source: 'default', safeMode: false } },
  });
  expect(readFileSync(workspaceHomeRolePath(deps.projectHomeDir), 'utf8')).toBe(
    stored,
  );
  await app.request('/home-role', { method: 'DELETE' });
  expect(read()).toMatchObject({
    status: { state: 'none' },
    slots: { home: { source: 'default' } },
  });
});
