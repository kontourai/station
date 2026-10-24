/**
 * #2995 — a layout read states its CONTRIBUTOR's declaration (`primary`,
 * `presentation`, `drillIns`): the built-in starter's, or the installed
 * plugin's current one less any claim its plugin is not granted. The stored
 * record never carries it, and no request body can write it.
 *
 * Driven through the real project routes over a real file store and a real
 * installed-plugin tree, with the real grants store.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  projectOps: { add: vi.fn() },
}));

const { createProjectRoutes } = await import('../projects.js');
const { FileStorageAdapter } = await import(
  '../../../domain/file-storage-adapter.js'
);
const { putProject } = await import(
  '../../../domain/__tests__/file-storage-test-helpers.js'
);
const { ProjectService } = await import(
  '../../../services/projects/project-service.js'
);
const { grantPermissions } = await import(
  '../../../services/plugins/plugin-permissions.js'
);

const NOW = '2026-08-01T00:00:00.000Z';
const PLUGIN = 'stack-fixture';
const PANE_ONE = `pane:plugin%3A${PLUGIN}:stack:one`;
const PANE_TWO = `pane:plugin%3A${PLUGIN}:stack:two`;
const tempHome = trackTempDirs();

function home(): string {
  return tempHome('station-layout-declaration-');
}

/** A legacy-format plugin with one layout of two plugin-component tabs. */
function writeStackPlugin(
  projectHome: string,
  declaration: Record<string, unknown>,
): void {
  const dir = join(projectHome, 'plugins', PLUGIN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'plugin.json'),
    JSON.stringify({
      name: PLUGIN,
      version: '1.0.0',
      permissions: ['layout.primaryChat'],
      layout: { slug: 'stack', source: 'layout.json' },
    }),
  );
  writeFileSync(
    join(dir, 'layout.json'),
    JSON.stringify({
      name: 'Stack fixture',
      slug: 'stack',
      tabs: [
        { id: 'one', label: 'One', component: 'stack-fixture-one' },
        { id: 'two', label: 'Two', component: 'stack-fixture-two' },
      ],
      ...declaration,
    }),
  );
}

function appFor(
  projectHome: string,
  canSeePlugin?: (pluginId: string) => boolean,
) {
  const storage = new FileStorageAdapter(projectHome);
  const projectService = new ProjectService(storage);
  return {
    app: createProjectRoutes(
      projectService as any,
      storage as any,
      projectHome,
      {
        listAgents: async () => [],
        ...(canSeePlugin
          ? {
              canSeePlugin: (_c: unknown, pluginId: string) =>
                canSeePlugin(pluginId),
            }
          : {}),
      } as any,
    ),
    storage,
  };
}

async function seed(
  storage: InstanceType<typeof FileStorageAdapter>,
  layouts: Array<Record<string, unknown>>,
): Promise<void> {
  await putProject(storage, {
    id: 'project-1',
    slug: 'demo',
    name: 'Demo',
    createdAt: NOW,
    updatedAt: NOW,
  } as any);
  for (const layout of layouts) {
    await storage.createLayout('demo', {
      projectSlug: 'demo',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
      ...layout,
    } as any);
  }
}

/** The exact shape `applyCatalogLayout` persists for a built-in Coding. */
const STORED_CODING = {
  id: 'layout-coding',
  slug: 'coding',
  name: 'Coding',
  type: 'coding',
  workspaceBinding: 'repository',
  catalogContribution: {
    id: 'builtin:coding',
    version: '1',
    sourceIdentity: { id: 'builtin', kind: 'builtin' },
    provenance: { origin: 'builtin' },
  },
  config: {},
};

/** The exact shape `applyCatalogLayout` persists for a plugin layout. */
const STORED_PLUGIN = {
  id: 'layout-stack',
  slug: 'stack',
  name: 'Stack fixture',
  type: 'custom',
  catalogContribution: {
    id: `plugin:${PLUGIN}:stack`,
    version: '1.0.0',
    sourceIdentity: { id: PLUGIN, kind: 'local', source: `plugins/${PLUGIN}` },
    provenance: { origin: 'plugin', pluginId: PLUGIN },
  },
  config: {
    plugin: PLUGIN,
    tabs: [
      { id: 'one', label: 'One', component: 'stack-fixture-one' },
      { id: 'two', label: 'Two', component: 'stack-fixture-two' },
    ],
  },
};

const STACK = {
  primary: 'chat',
  presentation: 'stack',
  drillIns: [PANE_ONE, PANE_TWO],
};

describe('layout reads state the contributor’s declaration (#2995)', () => {
  test('a stored built-in Coding record reads with Coding’s declaration', async () => {
    const projectHome = home();
    const { app, storage } = appFor(projectHome);
    await seed(storage, [STORED_CODING]);
    const res = await app.request('/demo/layouts/coding');
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject({
      primary: 'chat',
      presentation: 'stack',
      drillIns: [
        'pane:builtin:coding:diff',
        'pane:builtin:coding:file-browser',
        'pane:builtin:coding:terminal',
        'pane:builtin:evidence:plan',
        'pane:builtin:evidence:readiness',
        'pane:builtin:evidence:trust',
      ],
    });
    // Nothing was written: the record on disk still carries no declaration.
    const disk = JSON.parse(
      readFileSync(
        join(projectHome, 'projects', 'demo', 'layouts', 'coding.json'),
        'utf-8',
      ),
    );
    expect(disk).not.toHaveProperty('primary');
    expect(disk).not.toHaveProperty('presentation');
  });

  test('a granted plugin layout reads with its Chat centre and drill-ins', async () => {
    const projectHome = home();
    writeStackPlugin(projectHome, STACK);
    await grantPermissions(projectHome, PLUGIN, ['layout.primaryChat']);
    const { app, storage } = appFor(projectHome);
    await seed(storage, [STORED_PLUGIN]);
    const res = await app.request('/demo/layouts/stack');
    expect(res.status).toBe(200);
    expect((await json(res)).data).toMatchObject(STACK);
  });

  test('without the layout.primaryChat grant the plugin layout keeps its stack but not the claim', async () => {
    const projectHome = home();
    writeStackPlugin(projectHome, STACK);
    const { app, storage } = appFor(projectHome);
    await seed(storage, [STORED_PLUGIN]);
    const data = (await json(await app.request('/demo/layouts/stack'))).data;
    expect(data).toMatchObject({
      presentation: 'stack',
      drillIns: [PANE_ONE, PANE_TWO],
    });
    expect(data).not.toHaveProperty('primary');
  });

  test('a plugin whose layout declares an unknown primary is answered as tabs', async () => {
    const projectHome = home();
    writeStackPlugin(projectHome, { ...STACK, primary: 'terminal' });
    await grantPermissions(projectHome, PLUGIN, ['layout.primaryChat']);
    const { app, storage } = appFor(projectHome);
    await seed(storage, [STORED_PLUGIN]);
    const data = (await json(await app.request('/demo/layouts/stack'))).data;
    expect(data.presentation).toBe('tabs');
    expect(data).not.toHaveProperty('primary');
    expect(data).not.toHaveProperty('drillIns');
  });

  test('a plugin record typed coding gets nothing from the word', async () => {
    const projectHome = home();
    writeStackPlugin(projectHome, {});
    const { app, storage } = appFor(projectHome);
    await seed(storage, [{ ...STORED_PLUGIN, type: 'coding' }]);
    const data = (await json(await app.request('/demo/layouts/stack'))).data;
    expect(data.presentation).toBe('tabs');
    expect(data).not.toHaveProperty('primary');
  });

  test('the list states each row’s declaration, and a withheld row states only tabs', async () => {
    const projectHome = home();
    writeStackPlugin(projectHome, STACK);
    await grantPermissions(projectHome, PLUGIN, ['layout.primaryChat']);
    const visible = appFor(projectHome);
    await seed(visible.storage, [STORED_CODING, STORED_PLUGIN]);
    const rows = (await json(await visible.app.request('/demo/layouts'))).data;
    expect(rows.find((row: any) => row.slug === 'coding')).toMatchObject({
      primary: 'chat',
      presentation: 'stack',
    });
    expect(rows.find((row: any) => row.slug === 'stack')).toMatchObject(STACK);

    const hidden = appFor(projectHome, () => false);
    const hiddenRows = (await json(await hidden.app.request('/demo/layouts')))
      .data;
    const withheld = hiddenRows.find((row: any) => row.slug === 'stack');
    expect(withheld.presentation).toBe('tabs');
    expect(withheld).not.toHaveProperty('primary');
    expect(withheld).not.toHaveProperty('drillIns');
    expect(withheld.plugin).toBeUndefined();
    const hiddenDetail = (
      await json(await hidden.app.request('/demo/layouts/stack'))
    ).data;
    expect(hiddenDetail.presentation).toBe('tabs');
    expect(hiddenDetail).not.toHaveProperty('drillIns');
  });

  test('a GET→PUT round trip is accepted and persists no declaration', async () => {
    const projectHome = home();
    const { app, storage } = appFor(projectHome);
    await seed(storage, [STORED_CODING]);
    const read = (await json(await app.request('/demo/layouts/coding'))).data;
    const res = await app.request('/demo/layouts/coding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...read, name: 'Renamed' }),
    });
    expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
    expect((await json(res)).data).toMatchObject({
      name: 'Renamed',
      primary: 'chat',
      presentation: 'stack',
    });
    const disk = JSON.parse(
      readFileSync(
        join(projectHome, 'projects', 'demo', 'layouts', 'coding.json'),
        'utf-8',
      ),
    );
    expect(disk.name).toBe('Renamed');
    expect(disk).not.toHaveProperty('primary');
    expect(disk).not.toHaveProperty('presentation');
    expect(disk).not.toHaveProperty('drillIns');
  });

  test('a create body cannot write itself a Chat centre', async () => {
    const projectHome = home();
    const { app, storage } = appFor(projectHome);
    await seed(storage, []);
    const res = await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'mine',
        name: 'Mine',
        type: 'custom',
        primary: 'chat',
        presentation: 'stack',
        drillIns: ['pane:builtin:coding:diff'],
      }),
    });
    expect(res.status).toBe(201);
    const created = (await json(res)).data;
    expect(created.presentation).toBe('tabs');
    expect(created).not.toHaveProperty('primary');
    const read = (await json(await app.request('/demo/layouts/mine'))).data;
    expect(read.presentation).toBe('tabs');
    expect(read).not.toHaveProperty('primary');
  });
});
