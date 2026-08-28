/**
 * archive#1497 — a coding layout's working directory is derived from its owning
 * project, never persisted into the layout's own config.
 *
 * These tests deliberately exercise TRANSITIONS rather than snapshots. The
 * sibling slice-0 branch's review found that a monotone test path (first-time
 * value → new first-time value) cannot see the defect class this fix exists to
 * close: state that is already on disk and that no later write corrects. So
 * every route-level case below either re-enters a prior state (A→B→A), removes
 * a value that was previously present, starts from a pre-fix on-disk fixture,
 * or re-reads through a freshly constructed app (the restart path).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import {
  codingLayoutRepoId,
  withDerivedWorkingDirectory,
  withoutPersistedWorkingDirectory,
} from '../layout-working-directory.js';

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

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-layout-wd-'));
  tempDirs.push(dir);
  return dir;
}

/**
 * `listAgents` is supplied deliberately: production always wires it
 * (`src-server/runtime/routes/runtime-routes.ts:760-771`), and the layout
 * handlers take a different path when it is absent — they skip an unguarded
 * `storageAdapter.getProject` call. A three-argument test app exercises a
 * dependency shape the shipped server never has, which is how an earlier
 * revision of this branch "proved" a resilience it did not have.
 */
function appFor(home: string) {
  const storage = new FileStorageAdapter(home);
  const projectService = new ProjectService(storage);
  return {
    app: createProjectRoutes(projectService as any, storage as any, home, {
      listAgents: async () => [],
    }),
    storage,
  };
}

const NOW = '2026-08-01T00:00:00.000Z';

async function seedProject(
  storage: InstanceType<typeof FileStorageAdapter>,
  workingDirectory?: string,
): Promise<void> {
  await putProject(storage, {
    id: 'project-1',
    slug: 'demo',
    name: 'Demo',
    ...(workingDirectory === undefined ? {} : { workingDirectory }),
    createdAt: NOW,
    updatedAt: NOW,
  } as any);
}

async function seedLayout(
  storage: InstanceType<typeof FileStorageAdapter>,
  config: Record<string, unknown>,
  type = 'coding',
): Promise<void> {
  await storage.createLayout('demo', {
    id: 'layout-1',
    projectSlug: 'demo',
    slug: 'coding',
    name: 'Coding',
    type,
    config,
    createdAt: NOW,
    updatedAt: NOW,
  } as any);
}

/** Reads the layout record straight off disk — the only honest persistence proof. */
function storedLayoutConfig(home: string): Record<string, unknown> {
  const raw = readFileSync(
    join(home, 'projects', 'demo', 'layouts', 'coding.json'),
    'utf-8',
  );
  return JSON.parse(raw).config;
}

type TestApp = ReturnType<typeof appFor>['app'];

async function getLayoutConfig(app: TestApp): Promise<Record<string, unknown>> {
  const res = await app.request('/demo/layouts/coding');
  expect(res.status).toBe(200);
  return (await json(res)).data.config;
}

describe('layout working-directory derivation helpers (pure)', () => {
  test('strips a persisted working directory from a coding layout only', () => {
    const coding = { type: 'coding', config: { workingDirectory: '/a', x: 1 } };
    expect(withoutPersistedWorkingDirectory(coding).config).toEqual({ x: 1 });

    const tasks = { type: 'tasks', config: { workingDirectory: '/a' } };
    // Non-coding layouts are returned by identity: the server never wrote a
    // working directory into them, so nothing here is ours to remove.
    expect(withoutPersistedWorkingDirectory(tasks)).toBe(tasks);
  });

  test('a coding layout without the key is returned by identity', () => {
    const layout = { type: 'coding', config: { tabs: [] } };
    expect(withoutPersistedWorkingDirectory(layout)).toBe(layout);
  });

  test('derivation replaces a stale persisted value rather than deferring to it', () => {
    const layout = { type: 'coding', config: { workingDirectory: '/stale' } };
    expect(withDerivedWorkingDirectory(layout, '/current').config).toEqual({
      workingDirectory: '/current',
    });
  });

  test('no project working directory removes the key entirely, not sets it undefined', () => {
    const layout = { type: 'coding', config: { workingDirectory: '/stale' } };
    const derived = withDerivedWorkingDirectory(layout, undefined);
    expect(Object.hasOwn(derived.config, 'workingDirectory')).toBe(false);
    // The emitted JSON shape must equal the pre-change "no directory" shape.
    expect(JSON.stringify(derived.config)).toBe('{}');
  });

  test('an empty-string project working directory still means "none"', () => {
    // Pre-change the copy was guarded by plain truthiness; preserving that
    // exactly is what makes this a zero-behavior-change read path.
    const layout = { type: 'coding', config: {} };
    expect(
      Object.hasOwn(
        withDerivedWorkingDirectory(layout, '').config,
        'workingDirectory',
      ),
    ).toBe(false);
  });

  test('non-coding layouts are never given a derived working directory', () => {
    const layout = { type: 'tasks', config: {} };
    expect(withDerivedWorkingDirectory(layout, '/current')).toBe(layout);
  });
});

describe('coding layout working directory is derived, not persisted', () => {
  test('creating a coding layout persists no working directory but reports one', async () => {
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/demo');

    const created = await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slug: 'coding', name: 'Coding', type: 'coding' }),
    });
    expect(created.status).toBe(201);
    expect((await json(created)).data.config.workingDirectory).toBe(
      '/repos/demo',
    );

    // The persisted record is the thing under test: nothing on disk.
    expect(storedLayoutConfig(home)).toEqual({});
  });

  test('a client-supplied working directory that differs is refused by name, not discarded', async () => {
    // Disclosed behavior change: a coding layout's working directory is no
    // longer an independently settable field. The CLI's
    // `station projects layouts create --data=<json>` payload reaches the
    // route verbatim through a passthrough schema, so a value CAN arrive here
    // and pre-change the server honoured it. Silently discarding it would be
    // exactly the assert-then-retract the honesty bar forbids: a 200 carrying
    // a directory different from the one submitted. It is refused instead.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/demo');

    const rejected = await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'coding',
        name: 'Coding',
        type: 'coding',
        config: { workingDirectory: '/client/supplied' },
      }),
    });
    expect(rejected.status).toBe(400);
    const error = (await json(rejected)).error as string;
    expect(error).toContain('config.workingDirectory');
    expect(error).toContain('/repos/demo');
    // Refused means refused: nothing was written.
    expect(existsSync(join(home, 'projects', 'demo', 'layouts'))).toBe(false);
  });

  test('a supplied working directory equal to the derived one is accepted and still not persisted', async () => {
    // This is the GET-then-PUT/POST round trip: a client that echoes back what
    // it read must not be rejected, because the derived value is exactly what
    // the read handed it.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/demo');

    const created = await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'coding',
        name: 'Coding',
        type: 'coding',
        config: { workingDirectory: '/repos/demo' },
      }),
    });
    expect(created.status).toBe(201);
    expect(storedLayoutConfig(home)).toEqual({});
  });

  test('renaming a layout that carries a pre-fix copy is not refused by the conflict check', async () => {
    // The conflict check reads the REQUEST body, never the merged record —
    // otherwise every install carrying a pre-fix copy would be unable to
    // rename its own layouts, and the copy would become permanent.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, { workingDirectory: '/repos/stale' });

    const renamed = await app.request('/demo/layouts/coding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(renamed.status).toBe(200);
    expect(storedLayoutConfig(home)).toEqual({});
  });

  test('a PUT naming a different working directory is refused', async () => {
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, {});

    const rejected = await app.request('/demo/layouts/coding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: { workingDirectory: '/somewhere/else' } }),
    });
    expect(rejected.status).toBe(400);
    expect((await json(rejected)).error).toContain('config.workingDirectory');
  });

  test('catalog-applied coding layouts persist no working directory', async () => {
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/demo');

    const applied = await app.request('/demo/layouts/apply', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layoutId: 'builtin:coding' }),
    });
    expect(applied.status).toBe(201);
    expect((await json(applied)).data.config.workingDirectory).toBe(
      '/repos/demo',
    );
    expect(storedLayoutConfig(home)).toEqual({});
  });
});

describe('transitions: a project working directory that moves and returns', () => {
  test('A → B → A is reflected on every read with no layout-side write', async () => {
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/a');
    await seedLayout(storage, {});

    expect(await getLayoutConfig(app)).toEqual({
      workingDirectory: '/repos/a',
    });

    await seedProject(storage, '/repos/b');
    expect(await getLayoutConfig(app)).toEqual({
      workingDirectory: '/repos/b',
    });

    // Re-entering the ORIGINAL state is the case a monotone test never covers.
    await seedProject(storage, '/repos/a');
    expect(await getLayoutConfig(app)).toEqual({
      workingDirectory: '/repos/a',
    });

    // And nothing was ever written to the layout to make that true.
    expect(storedLayoutConfig(home)).toEqual({});
  });

  test('clearing a project working directory clears it from its coding layouts', async () => {
    // The pre-change read path could not do this: it backfilled only when the
    // value was MISSING, so once a copy existed the layout advertised the old
    // path forever.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/a');
    await seedLayout(storage, {});

    expect(await getLayoutConfig(app)).toEqual({
      workingDirectory: '/repos/a',
    });

    await seedProject(storage, undefined);
    const cleared = await getLayoutConfig(app);
    expect(Object.hasOwn(cleared, 'workingDirectory')).toBe(false);
  });

  test('a project that never had a working directory yields no key', async () => {
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, undefined);
    await seedLayout(storage, {});
    const config = await getLayoutConfig(app);
    expect(Object.hasOwn(config, 'workingDirectory')).toBe(false);
  });
});

describe('upgrade path: installs that already persisted a copy', () => {
  test('a pre-fix persisted copy is ignored in favour of the derived value', async () => {
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    // Exactly the shape an install created before this fix shipped.
    await seedLayout(storage, { workingDirectory: '/repos/stale', tabs: [] });

    expect(await getLayoutConfig(app)).toEqual({
      workingDirectory: '/repos/current',
      tabs: [],
    });
  });

  test('the pre-fix copy is cleared from disk by the next layout write', async () => {
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, { workingDirectory: '/repos/stale', tabs: [] });
    expect(storedLayoutConfig(home)).toHaveProperty(
      'workingDirectory',
      '/repos/stale',
    );

    const renamed = await app.request('/demo/layouts/coding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(renamed.status).toBe(200);

    expect(storedLayoutConfig(home)).toEqual({ tabs: [] });
    expect(await getLayoutConfig(app)).toEqual({
      workingDirectory: '/repos/current',
      tabs: [],
    });
  });

  test('a GET → PUT round trip does not re-plant the derived value on disk', async () => {
    // The derived value now appears in the GET response, so a client that
    // saves what it read back would persist a fresh copy unless the write path
    // strips it. This is the regression that would silently undo the fix.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, { tabs: [] });

    const read = await app.request('/demo/layouts/coding');
    const layout = (await json(read)).data;
    expect(layout.config.workingDirectory).toBe('/repos/current');

    const saved = await app.request('/demo/layouts/coding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(layout),
    });
    expect(saved.status).toBe(200);
    expect(storedLayoutConfig(home)).toEqual({ tabs: [] });
  });

  test('a fresh app over the same home still derives after a restart', async () => {
    const home = tempHome();
    const first = appFor(home);
    await seedProject(first.storage, '/repos/current');
    await seedLayout(first.storage, { workingDirectory: '/repos/stale' });

    // A new adapter + routes over the same on-disk home: no in-memory state
    // carries the correction, so this proves the derivation is a read-path
    // property rather than a one-time fixup.
    const restarted = appFor(home);
    expect(await getLayoutConfig(restarted.app)).toEqual({
      workingDirectory: '/repos/current',
    });
  });
});

describe('scope: non-coding layouts keep their own working directory', () => {
  test('a tasks layout keeps a client-set working directory verbatim', async () => {
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, { workingDirectory: '/explicit' }, 'tasks');

    expect(storedLayoutConfig(home)).toEqual({
      workingDirectory: '/explicit',
    });
    expect(await getLayoutConfig(app)).toEqual({
      workingDirectory: '/explicit',
    });
  });

  test('a non-coding layout created without a config is persisted with an empty one', async () => {
    // Disclosed, deliberate, and NOT scoped to coding layouts: `LayoutConfig`
    // requires `config`, and a record without it used to break the list read
    // for the whole project. Materializing it is a repair, but it does change
    // the persisted record and the 201 body for every layout type.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');

    const created = await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        slug: 'board',
        name: 'Board',
        type: 'session-board',
      }),
    });
    expect(created.status).toBe(201);
    expect((await json(created)).data.config).toEqual({});

    const raw = JSON.parse(
      readFileSync(
        join(home, 'projects', 'demo', 'layouts', 'board.json'),
        'utf-8',
      ),
    );
    expect(raw.config).toEqual({});
  });
});

describe('the layout list neither exposes nor needs a working directory', () => {
  test('list entries carry no config at all, stale copy or otherwise', async () => {
    // The fix deliberately leaves the list route alone. This turns that from
    // proof-by-inspection into evidence, against the REAL storage adapter —
    // the route test's mock returns full layout records, a shape
    // `IStorageAdapter.listLayouts` forbids.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, { workingDirectory: '/repos/stale', tabs: [] });

    const res = await app.request('/demo/layouts');
    expect(res.status).toBe(200);
    const entries = (await json(res)).data as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(1);
    expect(Object.hasOwn(entries[0], 'config')).toBe(false);
    expect(JSON.stringify(entries[0])).not.toContain('/repos/stale');
  });

  test('updating a legacy config-less record repairs it instead of re-persisting the shape', async () => {
    // The write half of the same hazard, and the one a fault injection caught
    // this file failing to prove: `{...existing, ...body}` inherits `undefined`
    // from a legacy record, so a plain rename used to save the broken shape
    // straight back — a record no write could repair, which is precisely the
    // already-persisted-state class this branch exists to close.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, {});
    const path = join(home, 'projects', 'demo', 'layouts', 'coding.json');
    const record = JSON.parse(readFileSync(path, 'utf-8'));
    delete record.config;
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');

    const renamed = await app.request('/demo/layouts/coding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });
    expect(renamed.status).toBe(200);

    const saved = JSON.parse(readFileSync(path, 'utf-8'));
    expect(Object.hasOwn(saved, 'config')).toBe(true);
    expect(saved.config).toEqual({});
  });

  test('a legacy record persisted without a config does not 500 the list', async () => {
    // Reachable on disk today and repaired by no write, which is why the read
    // tolerates it rather than waiting for a migration.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, {});
    const path = join(home, 'projects', 'demo', 'layouts', 'coding.json');
    const record = JSON.parse(readFileSync(path, 'utf-8'));
    delete record.config;
    writeFileSync(path, JSON.stringify(record, null, 2), 'utf-8');

    const res = await app.request('/demo/layouts');
    expect(res.status).toBe(200);
    expect((await json(res)).data).toHaveLength(1);
  });
});

describe('an unreadable project record fails the request rather than degrading', () => {
  test('an orphaned layout 404s instead of reporting an absent working directory', async () => {
    // An earlier revision caught the read failure and returned `undefined`,
    // documented as an "honest absence". Review proved that path unreachable:
    // the handler calls `getProject` again, unguarded, for agent-reference
    // diagnostics, and production always supplies `listAgents`. The swallow
    // only made the code look resilient. The claim is deleted rather than
    // defended, and this test pins the behavior that actually ships.
    const home = tempHome();
    const { app, storage } = appFor(home);
    await seedProject(storage, '/repos/current');
    await seedLayout(storage, { workingDirectory: '/repos/stale' });

    // Remove only the project record, leaving the layout behind.
    rmSync(join(home, 'projects', 'demo', 'project.json'));
    mkdirSync(join(home, 'projects', 'demo'), { recursive: true });

    const res = await app.request('/demo/layouts/coding');
    expect(res.status).toBe(404);
    expect((await json(res)).error).toBe('Project not found');
  });
});

// ── archive#1503 — layouts reference repos by id ───────────────────

describe('codingLayoutRepoId (pure)', () => {
  test('reads a non-empty string repoId from a CODING layout only', () => {
    expect(
      codingLayoutRepoId({ type: 'coding', config: { repoId: ' api ' } }),
    ).toBe('api');
    // Non-coding layouts have no derived working directory at all, so they
    // have nothing to point at a repo.
    expect(
      codingLayoutRepoId({ type: 'tasks', config: { repoId: 'api' } }),
    ).toBeUndefined();
  });

  test.each([
    ['an absent config', { type: 'coding' }],
    ['an absent key', { type: 'coding', config: {} }],
    ['an empty string', { type: 'coding', config: { repoId: '' } }],
    ['whitespace only', { type: 'coding', config: { repoId: '   ' } }],
    ['a number', { type: 'coding', config: { repoId: 7 } }],
    ['null', { type: 'coding', config: { repoId: null } }],
    ['an object', { type: 'coding', config: { repoId: { id: 'api' } } }],
  ])('answers undefined for %s — exact shape or nothing', (_label, layout) => {
    // Coercing a non-string would send the derivation at a resource nobody
    // named, and the caller then falls back to the project's own directory —
    // which on a multi-repo project is a DIFFERENT repo's checkout.
    expect(
      codingLayoutRepoId(
        layout as { type?: string; config?: Record<string, unknown> },
      ),
    ).toBeUndefined();
  });
});

describe('a coding layout that names a repo derives THAT repo (station#1503)', () => {
  /**
   * The app with resolution wired, plus a resolver double whose answers are
   * per-resource. A double is right here: the derivation under test is "which
   * resource id did the route ask about", and the real resolver's stores would
   * only add a second thing that could fail.
   */
  function appWithResolver(
    home: string,
    answers: Record<string, { state: string; path?: string }>,
  ) {
    const storage = new FileStorageAdapter(home);
    const projectService = new ProjectService(storage);
    const asked: (string | undefined)[] = [];
    const resolver = {
      resolveProjectResource: async (_slug: string, resourceId?: string) => {
        asked.push(resourceId);
        const answer = answers[resourceId ?? ''] ?? {
          state: 'unbound',
          reason: 'nothing here records a location for it',
        };
        return answer.state === 'bound'
          ? { state: 'bound', resourceId: resourceId ?? '', path: answer.path }
          : {
              state: 'unbound',
              resourceId: resourceId ?? '',
              reason: 'nothing here records a location for it',
            };
      },
    };
    return {
      app: createProjectRoutes(projectService as any, storage as any, home, {
        listAgents: async () => [],
        resolution: {
          resolver: resolver as any,
          manifests: { readRecord: () => undefined } as any,
          bindings: { read: () => ({ bindings: [] }) } as any,
          readRemotes: (async () => ({ ok: true, remotes: [] })) as any,
        },
      }),
      storage,
      asked,
    };
  }

  test('resolves the NAMED repo, not the project working directory', async () => {
    const home = tempHome();
    const { app, storage, asked } = appWithResolver(home, {
      'github.com/acme/web': { state: 'bound', path: '/checkouts/web' },
    });
    await seedProject(storage, '/checkouts/api');
    await seedLayout(storage, { repoId: 'github.com/acme/web' });

    const config = await getLayoutConfig(app);

    expect(config.workingDirectory).toBe('/checkouts/web');
    expect(config.repoId).toBe('github.com/acme/web');
    expect(asked).toContain('github.com/acme/web');
  });

  test('a repo that is NOT bound here derives NO working directory', async () => {
    // Absent means absent. Falling back to the project's directory would open
    // the wrong repository under a caption naming the right one.
    const home = tempHome();
    const { app, storage } = appWithResolver(home, {});
    await seedProject(storage, '/checkouts/api');
    await seedLayout(storage, { repoId: 'github.com/acme/web' });

    const config = await getLayoutConfig(app);

    expect('workingDirectory' in config).toBe(false);
  });

  test('a layout naming NO repo keeps the project-derived value verbatim', async () => {
    const home = tempHome();
    const { app, storage, asked } = appWithResolver(home, {});
    await seedProject(storage, '/checkouts/api');
    await seedLayout(storage, {});

    const config = await getLayoutConfig(app);

    expect(config.workingDirectory).toBe('/checkouts/api');
    // The resolver was never consulted — §1497's derivation is untouched for
    // every layout that predates this slice.
    expect(asked).toEqual([]);
  });

  test('the repoId is PERSISTED while the working directory is not', async () => {
    // A resource id is a portable fact about the project; a path is a
    // machine-local one that drifts the moment a checkout moves. That is why
    // one is safe to store and the other is not.
    const home = tempHome();
    const { app, storage } = appWithResolver(home, {
      'github.com/acme/web': { state: 'bound', path: '/checkouts/web' },
    });
    await seedProject(storage, '/checkouts/api');
    await seedLayout(storage, { repoId: 'github.com/acme/web' });

    await app.request('/demo/layouts/coding', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(storedLayoutConfig(home)).toEqual({
      repoId: 'github.com/acme/web',
    });
  });
});
