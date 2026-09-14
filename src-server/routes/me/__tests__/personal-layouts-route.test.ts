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
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
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

function seeded() {
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
  });
  return { dir, storage, app };
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
      'missing deleteOwnedLayout, mutateOwnedLayout',
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
