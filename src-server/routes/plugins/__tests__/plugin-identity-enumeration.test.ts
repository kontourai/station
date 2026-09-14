/**
 * The enumeration gate (#2067).
 *
 * `GET /api/plugins` was projected first; a review found four more
 * enumerators; those were closed and the inventory written down; a second
 * review found five more plus the SSE relay. So this file drives EVERY route
 * in `PLUGIN_IDENTITY_ROUTES` as a non-operator and asserts each behaves the
 * way its declared disposition claims.
 *
 * ## Every driver is the REAL handler
 *
 * The previous version of this file built its own Hono app for the registry
 * rows and applied `operatorOnly` by hand, then marked those rows covered.
 * That proved the HELPER and never the route: an independent reviewer deleted
 * the guard from `GET /api/registry/plugins/installed` and this file stayed
 * green. Stand-in coverage is worse than no coverage, because the row reads
 * as checked.
 *
 * `DRIVERS` therefore contains only real route factories, and
 * `coverage.driver` records which one — the coverage assertion refuses any
 * row whose driver is not a real composition.
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
);

import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import type { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  registryOps: { add: vi.fn() },
  sseOps: { add: vi.fn() },
}));

vi.mock('../../../providers/registries/registry.js', () => {
  // The installed twins carry plugin identity; the fixture says so, so the
  // operator control below can prove the row is reachable at all.
  const installedRow = { id: 'a1', installedPluginName: 'secret-notes' };
  const agentProvider = {
    listAvailable: vi.fn().mockResolvedValue([]),
    listInstalled: vi.fn().mockResolvedValue([installedRow]),
    install: vi.fn().mockResolvedValue({ success: true }),
    uninstall: vi.fn().mockResolvedValue({ success: true }),
  };
  const integrationProvider = {
    listAvailable: vi.fn().mockResolvedValue([]),
    listInstalled: vi.fn().mockResolvedValue([installedRow]),
    install: vi.fn().mockResolvedValue({ success: true }),
    uninstall: vi.fn().mockResolvedValue({ success: true }),
    getToolDef: vi.fn().mockResolvedValue(null),
    sync: vi.fn().mockResolvedValue(undefined),
  };
  return {
    getSkillRegistryProviders: vi.fn().mockReturnValue([]),
    getAgentRegistryProvider: vi.fn().mockReturnValue(agentProvider),
    getIntegrationRegistryProvider: vi
      .fn()
      .mockReturnValue(integrationProvider),
    getPluginRegistryProviders: vi.fn().mockReturnValue([]),
    clearAll: vi.fn(),
  };
});

const { LOCAL_OPERATOR_PRINCIPAL_ID } = await import(
  '../../../services/identity/principal-resolver.js'
);
const { PluginVisibilityService } = await import(
  '../../../services/plugins/plugin-visibility-service.js'
);
const { PLUGIN_IDENTITY_ROUTES } = await import(
  '../plugin-identity-enumeration.js'
);
const { registerPluginInstallRoutes } = await import(
  '../plugin-install-routes.js'
);
const { registerPluginLifecycleRoutes } = await import(
  '../plugin-lifecycle-routes.js'
);
const { createRegistryRoutes } = await import('../registry.js');
const { Hono: HonoApp } = await import('hono');

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

const logger = {
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
} as any;

const COLLABORATOR: PrincipalRef = humanPrincipal(
  'device',
  'collaborator-device',
  'Collaborator',
);
const OPERATOR: PrincipalRef = {
  id: LOCAL_OPERATOR_PRINCIPAL_ID,
  kind: 'human',
  display: 'Operator',
};

const SECRET = 'secret-notes';

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-plugin-enumeration-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const pluginsDir = join(dir, 'plugins', SECRET);
  mkdirSync(pluginsDir, { recursive: true });
  writeFileSync(
    join(pluginsDir, 'plugin.json'),
    JSON.stringify({ name: SECRET, version: '1.0.0' }),
  );
  return dir;
}

/**
 * The caller under test. Every driver takes one, so the SAME mounted route
 * answers both a collaborator and the operator — the operator case is the
 * control that rules out a route which returns nothing for everybody.
 */
const visibilityFor = (dir: string, principal: PrincipalRef) => {
  const service = new PluginVisibilityService(dir);
  return {
    resolvePrincipal: () => principal,
    canSeePlugin: (_c: unknown, pluginId: string) =>
      service.canSee(principal, pluginId),
    project: () => (installed: readonly string[]) =>
      service.visiblePlugins(principal, installed),
  };
};

const pluginLayoutItem = () => ({
  installationReadiness: { state: 'ready' as const },
  source: 'plugin',
  plugin: SECRET,
  name: 'Secret layout',
  slug: 'secret-layout',
  type: 'coding',
  id: `plugin:${SECRET}:layout`,
  sourceIdentity: {
    id: SECRET,
    kind: 'local' as const,
    source: `plugins/${SECRET}`,
  },
  contribution: {
    id: `plugin:${SECRET}:layout`,
    version: '1.0.0',
    sourceIdentity: {
      id: SECRET,
      kind: 'local' as const,
      source: `plugins/${SECRET}`,
    },
    provenance: { origin: 'plugin' as const, pluginId: SECRET },
  },
  lifecycle: {
    itemId: `plugin:${SECRET}:layout`,
    state: 'installed' as const,
    source: SECRET,
  },
  visible: true,
  installable: false,
  enabled: true,
  policy: {},
  tabCount: 1,
});

function registryApp(dir: string, principal: PrincipalRef): Hono {
  const visibility = visibilityFor(dir, principal);
  const layoutCatalog = {
    listLayouts: () => [pluginLayoutItem()],
    listInstalledLayouts: () => [pluginLayoutItem()],
    listPluginWorkspacePaneContributions: () => [],
    resolveForCatalog: () => {
      throw new Error('not used');
    },
  };
  return FACTORY_SPIES.createRegistryRoutes(
    {
      getProjectHomeDir: () => dir,
      loadIntegration: vi.fn().mockRejectedValue(new Error('not found')),
      saveIntegration: vi.fn(),
      deleteIntegration: vi.fn().mockResolvedValue(undefined),
    } as never,
    vi.fn().mockResolvedValue(undefined),
    vi.fn().mockResolvedValue(undefined),
    undefined,
    {
      visibility: { resolvePrincipal: visibility.resolvePrincipal },
      canSeePlugin: visibility.canSeePlugin,
      layoutCatalog: layoutCatalog as never,
      logger,
    } as never,
  ) as Hono;
}

/**
 * Each inventory row's REAL handler. `driver` names the production
 * composition; a row whose driver is `'stand-in'` is refused by the coverage
 * assertion, because that is the shape that shipped a guard with no power.
 */
/**
 * The real factories, each wrapped in a spy so the coverage assertion can
 * check the mount CALLED it rather than that a field names it.
 *
 * The previous guard compared a `driver` value against a list — first a
 * string against a regex, then a function reference — and neither coupled
 * anything: a reviewer replaced the registry mount with a hand-rolled Hono
 * app, left all six `driver` entries untouched, and the file ran 12/12 green
 * including the row that certifies real compositions. A spy is the coupling:
 * if the mount stops calling the factory, the call count stays zero.
 */
const FACTORY_SPIES = {
  createRegistryRoutes: vi.fn(createRegistryRoutes),
  registerPluginInstallRoutes: vi.fn(registerPluginInstallRoutes),
  registerPluginLifecycleRoutes: vi.fn(registerPluginLifecycleRoutes),
} as const;

const DRIVERS: Record<
  string,
  {
    /**
     * The REAL route factory this row is driven through — the function
     * itself, not its name. A hand-written string matched against a regex
     * proved nothing: a probe swapped the registry mount for a hand-rolled
     * Hono app, kept the string, and stayed green. `mount` must use this
     * exact reference, so replacing the mount without replacing this fails
     * the identity check below.
     */
    driver: { mock: { calls: unknown[] } };
    mount: (
      dir: string,
      principal: PrincipalRef,
    ) => { app: Hono; path: string };
  }
> = {
  'GET /api/plugins': {
    driver: FACTORY_SPIES.registerPluginInstallRoutes,
    mount: (dir, principal) => {
      const app = new HonoApp();
      FACTORY_SPIES.registerPluginInstallRoutes(app, {
        pluginsDir: join(dir, 'plugins'),
        projectHomeDir: dir,
        agentsDir: join(dir, 'agents'),
        logger,
        projectVisiblePlugins: visibilityFor(dir, principal).project,
      });
      return { app, path: '/' };
    },
  },
  'GET /api/plugins/check-updates': {
    driver: FACTORY_SPIES.registerPluginLifecycleRoutes,
    mount: (dir, principal) => {
      const app = new HonoApp();
      FACTORY_SPIES.registerPluginLifecycleRoutes(app, {
        pluginsDir: join(dir, 'plugins'),
        projectHomeDir: dir,
        agentsDir: join(dir, 'agents'),
        logger,
        visibility: { resolvePrincipal: () => principal },
      } as never);
      return { app, path: '/check-updates' };
    },
  },
  'POST /api/plugins/reload': {
    driver: FACTORY_SPIES.registerPluginLifecycleRoutes,
    mount: (dir, principal) => {
      const app = new HonoApp();
      FACTORY_SPIES.registerPluginLifecycleRoutes(app, {
        pluginsDir: join(dir, 'plugins'),
        projectHomeDir: dir,
        agentsDir: join(dir, 'agents'),
        logger,
        visibility: { resolvePrincipal: () => principal },
      } as never);
      return { app, path: '/reload' };
    },
  },
  'GET /api/registry/plugins': {
    driver: FACTORY_SPIES.createRegistryRoutes,
    mount: (dir, principal) => ({
      app: registryApp(dir, principal),
      path: '/plugins',
    }),
  },
  'GET /api/registry/plugins/installed': {
    driver: FACTORY_SPIES.createRegistryRoutes,
    mount: (dir, principal) => ({
      app: registryApp(dir, principal),
      path: '/plugins/installed',
    }),
  },
  'GET /api/registry/agents/installed': {
    driver: FACTORY_SPIES.createRegistryRoutes,
    mount: (dir, principal) => ({
      app: registryApp(dir, principal),
      path: '/agents/installed',
    }),
  },
  'GET /api/registry/integrations/installed': {
    driver: FACTORY_SPIES.createRegistryRoutes,
    mount: (dir, principal) => ({
      app: registryApp(dir, principal),
      path: '/integrations/installed',
    }),
  },
  'GET /api/registry/layouts': {
    driver: FACTORY_SPIES.createRegistryRoutes,
    mount: (dir, principal) => ({
      app: registryApp(dir, principal),
      path: '/layouts',
    }),
  },
  'GET /api/registry/layouts/installed': {
    driver: FACTORY_SPIES.createRegistryRoutes,
    mount: (dir, principal) => ({
      app: registryApp(dir, principal),
      path: '/layouts/installed',
    }),
  },
};

const request = async (
  key: string,
  principal: PrincipalRef,
  dir: string,
): Promise<{ status: number; body: string; factoryCalls: number }> => {
  // The delta across THIS row's mount, not a cumulative count: another row
  // driving the same factory must not cover for a row that stopped.
  const before = DRIVERS[key]!.driver.mock.calls.length;
  const { app, path } = DRIVERS[key]!.mount(dir, principal);
  const factoryCalls = DRIVERS[key]!.driver.mock.calls.length - before;
  const method = key.startsWith('POST ') ? 'POST' : 'GET';
  const response = await app.request(path, { method });
  return { status: response.status, body: await response.text(), factoryCalls };
};

/**
 * Rows driven in another file, and the file that drives each. A citation is
 * a claim: `CITED_FILES` is asserted to exist below, because the previous
 * version of this list named a test file that was never written.
 */
const ELSEWHERE = new Map<string, string>([
  [
    'GET /api/projects/:slug/panes',
    'src-server/routes/projects/__tests__/pane-visibility.routes.test.ts',
  ],
  [
    'GET /api/projects/layouts/available',
    'src-server/routes/projects/__tests__/pane-visibility.routes.test.ts',
  ],
  [
    'GET /api/plugins/home-role',
    'src-server/routes/plugins/__tests__/plugin-home-role-routes.test.ts',
  ],
  [
    'GET /api/plugins/home-role/candidates',
    'src-server/routes/plugins/__tests__/plugin-home-role-routes.test.ts',
  ],
]);

describe('every route that returns plugin identity is projected or operator-only', () => {
  /** row -> how many times its own mount called its own real factory. */
  const covered = new Map<string, number>();

  const projected = PLUGIN_IDENTITY_ROUTES.filter(
    (route) => route.disposition === 'projected' && DRIVERS[routeKey(route)],
  );
  const operatorOnlyRows = PLUGIN_IDENTITY_ROUTES.filter(
    (route) =>
      route.disposition === 'operator-only' && DRIVERS[routeKey(route)],
  );

  test.each(projected.map((route) => [routeKey(route)] as const))(
    '%s answers a non-operator and names no ungranted plugin',
    async (key) => {
      const dir = home();
      const asCollaborator = await request(key, COLLABORATOR, dir);
      covered.set(key, asCollaborator.factoryCalls);
      expect(asCollaborator.status).toBe(200);
      // Whole-body, not field by field: this family's defect was a response
      // naming the plugin in a field nobody asserted on.
      expect(asCollaborator.body).not.toContain(SECRET);

      // The control. Same route, same fixture, operator calling.
      const asOperator = await request(key, OPERATOR, dir);
      expect(asOperator.status).toBe(200);
      expect(asOperator.body).toContain(SECRET);
    },
  );

  test.each(operatorOnlyRows.map((route) => [routeKey(route)] as const))(
    '%s refuses a non-operator outright',
    async (key) => {
      const dir = home();
      const asCollaborator = await request(key, COLLABORATOR, dir);
      covered.set(key, asCollaborator.factoryCalls);
      expect(asCollaborator.status).toBe(403);
      expect(asCollaborator.body).not.toContain(SECRET);

      // The control: the operator reaches the handler. A 403 everybody got
      // would be a broken route, not a refusal.
      const asOperator = await request(key, OPERATOR, dir);
      expect(asOperator.status).not.toBe(403);
    },
  );

  test('every inventory row is driven through a REAL composition', () => {
    const missing = PLUGIN_IDENTITY_ROUTES.map(routeKey).filter(
      (key) =>
        !covered.has(key) &&
        // Driven in their own files, against their real handlers, because
        // each needs machinery a Hono app alone cannot supply. Every path
        // named here must exist — the previous version cited
        // `projects-layout-visibility.test.ts`, which was never written, so
        // the row read as covered by a file that did not exist:
        //   GET /api/projects/:slug/panes
        //     src-server/routes/projects/__tests__/pane-visibility.routes.test.ts
        //     (the catalogue BUILDER has its own service test, but a service
        //      test is not a route driver and does not excuse this row)
        //   GET /api/projects/layouts/available
        //     src-server/routes/projects/__tests__/pane-visibility.routes.test.ts
        //   GET /api/plugins/home-role{,/candidates}
        //     src-server/routes/plugins/__tests__/plugin-home-role-routes.test.ts
        !ELSEWHERE.has(key),
    );
    expect(missing).toEqual([]);
    // A row is only covered if its mount actually CALLED the real factory.
    // Two earlier versions compared a `driver` field against a list and
    // coupled nothing; swapping the mount for a stand-in left them green.
    for (const [key, factoryCalls] of covered) {
      expect(
        factoryCalls,
        `${key}: its mount must call the real route factory, not a stand-in`,
      ).toBeGreaterThan(0);
    }
  });

  test('every "driven elsewhere" citation actually REQUESTS that route', () => {
    // Three versions of this check, because the first two were satisfied by
    // things that prove nothing. v1 asserted the cited file exists — any
    // unrelated file satisfies that, and the original citation named a file
    // that had never been written. v2 asserted the file MENTIONS the route
    // segment — and the very commit that added v2 deleted the only real
    // driver, leaving the word alive in a PROSE SENTENCE at the top of the
    // file. A comment is not a driver.
    //
    // v3 requires an actual `.request('…<segment>…')` call. Still a source
    // scan, and the limit is sharper than it looks: it proves a request to
    // that path is WRITTEN in the file, not that it executes or asserts
    // anything. A `describe.skip` or a commented-out call satisfies it, so a
    // driver parked for flakiness would leave the row undriven and reported
    // covered. What it does catch is the shape that got past v1 and v2 — a
    // citation whose request was deleted or never existed.
    for (const [key, file] of ELSEWHERE) {
      const path = join(REPO_ROOT, file);
      expect(
        existsSync(path),
        `${key} cites ${file}, which does not exist`,
      ).toBe(true);
      const source = readFileSync(path, 'utf8');
      const segment = key.split(' ')[1]!.split('/').pop()!;
      const requests = [
        ...source.matchAll(/\.request\(\s*[`'"]([^`'"]*)[`'"]/g),
      ].map((match) => match[1]!);
      expect(
        requests.some((requested) => requested.includes(segment)),
        `${key} cites ${file}, which never REQUESTS a path containing '${segment}' — a mention in prose is not a driver`,
      ).toBe(true);
    }
  });

  test('every row states a disposition and a reason for it', () => {
    for (const route of PLUGIN_IDENTITY_ROUTES) {
      expect(['projected', 'operator-only']).toContain(route.disposition);
      // Asserted against the shape of a sentence rather than a length
      // constant compared to its own literal: a rationale has to name a
      // reason, and a bare noun phrase does not.
      expect(route.rationale.trim()).toMatch(/\s\w+.*\./);
      expect(route.rationale.split(/\s+/).length).toBeGreaterThan(8);
    }
  });
});

function routeKey(route: { method: string; path: string }): string {
  return `${route.method} ${route.path}`;
}
