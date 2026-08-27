import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_GRANT_PAIRING_SCOPE,
  PAIRING_SCOPES,
  pairingScopeIncludes,
  pairingScopePresetString,
} from '@kontourai/station-contracts';
import { Hono } from 'hono';
import { describe, expect, test, vi } from 'vitest';
import {
  type DiscoveredLeafRoute,
  scanRegisteredLeafRoutes,
} from '../pairing-route-leaf-scan.js';
import {
  assertRuntimeHttpRouteCoverage,
  credentialAuthorizedForScope,
  EXTERNAL_SURFACE_CAPABILITY_TABLE,
  findUnclassifiedRuntimeHttpRoutes,
  isLeafScopeDeclared,
  matchPairingScopeRule,
  PAIRING_SCOPE_CATCH_ALL_MOUNT_EXCEPTIONS,
  PAIRING_SCOPE_FAMILY_INHERITED_LEAVES,
  PAIRING_WS_SCOPES,
  requiredExternalSurfaceCapability,
  requiredPairingScope,
} from '../pairing-route-scopes.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_ROUTES_PATH = join(
  __dirname,
  '../../runtime/routes/runtime-routes.ts',
);
const FIXTURE_RUNTIME_ROUTES_PATH = join(
  __dirname,
  'fixtures/leaf-scan/runtime-routes-fixture.ts',
);
const FIXTURE_COMPOSED_RUNTIME_ROUTES_PATH = join(
  __dirname,
  'fixtures/leaf-scan/runtime-routes-fixture-composed.ts',
);
const FIXTURE_COMMENTED_RUNTIME_ROUTES_PATH = join(
  __dirname,
  'fixtures/leaf-scan/runtime-routes-fixture-commented.ts',
);
const FIXTURE_UNPARSED_RUNTIME_ROUTES_PATH = join(
  __dirname,
  'fixtures/leaf-scan/runtime-routes-fixture-unparsed.ts',
);
const FIXTURE_DYNAMIC_BASE_RUNTIME_ROUTES_PATH = join(
  __dirname,
  'fixtures/leaf-scan/runtime-routes-fixture-dynamic-base.ts',
);
const FIXTURE_BRACES_RUNTIME_ROUTES_PATH = join(
  __dirname,
  'fixtures/leaf-scan/runtime-routes-fixture-braces.ts',
);

/**
 * Every literal base path `configureRuntimeRoutes` mounts a sub-router at,
 * via `context.app.route('<base>', ...)`. This is a live scan of the real
 * source file, not a hand-copied list — so a new mount added to
 * `runtime-routes.ts` without a matching table entry makes
 * `'covers every context.app.route(...) mount in runtime-routes.ts'` below
 * fail red, exactly what station#1098 R2's "test enumerating the route
 * surface" requires.
 *
 * Scoped honestly: the regex only matches a string-literal first argument
 * (`context.app.route('/x', ...)`). A future mount registered through a
 * computed or variable base path (`context.app.route(someBase, ...)`) would
 * not be found by this scan and would silently evade this coverage
 * assertion — it would need its own explicit test. Every mount in
 * `runtime-routes.ts` today is a string literal.
 */
function scanMountedRouteBases(): string[] {
  const source = readFileSync(RUNTIME_ROUTES_PATH, 'utf8');
  const bases: string[] = [];
  const pattern = /context\.app\.route\(\s*(['"`])((?:(?!\1).)*)\1/g;
  for (const match of source.matchAll(pattern)) {
    bases.push(match[2]);
  }
  return bases;
}

describe('pairing-route-scopes: source-derived coverage (station#1098 R2)', () => {
  test('declares each inherited leaf exactly once', () => {
    const identities = PAIRING_SCOPE_FAMILY_INHERITED_LEAVES.map(
      ({ method, path }) => `${method} ${path}`,
    );
    expect(identities).toEqual([...new Set(identities)]);
  });

  test('inherits read scope for the local operating-state availability leaf', () => {
    const path = '/api/projects/:slug/operating-state/availability';
    expect(isLeafScopeDeclared('GET', path)).toBe(true);
    expect(PAIRING_SCOPE_FAMILY_INHERITED_LEAVES).toContainEqual({
      method: 'GET',
      path,
    });
    expect(matchPairingScopeRule('GET', path)).toMatchObject({
      origin: 'family',
      prefix: '/api/projects',
      scope: 'orchestration:read',
    });
    expect(requiredPairingScope('GET', path)).toBe('orchestration:read');
  });

  test('declares the protected Task tool-result projection leaf at the read tier', () => {
    const path = '/api/tasks/:taskId/tool-result-references';
    expect(PAIRING_SCOPE_FAMILY_INHERITED_LEAVES).toContainEqual({
      method: 'GET',
      path,
    });
    expect(requiredPairingScope('GET', path)).toBe('orchestration:read');
  });

  test('keeps protected MCP App leaves at their existing family operate tier', () => {
    for (const [method, path, prefix] of [
      [
        'POST',
        '/integrations/:serverId/ui/:toolName/initial-result',
        '/integrations',
      ],
      ['POST', '/api/tasks/:taskId/basis/app-read', '/api/tasks'],
      ['DELETE', '/api/tasks/:taskId/basis/app-read', '/api/tasks'],
    ] as const) {
      expect(PAIRING_SCOPE_FAMILY_INHERITED_LEAVES).toContainEqual({
        method,
        path,
      });
      expect(matchPairingScopeRule(method, path)).toMatchObject({
        origin: 'family',
        prefix,
        scope: 'orchestration:operate',
      });
      expect(requiredPairingScope(method, path)).toBe('orchestration:operate');
    }
  });
  test('covers every context.app.route(...) mount in runtime-routes.ts', () => {
    const bases = scanMountedRouteBases();
    expect(bases.length).toBeGreaterThan(20); // sanity: the scan itself found routes

    const uncovered: string[] = [];
    for (const base of new Set(bases)) {
      if (PAIRING_SCOPE_CATCH_ALL_MOUNT_EXCEPTIONS.includes(base)) continue;
      if (requiredPairingScope('GET', base) === undefined) {
        uncovered.push(base);
      }
    }
    expect(uncovered).toEqual([]);
  });

  test('the catch-all mount exceptions are exactly the two known absolute-leaf-path bases', () => {
    // '' (createOtlpReceiverRoutes -> /v1/*) and '/' (createInvokeRoutes ->
    // /invoke, /agents/:slug/invoke, ...) are the only bases whose sub-router
    // registers absolute leaf paths rather than paths nested under the base
    // itself. Both leaf paths are independently covered by the table (see
    // the next test) — this just pins the exception list from silently
    // growing to swallow a real, uncovered future mount.
    expect(PAIRING_SCOPE_CATCH_ALL_MOUNT_EXCEPTIONS).toEqual(['', '/']);
  });

  test('the two catch-all mounts still resolve scope through their real absolute leaf paths', () => {
    expect(requiredPairingScope('POST', '/invoke')).toBe(
      'orchestration:operate',
    );
    expect(requiredPairingScope('POST', '/v1/traces')).toBe(
      'orchestration:operate',
    );
  });
});

describe('external surface capability table (station#2000)', () => {
  test('makes public, MCP-token, SSE/RPC, and dedicated WebSocket contracts explicit', () => {
    expect(
      requiredExternalSurfaceCapability(
        'http',
        'POST',
        '/.well-known/station/v1/pairing/request',
      ),
    ).toMatchObject({ capability: 'public' });
    expect(
      requiredExternalSurfaceCapability('http', 'POST', '/mcp/station-control'),
    ).toMatchObject({ capability: 'mcp-token' });
    expect(
      requiredExternalSurfaceCapability('http', 'GET', '/events'),
    ).toMatchObject({
      capability: 'pairing-scope',
      scope: 'orchestration:read',
    });
    expect(
      requiredExternalSurfaceCapability(
        'http',
        'GET',
        '/api/memory/conversations',
      ),
    ).toMatchObject({
      capability: 'pairing-scope',
      scope: 'orchestration:read',
    });
    expect(
      requiredExternalSurfaceCapability('http', 'POST', '/setup-observability'),
    ).toMatchObject({
      capability: 'pairing-scope',
      scope: 'orchestration:operate',
    });
    expect(
      requiredExternalSurfaceCapability('terminal-ws', 'CONNECT', '/'),
    ).toMatchObject({
      capability: 'pairing-scope',
      scope: 'terminal:operate',
    });
    expect(
      requiredExternalSurfaceCapability('voice-ws', 'CONNECT', '/'),
    ).toMatchObject({
      capability: 'pairing-scope',
      scope: 'orchestration:operate',
    });
    expect(
      requiredExternalSurfaceCapability(
        'terminal-ws',
        'CONNECT',
        '/__station/health',
      ),
    ).toMatchObject({ capability: 'public' });
    expect(EXTERNAL_SURFACE_CAPABILITY_TABLE).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: 'public',
          reason: expect.any(String),
        }),
        expect.objectContaining({
          capability: 'mcp-token',
          reason: expect.any(String),
        }),
      ]),
    );
  });

  test('fails closed for an unclassified registered method/path', () => {
    const app = new Hono();
    app.get('/api/system/liveness', () => new Response());
    app.post('/not-in-the-capability-table', () => new Response());

    expect(findUnclassifiedRuntimeHttpRoutes(app.routes)).toEqual([
      'POST /not-in-the-capability-table',
    ]);
    expect(() => assertRuntimeHttpRouteCoverage(app.routes)).toThrow(
      'Unclassified externally reachable HTTP route(s): POST /not-in-the-capability-table',
    );
  });
});

/**
 * station#1131: `scanMountedRouteBases()` above proves every mount BASE
 * resolves to a scope, but is blind to a new LEAF registered under a base
 * that's already covered — exactly the gap PR #1128 hit with
 * `GET /api/environments/ssh/sessions` (see `pairing-route-scopes.ts`'s
 * module docblock and `pairing-route-leaf-scan.ts`'s own docblock for the
 * full mechanics). This block proves the extended, leaf-level scan (AC1),
 * that it stays green against the real, current route surface with the
 * seeded declarations (AC2), and that this file's synthetic-leaf fixture
 * makes the guard fail red the way a real un-declared leaf would.
 */
/**
 * Scope-coverage invariant for the leaf scan (station#1634, epic #1555).
 *
 * The rejection half of this guardrail is already proven below: a synthetic
 * leaf under an existing mount is discovered and flagged. The structural
 * checks here additionally prove that comments cannot hide a mount and that an
 * unsupported mount expression fails closed instead of silently dropping its
 * leaves from the pairing-scope guard.
 */
describe('pairing-route-scopes: the leaf scan can see every declared mount (station#1634)', () => {
  test('every mount base declared in runtime-routes.ts yields at least one discovered leaf', () => {
    const leaves = scanRegisteredLeafRoutes(RUNTIME_ROUTES_PATH);
    const bases = new Set(scanMountedRouteBases());
    expect(bases.size).toBeGreaterThan(20);

    const unreached = [...bases].filter((base) => {
      // The two catch-all mounts register absolute leaf paths that do not nest
      // under their own base; they are covered by their own assertions above.
      if (PAIRING_SCOPE_CATCH_ALL_MOUNT_EXCEPTIONS.includes(base)) return false;
      const prefix = base.endsWith('/') ? base : `${base}/`;
      return !leaves.some(
        (leaf) => leaf.path === base || leaf.path.startsWith(prefix),
      );
    });

    expect(
      unreached,
      `${unreached.join(', ')} — a mount the source declares but the leaf scan ` +
        'produced no leaf for. Every authenticated route beneath it is outside ' +
        'the pairing-scope security scan and the scan will report clean anyway. ' +
        'The scanner must parse the mount or fail closed before this assertion.',
    ).toEqual([]);
  });

  test('discovers a comment-preceded mount after a regex literal and ignores prose', () => {
    const leaves = scanRegisteredLeafRoutes(
      FIXTURE_COMMENTED_RUNTIME_ROUTES_PATH,
    );
    expect(leaves).toContainEqual({
      method: 'GET',
      path: '/api/system/status',
      file: expect.stringContaining('fixture-leaf-routes.ts'),
    });
    expect(leaves).toContainEqual({
      method: 'GET',
      path: '/api/system/commented-direct-leaf',
      file: expect.stringContaining('runtime-routes-fixture-commented.ts'),
    });
  });

  test('fails closed with the source file and counts when a mount expression is unsupported', () => {
    expect(() =>
      scanRegisteredLeafRoutes(FIXTURE_UNPARSED_RUNTIME_ROUTES_PATH),
    ).toThrow(
      /parsed 0 of 1 route\(\.\.\.\) mounts .*runtime-routes-fixture-unparsed\.ts/,
    );
  });

  test('fails closed when an executable mount uses a nonliteral base', () => {
    expect(() =>
      scanRegisteredLeafRoutes(FIXTURE_DYNAMIC_BASE_RUNTIME_ROUTES_PATH),
    ).toThrow(
      /parsed 0 of 1 route\(\.\.\.\) mounts .*runtime-routes-fixture-dynamic-base\.ts/,
    );
  });

  test.each([
    'configureRegexRoutes',
    'configureStringRoutes',
    'configureCommentRoutes',
  ])('uses AST body locations when %s contains a closing brace', (entry) => {
    const leaves = scanRegisteredLeafRoutes(
      FIXTURE_BRACES_RUNTIME_ROUTES_PATH,
      entry,
    );
    expect(leaves).toContainEqual({
      method: 'GET',
      path: '/api/system/status',
      file: expect.stringContaining('fixture-leaf-routes.ts'),
    });
  });
});

describe('pairing-route-scopes: leaf-level coverage (station#1131)', () => {
  function describeUndeclaredLeaf(leaf: DiscoveredLeafRoute): string {
    return (
      `${leaf.method} ${leaf.path} (registered in ${leaf.file}) resolves through ` +
      'the generic family split but has no PAIRING_SCOPE_FAMILY_INHERITED_LEAVES ' +
      'entry in pairing-route-scopes.ts. Add one ONLY after confirming this leaf ' +
      'is no more sensitive than the rest of its family (does it return another ' +
      "environment's or another Station's data? does it mutate?) — otherwise add " +
      'an explicit PairingScopeRouteRule override instead, the way ' +
      '`/api/environments/ssh/sessions` does above.'
    );
  }

  test('AC2: every leaf discovered on the real runtime-routes.ts surface is explicitly declared', () => {
    const leaves = scanRegisteredLeafRoutes(RUNTIME_ROUTES_PATH);
    // Sanity: the recursive scan itself found a realistic number of leaves —
    // guards against a silently-broken scan (e.g. a regex stops matching)
    // passing this test by discovering nothing.
    expect(leaves.length).toBeGreaterThan(300);

    const undeclared = leaves.filter(
      (leaf) => !isLeafScopeDeclared(leaf.method, leaf.path),
    );
    expect(undeclared.map(describeUndeclaredLeaf)).toEqual([]);
  });

  test('AC2: the seeded allowlist has no stale entry the live scan no longer discovers', () => {
    // The inverse direction: every declared leaf should still be a real,
    // currently-registered route — otherwise the allowlist silently grows
    // without anyone ever pruning it, and a genuinely new (and different)
    // leaf could coincidentally collide with a stale path/method pair.
    const leaves = scanRegisteredLeafRoutes(RUNTIME_ROUTES_PATH);
    const live = new Set(leaves.map((leaf) => `${leaf.method} ${leaf.path}`));
    const stale = PAIRING_SCOPE_FAMILY_INHERITED_LEAVES.filter(
      (leaf) => !live.has(`${leaf.method} ${leaf.path}`),
    );
    expect(stale).toEqual([]);
  });

  test('declares every metadata-only Session inventory leaf at its protected read scope', () => {
    const inventoryLeaves = scanRegisteredLeafRoutes(RUNTIME_ROUTES_PATH)
      .filter((leaf) => leaf.path.includes('/inventory'))
      .filter((leaf) => leaf.method === 'GET');
    expect(
      inventoryLeaves.map((leaf) => `${leaf.method} ${leaf.path}`),
    ).toEqual(
      expect.arrayContaining([
        'GET /api/orchestration/sessions/:threadId/inventory',
        'GET /api/orchestration/sessions/:threadId/inventory/groups/:groupId',
        'GET /api/tasks/:taskId/sessions/:sessionId/inventory',
        'GET /api/tasks/:taskId/sessions/:sessionId/inventory/groups/:groupId',
      ]),
    );
    expect(
      inventoryLeaves.every((leaf) =>
        isLeafScopeDeclared(leaf.method, leaf.path),
      ),
    ).toBe(true);
  });

  test('AC1: a synthetic leaf added under an existing mount base is discovered and flagged undeclared', () => {
    const leaves = scanRegisteredLeafRoutes(FIXTURE_RUNTIME_ROUTES_PATH);

    // The fixture's ordinary leaf resolves via the real /api/system family
    // rule and IS declared (proves the fixture's mount base is genuinely
    // covered, not itself hitting the fail-closed default).
    const ordinary = leaves.find((leaf) => leaf.path === '/api/system/status');
    expect(ordinary).toBeDefined();
    expect(isLeafScopeDeclared(ordinary!.method, ordinary!.path)).toBe(true);

    // The synthetic leaf is discovered by the scan...
    const synthetic = leaves.find(
      (leaf) => leaf.path === '/api/system/__leaf_guard_fixture_unmapped__',
    );
    expect(synthetic).toBeDefined();
    expect(synthetic).toMatchObject({ method: 'GET' });

    // ...and the guard correctly refuses to treat it as covered just
    // because its family prefix resolves a scope — this is the red the
    // issue asked for: a real PR adding this leaf without a declaration
    // would fail exactly this assertion.
    expect(isLeafScopeDeclared(synthetic!.method, synthetic!.path)).toBe(false);
  });

  test('AC1 follow-up (review round 1, HIGH item 2): a leaf added behind a register*Routes(app, deps) composition helper is also discovered and flagged undeclared', () => {
    // The fixture above only exercises the direct-call-factory shape
    // (`context.app.route('<base>', createFoo())`). This fixture instead
    // mirrors `plugins.ts`'s real composition shape — a local
    // `const app = new Hono()` handed to a sibling `register*Routes(app,
    // deps)` call — which the scan was blind to before this round (the
    // `/api/plugins/**` subtree resolved zero leaves).
    const leaves = scanRegisteredLeafRoutes(
      FIXTURE_COMPOSED_RUNTIME_ROUTES_PATH,
    );

    const ordinary = leaves.find((leaf) => leaf.path === '/api/system/status');
    expect(ordinary).toBeDefined();
    expect(isLeafScopeDeclared(ordinary!.method, ordinary!.path)).toBe(true);

    const synthetic = leaves.find(
      (leaf) =>
        leaf.path === '/api/system/__leaf_guard_fixture_composed_unmapped__',
    );
    expect(synthetic).toBeDefined();
    expect(synthetic).toMatchObject({ method: 'GET' });
    expect(isLeafScopeDeclared(synthetic!.method, synthetic!.path)).toBe(false);
  });
});

describe('pairing-route-scopes: table-driven lookups', () => {
  test.each([
    ['GET', '/api/projects', 'orchestration:read'],
    ['GET', '/api/tasks/task-1/user-input-references', 'orchestration:read'],
    ['POST', '/api/tasks/task-1/references', 'orchestration:operate'],
    ['GET', '/api/projects/my-proj/knowledge/status', 'orchestration:read'],
    ['POST', '/api/projects', 'orchestration:operate'],
    ['GET', '/api/usage-telemetry/disclosure', 'orchestration:read'],
    [
      'POST',
      '/api/usage-telemetry/disclosure/acknowledgements',
      'access:manage',
    ],
    ['POST', '/api/projects/my-proj/file-preview', 'orchestration:read'],
    [
      'POST',
      '/api/projects/my-proj/file-preview/download',
      'orchestration:read',
    ],
    [
      'DELETE',
      '/api/projects/my-proj/terminals/terminal-1',
      'terminal:operate',
    ],
    ['PATCH', '/agents/example/chat', 'orchestration:operate'],
    [
      'POST',
      '/agents/example/conversations/conversation-1/regenerate-title',
      'orchestration:operate',
    ],
    ['GET', '/api/orchestration/runs', 'orchestration:read'],
    [
      'GET',
      '/api/starter-work/inspect-approval/candidate',
      'orchestration:read',
    ],
    ['POST', '/api/starter-work/launch', 'orchestration:operate'],
    [
      'GET',
      '/agents/example/conversations/conversation-1/export',
      'orchestration:read',
    ],
    ['DELETE', '/api/connections/example', 'orchestration:operate'],
    [
      'POST',
      '/api/conversations/some-id/acknowledgement',
      'orchestration:operate',
    ],
    ['GET', '/api/environments/ssh', 'orchestration:read'],
    ['GET', '/api/environments/ssh/some-id', 'orchestration:read'],
    ['POST', '/api/environments/ssh/some-id/connect', 'orchestration:operate'],
    // station#1131 audit finding: this had NO table entry at all before
    // this PR (a straight coverage gap in the catch-all-mount exception
    // list, not a family-inheritance near-miss) — every remote-paired
    // credential got a fail-closed 403, invisible locally because loopback
    // callers bypass scope checks entirely.
    ['POST', '/tool-approval/some-approval-id', 'orchestration:operate'],
    // station#1097 review round 2 (HIGH): the cross-station-read leaf
    // override — see `pairing-route-scopes.ts`'s "Family-granularity
    // inheritance" docblock note and `docs/security/
    // remote-access-threat-model.md`'s "Cross-station reads" section.
    ['GET', '/api/environments/ssh/sessions', 'orchestration:operate'],
    ['HEAD', '/api/environments/ssh/sessions', 'orchestration:operate'],
    ['GET', '/api/pairing/devices', 'access:manage'],
    ['GET', '/api/secret-bindings', 'access:manage'],
    ['GET', '/api/secret-bindings/integrations/github', 'access:manage'],
    ['GET', '/api/secret-bindings/github', 'access:manage'],
    ['POST', '/api/secret-bindings', 'access:manage'],
    ['PUT', '/api/secret-bindings/github', 'access:manage'],
    ['POST', '/api/secret-bindings/github/revoke', 'access:manage'],
    ['POST', '/api/secret-bindings/github/bind', 'access:manage'],
    ['POST', '/api/secret-bindings/github/unbind', 'access:manage'],
    [
      'POST',
      '/api/secret-bindings/integrations/github/migrate-stored-env',
      'access:manage',
    ],
    ['POST', '/api/secret-bindings/github/migrate-stored-env', 'access:manage'],
    ['GET', '/api/client-presence/summary', 'orchestration:read'],
    ['POST', '/api/pairing/offers', 'access:manage'],
    ['DELETE', '/api/pairing/devices/some-id', 'access:manage'],
    ['GET', '/api/pairing/requests', 'access:manage'],
    // station#1398 slice 2: the fleet inference family, one tier for every
    // method — the read (which models does this Station contribute) and the
    // write (generate tokens on one) are the same disclosure decision.
    ['GET', '/api/inference/manifest', 'inference:invoke'],
    ['POST', '/api/inference/completions', 'inference:invoke'],
    ['DELETE', '/api/inference/anything-added-later', 'inference:invoke'],
    // station#1398 §10 OQ-2: the model-inventory leaf override.
    ['GET', '/api/connections/model-inventory', 'inference:invoke'],
    ['HEAD', '/api/connections/model-inventory', 'inference:invoke'],
    ['GET', '/api/connections/codex-runtime/quota', 'orchestration:read'],
    // station#1398 slice 4 (security review, M-4): the fleet receipt leaves
    // name OTHER Stations — peer ids, operator-facing labels, contributed
    // model ids, and the fingerprints of peers that called in. Their source,
    // the outbound peer registry, is gated at `access:manage`, so anything
    // lower here would make the higher gate decorative. The rest of
    // `/monitoring` deliberately stays at the family read tier.
    ['GET', '/monitoring/fleet-routing-receipts', 'access:manage'],
    ['HEAD', '/monitoring/fleet-routing-receipts', 'access:manage'],
    ['GET', '/monitoring/fleet-serve-receipts', 'access:manage'],
    ['HEAD', '/monitoring/fleet-serve-receipts', 'access:manage'],
    ['GET', '/monitoring/stats', 'orchestration:read'],
    ['GET', '/monitoring/metrics', 'orchestration:read'],
    ['GET', '/api/registry/kits', 'orchestration:read'],
    ['GET', '/api/registry/kits/example/layout', 'orchestration:read'],
    ['POST', '/api/registry/kits/example/disable', 'orchestration:operate'],
    ['POST', '/api/registry/kits/example/enable', 'orchestration:operate'],
    ['POST', '/api/registry/kits/example/actions', 'orchestration:operate'],
  ] as const)('%s %s requires %s', (method, path, expected) => {
    expect(requiredPairingScope(method, path)).toBe(expected);
  });

  test('gives the project-bound file-preview POST leaf an explicit read override', () => {
    expect(
      matchPairingScopeRule('POST', '/api/projects/:slug/file-preview'),
    ).toMatchObject({
      origin: 'explicit',
      prefix: '/api/projects/:slug/file-preview',
      scope: 'orchestration:read',
    });
    expect(
      isLeafScopeDeclared('POST', '/api/projects/:slug/file-preview'),
    ).toBe(true);
    expect(PAIRING_SCOPE_FAMILY_INHERITED_LEAVES).not.toContainEqual({
      method: 'POST',
      path: '/api/projects/:slug/file-preview',
    });
  });

  test('declares title regeneration as the local conversation mutation it is', () => {
    const path = '/agents/:slug/conversations/:conversationId/regenerate-title';
    expect(isLeafScopeDeclared('POST', path)).toBe(true);
    expect(PAIRING_SCOPE_FAMILY_INHERITED_LEAVES).toContainEqual({
      method: 'POST',
      path,
    });
    expect(requiredPairingScope('POST', path)).toBe('orchestration:operate');
  });

  test('classifies local conversation handoff mutation and read leaves at the orchestration family split', () => {
    const handoff = '/api/orchestration/conversations/:conversationId/handoff';
    const handoffReceipt =
      '/api/orchestration/conversations/:conversationId/handoffs/:idempotencyKey';
    const eventWindow =
      '/api/orchestration/conversations/:conversationId/event-window';

    for (const [method, path, scope] of [
      ['POST', handoff, 'orchestration:operate'],
      ['GET', handoffReceipt, 'orchestration:read'],
      ['GET', eventWindow, 'orchestration:read'],
    ] as const) {
      expect(PAIRING_SCOPE_FAMILY_INHERITED_LEAVES).toContainEqual({
        method,
        path,
      });
      expect(isLeafScopeDeclared(method, path)).toBe(true);
      expect(matchPairingScopeRule(method, path)).toMatchObject({
        origin: 'family',
        prefix: '/api/orchestration',
        scope,
      });
      expect(requiredPairingScope(method, path)).toBe(scope);
    }
  });

  test('full runtime leaf completeness includes every conversation handoff route', () => {
    const leaves = scanRegisteredLeafRoutes(RUNTIME_ROUTES_PATH);
    const handoffLeaves = leaves.filter((leaf) =>
      [
        'POST /api/orchestration/conversations/:conversationId/handoff',
        'GET /api/orchestration/conversations/:conversationId/handoffs/:idempotencyKey',
        'GET /api/orchestration/conversations/:conversationId/event-window',
      ].includes(`${leaf.method} ${leaf.path}`),
    );
    expect(handoffLeaves).toHaveLength(3);
    expect(
      handoffLeaves.filter(
        (leaf) => !isLeafScopeDeclared(leaf.method, leaf.path),
      ),
    ).toEqual([]);
  });

  test('declares the attachment handoff as its own exact project read leaf', () => {
    expect(
      matchPairingScopeRule(
        'POST',
        '/api/projects/:slug/file-preview/download',
      ),
    ).toMatchObject({
      origin: 'explicit',
      prefix: '/api/projects/:slug/file-preview/download',
      scope: 'orchestration:read',
    });
    expect(
      isLeafScopeDeclared('POST', '/api/projects/:slug/file-preview/download'),
    ).toBe(true);
    expect(PAIRING_SCOPE_FAMILY_INHERITED_LEAVES).not.toContainEqual({
      method: 'POST',
      path: '/api/projects/:slug/file-preview/download',
    });
  });

  test('keeps Project preview and its attachment handoff at read authority', () => {
    expect(
      requiredPairingScope('POST', '/api/projects/my-proj/file-preview'),
    ).toBe('orchestration:read');
    expect(
      requiredPairingScope(
        'POST',
        '/api/projects/my-proj/file-preview/download',
      ),
    ).toBe('orchestration:read');
  });

  test('gives project terminal termination the explicit terminal-operate scope', () => {
    expect(
      matchPairingScopeRule(
        'DELETE',
        '/api/projects/:slug/terminals/:terminalId',
      ),
    ).toMatchObject({
      origin: 'explicit',
      prefix: '/api/projects/:slug/terminals/:terminalId',
      scope: 'terminal:operate',
    });
    expect(
      isLeafScopeDeclared(
        'DELETE',
        '/api/projects/:slug/terminals/:terminalId',
      ),
    ).toBe(true);
  });

  test('makes integration detail and embedded tool execution explicit operate decisions', () => {
    expect(matchPairingScopeRule('GET', '/integrations/mcp-1')).toMatchObject({
      origin: 'explicit',
      scope: 'orchestration:operate',
      prefix: '/integrations/:id',
    });
    expect(
      matchPairingScopeRule('GET', '/integrations/mcp-1/ui/render/embedded'),
    ).toMatchObject({
      origin: 'explicit',
      scope: 'orchestration:operate',
      prefix: '/integrations/:serverId/ui/:toolName/embedded',
    });
    expect(
      matchPairingScopeRule('HEAD', '/integrations/mcp-1/ui/render/embedded'),
    ).toMatchObject({
      origin: 'explicit',
      scope: 'orchestration:operate',
      prefix: '/integrations/:serverId/ui/:toolName/embedded',
    });
    expect(
      isLeafScopeDeclared(
        'HEAD',
        '/integrations/:serverId/ui/:toolName/embedded',
      ),
    ).toBe(true);
    expect(
      requiredPairingScope('GET', '/integrations/mcp-1/ui/render/resource'),
    ).toBe('orchestration:read');
    expect(requiredPairingScope('GET', '/integrations')).toBe(
      'orchestration:read',
    );
  });

  test('fails closed (undefined) for a route with no table entry', () => {
    expect(
      requiredPairingScope('GET', '/api/totally-unmapped-surface'),
    ).toBeUndefined();
    expect(requiredPairingScope('GET', '/')).toBe('orchestration:read');
    expect(requiredPairingScope('POST', '')).toBeUndefined();
  });

  test('a route method not covered by any rule at a known prefix also fails closed', () => {
    // The table only defines read + mutate methods; an exotic method at an
    // otherwise-covered prefix still has to fail closed rather than
    // silently falling through to some default.
    expect(requiredPairingScope('TRACE', '/api/projects')).toBeUndefined();
  });

  test('pairing/device management is a single tier regardless of method', () => {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']) {
      expect(requiredPairingScope(method, '/api/pairing/offers')).toBe(
        'access:manage',
      );
    }
  });

  test('station#1131 review round 1 (HIGH): plugin host-approvals require access:manage, not the family default', () => {
    // Own-audit finding, not just the reviewer's two named leaves: before
    // this entry, approving a plugin's 'trusted' permission grant
    // resolved through the ordinary /api/plugins mutate tier
    // (orchestration:operate) — a tier the DEFAULT pairing preset
    // ('standard') already grants every paired device, defeating the
    // "isolated host approval channel" /grant's own error message
    // promises. access:manage is the one scope no paired-device preset
    // ever grants (see environment-security.ts's PAIRING_SCOPE_PRESETS
    // doc comment).
    for (const [method, path] of [
      ['POST', '/api/plugins/host-approvals'],
      ['GET', '/api/plugins/host-approvals/some-id'],
      ['GET', '/api/plugins/host-approvals/some-id/review'],
      ['POST', '/api/plugins/host-approvals/some-id/approve'],
      ['POST', '/api/plugins/host-approvals/some-id/deny'],
    ] as const) {
      expect(requiredPairingScope(method, path)).toBe('access:manage');
    }
    // Sanity: the rest of the /api/plugins family is unaffected — still
    // the ordinary family split, not swept up by the host-approvals
    // override.
    expect(requiredPairingScope('GET', '/api/plugins')).toBe(
      'orchestration:read',
    );
    expect(requiredPairingScope('POST', '/api/plugins/install')).toBe(
      'orchestration:operate',
    );
  });

  test('station#3677 PR 2 review (BLOCKING): Home role requests require access:manage, not the family default', () => {
    // Request creation RETURNS the transaction-bound decision-session cookie,
    // and fetch-metadata headers only constrain browsers — so on the family
    // default (orchestration:operate, in the standard pairing preset) a
    // merely-paired raw HTTP client could mint the cookie, forge the
    // navigation headers against the consent listener, and grant ITSELF the
    // Home role with zero operator involvement. Same shape, same fix, same
    // reasoning as the host-approvals override above.
    for (const [method, path] of [
      ['POST', '/api/plugins/home-role/requests'],
      ['GET', '/api/plugins/home-role/requests/some-id'],
    ] as const) {
      expect(requiredPairingScope(method, path)).toBe('access:manage');
    }
    // The read/revoke/candidates leaves stay on the family tiers: none of
    // them mints authority, and revoke's floor direction is the disclosed
    // #3673 trade.
    expect(requiredPairingScope('GET', '/api/plugins/home-role')).toBe(
      'orchestration:read',
    );
    expect(
      requiredPairingScope('GET', '/api/plugins/home-role/candidates'),
    ).toBe('orchestration:read');
    expect(requiredPairingScope('DELETE', '/api/plugins/home-role')).toBe(
      'orchestration:operate',
    );
  });

  test('credential-profile management requires access:manage for every declared leaf', async () => {
    const leaves = [
      ['GET', '/api/connections/agent/codex-runtime/credential-recovery'],
      [
        'POST',
        '/api/connections/agent/codex-runtime/credential-recovery/profiles',
      ],
      [
        'DELETE',
        '/api/connections/agent/codex-runtime/credential-recovery/profiles/profile-a',
      ],
      [
        'PUT',
        '/api/connections/agent/codex-runtime/credential-recovery/profiles/profile-a/enrollment',
      ],
      [
        'PUT',
        '/api/connections/agent/codex-runtime/credential-recovery/policy',
      ],
      [
        'POST',
        '/api/connections/agent/codex-runtime/credential-recovery/profiles/profile-a/import',
      ],
      [
        'POST',
        '/api/connections/agent/codex-runtime/credential-recovery/profiles/profile-a/apply',
      ],
    ] as const;
    const standardResolver = {
      verifyCredential: vi.fn(async () => true),
      resolveGrantedScope: vi.fn(async () =>
        pairingScopePresetString('standard'),
      ),
    };
    const operatorResolver = {
      verifyCredential: vi.fn(async () => true),
      resolveGrantedScope: vi.fn(async () => DEFAULT_GRANT_PAIRING_SCOPE),
    };

    for (const [method, path] of leaves) {
      expect(requiredPairingScope(method, path)).toBe('access:manage');
      await expect(
        credentialAuthorizedForScope(
          standardResolver,
          requiredPairingScope(method, path)!,
          'remote-standard-credential',
        ),
      ).resolves.toBe(false);
      await expect(
        credentialAuthorizedForScope(
          operatorResolver,
          requiredPairingScope(method, path)!,
          'operator-credential',
        ),
      ).resolves.toBe(true);
    }
  });

  test('a bare prefix segment collision does not falsely match (path boundary correctness)', () => {
    // '/api/agentsomething' must not be treated as being under '/api/agents'.
    expect(requiredPairingScope('GET', '/api/agentsomething')).toBeUndefined();
  });
});

describe('pairing-route-scopes: leaf override precedence (station#1097 review round 2, HIGH)', () => {
  test('the longer, more specific /sessions leaf entry wins over the /api/environments/ssh family entry', () => {
    // Sanity: the family prefix alone still resolves to its own (lower)
    // read tier for every OTHER path under it.
    expect(requiredPairingScope('GET', '/api/environments/ssh')).toBe(
      'orchestration:read',
    );
    expect(requiredPairingScope('GET', '/api/environments/ssh/some-id')).toBe(
      'orchestration:read',
    );

    // The leaf itself, and anything nested under it, resolves to the
    // stricter tier instead — proving the longest-prefix matcher picks the
    // more specific rule over the family rule it is nested inside.
    expect(requiredPairingScope('GET', '/api/environments/ssh/sessions')).toBe(
      'orchestration:operate',
    );
    expect(requiredPairingScope('HEAD', '/api/environments/ssh/sessions')).toBe(
      'orchestration:operate',
    );
  });

  test('the leaf override only adds GET/HEAD rules — an unanticipated mutating method on that path still fails closed to a real scope via the family rule, never undefined', () => {
    // No route actually registers a mutating method on this leaf today, but
    // the table's fail-closed contract means it must still resolve
    // deterministically. The leaf override above only added GET/HEAD rules,
    // so a POST here falls through to the family's own mutate-tier rule
    // (`/api/environments/ssh`, already `orchestration:operate` for every
    // mutating method) rather than resolving to `undefined`.
    expect(requiredPairingScope('POST', '/api/environments/ssh/sessions')).toBe(
      'orchestration:operate',
    );
  });
});

describe('station#1398 slice 4: the fleet receipt leaves (security review, M-4)', () => {
  test('NO paired-device preset reads the fleet receipts — including the default one', () => {
    // The finding this test exists for. At the first cut's
    // `orchestration:operate`, `standard` (the DEFAULT pairing preset) and
    // `delegation` both passed, so an ordinary paired laptop could enumerate
    // which machines the owner has paired, what they contribute, and which
    // peers have been calling in — while being refused that same information
    // at its source, `/api/environments/peers` (`access:manage`). A leaf that
    // discloses what a higher gate protects makes the higher gate decorative.
    for (const path of [
      '/monitoring/fleet-routing-receipts',
      '/monitoring/fleet-serve-receipts',
    ]) {
      const required = requiredPairingScope('GET', path);
      expect(required).toBe('access:manage');
      for (const preset of [
        'read-only',
        'standard',
        'delegation',
        'inference',
      ] as const) {
        expect(
          pairingScopeIncludes(pairingScopePresetString(preset), required!),
        ).toBe(false);
      }
      // The default grant DOES reach it, and that is the correct answer
      // rather than an oversight: `DEFAULT_GRANT_PAIRING_SCOPE` carries
      // `access:manage` and covers unscoped offers, migrated pre-scoping
      // credentials, and the OPERATOR BOOTSTRAP credential — the owner's own
      // authority over their own machine. The tier's job is to keep fleet
      // topology away from delegated devices, not from the operator. Pinned
      // explicitly so the distinction is a decision on the record.
      expect(pairingScopeIncludes(DEFAULT_GRANT_PAIRING_SCOPE, required!)).toBe(
        true,
      );
    }
  });

  test('the receipt leaves sit ABOVE their family, and the family is unmoved', () => {
    // The override must be a leaf, not a family raise: everything else under
    // /monitoring is this Station talking about itself and stays readable at
    // the ordinary tier.
    expect(requiredPairingScope('GET', '/monitoring/stats')).toBe(
      'orchestration:read',
    );
    expect(requiredPairingScope('GET', '/monitoring/events')).toBe(
      'orchestration:read',
    );
    expect(
      requiredPairingScope('GET', '/monitoring/fleet-routing-receipts'),
    ).toBe('access:manage');
  });

  test('an inference-preset PEER cannot read the receipts about itself', () => {
    // The peers these records name are exactly the population that must not
    // read them: a contributing peer learning which other machines the owner
    // routes to is fleet-topology disclosure the design's §5.2 narrows.
    const scope = pairingScopePresetString('inference');
    for (const path of [
      '/monitoring/fleet-routing-receipts',
      '/monitoring/fleet-serve-receipts',
    ]) {
      const required = requiredPairingScope('GET', path);
      expect(required).toBeDefined();
      expect(pairingScopeIncludes(scope, required!)).toBe(false);
    }
  });
});

describe('station#1398 slice 2: the fleet inference family and the model-inventory override', () => {
  test('no credential that exists today reaches /api/inference without a grant minted for it', () => {
    // The decoupling's payoff, stated as an authorization fact rather than a
    // constant: the default grant (unscoped offers, migrated pre-scoping
    // credentials, the operator bootstrap credential) and every pre-#1398
    // preset are all refused. Only the `inference` preset passes.
    for (const scope of [
      DEFAULT_GRANT_PAIRING_SCOPE,
      pairingScopePresetString('read-only'),
      pairingScopePresetString('standard'),
      pairingScopePresetString('delegation'),
    ]) {
      expect(pairingScopeIncludes(scope, 'inference:invoke')).toBe(false);
    }
    expect(
      pairingScopeIncludes(
        pairingScopePresetString('inference'),
        'inference:invoke',
      ),
    ).toBe(true);
  });

  test('the inference preset buys the inference family and NOTHING else', () => {
    const scope = pairingScopePresetString('inference');
    const required = requiredPairingScope('GET', '/api/inference/manifest');
    expect(required).toBeDefined();
    expect(pairingScopeIncludes(scope, required!)).toBe(true);

    // Every other family this peer might try. Each resolves to a real scope
    // (never `undefined`, which would be a fail-closed bug signal), and the
    // inference-only grant satisfies none of them.
    for (const [method, path] of [
      ['GET', '/api/orchestration/sessions'],
      ['POST', '/api/orchestration/delegations'],
      ['POST', '/api/agents/example/chat'],
      ['GET', '/api/coding/files'],
      ['POST', '/api/pairing/offers'],
      ['GET', '/config/app'],
      ['PUT', '/config/app'],
    ] as const) {
      const scopeRequired = requiredPairingScope(method, path);
      expect(scopeRequired).toBeDefined();
      expect(pairingScopeIncludes(scope, scopeRequired!)).toBe(false);
    }
  });

  test('the ONE route the inference preset also buys is the model-inventory leaf, and it is the contributed subset', () => {
    // Called out because this test's title would otherwise be false: the
    // OQ-2 leaf override means an inference-preset grant DOES reach
    // `GET /api/connections/model-inventory`. That is deliberate and only
    // defensible because the payload was narrowed in the same change —
    // otherwise raising the tier would hand the full launchable enumeration
    // to exactly the peer class `model-not-contributed`'s refusal parity
    // keeps it from. The payload half is pinned in
    // `routes/connections/__tests__/connections.routes.test.ts`; this pins
    // that the reach is real and intentional rather than an oversight.
    const scope = pairingScopePresetString('inference');
    const required = requiredPairingScope(
      'GET',
      '/api/connections/model-inventory',
    );
    expect(required).toBe('inference:invoke');
    expect(pairingScopeIncludes(scope, required!)).toBe(true);

    // And it buys nothing else under `/api/connections` — the sibling
    // endpoints that DO enumerate every connection stay out of reach.
    for (const path of [
      '/api/connections',
      '/api/connections/models',
      '/api/connections/agents',
      '/api/connections/agents/catalog',
    ]) {
      const siblingScope = requiredPairingScope('GET', path);
      expect(siblingScope).toBe('orchestration:read');
      expect(pairingScopeIncludes(scope, siblingScope!)).toBe(false);
    }
  });

  test('OQ-2: the model-inventory leaf wins over the /api/connections family without disturbing its siblings', () => {
    expect(requiredPairingScope('GET', '/api/connections')).toBe(
      'orchestration:read',
    );
    expect(requiredPairingScope('GET', '/api/connections/models')).toBe(
      'orchestration:read',
    );
    expect(
      requiredPairingScope('GET', '/api/connections/model-inventory'),
    ).toBe('inference:invoke');
    // Same fail-closed discipline as the ssh/sessions override: the leaf
    // adds GET/HEAD only, so an unanticipated mutating method still resolves
    // to a real scope through the family rule rather than to `undefined`.
    expect(
      requiredPairingScope('POST', '/api/connections/model-inventory'),
    ).toBe('orchestration:operate');
  });
});

describe('pairing-route-scopes: WS upgrade paths', () => {
  test('terminal requires terminal:operate; voice requires orchestration:operate', () => {
    expect(PAIRING_WS_SCOPES.terminal).toBe('terminal:operate');
    expect(PAIRING_WS_SCOPES.voice).toBe('orchestration:operate');
  });

  test('every WS scope is a real member of the pairing-scope vocabulary', () => {
    // terminal:operate never appears as an HTTP route-table value (terminal
    // has no HTTP surface — see this file's module doc), so this checks
    // against PAIRING_SCOPES directly rather than the HTTP table's values.
    for (const scope of Object.values(PAIRING_WS_SCOPES)) {
      expect(PAIRING_SCOPES).toContain(scope);
    }
  });
});

/**
 * `credentialAuthorizedForScope` is the exact function both WebSocket
 * first-frame auth wrappers call — terminal's in
 * `runtime-service-bootstrap.ts` (`PAIRING_WS_SCOPES.terminal`) and voice's
 * in `runtime-initialize.ts` (`PAIRING_WS_SCOPES.voice`). Mirrored describe
 * blocks per station#1098 review round 1: terminal already had a
 * capture-based bootstrap test (`runtime-service-bootstrap.test.ts`); voice
 * had none. Both are exercised identically here against the same shared
 * function, so this closes that gap without depending on either runtime's
 * heavy cold-start wiring.
 */
describe.each([
  ['terminal', PAIRING_WS_SCOPES.terminal],
  ['voice', PAIRING_WS_SCOPES.voice],
] as const)(
  'credentialAuthorizedForScope: %s WebSocket gate',
  (_name, requiredScope) => {
    test('a read-only credential is denied', async () => {
      const resolver = {
        verifyCredential: vi.fn(async () => true),
        resolveGrantedScope: vi.fn(async () =>
          pairingScopePresetString('read-only'),
        ),
      };
      await expect(
        credentialAuthorizedForScope(resolver, requiredScope, 'device-1'),
      ).resolves.toBe(false);
    });

    test('a standard credential is allowed', async () => {
      const resolver = {
        verifyCredential: vi.fn(async () => true),
        resolveGrantedScope: vi.fn(async () =>
          pairingScopePresetString('standard'),
        ),
      };
      await expect(
        credentialAuthorizedForScope(resolver, requiredScope, 'device-1'),
      ).resolves.toBe(true);
    });

    test('the full-scope (operator) credential is allowed', async () => {
      const resolver = {
        verifyCredential: vi.fn(async () => true),
        resolveGrantedScope: vi.fn(async () => DEFAULT_GRANT_PAIRING_SCOPE),
      };
      await expect(
        credentialAuthorizedForScope(resolver, requiredScope, 'operator'),
      ).resolves.toBe(true);
    });

    test('an invalid credential is denied before resolveGrantedScope is ever called', async () => {
      const resolveGrantedScope = vi.fn(
        async () => DEFAULT_GRANT_PAIRING_SCOPE,
      );
      const resolver = {
        verifyCredential: vi.fn(async () => false),
        resolveGrantedScope,
      };
      await expect(
        credentialAuthorizedForScope(resolver, requiredScope, 'garbage'),
      ).resolves.toBe(false);
      expect(resolveGrantedScope).not.toHaveBeenCalled();
    });

    test('an unresolvable (undefined) scope is denied', async () => {
      const resolver = {
        verifyCredential: vi.fn(async () => true),
        resolveGrantedScope: vi.fn(async () => undefined),
      };
      await expect(
        credentialAuthorizedForScope(resolver, requiredScope, 'device-1'),
      ).resolves.toBe(false);
    });
  },
);
