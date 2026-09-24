import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A grant or content change can silently orphan an already-admitted plugin
 * command effect: the browser document still holds a "navigate" or
 * "seed-composer" receipt for authority that no longer exists. The three
 * `PluginCommandWithdrawalCause`s in
 * `@kontourai/station-contracts/plugin-command-effect`
 * (`removal` | `update` | `grant-withdrawal`) name exactly the changes that
 * must capture and withdraw any outstanding effect
 * (`withdrawPluginCommandEffects`, kontourai/station#1418, #1419).
 *
 * A hand-kept list of "the routes that need this" rots the same way
 * `reserved-plugin-identities.ts` used to: a new grant or content mutation
 * lands, nobody remembers the ledger exists, and the next withdrawal that
 * should have happened silently doesn't. So this derives the mutating
 * routes from the real route source, the way that file derives reserved
 * segments — never from a hand-typed path list.
 */

const ROUTES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const TRANSACTION_MODULE = join(
  ROUTES_DIR,
  '..',
  '..',
  'services',
  'plugins',
  'plugin-install-transaction.ts',
);

/**
 * Calls that mutate a plugin's permission grants or its installed content.
 * `grantPermissions`/`revokeGrants`/`revokeAllGrants`/
 * `createPluginGrantMutationScope` are the grant-mutation primitives;
 * `installPluginFromSource`, `uninstallInstalledPlugin` and
 * `recoverInstalledPlugin` are the content-mutation transaction entry
 * points. Any route whose body reaches one of these is a candidate that
 * must also reach a withdrawal capture.
 */
const MUTATION_MARKERS = [
  /\bgrantPermissions\(/,
  /\brevokeGrants\(/,
  /\brevokeAllGrants\(/,
  /\bcreatePluginGrantMutationScope\(/,
  /\binstallPluginFromSource\(/,
  /\buninstallInstalledPlugin\(/,
  /\brecoverInstalledPlugin\(/,
];

const CAPTURE_MARKER = /\bwithdrawPluginCommandEffects\(/;

/**
 * Transaction-module entry points a route may name INSTEAD of capturing
 * itself. Trusted only because the "the delegates this scan trusts" block
 * below independently proves each one's own body still reaches
 * `withdrawPluginCommandEffects` — a route naming one of these is not
 * taking capture on faith, and if that proof ever goes red, this list stops
 * being a laundering seam.
 */
const TRUSTED_DELEGATES = [
  /\binstallPluginFromSource\(/,
  /\buninstallInstalledPlugin\(/,
  /\brecoverInstalledPlugin\(/,
];

const ROUTE_REGISTRATION = /\bapp\.(?:get|post|put|patch|delete|all)\(/g;

interface RouteSlice {
  file: string;
  index: number;
  body: string;
}

/**
 * One slice per `app.<method>(` call in a routes/plugins file, from that
 * call to the start of the next one (or EOF). An approximation of "the
 * handler this registration installs" that needs no brace balancing: two
 * registrations never overlap, and everything a handler does textually sits
 * between its own registration and the next one.
 */
function routeSlices(): RouteSlice[] {
  const slices: RouteSlice[] = [];
  for (const entry of readdirSync(ROUTES_DIR)) {
    if (!entry.endsWith('.ts')) continue;
    const source = readFileSync(join(ROUTES_DIR, entry), 'utf8');
    const starts = [...source.matchAll(ROUTE_REGISTRATION)].map(
      (match) => match.index as number,
    );
    for (let i = 0; i < starts.length; i++) {
      const start = starts[i] as number;
      const end = starts[i + 1] ?? source.length;
      slices.push({
        file: entry,
        index: start,
        body: source.slice(start, end),
      });
    }
  }
  return slices;
}

/**
 * The body of a top-level (column-0) `function`/`export function`
 * declaration in `source`, from its own declaration to the next one (or
 * EOF). `plugin-install-transaction.ts` declares every function this way;
 * an arrow-function const (`export const installPluginFromSource = ...`)
 * is not itself one of these boundaries and falls inside whichever
 * declaration precedes it, which is never what this reads.
 */
function topLevelFunctionBody(source: string, name: string): string {
  const DECLARATION = /^(?:export )?(?:async )?function ([A-Za-z0-9_]+)/gm;
  const declarations = [...source.matchAll(DECLARATION)];
  const targetPos = declarations.findIndex((match) => match[1] === name);
  if (targetPos === -1)
    throw new Error(`function ${name} not found while deriving its body`);
  const start = declarations[targetPos]!.index as number;
  const end = declarations[targetPos + 1]?.index ?? source.length;
  return source.slice(start, end);
}

describe('plugin command effect withdrawal capture (kontourai/station#1419)', () => {
  it('reaches a withdrawal capture from every grant- or content-mutating route', () => {
    const slices = routeSlices();
    // Self-guard: a regex that stopped matching would compare an empty list
    // against nothing and report a clean sweep of nothing, the same failure
    // shape `reserved-plugin-identities.test.ts` guards against.
    expect(slices.length).toBeGreaterThanOrEqual(20);

    const mutating = slices.filter((slice) =>
      MUTATION_MARKERS.some((marker) => marker.test(slice.body)),
    );
    // Known mutating routes, named independently of the scan, so the
    // threshold and the arrayContaining check below cannot both pass by
    // finding nothing.
    expect(mutating.length).toBeGreaterThanOrEqual(5);
    expect(mutating.map((slice) => slice.file)).toEqual(
      expect.arrayContaining([
        'plugin-lifecycle-routes.ts', // update, remove
        'plugin-public-routes.ts', // grant, revoke
        'plugin-host-approval-routes.ts', // host-approval commit
        'plugin-install-routes.ts', // install, recover
      ]),
    );

    const uncaptured = mutating
      .filter(
        (slice) =>
          !CAPTURE_MARKER.test(slice.body) &&
          !TRUSTED_DELEGATES.some((marker) => marker.test(slice.body)),
      )
      .map((slice) => `${slice.file}:${slice.index}`);

    expect(uncaptured).toEqual([]);
  });

  describe('the delegates this scan trusts actually reach a withdrawal', () => {
    const source = readFileSync(TRANSACTION_MODULE, 'utf8');

    it('installPluginFromSourceUnderContext captures on replacement', () => {
      const body = topLevelFunctionBody(
        source,
        'installPluginFromSourceUnderContext',
      );
      expect(CAPTURE_MARKER.test(body)).toBe(true);
    });

    it('uninstallPluginUnderPublication captures on removal', () => {
      const body = topLevelFunctionBody(
        source,
        'uninstallPluginUnderPublication',
      );
      expect(CAPTURE_MARKER.test(body)).toBe(true);
    });

    it('recoverInstalledPlugin reaches installPluginFromSource, not a bypass', () => {
      const body = topLevelFunctionBody(source, 'recoverInstalledPlugin');
      expect(/\binstallPluginFromSource\(/.test(body)).toBe(true);
    });
  });
});
