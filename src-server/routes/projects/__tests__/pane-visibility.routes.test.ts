/**
 * #2067 — the Pane catalogue route, end to end, through a real
 * `FileStorageAdapter`.
 *
 * It drives `GET /:slug/panes` and `GET /layouts/available` through the REAL
 * `createProjectRoutes`, because both are `projected` rows in
 * `PLUGIN_IDENTITY_ROUTES` and a service-level test of the catalogue builder
 * does not prove the ROUTE passes the projection down. Deleting
 * `canSeePlugin` from the route's deps must red something here, and does.
 *
 * (An earlier version of this file drove a referenced-pane path that has
 * since been removed — see the `'visibility'` reason-code docblock in
 * `packages/contracts/src/workspace-pane-availability.ts` for why. What
 * remains is the discovery projection, which is live.)
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  projectOps: { add: vi.fn() },
  workspacePaneAvailabilityResolutions: { add: vi.fn() },
  projectPaneCatalogDuration: { record: vi.fn() },
}));

const { createProjectRoutes } = await import('../projects.js');
const { FileStorageAdapter } = await import(
  '../../../domain/file-storage-adapter.js'
);
const { ProjectService } = await import(
  '../../../services/projects/project-service.js'
);

const NOW = '2026-01-01T00:00:00.000Z';
const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

const PLUGIN_NAME = 'secret-notes';

/** One direct plugin Pane declaration, as the distribution service reports it. */
const PLUGIN_PANE = {
  id: `plugin:${PLUGIN_NAME}:pane-0123456789ab`,
  pluginName: PLUGIN_NAME,
  enabled: true as const,
  descriptor: {
    version: '1.0',
    id: `${PLUGIN_NAME}-review`,
    name: 'Secret Review',
    rendererId: `${PLUGIN_NAME}.review`,
    renderer: { kind: 'plugin-component' as const, name: 'review' },
    placement: { supportedRegions: ['primary' as const] },
    modes: [{ id: 'default', contextRequirement: { project: true as const } }],
    provenance: { origin: 'plugin' as const, pluginId: PLUGIN_NAME },
    lifecycle: { stage: 'stable' as const },
  },
  contribution: {
    id: `plugin:${PLUGIN_NAME}:pane-0123456789ab`,
    version: '4.5.6',
    sourceIdentity: {
      id: PLUGIN_NAME,
      kind: 'local' as const,
      source: `plugins/${PLUGIN_NAME}`,
    },
    provenance: { origin: 'plugin' as const, pluginId: PLUGIN_NAME },
  },
};

/** One plugin-contributed layout, as the distribution catalog reports it. */
const PLUGIN_LAYOUT = {
  installationReadiness: { state: 'ready' as const },
  source: 'plugin',
  plugin: PLUGIN_NAME,
  name: 'Secret layout',
  slug: 'secret-layout',
  type: 'coding',
  id: 'plugin:secret-notes:layout',
  sourceIdentity: {
    id: 'secret-notes',
    kind: 'local' as const,
    source: 'plugins/secret-notes',
  },
  contribution: {
    id: 'plugin:secret-notes:layout',
    version: '1.0.0',
    sourceIdentity: {
      id: 'secret-notes',
      kind: 'local' as const,
      source: 'plugins/secret-notes',
    },
    provenance: { origin: 'plugin' as const, pluginId: 'secret-notes' },
  },
  lifecycle: {
    itemId: 'plugin:secret-notes:layout',
    state: 'installed' as const,
    source: 'secret-notes',
  },
  visible: true,
  installable: false,
  enabled: true,
  policy: {},
  tabCount: 1,
};

async function seeded(options: { canSeePlugin: () => boolean }) {
  const home = mkdtempSync(join(tmpdir(), 'station-pane-visibility-'));
  tempDirs.push(home);
  const storage = new FileStorageAdapter(home);
  const projectService = new ProjectService(storage);
  const app = createProjectRoutes(
    projectService as never,
    storage as never,
    home,
    {
      listAgents: async () => [],
      canSeePlugin: options.canSeePlugin,
      layoutCatalog: {
        listLayouts: () => [PLUGIN_LAYOUT],
        listInstalledLayouts: () => [PLUGIN_LAYOUT],
        listPluginWorkspacePaneContributions: () => [PLUGIN_PANE],
        // Returns a layout with no tabs, so the layout itself contributes no
        // Pane and the direct contribution above is the only one. It must
        // not throw: the operator control reaches it.
        resolveForCatalog: () => ({
          item: PLUGIN_LAYOUT,
          definition: { ...PLUGIN_LAYOUT, tabs: [] },
          pluginName: PLUGIN_NAME,
        }),
      },
    } as never,
  );
  await storage.createProject({
    id: 'project-1',
    slug: 'demo',
    name: 'Demo',
    createdAt: NOW,
    updatedAt: NOW,
  });
  return { app };
}

describe('GET /:slug/panes is projected', () => {
  test('a collaborator gets no trace of a plugin they cannot see', async () => {
    const hidden = await seeded({ canSeePlugin: () => false });
    const response = await hidden.app.request('/demo/panes');
    expect(response.status).toBe(200);
    // Whole body: the catalogue carries a plugin's name, version,
    // `plugins/<name>` source and lifecycle state across four arrays, and
    // this family's defect was always a field nobody asserted on.
    expect(await response.text()).not.toContain(PLUGIN_NAME);
  });

  test('the operator gets it, so the absence above is a projection', async () => {
    // The control. Without it a route that returned an empty catalogue for
    // everybody — or that had lost `canSeePlugin` entirely and thrown —
    // would satisfy the case above.
    const visible = await seeded({ canSeePlugin: () => true });
    const response = await visible.app.request('/demo/panes');
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(PLUGIN_NAME);
  });
});

describe('GET /layouts/available is projected', () => {
  test('a layout from a plugin the viewer cannot see is absent, and present for one who can', async () => {
    // The row is recorded `projected` in PLUGIN_IDENTITY_ROUTES and was
    // excused there by a citation to a test file that did not exist. This
    // is that test.
    const hidden = await seeded({ canSeePlugin: () => false });
    const visible = await seeded({ canSeePlugin: () => true });
    const read = async (app: Hono) =>
      JSON.stringify(await json(await app.request('/layouts/available')));
    // The control first: the catalogue is reachable and non-trivial for a
    // caller who can see everything, so the absence below is a projection
    // rather than an empty fixture.
    const asOperator = await read(visible.app);
    const asCollaborator = await read(hidden.app);
    // The control: the catalogue really does carry the plugin layout, so the
    // absence below is a projection rather than an empty fixture.
    expect(asOperator).toContain(PLUGIN_NAME);
    expect(asCollaborator).not.toContain(PLUGIN_NAME);
    expect(asCollaborator).toContain('"success":true');
  });
});
