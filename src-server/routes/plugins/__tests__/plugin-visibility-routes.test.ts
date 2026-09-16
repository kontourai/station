/**
 * Per-principal plugin visibility over the REAL routes (#2067).
 *
 * Every test here drives a registered Hono handler with an HTTP request, not
 * a service method: the questions at stake — does the instance's plugin list
 * reach a collaborator, and can a caller name themselves the operator — are
 * questions about the route composition, and a service-level test would
 * answer neither.
 *
 * The one thing that is stubbed is `resolvePrincipal`, because the real one
 * reads a verified authority fact minted at the auth boundary
 * (`services/identity/principal-resolver.ts`) that no in-process request can
 * carry. Stubbing it is what lets a test STATE who is calling; everything
 * downstream of that statement — the grant record, the projection, the
 * operator check, the filter on `GET /` — is the production code.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  humanPrincipal,
  type PrincipalRef,
} from '@kontourai/station-contracts/principal';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  LOCAL_OPERATOR_PRINCIPAL_ID,
  PrincipalUnresolvedError,
} from '../../../services/identity/principal-resolver.js';
import { PluginVisibilityService } from '../../../services/plugins/plugin-visibility-service.js';
import { registerPluginInstallRoutes } from '../plugin-install-routes.js';
import { registerPluginVisibilityRoutes } from '../plugin-visibility-routes.js';
import { TEST_OPERATOR_PRINCIPAL } from './plugin-visibility-test-support.js';

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

/** A collaborator: a real device principal, exactly as pairing mints one. */
const COLLABORATOR: PrincipalRef = humanPrincipal(
  'device',
  'collaborator-device',
  'Collaborator',
);

function home(): string {
  const dir = mkdtempSync(join(tmpdir(), 'station-plugin-visibility-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** Two plugins installed instance-wide, as `GET /api/plugins` observes them. */
function installPlugins(projectHomeDir: string, names: string[]): string {
  const pluginsDir = join(projectHomeDir, 'plugins');
  for (const name of names) {
    mkdirSync(join(pluginsDir, name), { recursive: true });
    writeFileSync(
      join(pluginsDir, name, 'plugin.json'),
      JSON.stringify({ name, version: '1.0.0' }),
    );
  }
  return pluginsDir;
}

/**
 * The real `GET /api/plugins` composition, with the caller stated. The
 * projection is the production one — a `PluginVisibilityService` over this
 * test's own home — so a grant written through the route below is the same
 * fact this list reads.
 */
function listRoutes(
  projectHomeDir: string,
  service: PluginVisibilityService,
  caller: () => PrincipalRef,
) {
  const app = new Hono();
  registerPluginInstallRoutes(app, {
    pluginsDir: join(projectHomeDir, 'plugins'),
    projectHomeDir,
    agentsDir: join(projectHomeDir, 'agents'),
    logger,
    projectVisiblePlugins: () => {
      const principal = caller();
      return (installed) => service.visiblePlugins(principal, installed);
    },
  });
  return app;
}

function visibilityRoutes(
  service: PluginVisibilityService,
  caller: () => PrincipalRef,
  known: Array<{ id: string; display: string; revoked: boolean }> = [],
) {
  const app = new Hono();
  registerPluginVisibilityRoutes(app, {
    service,
    resolvePrincipal: () => caller(),
    listKnownPrincipals: () => known,
  });
  return app;
}

const grantBody = (principalId: string, plugin: string) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ principalId, plugin }),
});

describe('the first-member journey does not enumerate the instance plugin list', () => {
  test('a collaborator gets an empty list where the operator gets every installed plugin', async () => {
    const dir = home();
    installPlugins(dir, ['notes', 'timers']);
    const service = new PluginVisibilityService(dir);

    const operatorList = (await (
      await listRoutes(dir, service, () => TEST_OPERATOR_PRINCIPAL).request('/')
    ).json()) as { plugins: Array<{ name: string }> };
    expect(operatorList.plugins.map((plugin) => plugin.name).sort()).toEqual([
      'notes',
      'timers',
    ]);

    const collaboratorResponse = await listRoutes(
      dir,
      service,
      () => COLLABORATOR,
    ).request('/');
    expect(collaboratorResponse.status).toBe(200);
    // Absence, not a `visible: false` flag: the projection IS the derivation,
    // so a plugin this person cannot see leaves no trace on the wire for a
    // client to re-derive an inventory from.
    expect(await collaboratorResponse.json()).toEqual({ plugins: [] });
  });

  test('a granted plugin, and only that one, reaches the collaborator', async () => {
    const dir = home();
    installPlugins(dir, ['notes', 'timers']);
    const service = new PluginVisibilityService(dir);
    await service.grant(COLLABORATOR.id, 'notes');

    const listed = (await (
      await listRoutes(dir, service, () => COLLABORATOR).request('/')
    ).json()) as { plugins: Array<{ name: string }> };
    expect(listed.plugins.map((plugin) => plugin.name)).toEqual(['notes']);
  });

  test('a caller this instance cannot attribute is refused before the scan, not after it', async () => {
    const dir = home();
    installPlugins(dir, ['notes']);
    const service = new PluginVisibilityService(dir);
    // The ordering matters, not just the status. Resolving the caller after
    // the enumeration means an unattributable request pays a full inventory
    // scan and a per-plugin Git observation before being told no. The journal
    // read is the first thing the scan does, so never touching it is the
    // observable proof the refusal came first.
    const selectedInstallations = vi.fn(() => ({ state: 'unavailable' }));
    const app = new Hono();
    registerPluginInstallRoutes(app, {
      pluginsDir: join(dir, 'plugins'),
      projectHomeDir: dir,
      agentsDir: join(dir, 'agents'),
      logger,
      packageMcpJournal: { selectedInstallations } as never,
      projectVisiblePlugins: () => {
        throw new PrincipalUnresolvedError('no authority fact');
      },
    });
    const response = await app.request('/');
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false });
    expect(selectedInstallations).not.toHaveBeenCalled();

    // The control: a caller who DOES resolve reaches the scan, so the
    // assertion above is about ordering rather than about a route that never
    // scans at all.
    const reaching = new Hono();
    registerPluginInstallRoutes(reaching, {
      pluginsDir: join(dir, 'plugins'),
      projectHomeDir: dir,
      agentsDir: join(dir, 'agents'),
      logger,
      packageMcpJournal: { selectedInstallations } as never,
      projectVisiblePlugins: () => (installed) =>
        service.visiblePlugins(TEST_OPERATOR_PRINCIPAL, installed),
    });
    await reaching.request('/');
    expect(selectedInstallations).toHaveBeenCalled();
  });

  test('a grant naming an uninstalled plugin shows the collaborator nothing', async () => {
    const dir = home();
    installPlugins(dir, ['notes']);
    const service = new PluginVisibilityService(dir);
    await service.grant(COLLABORATOR.id, 'timers');
    const listed = (await (
      await listRoutes(dir, service, () => COLLABORATOR).request('/')
    ).json()) as { plugins: unknown[] };
    expect(listed.plugins).toEqual([]);
  });
});

describe('the grant surface is the operator, resolved from the request', () => {
  test('a collaborator cannot grant themselves sight of a plugin', async () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    const response = await visibilityRoutes(
      service,
      () => COLLABORATOR,
    ).request('/visibility/grants', grantBody(COLLABORATOR.id, 'notes'));
    expect(response.status).toBe(403);
    // The refusal has to be the RECORD's, not just the response's: a 403 that
    // still wrote the grant would leave the collaborator visible on the next
    // request from a route that never re-checks.
    expect(service.read().grants[COLLABORATOR.id]).toBeUndefined();
    expect(service.canSee(COLLABORATOR, 'notes')).toBe(false);
  });

  test('a body-supplied operator id does not make the caller the operator', async () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    // The body names the operator as the TARGET while the caller is a
    // collaborator. If the route ever read authority out of the body, this is
    // the request that would pass.
    const response = await visibilityRoutes(
      service,
      () => COLLABORATOR,
    ).request(
      '/visibility/grants',
      grantBody(LOCAL_OPERATOR_PRINCIPAL_ID, 'notes'),
    );
    expect(response.status).toBe(403);
    expect(service.read().grants).toEqual({});
  });

  test('the operator grants and revokes, and the record follows', async () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    const app = visibilityRoutes(service, () => TEST_OPERATOR_PRINCIPAL);

    const granted = await app.request(
      '/visibility/grants',
      grantBody(COLLABORATOR.id, 'notes'),
    );
    expect(granted.status).toBe(200);
    expect(await granted.json()).toEqual({
      success: true,
      data: { principalId: COLLABORATOR.id, plugins: ['notes'] },
    });
    expect(service.canSee(COLLABORATOR, 'notes')).toBe(true);

    const revoked = await app.request('/visibility/grants', {
      ...grantBody(COLLABORATOR.id, 'notes'),
      method: 'DELETE',
    });
    expect(revoked.status).toBe(200);
    expect(service.canSee(COLLABORATOR, 'notes')).toBe(false);
    // An emptied principal leaves the record rather than lingering as an
    // empty array a reader could mistake for a different state.
    expect(service.read().grants).toEqual({});
  });

  test('a grant that could never name a principal or a plugin is refused', async () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    const app = visibilityRoutes(service, () => TEST_OPERATOR_PRINCIPAL);
    for (const [principalId, plugin] of [
      ['not-a-principal-id', 'notes'],
      [COLLABORATOR.id, 'Not A Plugin Name'],
    ]) {
      const response = await app.request(
        '/visibility/grants',
        grantBody(principalId!, plugin!),
      );
      expect(response.status).toBe(400);
    }
    expect(service.read().grants).toEqual({});
  });

  test('the directory the operator picks from is the pairing registry plus the operator row', async () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    await service.grant(COLLABORATOR.id, 'notes');
    const response = await visibilityRoutes(
      service,
      () => TEST_OPERATOR_PRINCIPAL,
      [
        { id: COLLABORATOR.id, display: 'Collaborator', revoked: false },
        // A registry that also reports the operator must not produce two rows.
        {
          id: LOCAL_OPERATOR_PRINCIPAL_ID,
          display: 'Somebody else',
          revoked: true,
        },
      ],
    ).request('/visibility');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: {
        principals: Array<{
          id: string;
          plugins: string[];
          operator: boolean;
        }>;
      };
    };
    expect(body.data.principals).toEqual([
      {
        id: LOCAL_OPERATOR_PRINCIPAL_ID,
        display: 'Operator',
        revoked: false,
        plugins: [],
        operator: true,
      },
      {
        id: COLLABORATOR.id,
        display: 'Collaborator',
        revoked: false,
        plugins: ['notes'],
        operator: false,
      },
    ]);
  });

  test('a collaborator cannot read the directory of who this instance knows', async () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    const response = await visibilityRoutes(service, () => COLLABORATOR, [
      { id: COLLABORATOR.id, display: 'Collaborator', revoked: false },
    ]).request('/visibility');
    expect(response.status).toBe(403);
  });
});

/**
 * The record is on disk in the Station home. Its docblock claims every entry
 * is re-validated on READ so a hand-edited or partially-written file cannot
 * widen a projection — a claim nothing exercised until these tests, which an
 * independent reviewer proved by deleting the guard and watching 461 tests
 * stay green.
 */
describe('a hand-edited record cannot widen a projection', () => {
  const writeRecord = (dir: string, record: unknown) => {
    const path = new PluginVisibilityService(dir).recordPath;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(record));
    return path;
  };

  test('an entry whose key could never name a principal grants nothing', () => {
    const dir = home();
    writeRecord(dir, {
      version: 1,
      grants: {
        // Not a principal id: no kind prefix, so nothing can ever resolve to
        // it, and an entry keyed on it must not become somebody's grant.
        'notes-for-everyone': ['notes'],
        '*': ['notes'],
        'human:': ['notes'],
        'tenant:acme': ['notes'],
      },
    });
    const service = new PluginVisibilityService(dir);
    expect(service.read().grants).toEqual({});
    expect(service.canSee(COLLABORATOR, 'notes')).toBe(false);
    expect(service.visiblePlugins(COLLABORATOR, ['notes'])).toEqual([]);
  });

  test('a plugin name the grammar refuses is dropped from a real entry', () => {
    const dir = home();
    writeRecord(dir, {
      version: 1,
      grants: {
        [COLLABORATOR.id]: ['notes', '../../etc/passwd', 'NOT-CANONICAL', 42],
      },
    });
    const service = new PluginVisibilityService(dir);
    expect(service.read().grants[COLLABORATOR.id]).toEqual(['notes']);
    expect(service.canSee(COLLABORATOR, '../../etc/passwd')).toBe(false);
  });

  test('a record larger than the bound refuses rather than being read', () => {
    const dir = home();
    writeRecord(dir, {
      version: 1,
      grants: {
        [COLLABORATOR.id]: ['notes'],
        filler: Array.from({ length: 40_000 }, (_, index) => `p${index}`),
      },
    });
    const service = new PluginVisibilityService(dir);
    // REFUSES, and deliberately does not degrade to an empty record. An empty
    // record is a legitimate state meaning "nobody has been granted anything",
    // so silently substituting it for "this file could not be read" would
    // erase an operator's real grants with no signal — a quieter lie than the
    // error. Every caller below turns the refusal into its own fail-closed
    // answer; none of them turns it into visibility.
    expect(() => service.read()).toThrow(/byte limit/);
    expect(() => service.canSee(COLLABORATOR, 'notes')).toThrow();
  });

  test('a truncated, unparseable record refuses rather than being read', () => {
    const dir = home();
    const path = new PluginVisibilityService(dir).recordPath;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"version":1,"grants":{"human:device:x":["not');
    const service = new PluginVisibilityService(dir);
    expect(() => service.read()).toThrow(SyntaxError);
  });

  test('an absent record is the one fallback: nobody is granted anything', () => {
    // The ONLY case that reads as an empty record, because it genuinely is
    // one — a Station where no grant has ever been made.
    const service = new PluginVisibilityService(home());
    expect(service.read().grants).toEqual({});
    expect(service.canSee(COLLABORATOR, 'notes')).toBe(false);
    expect(service.canSee(TEST_OPERATOR_PRINCIPAL, 'notes')).toBe(true);
  });

  test('a later honest grant repairs the file rather than inheriting its rubbish', async () => {
    const dir = home();
    writeRecord(dir, {
      version: 1,
      grants: { 'not-a-principal': ['notes'], [COLLABORATOR.id]: ['BAD NAME'] },
    });
    const service = new PluginVisibilityService(dir);
    await service.grant(COLLABORATOR.id, 'notes');
    expect(service.read().grants).toEqual({ [COLLABORATOR.id]: ['notes'] });
  });
});

describe('the projection is an intersection with what is installed', () => {
  test('a grant for an uninstalled plugin contributes nothing', () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    return service.grant(COLLABORATOR.id, 'timers').then(() => {
      // The derivation the list route applies. A pointwise predicate would
      // answer `true` for 'timers' here; the intersection is what makes a
      // stale grant inert rather than merely unused.
      expect(service.visiblePlugins(COLLABORATOR, ['notes'])).toEqual([]);
      expect(service.visiblePlugins(COLLABORATOR, ['notes', 'timers'])).toEqual(
        ['timers'],
      );
      // The operator's projection is the installed list itself, in order.
      expect(
        service.visiblePlugins(TEST_OPERATOR_PRINCIPAL, ['timers', 'notes']),
      ).toEqual(['timers', 'notes']);
    });
  });
});

describe('concurrent grants', () => {
  test('eight grants issued together all survive', async () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    const plugins = ['a1', 'b2', 'c3', 'd4', 'e5', 'f6', 'g7', 'h8'];
    // Issued without awaiting each other: every one reads the record, adds a
    // name and writes it back. Outside the store's per-path mutation lock
    // they would all read the same empty base and the last write would be the
    // only survivor. Inside it, each sees its predecessor's write.
    await Promise.all(
      plugins.map((plugin) => service.grant(COLLABORATOR.id, plugin)),
    );
    expect(service.read().grants[COLLABORATOR.id]).toEqual([...plugins].sort());
  });

  test('concurrent grants to different principals do not lose each other', async () => {
    const dir = home();
    const service = new PluginVisibilityService(dir);
    const other = humanPrincipal('device', 'second-device', 'Second');
    await Promise.all([
      service.grant(COLLABORATOR.id, 'notes'),
      service.grant(other.id, 'timers'),
    ]);
    expect(service.read().grants).toEqual({
      [COLLABORATOR.id]: ['notes'],
      [other.id]: ['timers'],
    });
  });
});
