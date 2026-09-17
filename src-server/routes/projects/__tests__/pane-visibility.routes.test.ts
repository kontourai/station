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
 * NAMESPACED, because that is what real plugins ship: `survey-review-workbench-main`,
 * `fieldwork-review-main`, `minimal-workspace`. An earlier version of this
 * fixture used a bare `notes-view` and was commented as "the realistic
 * shape", which made a whole-body "names the plugin nowhere" assertion pass
 * for a reason the fixture chose rather than a reason the code guarantees.
 * It does not hold for an applied layout and the tests below no longer claim
 * it does — see `a withheld response still spells the plugin name`.
 */
const STORED_TABS = [
  { id: 'notes', label: 'Notes', component: `${PLUGIN_NAME}-notes-view` },
] as const;

/**
 * The tabs the plugin declares ON DISK, which `readPluginLayout` merges over
 * the stored ones. These DO carry the plugin's name, so a response that
 * performed the live merge for a caller who cannot see the plugin fails the
 * "names it nowhere" assertion — the merge is the leak, and this is what
 * discriminates it from the stored copy.
 */
/** A second installed plugin, hidden while `PLUGIN_NAME` is visible. */
const OTHER_PLUGIN = 'hidden-ledger';

/** Installed here, but DISABLED — the other refusal `resolveForApply` gives. */
const DISABLED_LAYOUT_ID = `plugin:${OTHER_PLUGIN}:layout`;

const OTHER_LIVE_TABS = [
  {
    id: 'ledger',
    label: `${OTHER_PLUGIN} ledger`,
    component: `${OTHER_PLUGIN}.ledger`,
  },
] as const;

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
  const installPlugin = (name: string, tabs: unknown) => {
    const pluginDir = join(home, 'plugins', name);
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(
      join(pluginDir, 'plugin.json'),
      JSON.stringify({
        name,
        version: '4.5.6',
        layout: { source: 'layout.json' },
      }),
    );
    writeFileSync(
      join(pluginDir, 'layout.json'),
      JSON.stringify({ name: `${name} layout`, tabs }),
    );
  };
  installPlugin(PLUGIN_NAME, LIVE_TABS);
  // A SECOND installed plugin, for the per-plugin cases. A predicate that is
  // globally true or false cannot discriminate a decision that reads one
  // field while the merge reads another; two plugins with opposite
  // visibility is what makes that case fail when it is wrong.
  installPlugin(OTHER_PLUGIN, OTHER_LIVE_TABS);
  const storage = new FileStorageAdapter(home);
  const projectService = new ProjectService(storage);
  const app = createProjectRoutes(
    projectService as never,
    storage as never,
    home,
    {
      listAgents: async () => [],
      // The route dep is `(c, pluginId)`; the cases here take a PER-PLUGIN
      // predicate, so the context is dropped once, here, rather than in
      // every case (the earlier `() => false` cases happened not to care,
      // which is what hid the arity from them).
      ...(options.canSeePlugin
        ? {
            canSeePlugin: (_c: unknown, pluginId: string) =>
              options.canSeePlugin!(pluginId),
          }
        : {}),
      layoutCatalog: {
        listLayouts: () => [PLUGIN_LAYOUT],
        listInstalledLayouts: () => [PLUGIN_LAYOUT],
        listPluginWorkspacePaneContributions: () => [PLUGIN_PANE],
        // Returns a layout with no tabs, so the layout itself contributes no
        // Pane and the direct contribution above is the only one. It must
        // not throw: the operator control reaches it.
        resolveForCatalog: (id?: string) =>
          id === DISABLED_LAYOUT_ID
            ? {
                item: {
                  ...PLUGIN_LAYOUT,
                  id: DISABLED_LAYOUT_ID,
                  plugin: OTHER_PLUGIN,
                  enabled: false,
                  contribution: {
                    ...PLUGIN_LAYOUT.contribution,
                    id: DISABLED_LAYOUT_ID,
                    sourceIdentity: {
                      id: OTHER_PLUGIN,
                      kind: 'local' as const,
                      source: `plugins/${OTHER_PLUGIN}`,
                    },
                    provenance: {
                      origin: 'plugin' as const,
                      pluginId: OTHER_PLUGIN,
                    },
                  },
                },
                definition: { ...PLUGIN_LAYOUT, tabs: [] },
                pluginName: OTHER_PLUGIN,
              }
            : {
                item: PLUGIN_LAYOUT,
                definition: { ...PLUGIN_LAYOUT, tabs: [] },
                pluginName: PLUGIN_NAME,
              },
        // The apply path's resolver. This one DOES carry tabs, because apply
        // is the only writer of `catalogContribution` and the fixture below
        // needs the record it really writes. An id nobody has throws the
        // REAL service's message verbatim (`resolveForCatalog` in
        // `distribution-profile-service.ts`), so the refusal-identity case
        // compares two real answers rather than one answer and a quotation.
        resolveForApply: (id: string) => {
          if (id === DISABLED_LAYOUT_ID) {
            // The REAL service's other refusal: `resolveForApply` is
            // `resolveForCatalog` plus an installed-and-enabled check, and
            // that check throws a DIFFERENT message. It is what makes the
            // ordering of the visibility check observable.
            throw new Error('Layout is not installed and enabled');
          }
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
    const data = JSON.parse(text).data as Record<string, any>;
    // Every field the SERVER derives about the plugin is gone.
    expect(data.catalogContribution).toBeUndefined();
    expect(data.config.plugin).toBeUndefined();
    expect(text).not.toContain(`plugins/${PLUGIN_NAME}`);
    expect(text).not.toContain(PLUGIN_LAYOUT.contribution.version);
    // The stored tabs remain — they are the project's own record, and the
    // verdict is keyed on their ids. The LIVE ones, read from the plugin on
    // disk, do not: that merge is the disclosure.
    expect(data.config.tabs).toEqual(STORED_TABS);
    expect(text).not.toContain(LIVE_TABS[0].component);
    expect(data.paneReferences).toEqual({ unavailableTabIds: ['notes'] });
    // The tab id, never the minted descriptor id, which encodes the plugin.
    expect(JSON.stringify(data.paneReferences)).not.toContain('pane:');
  });

  test('a withheld response still spells the plugin name, and that is the residual', async () => {
    // Stated as a test rather than a comment, because the opposite claim is
    // easy to make and was made. What a withheld response still carries is
    // the PROJECT's own stored record, written when somebody who could see
    // the plugin applied it:
    //
    //  - component ids, which real plugins namespace by convention;
    //  - the layout `name`, which the catalog parser falls back from the
    //    layout's own to `manifest.displayName` to the PLUGIN NAME
    //    (`distribution-profile-service.ts`), and `description` likewise to
    //    the manifest's — apply persists both and the strip removes neither;
    //  - the layout `slug`, which is plugin-authored and is the route
    //    ADDRESS, so it cannot be withheld at all.
    //
    // None of this reopens the guess oracle, which is about learning whether
    // a plugin you NAME is installed. It is a disclosure to a member of a
    // project an operator already applied that layout into.
    // Asserted on a real withheld RESPONSE. An earlier version of this test
    // compared `STORED_TABS[0].component` against its own literal, which is
    // a const asserting itself under a name claiming something about a
    // response — it stayed green if the response stopped spelling the name,
    // and if the strip removed tabs entirely.
    let visible = true;
    const { app } = await seeded({ canSeePlugin: () => visible });
    await app.request('/demo/layouts/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layoutId: PLUGIN_LAYOUT.id }),
    });
    visible = false;
    const withheld = await (
      await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`)
    ).text();
    expect(withheld).toContain(PLUGIN_NAME);
    expect(JSON.parse(withheld).data.config.tabs[0].component).toContain(
      PLUGIN_NAME,
    );
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

  test('a DISABLED hidden plugin refuses like an id nobody has', async () => {
    // `resolveForApply` is `resolveForCatalog` plus an installed-and-enabled
    // check, and the two throw DIFFERENT messages. Checking visibility after
    // it would let a caller guessing catalog ids tell "exists here, but
    // disabled" from "does not exist" — a weaker oracle than the one #2103
    // closed, but the same oracle.
    const { app } = await asCollaborator();
    const refusal = async (layoutId: string) => {
      const response = await app.request('/demo/layouts/apply', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ layoutId }),
      });
      return `${response.status} ${await response.text()}`;
    };
    expect(await refusal(DISABLED_LAYOUT_ID)).toBe(
      await refusal('plugin:nobody-has-this:layout'),
    );

    // The control: an OPERATOR reaches the state refusal, so the message
    // above really is being withheld rather than being the only message this
    // fixture can produce.
    const operator = await seeded({ canSeePlugin: () => true });
    const asOperator = await operator.app.request('/demo/layouts/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layoutId: DISABLED_LAYOUT_ID }),
    });
    expect(await asOperator.text()).toContain('not installed and enabled');
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
    // The write's own answer is projected exactly as the read is. Asserted
    // on the SERVER-DERIVED facts, not on a whole-body string: the stored
    // record's own component ids are plugin-authored and stay (see `a
    // withheld response still spells the plugin name`).
    const writtenText = await written.clone().text();
    expect(writtenText).not.toContain(`"plugin":"${PLUGIN_NAME}"`);
    expect(writtenText).not.toContain(`plugins/${PLUGIN_NAME}`);
    const body = await json<{ data: Record<string, any> }>(written);
    expect(body.data.paneReferences).toEqual({ unavailableTabIds: ['notes'] });
  });
});

/**
 * #2103 CRITICAL — the gate must read every plugin name the response derives
 * from, not one owning id.
 *
 * The first implementation gated on a single id, preferring the SERVER-ISSUED
 * `catalogContribution.provenance.pluginId`. The live merge is keyed on
 * `config.plugin`, which a member can write. When those disagree the gate
 * answered about the contribution while the merge read the config.
 *
 * Every case here uses a PER-PLUGIN predicate. A globally true or false
 * predicate cannot see this defect at all: it needs one plugin the caller can
 * see (to get a server-issued contribution written into the record at all)
 * and one they cannot.
 */
describe('the withheld decision reads every plugin name in the record', () => {
  /** Sees `PLUGIN_NAME`; cannot see `OTHER_PLUGIN` or anything else. */
  const asMember = () =>
    seeded({ canSeePlugin: (pluginId) => pluginId === PLUGIN_NAME });

  async function appliedThenRepointed(target: string) {
    const { app } = await asMember();
    // Apply is available to members and is the ONLY writer of
    // `catalogContribution`, so this is entirely self-service.
    expect(
      (
        await app.request('/demo/layouts/apply', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ layoutId: PLUGIN_LAYOUT.id }),
        })
      ).status,
    ).toBe(201);
    const read = await json<{ data: Record<string, any> }>(
      await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`),
    );
    // The record now carries a contribution naming a plugin they CAN see.
    expect(read.data.catalogContribution.provenance.pluginId).toBe(PLUGIN_NAME);
    // Repoint the merge key at the guess, leaving the contribution alone.
    const written = await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        ...read.data,
        config: { ...read.data.config, plugin: target },
      }),
    });
    expect(written.status).toBe(200);
    return await (
      await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`)
    ).text();
  }

  test('a guess written into config.plugin does not reach the live merge', async () => {
    const guessed = await appliedThenRepointed(OTHER_PLUGIN);
    // The whole defect in one assertion: the hidden plugin's LIVE tabs.
    expect(guessed).not.toContain(OTHER_LIVE_TABS[0].component);
    expect(guessed).not.toContain(OTHER_PLUGIN);
    // And the visible plugin's own facts go too, because the RESPONSE now
    // derives from a name this caller cannot see.
    expect(guessed).not.toContain(`plugins/${PLUGIN_NAME}`);

    // The control: the same request naming a plugin nobody installed. If the
    // two answers differed, the route would still be an existence oracle —
    // which is exactly how review reproduced the original defect.
    const absent = await appliedThenRepointed('no-such-plugin-anywhere');
    const normalize = (body: string) => JSON.parse(body).data.config.tabs;
    expect(normalize(guessed)).toEqual(normalize(absent));
    expect(JSON.parse(guessed).data.paneReferences).toEqual(
      JSON.parse(absent).data.paneReferences,
    );
  });

  test('a layout bound only to the visible plugin is unaffected', async () => {
    // The control for the controls: the per-plugin predicate really does let
    // one plugin through, so the withholding above is a decision rather than
    // a route that withholds from everybody.
    const { app } = await asMember();
    await app.request('/demo/layouts/apply', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ layoutId: PLUGIN_LAYOUT.id }),
    });
    const body = await json<{ data: Record<string, any> }>(
      await app.request(`/demo/layouts/${PLUGIN_LAYOUT.slug}`),
    );
    expect(body.data.config.plugin).toBe(PLUGIN_NAME);
    expect(body.data.config.tabs).toEqual(LIVE_TABS);
    expect(body.data.paneReferences).toBeUndefined();
  });
});

describe('a withheld read-modify-write preserves the whole record', () => {
  /**
   * The strip removes three `config` keys and the restore has to return all
   * three. The first version returned `plugin` only, so an ordinary rename by
   * a caller who could not see the plugin silently destroyed `actions` and
   * `globalSkills` — permanently, because the read route's live merge
   * restores `tabs`, `globalSkills`, `defaultAgent`, `availableAgents` and
   * `requiredProviders` and never `actions`. It also dropped the layout out
   * of `buildLayoutAgentReferences` (`domain/file-storage-records.ts`), which
   * reads exactly `config.actions` and `config.globalSkills`.
   *
   * The applied fixture above carries neither key — `applyCatalogLayout`
   * writes no `actions` at all — which is why this case builds its record
   * through the OTHER real writer, the ordinary create route, with both keys
   * present.
   */
  const CONFIG = {
    plugin: PLUGIN_NAME,
    tabs: [{ id: 'notes', label: 'Notes', component: `${PLUGIN_NAME}-notes` }],
    actions: [{ label: 'Run the report', type: 'prompt', data: 'report' }],
    globalSkills: [{ id: 'skill-1', label: 'Summarize', prompt: 'summarize' }],
  };

  test('a rename keeps every key the read withheld', async () => {
    const { app, storage } = await seeded({ canSeePlugin: () => false });
    expect(
      (
        await app.request('/demo/layouts', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            slug: 'bound',
            name: 'Bound',
            config: CONFIG,
          }),
        })
      ).status,
    ).toBe(201);

    const read = await json<{ data: Record<string, any> }>(
      await app.request('/demo/layouts/bound'),
    );
    // The read really did remove all three; otherwise the write below would
    // have nothing to restore and would pass for the wrong reason.
    expect(read.data.config.plugin).toBeUndefined();
    expect(read.data.config.actions).toBeUndefined();
    expect(read.data.config.globalSkills).toBeUndefined();

    const written = await app.request('/demo/layouts/bound', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...read.data, name: 'Renamed' }),
    });
    expect(written.status).toBe(200);

    const stored = storage.getLayout('demo', 'bound');
    expect(stored.name).toBe('Renamed');
    expect(stored.config).toEqual(CONFIG);
  });

  test('a viewer who CAN see the plugin still edits it normally', async () => {
    // The control: the restore must not freeze a config for somebody the
    // read withheld nothing from.
    const { app, storage } = await seeded({ canSeePlugin: () => true });
    await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug: 'bound', name: 'Bound', config: CONFIG }),
    });
    const written = await app.request('/demo/layouts/bound', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bound',
        config: { ...CONFIG, actions: [] },
      }),
    });
    expect(written.status).toBe(200);
    expect(storage.getLayout('demo', 'bound').config.actions).toEqual([]);
  });

  test('a built-in tab is not marked unavailable by a plugin binding', async () => {
    // The verdict is layout-level, but a tab whose component declares a
    // BUILTIN kind is by construction not plugin-owned, and a Board mixes
    // the two. Marking it would blank a tab the derivation never showed was
    // plugin-owned.
    const { app } = await seeded({ canSeePlugin: () => false });
    await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'mixed',
        name: 'Mixed',
        config: {
          plugin: PLUGIN_NAME,
          tabs: [
            { id: 'from-plugin', label: 'Plugin', component: 'notes-view' },
            {
              id: 'from-station',
              label: 'Runs',
              component: {
                kind: 'builtin-component',
                name: 'flow-run-console',
              },
            },
          ],
        },
      }),
    });
    const body = await json<{ data: Record<string, any> }>(
      await app.request('/demo/layouts/mixed'),
    );
    expect(body.data.paneReferences).toEqual({
      unavailableTabIds: ['from-plugin'],
    });
  });
});

describe('the restore does not let a withheld caller plant a key', () => {
  test('a key the stored record lacks is not persisted by a withheld write', async () => {
    // The restore's fail-closed half: it does not merely copy stored keys
    // in, it removes any of its keys the stored record does NOT have. Every
    // other fixture on this branch stores all three, so deleting that half
    // survived uncaught. It cannot reopen the oracle — the value is the
    // caller's own — but a config key that appears from a withheld write is
    // a write the caller could not see the effect of.
    const { app, storage } = await seeded({ canSeePlugin: () => false });
    await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'sparse',
        name: 'Sparse',
        // A plugin binding and tabs, and deliberately NO `actions`.
        config: {
          plugin: PLUGIN_NAME,
          tabs: [{ id: 'a', label: 'A', component: `${PLUGIN_NAME}-a` }],
        },
      }),
    });
    expect(storage.getLayout('demo', 'sparse').config.actions).toBeUndefined();

    const written = await app.request('/demo/layouts/sparse', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Sparse',
        config: {
          tabs: [{ id: 'a', label: 'A', component: `${PLUGIN_NAME}-a` }],
          actions: [{ label: 'Planted', type: 'prompt', data: 'x' }],
        },
      }),
    });
    expect(written.status).toBe(200);
    const stored = storage.getLayout('demo', 'sparse');
    expect(stored.config.actions).toBeUndefined();
    // The control: the binding the record DID have is still restored.
    expect(stored.config.plugin).toBe(PLUGIN_NAME);
  });
});
