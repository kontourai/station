/**
 * Scoped pairing (archive#1098) AC1: a read-only credential can read and
 * stream state but 403s on EVERY mutation and terminal route. This sweeps
 * `PAIRING_SCOPE_ROUTE_TABLE` itself — the same table
 * `runtime-http.ts`'s middleware consults — rather than a hand-picked list
 * of routes, so the assertion stays true even as the table grows.
 */

import type { HttpBindings } from '@hono/node-server';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { createUsageTelemetryDisclosureRoutes } from '../../routes/operations/usage-telemetry-disclosure.js';
import {
  PAIRING_SCOPE_ROUTE_TABLE,
  requiredPairingScope,
} from '../../security/pairing-route-scopes.js';
import type { EventBus } from '../../services/orchestration/event-bus.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';

const OPERATOR_CREDENTIAL = 'operator-credential-full-authority';
const READ_ONLY_CREDENTIAL = 'device-credential-read-only-scope';
const STANDARD_CREDENTIAL = 'device-credential-standard-scope';

type TestBindings = HttpBindings & {
  incoming: HttpBindings['incoming'] & {
    socket: HttpBindings['incoming']['socket'] & { remoteAddress?: string };
  };
};

function scopeFor(credential: string): string | undefined {
  if (credential === OPERATOR_CREDENTIAL) return DEFAULT_GRANT_PAIRING_SCOPE;
  if (credential === READ_ONLY_CREDENTIAL) {
    return pairingScopePresetString('read-only');
  }
  if (credential === STANDARD_CREDENTIAL) {
    return pairingScopePresetString('standard');
  }
  return undefined;
}

function createHarness() {
  const app = new Hono<{ Bindings: TestBindings }>();
  configureRuntimeHttp({
    app: app as never,
    logger: {
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
    },
    eventBus: { emit() {} } as unknown as EventBus,
    security: {
      verifyCredential: (candidate) => scopeFor(candidate) !== undefined,
      resolveGrantedScope: (candidate) => scopeFor(candidate),
      allowedOrigins: [],
    },
  } as Parameters<typeof configureRuntimeHttp>[0]);

  // A generic reachable handler for every path this suite probes — the
  // table's own prefixes plus representative leaf paths under them.
  app.all('*', (c) => c.json({ reached: true }));

  return {
    request: (path: string, method: string, credential: string) =>
      app.request(
        path,
        { method, headers: { Authorization: `Bearer ${credential}` } },
        {
          incoming: { socket: { remoteAddress: '100.96.12.7' } },
        } as TestBindings,
      ),
  };
}

/** One representative leaf path per read-tier rule in the route table. */
const READ_TIER_CASES = PAIRING_SCOPE_ROUTE_TABLE.filter(
  (rule) => rule.scope === 'orchestration:read',
).map((rule) => ({
  method: rule.method,
  // `/integrations/:id` is an explicit operate override. Appending a
  // synthetic segment to the family root accidentally exercises that detail
  // rule instead of the read-only list leaf this table entry owns.
  path: rule.prefix === '/integrations' ? rule.prefix : `${rule.prefix}/probe`,
}));

/** One representative leaf path per mutate-tier rule in the route table. */
const OPERATE_TIER_CASES = PAIRING_SCOPE_ROUTE_TABLE.filter(
  (rule) => rule.scope === 'orchestration:operate',
).map((rule) => ({ method: rule.method, path: `${rule.prefix}/probe` }));

describe('scoped pairing HTTP enforcement (station#1098 AC1, table-driven)', () => {
  it('the table itself has both a read and a mutate tier to sweep (sanity)', () => {
    expect(READ_TIER_CASES.length).toBeGreaterThan(10);
    expect(OPERATE_TIER_CASES.length).toBeGreaterThan(10);
  });

  it("DISCLOSURE CONSENT AUTHORIZATION DEFECT: a read-only paired caller cannot acknowledge telemetry on the operator's behalf", async () => {
    const app = new Hono<{ Bindings: TestBindings }>();
    configureRuntimeHttp({
      app: app as never,
      logger: {
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
      },
      eventBus: { emit() {} } as unknown as EventBus,
      security: {
        verifyCredential: (candidate) => scopeFor(candidate) !== undefined,
        resolveGrantedScope: (candidate) => scopeFor(candidate),
        allowedOrigins: [],
      },
    } as Parameters<typeof configureRuntimeHttp>[0]);
    const acknowledgeDisclosure = vi.fn();
    app.route(
      '/api/usage-telemetry',
      createUsageTelemetryDisclosureRoutes({
        acknowledgeDisclosure,
        disclosure: vi.fn().mockResolvedValue({
          acknowledged: false,
          inventoryRevision: 'inventory',
          events: {},
        }),
      } as never),
    );

    const response = await app.request(
      '/api/usage-telemetry/disclosure/acknowledgements',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${READ_ONLY_CREDENTIAL}` },
      },
      {
        incoming: { socket: { remoteAddress: '100.96.12.7' } },
      } as TestBindings,
    );

    expect(
      response.status,
      'read-only paired caller acknowledged telemetry consent',
    ).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });
    expect(
      acknowledgeDisclosure,
      'unauthorized caller reached acknowledgement writer',
    ).not.toHaveBeenCalled();
  });

  it.each(READ_TIER_CASES)(
    'a read-only credential is allowed on $method $path',
    async ({ method, path }) => {
      const { request } = createHarness();
      const response = await request(path, method, READ_ONLY_CREDENTIAL);
      expect(response.status, `${method} ${path}`).not.toBe(401);
      expect(response.status, `${method} ${path}`).not.toBe(403);
    },
  );

  it.each(OPERATE_TIER_CASES)(
    'a read-only credential 403s on EVERY mutation: $method $path',
    async ({ method, path }) => {
      const { request } = createHarness();
      const response = await request(path, method, READ_ONLY_CREDENTIAL);
      expect(response.status, `${method} ${path}`).toBe(403);
      // archive#1097 review round 2: HEAD only entered this operate-tier
      // sweep once the /api/environments/ssh/sessions leaf override added
      // the table's first HEAD:orchestration:operate rule — every prior
      // operate-tier case was a POST/PUT/PATCH/DELETE, which all carry a
      // body. A HEAD response never has one (HTTP spec, and the platform
      // fetch Response here correctly empties it even though the handler
      // wrote JSON), so `.json()` on it always throws regardless of scope
      // enforcement — assert the body only for methods that can carry one.
      if (method !== 'HEAD') {
        await expect(response.json()).resolves.toEqual({
          error: { code: 'insufficient_scope' },
        });
      }
    },
  );

  it('a standard credential is allowed on every mutation and read (but the table has no access:manage HTTP case to sweep separately)', async () => {
    const { request } = createHarness();
    for (const { method, path } of [
      ...READ_TIER_CASES,
      ...OPERATE_TIER_CASES,
    ]) {
      const response = await request(path, method, STANDARD_CREDENTIAL);
      expect(response.status, `${method} ${path}`).not.toBe(401);
      expect(response.status, `${method} ${path}`).not.toBe(403);
    }
  });

  // archive#1097 review round 2 (HIGH): a dedicated, literal-path exercise
  // of the cross-station-reads tightening — deliberately NOT via `/probe`
  // like the table-driven sweep above, so this proves the real production
  // route (no trailing segment) resolves the same way, not just its prefix.
  it('cross-station read tightening: a read-only credential 403s and a standard credential 200s on GET /api/environments/ssh/sessions', async () => {
    const { request } = createHarness();

    const readOnly = await request(
      '/api/environments/ssh/sessions',
      'GET',
      READ_ONLY_CREDENTIAL,
    );
    expect(readOnly.status).toBe(403);
    await expect(readOnly.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });

    const standard = await request(
      '/api/environments/ssh/sessions',
      'GET',
      STANDARD_CREDENTIAL,
    );
    expect(standard.status).toBe(200);

    // The rest of the /api/environments/ssh family is unaffected by the
    // leaf override — a read-only credential can still read this Station's
    // own SSH profile/connection metadata.
    const familyRead = await request(
      '/api/environments/ssh',
      'GET',
      READ_ONLY_CREDENTIAL,
    );
    expect(familyRead.status).not.toBe(401);
    expect(familyRead.status).not.toBe(403);
  });

  // archive#4181: dedicated, literal-path exercise of the board mutation
  // tightening — same posture as the SSH sessions test above: proves the
  // real production leaves (no `/probe` synthetic suffix the table-driven
  // sweep appends) resolve to the raised `orchestration:operate` tier, not
  // just their table prefix. `canReadSession`/`taskExists` reference
  // authorization (routes/board.ts) is a separate, additional gate — this
  // suite only exercises the pairing-scope boundary in front of it.
  it('board mutation tightening (station#4181): a read-only credential 403s on pin/unpin/move but still reads GET /api/board', async () => {
    const { request } = createHarness();

    for (const path of [
      '/api/board/pin',
      '/api/board/unpin',
      '/api/board/move',
    ]) {
      const response = await request(path, 'POST', READ_ONLY_CREDENTIAL);
      expect(response.status, `POST ${path}`).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: { code: 'insufficient_scope' },
      });
    }

    const read = await request('/api/board', 'GET', READ_ONLY_CREDENTIAL);
    expect(read.status).not.toBe(401);
    expect(read.status).not.toBe(403);
  });

  it('board mutation tightening (station#4181): a standard (operate-scoped) credential still reaches pin/unpin/move', async () => {
    const { request } = createHarness();
    for (const path of [
      '/api/board/pin',
      '/api/board/unpin',
      '/api/board/move',
    ]) {
      const response = await request(path, 'POST', STANDARD_CREDENTIAL);
      expect(response.status, `POST ${path}`).not.toBe(401);
      expect(response.status, `POST ${path}`).not.toBe(403);
    }
  });

  // archive#4075 stage 3 slice 2: dedicated, literal-path exercise of the
  // presence-roster endpoint — same posture as the SSH-sessions and board
  // tests above, proving the real production leaf (no `/probe` synthetic
  // suffix) resolves at the family's `orchestration:read` tier for BOTH a
  // read-only and a standard credential (`pairing-route-scopes.ts`'s
  // `PAIRING_SCOPE_FAMILY_INHERITED_LEAVES` entry records the reconciled
  // reasoning for staying at the family default rather than a raised tier).
  it('presence roster (station#4075 stage 3 slice 2): both a read-only and a standard credential reach GET /api/orchestration/presence/summary', async () => {
    const { request } = createHarness();

    const readOnly = await request(
      '/api/orchestration/presence/summary',
      'GET',
      READ_ONLY_CREDENTIAL,
    );
    expect(readOnly.status).not.toBe(401);
    expect(readOnly.status).not.toBe(403);

    const standard = await request(
      '/api/orchestration/presence/summary',
      'GET',
      STANDARD_CREDENTIAL,
    );
    expect(standard.status).not.toBe(401);
    expect(standard.status).not.toBe(403);
  });

  // Cross-station usage rollup: this route queries configured PEER Stations
  // with their stored bearer credentials and returns their environment
  // identities, so it discloses paired-environment relationships, not
  // ordinary local analytics. It therefore sits at access:manage alongside
  // the fleet receipt leaves — a STANDARD paired device is refused too, not
  // only a read-only one. `localOnly=1` is a request option, not a second
  // route capability, so it cannot lower this floor.
  it('usage rollup: read-only AND standard credentials 403 on GET /api/analytics/usage-rollup; the operator credential reaches it', async () => {
    const { request } = createHarness();

    for (const credential of [READ_ONLY_CREDENTIAL, STANDARD_CREDENTIAL]) {
      const refused = await request(
        '/api/analytics/usage-rollup',
        'GET',
        credential,
      );
      expect(refused.status, credential).toBe(403);
      await expect(refused.json()).resolves.toEqual({
        error: { code: 'insufficient_scope' },
      });
    }

    const operator = await request(
      '/api/analytics/usage-rollup',
      'GET',
      OPERATOR_CREDENTIAL,
    );
    expect(operator.status).not.toBe(401);
    expect(operator.status).not.toBe(403);
  });

  it('a standard credential still 403s on pairing/device management (access:manage)', async () => {
    const { request } = createHarness();
    const response = await request(
      '/api/pairing/devices',
      'GET',
      STANDARD_CREDENTIAL,
    );
    expect(response.status).toBe(403);
  });

  it('the operator credential (full scope) is allowed everywhere, including access:manage', async () => {
    const { request } = createHarness();
    for (const { method, path } of [
      ...READ_TIER_CASES,
      ...OPERATE_TIER_CASES,
    ]) {
      const response = await request(path, method, OPERATOR_CREDENTIAL);
      expect(response.status, `${method} ${path}`).not.toBe(401);
      expect(response.status, `${method} ${path}`).not.toBe(403);
    }
    const pairing = await request(
      '/api/pairing/devices',
      'GET',
      OPERATOR_CREDENTIAL,
    );
    expect(pairing.status).not.toBe(403);
  });

  it('fails closed (403) for a route the table does not recognize, even with a fully-scoped credential', async () => {
    const { request } = createHarness();
    expect(
      requiredPairingScope('GET', '/api/never-registered'),
    ).toBeUndefined();
    const response = await request(
      '/api/never-registered',
      'GET',
      OPERATOR_CREDENTIAL,
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: { code: 'insufficient_scope' },
    });
  });

  it('an invalid credential still 401s before any scope check runs', async () => {
    const { request } = createHarness();
    const response = await request(
      '/api/projects',
      'GET',
      'not-a-real-credential',
    );
    expect(response.status).toBe(401);
  });
});

/**
 * archive#2051: the credential requirement means a presented credential is
 * checked identically whether the direct peer is loopback or
 * remote — this is the SSH-tunnel-shaped case (an SSH local forward is
 * loopback at the TCP layer), so it re-runs a representative slice of the
 * table-driven sweep above at a loopback peer address to prove enforcement
 * doesn't quietly relax there.
 */
describe('scoped pairing HTTP enforcement at a loopback peer (station#1123 slice 3)', () => {
  function loopbackHarness() {
    const app = new Hono<{ Bindings: TestBindings }>();
    configureRuntimeHttp({
      app: app as never,
      logger: {
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
      },
      eventBus: { emit() {} } as unknown as EventBus,
      security: {
        verifyCredential: (candidate) => scopeFor(candidate) !== undefined,
        resolveGrantedScope: (candidate) => scopeFor(candidate),
        allowedOrigins: [],
      },
    } as Parameters<typeof configureRuntimeHttp>[0]);
    app.all('*', (c) => c.json({ reached: true }));
    return {
      request: (path: string, method: string, credential: string) =>
        app.request(
          path,
          { method, headers: { Authorization: `Bearer ${credential}` } },
          {
            incoming: { socket: { remoteAddress: '127.0.0.1' } },
          } as TestBindings,
        ),
    };
  }

  it.each(OPERATE_TIER_CASES)(
    'a read-only credential at a loopback peer still 403s on EVERY mutation: $method $path',
    async ({ method, path }) => {
      const { request } = loopbackHarness();
      const response = await request(path, method, READ_ONLY_CREDENTIAL);
      expect(response.status, `${method} ${path}`).toBe(403);
      if (method !== 'HEAD') {
        await expect(response.json()).resolves.toEqual({
          error: { code: 'insufficient_scope' },
        });
      }
    },
  );

  it.each(READ_TIER_CASES)(
    'a read-only credential at a loopback peer is still allowed on $method $path',
    async ({ method, path }) => {
      const { request } = loopbackHarness();
      const response = await request(path, method, READ_ONLY_CREDENTIAL);
      expect(response.status, `${method} ${path}`).not.toBe(401);
      expect(response.status, `${method} ${path}`).not.toBe(403);
    },
  );

  it('the operator credential (full scope) at a loopback peer is allowed everywhere, including access:manage', async () => {
    const { request } = loopbackHarness();
    for (const { method, path } of [
      ...READ_TIER_CASES,
      ...OPERATE_TIER_CASES,
    ]) {
      const response = await request(path, method, OPERATOR_CREDENTIAL);
      expect(response.status, `${method} ${path}`).not.toBe(401);
      expect(response.status, `${method} ${path}`).not.toBe(403);
    }
  });
});
