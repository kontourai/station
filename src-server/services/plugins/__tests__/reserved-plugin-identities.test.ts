import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertPluginIdentityAvailable,
  STATION_RESERVED_PLUGIN_IDENTITIES,
} from '../reserved-plugin-identities.js';

/**
 * `STATION_RESERVED_PLUGIN_IDENTITIES` names the plugin ids Station's own
 * routes already occupy at the `{plugin}` position under `/api/plugins` —
 * `/api/plugins/home-role/**` and friends, mounted at a LITERAL first segment
 * on the prefix a plugin's server module otherwise answers.
 *
 * A hand-kept list rots the moment someone adds a route, silently and in the
 * plugin's favour. So it is not kept by hand: this derives the real set from
 * the route registrations and fails in BOTH directions.
 *
 * This derivation moved here from
 * `plugin-api-surface-station-routes.test.ts` when the plugin frame's
 * `api-request` bridge was deleted (archive#4300). The bridge is what used to
 * consume the list; the COLLISION it describes is a property of the route
 * table and outlives it.
 */

const ROUTES_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'routes',
  'plugins',
);
const LITERAL_REGISTRATION =
  /\bapp\.(?:get|post|put|patch|delete|all)\(\s*'\/([a-z][a-z0-9-]*)(?:\/|')/g;

function declaredLiteralFirstSegments(): Map<string, string> {
  const found = new Map<string, string>();
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    // `registry.ts` lives in this directory but is mounted at `/api/registry`
    // (`runtime-routes.ts`), so its literal segments are not on the plugins
    // prefix and cannot collide with a plugin identity.
    if (entry === 'registry.ts') continue;
    const source = readFileSync(join(ROUTES_DIR, entry), 'utf8');
    for (const match of source.matchAll(LITERAL_REGISTRATION)) {
      const segment = match[1] as string;
      if (!found.has(segment)) found.set(segment, entry);
    }
  }
  return found;
}

describe('STATION_RESERVED_PLUGIN_IDENTITIES', () => {
  it('covers every literal first segment Station mounts on /api/plugins', () => {
    const declared = declaredLiteralFirstSegments();
    // The scan must actually find registrations; an empty map would let this
    // pass by finding nothing, which is the failure shape this file exists to
    // prevent.
    expect(declared.size).toBeGreaterThanOrEqual(2);
    expect([...declared.keys()]).toEqual(
      expect.arrayContaining(['home-role', 'host-approvals']),
    );

    const unreserved = [...declared.entries()].filter(
      ([segment]) => !STATION_RESERVED_PLUGIN_IDENTITIES.includes(segment),
    );
    expect(unreserved.map(([segment, file]) => `${segment} (${file})`)).toEqual(
      [],
    );
  });

  it('reserves no identity Station does not actually mount', () => {
    const declared = declaredLiteralFirstSegments();
    expect(
      STATION_RESERVED_PLUGIN_IDENTITIES.filter(
        (segment) => !declared.has(segment),
      ),
    ).toEqual([]);
  });

  it('has the seven entries the scan produces, named independently', () => {
    // Pinned by hand ON PURPOSE, and the reason is narrower than "the
    // derivations cannot see a removal" — verified by injection, the first
    // one CAN: it iterates the scanned segments and reports any the constant
    // fails to name.
    //
    // What neither derivation can do is notice the SCAN going quiet. Both
    // are stated relative to `declaredLiteralFirstSegments()`, and its only
    // self-guard is `size >= 2` plus two named segments — so a regex that
    // stopped matching four of the seven would leave both green against a
    // constant that had lost the same four. This assertion is the one fact
    // in the file that does not depend on the scan working.
    expect([...STATION_RESERVED_PLUGIN_IDENTITIES]).toEqual([
      'check-updates',
      'fetch',
      'home-role',
      'host-approvals',
      'install',
      'preview',
      'reload',
    ]);
  });
});

/**
 * Why an ALREADY-installed colliding plugin is left alone rather than disabled.
 *
 * Station's literal routes on `/api/plugins` and the plugin server-module
 * catch-all `/:name/*` both match `/api/plugins/home-role/requests`. Hono
 * dispatches in REGISTRATION order and a handler that returns a Response
 * without calling `next()` ends the chain — so which one answers is decided
 * entirely by the order of the `register*Routes` calls in `plugins.ts`.
 *
 * Today the catch-all is registered last, so Station's own route wins and a
 * colliding plugin is a BROKEN plugin (some of its own sub-paths shadowed),
 * not a hijack of an authority-bearing route. That is the whole basis for
 * refusing the name at install and touching nothing already on disk. It was
 * an unasserted property of six call sites in one function; this makes it a
 * derivation, so reordering them fails here instead of silently converting
 * every installed collision into an interception.
 */
describe('the plugin server-module catch-all is registered LAST', () => {
  const PLUGINS_ROUTER = join(ROUTES_DIR, 'plugins.ts');
  const CATCH_ALL = /\bapp\.all\(\s*'\/:name\/\*'/;

  /** `register…Routes` calls in `createPluginRoutes`, in source order. */
  function registrarCallOrder(): string[] {
    const source = readFileSync(PLUGINS_ROUTER, 'utf8');
    return [...source.matchAll(/\b(register\w*Routes)\(app,/g)].map(
      (match) => match[1] as string,
    );
  }

  /** Which file in this directory exports each registrar. */
  function registrarFiles(): Map<string, string> {
    const found = new Map<string, string>();
    for (const entry of readdirSync(ROUTES_DIR)) {
      if (!entry.endsWith('.ts') || entry === 'plugins.ts') continue;
      const source = readFileSync(join(ROUTES_DIR, entry), 'utf8');
      for (const match of source.matchAll(
        /\bexport function (register\w*Routes)\b/g,
      )) {
        found.set(match[1] as string, entry);
      }
    }
    return found;
  }

  it('is registered after every file mounting a reserved literal segment', () => {
    const order = registrarCallOrder();
    const files = registrarFiles();
    // Self-guard: a regex that stopped matching would compare empty lists and
    // report a clean sweep of nothing.
    expect(order.length).toBeGreaterThanOrEqual(5);
    expect([...files.keys()]).toEqual(expect.arrayContaining(order));

    const declared = declaredLiteralFirstSegments();
    const literalFiles = new Set(declared.values());
    expect(literalFiles.size).toBeGreaterThanOrEqual(2);

    const catchAllIndex = order.findIndex((registrar) => {
      const file = files.get(registrar);
      return Boolean(
        file && CATCH_ALL.test(readFileSync(join(ROUTES_DIR, file), 'utf8')),
      );
    });
    expect(
      catchAllIndex,
      "no registrar mounts app.all('/:name/*')",
    ).toBeGreaterThanOrEqual(0);

    const tooLate = order
      .map((registrar, index) => ({ registrar, index }))
      .filter(
        ({ registrar, index }) =>
          index > catchAllIndex &&
          literalFiles.has(files.get(registrar) as string),
      )
      .map(({ registrar }) => `${registrar} (${files.get(registrar)})`);

    expect(
      tooLate,
      "these mount a literal first segment AFTER the plugin catch-all, so an installed plugin with that id would answer Station's own route",
    ).toEqual([]);
  });
});

describe('assertPluginIdentityAvailable', () => {
  it('refuses every reserved identity, naming the prefix it cannot own', () => {
    for (const identity of STATION_RESERVED_PLUGIN_IDENTITIES) {
      expect(() => assertPluginIdentityAvailable(identity), identity).toThrow(
        `Plugin name '${identity}' is reserved`,
      );
    }
  });

  it('admits an ordinary plugin identity, including a near miss', () => {
    for (const identity of [
      'demo',
      'home-roles',
      'home-role-viewer',
      'installer',
      'fetcher',
    ]) {
      expect(
        () => assertPluginIdentityAvailable(identity),
        identity,
      ).not.toThrow();
    }
  });
});
