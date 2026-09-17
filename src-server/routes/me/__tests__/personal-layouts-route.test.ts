/**
 * #2061 — `/api/me/layouts`, the personal scope over HTTP.
 *
 * Every case drives the real Hono handlers, the real `FileStorageAdapter`
 * against a real temporary Station home, and the real
 * `resolvePrincipal` from `services/identity/principal-resolver.ts`. Only the
 * ingress facts that resolver reads are supplied by the test — which is the
 * seam production also fills, at `runtime-routes.ts`'s
 * `resolveOrchestrationRequestPrincipal`.
 *
 * NOT covered here: `runtime-routes.ts`'s own composition of those facts
 * (Tailscale WhoIs vs. device binding vs. operator credential). That
 * precedence is asserted where it lives; what this file asserts is that two
 * DISTINCT devices resolving to ONE principal see one set of Boards, and that
 * nothing a request carries can change which principal that is.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LayoutMetadata } from '@kontourai/station-contracts/layout';
import {
  humanPrincipal,
  PRINCIPAL_UNRESOLVED_CODE,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { afterEach, describe, expect, test } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import { principalLayoutStorageKey } from '../../../domain/layout-owner-storage.js';
import {
  FileStorageConflictError,
  FileStorageNotFoundError,
} from '../../../domain/project-file-transactions.js';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  PrincipalUnresolvedError,
  resolvePrincipal,
} from '../../../services/identity/principal-resolver.js';
import { ownedLayoutStore } from '../../../services/layouts/personal-layout-service.js';
import { createPersonalLayoutRoutes } from '../personal-layouts.js';

const NOW = '2026-01-01T00:00:00.000Z';

/**
 * Two paired devices bound to one person, plus a third bound to someone else.
 * A device is identified per request by its own header; the PERSON behind it
 * is what `resolvePrincipal` returns, and that is what the store is keyed on.
 */
const DEVICE_BINDINGS: Record<string, { subject: string }> = {
  'alice-laptop': { subject: 'alice@example.test' },
  'alice-phone': { subject: 'alice@example.test' },
  'bob-laptop': { subject: 'bob@example.test' },
};

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The agents this Station knows, as `agentService.listAgents()` reports them.
 * Shared by every app in this file so "unknown agent" means one thing here.
 */
const knownAgents = [{ slug: 'helper' as never, project: undefined }];

function seeded(
  options: { canSeePlugin?: (pluginId: string) => boolean } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'station-personal-layouts-route-'));
  tempDirs.push(dir);
  const storage = new FileStorageAdapter(dir);
  let nextId = 0;
  const app = createPersonalLayoutRoutes(ownedLayoutStore(storage), {
    resolvePrincipal: (c) => {
      const device = c.req.header('x-station-test-device');
      const binding = device ? DEVICE_BINDINGS[device] : undefined;
      // The same two facts `runtime-routes.ts` feeds this resolver: a verified
      // identity when the device is bound to a person, otherwise the
      // home-possession authority fact that resolves the local operator.
      return resolvePrincipal(
        binding
          ? {
              provider: 'tailscale-serve',
              subject: binding.subject,
              displayName: binding.subject,
            }
          : null,
        'personal',
        binding ? undefined : { locality: 'home-possession' },
        undefined,
      );
    },
    now: () => NOW,
    newId: () => `board-${++nextId}`,
    // #2062 review BLOCKING-2: promote runs the destination project's own
    // admission, so the harness supplies the same agent list production wires
    // from `agentService.listAgents()`. `helper` is a real agent every project
    // can reach; `ghost-agent` deliberately is NOT in this list, which is what
    // makes the refusal case below a refusal rather than a typo.
    listAgents: async () => knownAgents,
    // #2090. Absent by default, which is the point: every other case in this
    // file must keep answering exactly as it did before the verdict existed.
    ...(options.canSeePlugin
      ? {
          canSeePlugin: (_c: unknown, pluginId: string) =>
            options.canSeePlugin!(pluginId),
        }
      : {}),
  });
  return { dir, storage, app };
}

/** A Station home with the Boards routes AND two real projects to promote into. */
async function seededWithProjects() {
  const context = seeded();
  for (const [id, slug, name] of [
    ['project-1', 'demo', 'Demo'],
    ['project-2', 'other', 'Other'],
  ] as const) {
    await context.storage.createProject({
      id,
      slug,
      name,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }
  return context;
}

/**
 * The #2062 cases route every read through these three helpers rather than
 * calling `as(...)` inline, so a change to the request helper's own signature
 * lands in three places in this file instead of a dozen. (It already has: the
 * slice-3 fix round dropped the helper's unused `path` argument.)
 */
function listBoards(
  app: ReturnType<typeof seeded>['app'],
  device: string | undefined,
) {
  return app.request('/layouts', as(device));
}

function readBoard(
  app: ReturnType<typeof seeded>['app'],
  device: string | undefined,
  layoutSlug: string,
) {
  return app.request(`/layouts/${layoutSlug}`, as(device));
}

function promote(
  app: ReturnType<typeof seeded>['app'],
  device: string | undefined,
  layoutSlug: string,
  body: Record<string, unknown>,
) {
  return app.request(
    `/layouts/${layoutSlug}/promote`,
    as(device, { method: 'POST', body: JSON.stringify(body) }),
  );
}

/** A request as a given device; no device header means the local operator. */
function as(device: string | undefined, init: RequestInit = {}) {
  return {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(device ? { 'x-station-test-device': device } : {}),
      ...((init.headers as Record<string, string>) ?? {}),
    },
  };
}

function personalDir(dir: string, principal: PrincipalRef) {
  return join(dir, 'layouts', 'personal', principalLayoutStorageKey(principal));
}

const alice = humanPrincipal(
  'tailscale-serve',
  'alice@example.test',
  'alice@example.test',
);
const bob = humanPrincipal(
  'tailscale-serve',
  'bob@example.test',
  'bob@example.test',
);

async function createBoard(
  app: ReturnType<typeof seeded>['app'],
  device: string | undefined,
  body: Record<string, unknown>,
) {
  return app.request(
    '/layouts',
    as(device, { method: 'POST', body: JSON.stringify(body) }),
  );
}

describe('ownedLayoutStore', () => {
  test('refuses an adapter that cannot serve the personal scope, naming what is missing', () => {
    // The composition guard's refusal path. `IStorageAdapter` declares these
    // methods optional, so without this the first request — not startup —
    // would be where an incapable adapter surfaced, as `is not a function`.
    const partial = {
      listOwnedLayouts: () => [],
      getOwnedLayout: () => {
        throw new Error('unused');
      },
    };
    expect(() => ownedLayoutStore(partial)).toThrow(
      'missing createOwnedLayout, deleteOwnedLayout, mutateOwnedLayout, getProject',
    );
    expect(() =>
      ownedLayoutStore(new FileStorageAdapter('/tmp')),
    ).not.toThrow();
  });
});

describe('personal layout routes', () => {
  test('a Board created on one device is listed on another device of the same person', async () => {
    const { dir, app } = seeded();

    const created = await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Daily brief',
    });
    expect(created.status).toBe(201);

    // The second device is a DIFFERENT device — nothing about the first
    // request is replayed — and it lists the same Board because both resolve
    // to the same person.
    const listed = await app.request('/layouts', as('alice-phone'));
    expect(listed.status).toBe(200);
    const body = await json<{ data: LayoutMetadata[] }>(listed);
    expect(body.data.map((layout) => layout.slug)).toEqual(['daily']);
    expect(body.data[0]?.owner).toEqual({
      kind: 'principal',
      principal: alice,
    });

    const read = await app.request('/layouts/daily', as('alice-phone'));
    expect(read.status).toBe(200);
    expect((await json<{ data: { name: string } }>(read)).data.name).toBe(
      'Daily brief',
    );

    // Stored under the Station home keyed by PERSON, not by either device.
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(true);
    for (const device of ['alice-laptop', 'alice-phone']) {
      expect(existsSync(join(dir, 'layouts', 'personal', device))).toBe(false);
    }
  });

  test("another principal's Board is indistinguishable from one that never existed", async () => {
    const { app } = seeded();
    expect(
      (
        await createBoard(app, 'alice-laptop', {
          slug: 'daily',
          name: 'Daily brief',
        })
      ).status,
    ).toBe(201);

    for (const [method, init] of [
      ['GET', {}],
      ['PUT', { method: 'PUT', body: JSON.stringify({ name: 'Mine now' }) }],
      ['DELETE', { method: 'DELETE' }],
    ] as const) {
      const owned = await app.request('/layouts/daily', as('bob-laptop', init));
      const absent = await app.request(
        '/layouts/no-such-board',
        as('bob-laptop', init),
      );
      expect(
        [owned.status, await owned.text()],
        `${method} on another principal's slug must answer exactly like an unused slug`,
      ).toEqual([absent.status, await absent.text()]);
      expect(owned.status).toBe(404);
    }

    // And nothing bob sent reached alice's record.
    const aliceRead = await app.request('/layouts/daily', as('alice-laptop'));
    expect(aliceRead.status).toBe(200);
    expect((await json<{ data: { name: string } }>(aliceRead)).data.name).toBe(
      'Daily brief',
    );
  });

  test('a request cannot name the principal it stores under', async () => {
    const { dir, app } = seeded();

    // In the body: refused outright, and nothing is written.
    const named = await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Daily brief',
      owner: { kind: 'principal', principal: bob },
    });
    expect(named.status).toBe(400);
    expect(existsSync(personalDir(dir, bob))).toBe(false);
    expect(existsSync(personalDir(dir, alice))).toBe(false);

    // In the query string: ignored. The Board lands under the CALLER.
    const created = await app.request(
      '/layouts?principal=' + encodeURIComponent(bob.id),
      as('alice-laptop', {
        method: 'POST',
        body: JSON.stringify({ slug: 'daily', name: 'Daily brief' }),
      }),
    );
    expect(created.status).toBe(201);
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(true);
    expect(existsSync(personalDir(dir, bob))).toBe(false);

    const bobsList = await app.request('/layouts', as('bob-laptop'));
    expect((await json<{ data: LayoutMetadata[] }>(bobsList)).data).toEqual([]);
  });

  test('an update cannot rename the record onto another principal', async () => {
    const { app } = seeded();
    await createBoard(app, 'alice-laptop', { slug: 'daily', name: 'Daily' });

    const relocated = await app.request(
      '/layouts/daily',
      as('alice-laptop', {
        method: 'PUT',
        body: JSON.stringify({ owner: { kind: 'principal', principal: bob } }),
      }),
    );
    expect(relocated.status).toBe(400);

    const bobsList = await app.request('/layouts', as('bob-laptop'));
    expect((await json<{ data: LayoutMetadata[] }>(bobsList)).data).toEqual([]);
  });

  test('a body that names a slug or an unknown field is refused', async () => {
    const { app } = seeded();
    await createBoard(app, 'alice-laptop', { slug: 'daily', name: 'Daily' });

    for (const body of [{ slug: 'renamed' }, { colour: 'blue' }]) {
      const refused = await app.request(
        '/layouts/daily',
        as('alice-laptop', {
          method: 'PUT',
          body: JSON.stringify(body),
        }),
      );
      expect(refused.status, JSON.stringify(body)).toBe(400);
    }

    const read = await app.request('/layouts/daily', as('alice-laptop'));
    expect((await json<{ data: { slug: string } }>(read)).data.slug).toBe(
      'daily',
    );
  });

  test('a local single-operator instance stores under human:local:operator', async () => {
    const { dir, app } = seeded();

    // No device header: the resolver's local-operator path, gated on the
    // home-possession authority fact.
    const created = await createBoard(app, undefined, {
      slug: 'daily',
      name: 'Daily brief',
    });
    expect(created.status).toBe(201);
    const owner = (
      await json<{ data: { owner: { principal: PrincipalRef } } }>(created)
    ).data.owner;
    expect(owner.principal.id).toBe(LOCAL_OPERATOR_PRINCIPAL_ID);
    expect(LOCAL_OPERATOR_PRINCIPAL_ID).toBe('human:local:operator');

    expect(
      existsSync(
        join(personalDir(dir, owner.principal as PrincipalRef), 'daily.json'),
      ),
    ).toBe(true);

    // A paired person is a different principal and sees nothing of it.
    const alicesList = await app.request('/layouts', as('alice-laptop'));
    expect((await json<{ data: LayoutMetadata[] }>(alicesList)).data).toEqual(
      [],
    );
  });

  test('a second create under one slug is refused, not silently replaced', async () => {
    const { app } = seeded();
    const first = await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Daily brief',
    });
    expect(first.status).toBe(201);
    const firstId = (await json<{ data: { id: string } }>(first)).data.id;

    const second = await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Something else',
    });
    expect(second.status).toBe(409);

    const read = await app.request('/layouts/daily', as('alice-laptop'));
    const stored = (await json<{ data: { id: string; name: string } }>(read))
      .data;
    expect(stored).toMatchObject({ id: firstId, name: 'Daily brief' });
  });

  test('an update leaves the fields it does not name alone', async () => {
    const { app } = seeded();
    await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Daily brief',
      icon: 'star',
      description: 'Morning',
      config: { tabs: [] },
    });

    const updated = await app.request(
      '/layouts/daily',
      as('alice-laptop', {
        method: 'PUT',
        body: JSON.stringify({ name: 'Renamed' }),
      }),
    );
    expect(updated.status).toBe(200);
    expect(
      (await json<{ data: Record<string, unknown> }>(updated)).data,
    ).toMatchObject({
      id: 'board-1',
      slug: 'daily',
      name: 'Renamed',
      icon: 'star',
      description: 'Morning',
      createdAt: NOW,
    });
  });

  test('a slug that could never name a record answers as unused', async () => {
    const { app } = seeded();
    const absent = await app.request(
      '/layouts/no-such-board',
      as('alice-laptop'),
    );
    // These reach the handler unchanged (unlike `..`, which the router
    // normalizes away before any route matches) and are refused by path
    // safety. Their refusal must not be distinguishable from an unused slug:
    // sorting slugs into "malformed" and "merely unused" helps only somebody
    // guessing at what another person stored.
    for (const slug of ['a..b', '.hidden', '_hidden', '-lead']) {
      const refused = await app.request(`/layouts/${slug}`, as('alice-laptop'));
      expect([refused.status, await refused.text()], slug).toEqual([
        absent.status,
        await absent.clone().text(),
      ]);
      expect(refused.status).toBe(404);
    }
  });

  test('delete removes the caller’s own Board and reports a missing one', async () => {
    const { dir, app } = seeded();
    await createBoard(app, 'alice-laptop', { slug: 'daily', name: 'Daily' });

    const removed = await app.request(
      '/layouts/daily',
      as('alice-laptop', { method: 'DELETE' }),
    );
    expect(removed.status).toBe(200);
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(false);

    const again = await app.request(
      '/layouts/daily',
      as('alice-laptop', { method: 'DELETE' }),
    );
    expect(again.status).toBe(404);
  });
});

/**
 * #2062 — promote moves a Board into a project.
 *
 * Every case drives `POST /api/me/layouts/:layoutSlug/promote` against the real
 * `FileStorageAdapter`, and reads the FILESYSTEM for the move's two halves
 * rather than trusting the response: a promote that answered 200 while leaving
 * the personal record on disk is a copy, and the response body cannot tell the
 * difference.
 */
/**
 * #2062 review BLOCKING-2 — promote must be admitted by the DESTINATION's own
 * rules, not merely by the storage writer's fingerprint and slug checks.
 *
 * Every case drives the real route against the real `FileStorageAdapter`, and
 * asserts BOTH halves of a refusal: the answer the caller gets, and that
 * nothing moved. A promote that refused loudly while still writing half the
 * move would pass an assertion about the status alone.
 */
describe('promote is admitted by the project it publishes into (#2062)', () => {
  test('a Board naming an agent the project cannot reach is refused, and stays put', async () => {
    const { dir, app } = await seededWithProjects();
    await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Daily',
      config: { availableAgents: ['ghost-agent'] },
    });

    const refused = await promote(app, 'alice-laptop', 'daily', {
      projectSlug: 'demo',
    });

    // The project route's own answer for the identical body: 400, the first
    // diagnostic as the message, and the diagnostics alongside it.
    expect(refused.status).toBe(400);
    const body = await json<{
      error: string;
      diagnostics: Array<{ code: string; refId: string }>;
    }>(refused);
    expect(body.error).toBe("Layout references unknown agent 'ghost-agent'.");
    expect(body.diagnostics[0]).toMatchObject({
      code: 'unknown_layout_agent',
      refId: 'ghost-agent',
    });

    // NOTHING moved. The admission runs before the create, so neither half of
    // the move happened — this is the assertion that separates "refused" from
    // "refused after publishing".
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(true);
    expect(
      existsSync(join(dir, 'projects', 'demo', 'layouts', 'daily.json')),
    ).toBe(false);
  });

  test('a Board naming an agent the project CAN reach is promoted', async () => {
    const { dir, app } = await seededWithProjects();
    await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Daily',
      config: { availableAgents: ['helper'] },
    });

    // The discriminating half: without it, a promote that refused EVERY
    // config.availableAgents would pass the case above and this suite would
    // be asserting that promote is broken.
    expect(
      (await promote(app, 'alice-laptop', 'daily', { projectSlug: 'demo' }))
        .status,
    ).toBe(200);
    expect(
      existsSync(join(dir, 'projects', 'demo', 'layouts', 'daily.json')),
    ).toBe(true);
  });

  test('a promoted coding Board does not persist a working directory of its own', async () => {
    const { dir, storage, app } = await seededWithProjects();
    await createBoard(app, 'alice-laptop', {
      slug: 'work',
      name: 'Work',
      type: 'coding',
      config: { workingDirectory: '/somewhere/else' },
    });

    const refused = await promote(app, 'alice-laptop', 'work', {
      projectSlug: 'demo',
    });
    // `demo` has no working directory, so the supplied one differs from the
    // derived one and the project route's archive#1497 refusal applies here
    // too — by name, quoting the project.
    expect(refused.status).toBe(400);
    expect((await json<{ error: string }>(refused)).error).toContain(
      'config.workingDirectory is derived from its project',
    );
    expect(existsSync(join(personalDir(dir, alice), 'work.json'))).toBe(true);

    // ...and a coding Board WITHOUT one promotes, persisting no
    // `workingDirectory` key at all — the shape archive#1497 converges on.
    await createBoard(app, 'alice-laptop', {
      slug: 'clean',
      name: 'Clean',
      type: 'coding',
      config: {},
    });
    expect(
      (await promote(app, 'alice-laptop', 'clean', { projectSlug: 'demo' }))
        .status,
    ).toBe(200);
    const persisted = storage.getLayout('demo', 'clean');
    expect(
      Object.hasOwn((persisted.config ?? {}) as object, 'workingDirectory'),
    ).toBe(false);
  });
});

/**
 * #2062 review MED-5 — two promotes of ONE Board, racing.
 *
 * The create-then-delete order makes an interrupted promote to the SAME
 * project resumable (the id lineage identifies this Board's own copy). Two
 * promotes to DIFFERENT projects have no such resume path: both would create
 * their own copy and only one delete would find anything, leaving the Board
 * duplicated across two projects with nothing able to tell which was meant.
 * `promote` therefore serializes per Board, and this is that serialization
 * observed rather than asserted about.
 */
describe('two promotes of one Board cannot duplicate it (#2062)', () => {
  test('the loser finds the Board already gone and answers as unused', async () => {
    const { dir, app } = await seededWithProjects();
    await createBoard(app, 'alice-laptop', { slug: 'daily', name: 'Daily' });

    // Dispatched without awaiting between them, so both are in flight before
    // either completes — the shape that produced the duplicate.
    const [first, second] = await Promise.all([
      promote(app, 'alice-laptop', 'daily', { projectSlug: 'demo' }),
      promote(app, 'alice-laptop', 'daily', { projectSlug: 'other' }),
    ]);

    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 404]);

    // Exactly one project holds it, and the personal record is gone.
    const landed = ['demo', 'other'].filter((project) =>
      existsSync(join(dir, 'projects', project, 'layouts', 'daily.json')),
    );
    expect(landed).toHaveLength(1);
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(false);
  });
});

/**
 * #2062 review MED-4 — the delete leg, after the project copy is published.
 *
 * The personal record can be gone by the time promote deletes it (a
 * concurrent `DELETE /api/me/layouts/:slug`). That is not a failure: the
 * project holds the Layout and the personal scope does not, which is exactly
 * what the move promised. Before the guard, the `FileStorageNotFoundError`
 * reached the route's catch and became 404 `Project not found` — naming a
 * project whose copy had just been written.
 */
describe('promote whose personal record vanishes mid-move (#2062)', () => {
  test('reports the move it completed, not a missing project', async () => {
    const board = {
      id: 'board-1',
      owner: { kind: 'principal' as const, principal: alice },
      slug: 'daily',
      type: 'custom',
      name: 'Daily',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    };
    const created: string[] = [];
    // Deterministic, because the real adapter cannot be made to lose this race
    // on demand: the delete answers "already gone" exactly as it would for a
    // DELETE that landed between the create and the delete.
    const app = createPersonalLayoutRoutes(
      {
        listOwnedLayouts: () => [],
        getOwnedLayout: (owner, layoutSlug) => {
          if (owner.kind === 'principal' && layoutSlug === 'daily') {
            return board;
          }
          throw new FileStorageNotFoundError(
            `Layout '${layoutSlug}' not found`,
          );
        },
        createOwnedLayout: async (_owner, config) => {
          created.push(config.slug);
        },
        deleteOwnedLayout: async (_owner, layoutSlug) => {
          throw new FileStorageNotFoundError(
            `Layout '${layoutSlug}' not found`,
          );
        },
        mutateOwnedLayout: async () => {
          throw new Error('unused');
        },
        getProject: () => ({
          id: 'project-1',
          slug: 'demo',
          name: 'Demo',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      },
      {
        listAgents: async () => knownAgents,
        resolvePrincipal: () =>
          resolvePrincipal(
            {
              provider: 'tailscale-serve',
              subject: 'alice@example.test',
              displayName: 'alice@example.test',
            },
            'personal',
            undefined,
            undefined,
          ),
        now: () => NOW,
        newId: () => 'board-1',
      },
    );

    const moved = await promote(app, 'alice-laptop', 'daily', {
      projectSlug: 'demo',
    });

    expect(moved.status).toBe(200);
    // The project copy WAS written — which is why "Project not found" was
    // never a defensible answer here.
    expect(created).toEqual(['daily']);
  });

  /**
   * The other half of that guard, and the half a comment alone was asserting
   * (#2062 review F5): only ABSENCE is swallowed. Widening the catch to
   * `return;` for every error left the whole suite green, so nothing held the
   * narrowing in place.
   *
   * A delete that fails for any other reason leaves the Board in BOTH places,
   * and a caller told "moved" would have no reason to look. It must surface.
   */
  test('a delete that fails for any other reason is not reported as a move', async () => {
    const board = {
      id: 'board-1',
      owner: { kind: 'principal' as const, principal: alice },
      slug: 'daily',
      type: 'custom',
      name: 'Daily',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    };
    const app = createPersonalLayoutRoutes(
      {
        listOwnedLayouts: () => [],
        getOwnedLayout: (owner, layoutSlug) => {
          if (owner.kind === 'principal' && layoutSlug === 'daily') {
            return board;
          }
          throw new FileStorageNotFoundError(
            `Layout '${layoutSlug}' not found`,
          );
        },
        createOwnedLayout: async () => {},
        deleteOwnedLayout: async () => {
          // Not absence — a real storage failure, the case that leaves a
          // duplicate behind.
          throw new Error('EACCES: permission denied');
        },
        mutateOwnedLayout: async () => {
          throw new Error('unused');
        },
        getProject: () => ({
          id: 'project-1',
          slug: 'demo',
          name: 'Demo',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      },
      {
        listAgents: async () => knownAgents,
        resolvePrincipal: () =>
          resolvePrincipal(
            {
              provider: 'tailscale-serve',
              subject: 'alice@example.test',
              displayName: 'alice@example.test',
            },
            'personal',
            undefined,
            undefined,
          ),
        now: () => NOW,
        newId: () => 'board-1',
      },
    );

    const answer = await promote(app, 'alice-laptop', 'daily', {
      projectSlug: 'demo',
    });

    // Anything but 200. The route has no branch for this, so it reaches the
    // unhandled-error boundary as a 500 — which is the honest answer for a
    // move that half happened, and is emphatically not "moved".
    expect(answer.status).not.toBe(200);
    expect(answer.status).toBeGreaterThanOrEqual(500);
  });
});

describe('promote a Board into a project (#2062)', () => {
  test('the personal record is gone and the project layout carries the same id lineage', async () => {
    const { dir, storage, app } = await seededWithProjects();
    const created = await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Daily brief',
      icon: 'star',
      description: 'Morning',
    });
    expect(created.status).toBe(201);
    const board = (
      await json<{ data: { id: string; createdAt: string } }>(created)
    ).data;

    const promoted = await promote(app, 'alice-laptop', 'daily', {
      projectSlug: 'demo',
    });
    expect(promoted.status).toBe(200);

    // A MOVE: the personal record is gone, and the personal route answers for
    // it exactly as it answers for a slug nobody ever used.
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(false);
    expect((await readBoard(app, 'alice-laptop', 'daily')).status).toBe(404);
    expect(
      (
        await json<{ data: LayoutMetadata[] }>(
          await listBoards(app, 'alice-phone'),
        )
      ).data,
    ).toEqual([]);

    // ...and the project now owns it, under the SAME id and createdAt. The id
    // is the whole lineage claim: nothing else records that this project
    // Layout used to be that person's Board.
    const stored = storage.getLayout('demo', 'daily');
    expect(stored.id).toBe(board.id);
    expect(stored.createdAt).toBe(board.createdAt);
    expect(stored.name).toBe('Daily brief');
    expect(stored.icon).toBe('star');
    expect(stored.description).toBe('Morning');
    // A project record persists `projectSlug` and never `owner` — the shape
    // every pre-Boards record on disk already has.
    expect(stored.projectSlug).toBe('demo');
    expect(stored.owner).toBeUndefined();
    expect(
      JSON.parse(
        readFileSync(
          join(dir, 'projects', 'demo', 'layouts', 'daily.json'),
          'utf8',
        ),
      ).owner,
    ).toBeUndefined();
    // The response body reports the record that was actually written.
    expect(
      (await json<{ data: Record<string, unknown> }>(promoted)).data,
    ).toMatchObject({ id: board.id, slug: 'daily', projectSlug: 'demo' });
  });

  test('a project that does not exist answers 404 and leaves the Board where it was', async () => {
    const { dir, app } = await seededWithProjects();
    await createBoard(app, 'alice-laptop', { slug: 'daily', name: 'Daily' });

    for (const projectSlug of ['no-such-project', '.hidden', 'a..b']) {
      const refused = await promote(app, 'alice-laptop', 'daily', {
        projectSlug,
      });
      // The project routes' own answer for a missing project
      // (`projectMutationMessage`/`projectMutationStatus`,
      // src-server/routes/projects/projects.ts:229-248).
      expect(
        [refused.status, (await json<{ error: string }>(refused)).error],
        projectSlug,
      ).toEqual([404, 'Project not found']);
      // THE POINT: the destination is checked before anything is deleted, so a
      // promote that cannot land does not destroy the record it was moving.
      expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(
        true,
      );
    }

    expect(
      (
        await json<{ data: LayoutMetadata[] }>(
          await listBoards(app, 'alice-laptop'),
        )
      ).data.map((layout) => layout.slug),
    ).toEqual(['daily']);
  });

  test("another principal's Board cannot be promoted, and answers as unused", async () => {
    const { dir, app } = await seededWithProjects();
    await createBoard(app, 'alice-laptop', { slug: 'daily', name: 'Daily' });

    const refused = await promote(app, 'bob-laptop', 'daily', {
      projectSlug: 'demo',
    });
    expect(refused.status).toBe(404);
    expect(await refused.text()).toBe(
      await (
        await promote(app, 'bob-laptop', 'never-existed', {
          projectSlug: 'demo',
        })
      ).text(),
    );
    // Alice still has hers, and nothing reached the project.
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(true);
    expect(
      existsSync(join(dir, 'projects', 'demo', 'layouts', 'daily.json')),
    ).toBe(false);
  });

  test('a name the project already uses is a 409 that moves nothing', async () => {
    const { dir, storage, app } = await seededWithProjects();
    await createBoard(app, 'alice-laptop', { slug: 'daily', name: 'My Board' });
    await storage.createLayout('demo', {
      id: 'someone-elses-layout',
      projectSlug: 'demo',
      slug: 'daily',
      type: 'custom',
      name: 'The project already had this',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    });

    const refused = await promote(app, 'alice-laptop', 'daily', {
      projectSlug: 'demo',
    });
    expect(refused.status).toBe(409);
    // Neither half happened: the Board is still personal and the project's
    // existing Layout is untouched.
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(true);
    expect(storage.getLayout('demo', 'daily').id).toBe('someone-elses-layout');
  });

  test('a promote interrupted after the create completes on the next call', async () => {
    const { dir, storage, app } = await seededWithProjects();
    const created = await createBoard(app, 'alice-laptop', {
      slug: 'daily',
      name: 'Daily',
    });
    const board = (await json<{ data: { id: string } }>(created)).data;

    // The crash window this order deliberately accepts: the project copy
    // landed, the personal delete did not. Reproduced by performing only the
    // first half through the same storage the route uses.
    await storage.createLayout('demo', {
      id: board.id,
      projectSlug: 'demo',
      slug: 'daily',
      type: 'custom',
      name: 'Daily',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(true);

    const resumed = await promote(app, 'alice-laptop', 'daily', {
      projectSlug: 'demo',
    });
    expect(resumed.status).toBe(200);
    // Resumed, not refused: the occupant carries this Board's own id, so it is
    // the interrupted promote's own work rather than a name collision.
    expect(existsSync(join(personalDir(dir, alice), 'daily.json'))).toBe(false);
    expect(storage.getLayout('demo', 'daily').id).toBe(board.id);
  });

  test('a promote body may name only the destination project', async () => {
    const { app } = await seededWithProjects();
    await createBoard(app, 'alice-laptop', { slug: 'daily', name: 'Daily' });
    for (const body of [
      { projectSlug: 'demo', name: 'Renamed on the way' },
      { projectSlug: 'demo', id: 'chosen-id' },
      { projectSlug: 'demo', owner: { kind: 'instance' } },
      {},
    ]) {
      expect((await promote(app, 'alice-laptop', 'daily', body)).status).toBe(
        400,
      );
    }
  });
});

describe('an unresolvable caller', () => {
  /**
   * Production reaches this: a paired device whose person binding conflicts
   * with the current identity or deployment throws here
   * (`runtime-routes.ts`'s `resolveOrchestrationRequestPrincipal`), as does a
   * caller carrying no identity and no authority fact. The refusal must be
   * the typed authz answer the orchestration routes already give for the same
   * error — not the 500 "unexpected runtime error" an uncaught throw would
   * get from `runtime-http.ts`'s unhandled-error boundary, which would report
   * an infrastructure fault for a deterministic authorization failure and
   * invite a retry that cannot succeed.
   */
  function refusing() {
    const dir = mkdtempSync(join(tmpdir(), 'station-personal-layouts-route-'));
    tempDirs.push(dir);
    return createPersonalLayoutRoutes(
      ownedLayoutStore(new FileStorageAdapter(dir)),
      {
        resolvePrincipal: () => {
          throw new PrincipalUnresolvedError(
            'Device person binding conflicts with the current identity or deployment',
          );
        },
        // Never reached — the refusal happens before any handler runs — but
        // required, which is the point: a composition cannot forget it.
        listAgents: async () => knownAgents,
        now: () => NOW,
        newId: () => 'board-1',
      },
    );
  }

  test.each([
    ['GET', '/layouts', {}],
    [
      'POST',
      '/layouts',
      { method: 'POST', body: JSON.stringify({ slug: 'daily', name: 'D' }) },
    ],
    ['GET', '/layouts/daily', {}],
    [
      'PUT',
      '/layouts/daily',
      { method: 'PUT', body: JSON.stringify({ name: 'Renamed' }) },
    ],
    ['DELETE', '/layouts/daily', { method: 'DELETE' }],
    // #2062. Promote is the newest leaf and the only one that writes outside
    // the caller's own records, so it is the one most worth pinning here: it
    // must refuse an unresolvable caller BEFORE it reads a destination
    // project, not after.
    [
      'POST',
      '/layouts/daily/promote',
      { method: 'POST', body: JSON.stringify({ projectSlug: 'demo' }) },
    ],
  ] as const)(
    '%s %s answers the typed principal_unresolved refusal, not a 500',
    async (_method, path, init) => {
      const res = await refusing().request(path, as(undefined, init));

      expect(res.status).toBe(400);
      const body = await json<{
        success: boolean;
        error: string;
        code: string;
      }>(res);
      expect(body.code).toBe(PRINCIPAL_UNRESOLVED_CODE);
      expect(body.success).toBe(false);
      expect(body.error).toContain('Unable to resolve a principal');
    },
  );
});

/**
 * #2062 — the promote conflict branch has two causes, and they are different
 * answers.
 *
 * `FileStorageConflictError` covers BOTH "Layout 'x' already exists" and the
 * CAS refusal "Project changed before the Layout could be created". The real
 * adapter cannot be made to lose that race deterministically, so the route and
 * the service here are real and only the STORAGE is the stub — which is the
 * layer the race lives in.
 */
describe('promote and a lost CAS race (#2062)', () => {
  function racingApp() {
    const board = {
      id: 'board-1',
      owner: { kind: 'principal' as const, principal: alice },
      slug: 'daily',
      type: 'custom',
      name: 'Daily',
      config: {},
      createdAt: NOW,
      updatedAt: NOW,
    };
    const deleted: string[] = [];
    const app = createPersonalLayoutRoutes(
      {
        listOwnedLayouts: () => [],
        getOwnedLayout: (owner, layoutSlug) => {
          if (owner.kind === 'principal' && layoutSlug === 'daily') {
            return board;
          }
          // The project root has no record: the create was refused by the
          // project's own fingerprint check, not by an occupant.
          throw new FileStorageNotFoundError(
            `Layout '${layoutSlug}' not found`,
          );
        },
        createOwnedLayout: async () => {
          throw new FileStorageConflictError(
            'Project changed before the Layout could be created',
          );
        },
        deleteOwnedLayout: async (_owner, layoutSlug) => {
          deleted.push(layoutSlug);
        },
        mutateOwnedLayout: async () => {
          throw new Error('unused');
        },
        // The project EXISTS — that is the whole point of this case. The race
        // is against a concurrent change to it, not against its absence.
        getProject: () => ({
          id: 'project-1',
          slug: 'demo',
          name: 'Demo',
          createdAt: NOW,
          updatedAt: NOW,
        }),
      },
      {
        listAgents: async () => knownAgents,
        resolvePrincipal: () =>
          resolvePrincipal(
            {
              provider: 'tailscale-serve',
              subject: 'alice@example.test',
              displayName: 'alice@example.test',
            },
            'personal',
            undefined,
            undefined,
          ),
        now: () => NOW,
        newId: () => 'board-1',
      },
    );
    return { app, deleted };
  }

  test('answers 409 rather than reporting the project missing, and deletes nothing', async () => {
    const { app, deleted } = racingApp();

    const raced = await promote(app, 'alice-laptop', 'daily', {
      projectSlug: 'demo',
    });

    // 404 `Project not found` would be a lie: the project is there, the write
    // lost a race against a concurrent change to it.
    expect(raced.status).toBe(409);
    // And the Board is still the caller's — a move that did not land must not
    // have performed its second half.
    expect(deleted).toEqual([]);
  });
});

/**
 * #2090 — the Board twin of the project layout read.
 *
 * A Board reaches `LayoutRenderer` through the same `layoutWorkspaceShape`
 * derivation a project Layout does, so a Board tab naming a component from a
 * plugin this person cannot see hits the same false "…is not installed or
 * registered" sentence. The verdict is what lets the host answer it
 * causelessly instead.
 *
 * What this route deliberately does NOT do is withhold `config.plugin`. There
 * is no live plugin read and no catalog backfill here — a Board's binding is
 * the caller's own input into their own record — so stripping it would
 * disclose nothing while destroying that binding on the next
 * read-modify-write.
 */
describe('a Board tab whose plugin its owner cannot see (#2090)', () => {
  const HIDDEN_PLUGIN = 'secret-notes';

  async function boardWithPluginTab(options: {
    canSeePlugin?: (pluginId: string) => boolean;
  }) {
    const context = seeded(options);
    const created = await createBoard(context.app, 'alice-laptop', {
      slug: 'my-board',
      name: 'My board',
      config: {
        plugin: HIDDEN_PLUGIN,
        tabs: [
          { id: 'notes', label: 'Notes', component: 'notes-view' },
          { id: 'extra', label: 'Extra', component: 'extra-view' },
        ],
      },
    });
    expect(created.status).toBe(201);
    return context;
  }

  test('the read carries a causeless per-tab verdict', async () => {
    const { app } = await boardWithPluginTab({ canSeePlugin: () => false });
    const body = await json<{ data: Record<string, any> }>(
      await readBoard(app, 'alice-laptop', 'my-board'),
    );
    expect(body.data.paneReferences).toEqual({
      unavailableTabIds: ['notes', 'extra'],
    });
    // No reason, no source, no action: the verdict names only tab ids.
    expect(Object.keys(body.data.paneReferences)).toEqual([
      'unavailableTabIds',
    ]);
  });

  test('a viewer who can see the plugin gets no verdict', async () => {
    const { app } = await boardWithPluginTab({ canSeePlugin: () => true });
    const body = await json<{ data: Record<string, any> }>(
      await readBoard(app, 'alice-laptop', 'my-board'),
    );
    expect(body.data.paneReferences).toBeUndefined();
  });

  test('a composition with no projection is untouched', async () => {
    const { app } = await boardWithPluginTab({});
    const body = await json<{ data: Record<string, any> }>(
      await readBoard(app, 'alice-laptop', 'my-board'),
    );
    expect(body.data.paneReferences).toBeUndefined();
    expect(body.data.config.plugin).toBe(HIDDEN_PLUGIN);
  });

  test('a read-modify-write of the verdict is accepted and not persisted', async () => {
    // `personalLayoutUpdateSchema` is `.strict()`, so without the tolerated
    // key this PUT is a 400 on an ordinary round trip of this route's own
    // response; and the storage schema is `.strict()` too, so persisting it
    // would be a hard rejection one layer down.
    const { app, dir } = await boardWithPluginTab({
      canSeePlugin: () => false,
    });
    const read = await json<{ data: Record<string, any> }>(
      await readBoard(app, 'alice-laptop', 'my-board'),
    );
    expect(read.data.paneReferences).toBeDefined();
    const written = await app.request(
      '/layouts/my-board',
      as('alice-laptop', {
        method: 'PUT',
        body: JSON.stringify({
          name: 'Renamed',
          config: read.data.config,
          paneReferences: read.data.paneReferences,
        }),
      }),
    );
    expect(written.status).toBe(200);
    const stored = JSON.parse(
      readFileSync(join(personalDir(dir, alice), 'my-board.json'), 'utf8'),
    );
    expect(stored.name).toBe('Renamed');
    expect(stored).not.toHaveProperty('paneReferences');
  });
});
