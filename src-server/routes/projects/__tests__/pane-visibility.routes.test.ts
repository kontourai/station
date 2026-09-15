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
 * `packages/contracts/src/workspace-pane-availability.ts` for why.)
 *
 * #2090/#2103 add the REFERENCE half below: the layout read routes, driven
 * through the same real composition. Those cases build their fixture with
 * the ONLY writer of `catalogContribution` — `POST /:slug/layouts/apply` —
 * and assert the STORED record before asserting any behaviour, because the
 * previous attempt at this passed against a layout shape no writer produces.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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

/**
 * The tabs `POST /:slug/layouts/apply` PERSISTS into the project record.
 *
 * Deliberately free of the plugin's name: descriptor and component ids are
 * plugin-author-chosen with no namespacing requirement, so this is the
 * realistic shape, and it is what makes the whole-body assertions below bite
 * on the fields that really do name the plugin rather than on a fixture that
 * spells it everywhere.
 */
const STORED_TABS = [
  { id: 'notes', label: 'Notes', component: 'notes-view' },
] as const;

/**
 * The tabs the plugin declares ON DISK, which `readPluginLayout` merges over
 * the stored ones. These DO carry the plugin's name, so a response that
 * performed the live merge for a caller who cannot see the plugin fails the
 * "names it nowhere" assertion — the merge is the leak, and this is what
 * discriminates it from the stored copy.
 */
const LIVE_TABS = [
  {
    id: 'notes',
    label: `${PLUGIN_NAME} notes`,
    component: `${PLUGIN_NAME}.notes`,
  },
] as const;

async function seeded(options: {
  canSeePlugin?: (pluginId: string) => boolean;
}) {
  const home = mkdtempSync(join(tmpdir(), 'station-pane-visibility-'));
  tempDirs.push(home);
  // The plugin as it exists ON THIS INSTANCE. `readPluginLayout` reads these
  // two files, and a caller who cannot see the plugin must not learn from the
  // response that they exist.
  const pluginDir = join(home, 'plugins', PLUGIN_NAME);
  mkdirSync(pluginDir, { recursive: true });
  writeFileSync(
    join(pluginDir, 'plugin.json'),
    JSON.stringify({
      name: PLUGIN_NAME,
      version: '4.5.6',
      layout: { source: 'layout.json' },
    }),
  );
  writeFileSync(
    join(pluginDir, 'layout.json'),
    JSON.stringify({ name: 'Secret layout', tabs: LIVE_TABS }),
  );
  const storage = new FileStorageAdapter(home);
  const projectService = new ProjectService(storage);
  const app = createProjectRoutes(
    projectService as never,
    storage as never,
    home,
    {
      listAgents: async () => [],
      ...(options.canSeePlugin ? { canSeePlugin: options.canSeePlugin } : {}),
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
        // The apply path's resolver. This one DOES carry tabs, because apply
        // is the only writer of `catalogContribution` and the fixture below
        // needs the record it really writes. An id nobody has throws the
        // REAL service's message verbatim (`resolveForCatalog` in
        // `distribution-profile-service.ts`), so the refusal-identity case
        // compares two real answers rather than one answer and a quotation.
        resolveForApply: (id: string) => {
          if (id !== PLUGIN_LAYOUT.id) {
            throw new Error('Layout is not a known installed contribution');
          }
          return {
            item: PLUGIN_LAYOUT,
            definition: { ...PLUGIN_LAYOUT, tabs: STORED_TABS },
            pluginName: PLUGIN_NAME,
          };
        },
        getPluginManifest: () => undefined,
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
  return { app, storage };
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

/**
 * #2090/#2103 — the REFERENCE half, on the routes that read a SAVED layout.
 *
 * The fixture is built by the real writer. The previous attempt at this
 * shipped a test that passed against a layout shape no writer produces, so
 * every case here starts from `POST /:slug/layouts/apply` — the only writer
 * of `catalogContribution` — and the first test asserts the STORED record
 * before any behaviour is claimed about reading it.
 */
async function appliedPluginLayout(options: {
  canSeePlugin?: (pluginId: string) => boolean;
}) {
  const context = await seeded(options);
  const applied = await context.app.request('/demo/layouts/apply', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ layoutId: PLUGIN_LAYOUT.id }),
  });
  return { ...context, applied };
}

/** Create a layout the ordinary way, as any project member may. */
function createLayout(
  app: Hono,
  body: { slug: string; name: string; config: Record<string, unknown> },
) {
  return app.request('/demo/layouts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('a saved layout naming a plugin the viewer cannot see', () => {
  test('the fixture is what the real writer stores', async () => {
    // Asserted FIRST and separately. Everything below is a claim about
    // reading this record; if the record is not the one apply writes, none of
    // those claims are about production.
    const { applied, storage } = await appliedPluginLayout({
      canSeePlugin: () => true,
    });
    expect(applied.status).toBe(201);
    const stored = storage.getLayout('demo', PLUGIN_LAYOUT.slug);
    expect(stored.catalogContribution?.provenance).toEqual({
      origin: 'plugin',
      pluginId: PLUGIN_NAME,
    });
    expect(stored.config.plugin).toBe(PLUGIN_NAME);
    expect(stored.config.tabs).toEqual(STORED_TABS);
    expect((stored.config.tabs as unknown[]).length).toBeGreaterThan(0);
  });

  test('the read names the plugin nowhere and marks its tabs unavailable', async () => {
    // Sight is withdrawn AFTER the record exists, which is the real shape:
    // an operator applied the layout, and this person cannot see the plugin.
    let visible = true;
    const { app } = await seeded({ canSeePlugin: () => visible });
    expect(
      (
        await app.request('/demo/layouts/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layoutId: PLUGIN_LAYOUT.id }),
        })
      ).status,
    ).toBe(201);
    visible = false;

    const response = await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`);
    expect(response.status).toBe(200);
    const text = await response.text();
    // Whole body: this family's defect was always a field nobody asserted on.
    expect(text).not.toContain(PLUGIN_NAME);
    const data = JSON.parse(text).data as Record<string, any>;
    expect(data.catalogContribution).toBeUndefined();
    expect(data.config.plugin).toBeUndefined();
    // The stored tabs remain — they are the project's own record, and the
    // verdict is keyed on their ids. The LIVE ones, read from the plugin on
    // disk, do not: that merge is the disclosure.
    expect(data.config.tabs).toEqual(STORED_TABS);
    expect(data.paneReferences).toEqual({ unavailableTabIds: ['notes'] });
    // The tab id, never the minted descriptor id, which encodes the plugin.
    expect(JSON.stringify(data.paneReferences)).not.toContain('pane:');
  });

  test('a viewer who can see it reads exactly what they read before', async () => {
    // The control. Without it a route that withheld from everybody would
    // satisfy the case above.
    const { app } = await appliedPluginLayout({ canSeePlugin: () => true });
    const response = await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`);
    expect(response.status).toBe(200);
    const body = await json<{ data: Record<string, any> }>(response);
    expect(body.data.config.plugin).toBe(PLUGIN_NAME);
    expect(body.data.catalogContribution.provenance.pluginId).toBe(PLUGIN_NAME);
    // The live merge still happens for them, which is the pre-change
    // behaviour this route has always had.
    expect(body.data.config.tabs).toEqual(LIVE_TABS);
    expect(body.data.paneReferences).toBeUndefined();
  });

  test('a composition with no projection is untouched', async () => {
    // Absence must never read as a verdict: a route wired without
    // `canSeePlugin` must answer exactly as it did before this existed, or
    // every plugin layout is hidden from every caller.
    const { app } = await appliedPluginLayout({});
    const body = await json<{ data: Record<string, any> }>(
      await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`),
    );
    expect(body.data.config.plugin).toBe(PLUGIN_NAME);
    expect(body.data.config.tabs).toEqual(LIVE_TABS);
    expect(body.data.paneReferences).toBeUndefined();
  });

  test('a Kit layout is left alone', async () => {
    // Kit layouts carry `config.kit.contributionRef` and no `config.plugin`,
    // so they must fall into the emit-nothing branch even though the
    // projection is wired and refuses everything.
    const { app } = await seeded({ canSeePlugin: () => false });
    expect(
      (
        await createLayout(app, {
          slug: 'kit-board',
          name: 'Kit board',
          config: {
            kit: { contributionRef: 'some-kit/view' },
            tabs: [
              { id: 'main', label: 'Main', component: 'kit-standard-view' },
            ],
          },
        })
      ).status,
    ).toBe(201);
    const body = await json<{ data: Record<string, any> }>(
      await app.request('/demo/layouts/kit-board'),
    );
    expect(body.data.paneReferences).toBeUndefined();
    expect(body.data.config.kit).toEqual({ contributionRef: 'some-kit/view' });
  });
});

describe('the layout routes are not an enumeration oracle (#2103)', () => {
  /**
   * The regression test #2103 names. `PluginVisibilityService.canSee` reads a
   * grant list rather than the install tree, so a non-operator gets `false`
   * for a hidden plugin AND for a name nobody ever installed — which is what
   * makes these two responses one answer rather than two.
   */
  const asCollaborator = () => seeded({ canSeePlugin: () => false });

  test('a hidden plugin and a plugin that exists nowhere read identically', async () => {
    const { app } = await asCollaborator();
    for (const [slug, plugin] of [
      ['guess-hidden', PLUGIN_NAME],
      ['guess-absent', 'no-such-plugin-anywhere'],
    ] as const) {
      expect(
        (
          await createLayout(app, {
            slug,
            name: 'Guess',
            config: { plugin },
          })
        ).status,
      ).toBe(201);
    }
    const read = async (slug: string) => {
      const body = await json<{ data: Record<string, any> }>(
        await app.request(`/demo/layouts/${slug}`),
      );
      // Record identity differs by construction (two records cannot share a
      // slug); everything that could report on the PLUGIN is compared.
      const { id, slug: _slug, createdAt, updatedAt, ...rest } = body.data;
      return JSON.stringify(rest);
    };
    expect(await read('guess-hidden')).toBe(await read('guess-absent'));
    // The control: the fixture really does have one of these plugins
    // installed, so the equality above is a projection rather than two empty
    // reads. An operator sees the difference.
    const operator = await seeded({ canSeePlugin: () => true });
    for (const [slug, plugin] of [
      ['guess-hidden', PLUGIN_NAME],
      ['guess-absent', 'no-such-plugin-anywhere'],
    ] as const) {
      await createLayout(operator.app, {
        slug,
        name: 'Guess',
        config: { plugin },
      });
    }
    const asOperator = async (slug: string) =>
      await (await operator.app.request(`/demo/layouts/${slug}`)).text();
    expect(await asOperator('guess-hidden')).toContain('notes');
    expect(await asOperator('guess-absent')).not.toContain('notes');
  });

  test('the layout LIST withholds the same name the detail read does', async () => {
    const { app } = await asCollaborator();
    await createLayout(app, {
      slug: 'guess-hidden',
      name: 'Guess',
      config: { plugin: PLUGIN_NAME },
    });
    const listed = await app.request('/demo/layouts');
    expect(listed.status).toBe(200);
    expect(await listed.text()).not.toContain(PLUGIN_NAME);

    const operator = await seeded({ canSeePlugin: () => true });
    await createLayout(operator.app, {
      slug: 'guess-hidden',
      name: 'Guess',
      config: { plugin: PLUGIN_NAME },
    });
    expect(
      await (await operator.app.request('/demo/layouts')).text(),
    ).toContain(PLUGIN_NAME);
  });

  test('apply refuses a hidden plugin exactly as it refuses an unknown id', async () => {
    const { app } = await asCollaborator();
    const refusal = async (layoutId: string) => {
      const response = await app.request('/demo/layouts/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layoutId }),
      });
      return `${response.status} ${await response.text()}`;
    };
    expect(await refusal(PLUGIN_LAYOUT.id)).toBe(
      await refusal('plugin:nobody-has-this:layout'),
    );
    expect(await refusal(PLUGIN_LAYOUT.id)).toContain(
      'Layout is not a known installed contribution',
    );
    const operator = await seeded({ canSeePlugin: () => true });
    expect(
      (
        await operator.app.request('/demo/layouts/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layoutId: PLUGIN_LAYOUT.id }),
        })
      ).status,
    ).toBe(201);
  });

  test('from-plugin answers 404 by name for hidden and uninstalled alike', async () => {
    const { app } = await asCollaborator();
    const answer = async (plugin: string) => {
      const response = await app.request('/demo/layouts/from-plugin', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ plugin }),
      });
      return `${response.status} ${(await response.text()).replace(plugin, '<name>')}`;
    };
    expect(await answer(PLUGIN_NAME)).toBe(await answer('no-such-plugin'));
    expect(await answer(PLUGIN_NAME)).toContain('404');
    // The control.
    const operator = await seeded({ canSeePlugin: () => true });
    expect(
      (
        await operator.app.request('/demo/layouts/from-plugin', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ plugin: PLUGIN_NAME }),
        })
      ).status,
    ).toBe(201);
  });
});

describe('the write path survives what the read path withholds', () => {
  test('a read-modify-write neither is refused nor destroys the binding', async () => {
    // Two independent hazards in one round trip: `paneReferences` is
    // response-only and the STORAGE schema is `.strict()`, and `config` is
    // replaced wholesale by the body — so a caller who PUTs back what they
    // read would otherwise 400, or erase the plugin binding they could not
    // see.
    let visible = true;
    const { app, storage } = await seeded({ canSeePlugin: () => visible });
    expect(
      (
        await app.request('/demo/layouts/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layoutId: PLUGIN_LAYOUT.id }),
        })
      ).status,
    ).toBe(201);
    visible = false;
    const read = await json<{ data: Record<string, any> }>(
      await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`),
    );
    expect(read.data.paneReferences).toBeDefined();
    const written = await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...read.data, name: 'Renamed' }),
    });
    expect(written.status).toBe(200);
    const stored = storage.getLayout('demo', PLUGIN_LAYOUT.slug);
    expect(stored.name).toBe('Renamed');
    expect(stored.config.plugin).toBe(PLUGIN_NAME);
    expect(stored).not.toHaveProperty('paneReferences');
    // The write's own answer is projected exactly as the read is.
    expect(await written.clone().text()).not.toContain(PLUGIN_NAME);
    const body = await json<{ data: Record<string, any> }>(written);
    expect(body.data.paneReferences).toEqual({ unavailableTabIds: ['notes'] });
  });
});
