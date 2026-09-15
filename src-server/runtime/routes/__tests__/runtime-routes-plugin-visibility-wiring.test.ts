/**
 * The MOUNT seam for per-principal plugin visibility (#2067/#2090/#2103).
 *
 * ## Why this file exists
 *
 * Every other test in this family composes a route factory directly and
 * passes `canSeePlugin` itself. That proves the handlers, and it proves them
 * well — deleting the dependency inside `projects.ts` reds eight tests across
 * two files. It proves nothing about the line that supplies it in
 * production. Deleting BOTH `canSeePlugin: canSeePluginForRequest` lines from
 * `runtime-routes.ts` left all three suites green: on the project mount that
 * is not an under-report, it is a LEAK — the sight resolver returns
 * undefined, the withheld predicate returns false unconditionally, and the
 * whole #2103 closure (live merge, catalog backfill, `config.plugin`, the
 * list, apply, from-plugin) switches off at once. A one-line deletion in a
 * file nothing tests reverting a security change, with every gate green, is
 * the exact shape this repository keeps finding.
 *
 * ## What it checks, and the two halves that make it not vacuous
 *
 * `runtime-routes.ts` cannot be imported and driven here: it builds the whole
 * runtime. So the first half is a SOURCE assertion — but over the mount's
 * SYNTAX TREE, not its text, so a `canSeePlugin` that is commented out,
 * inside a string, in a decoy call, or in an unrelated object cannot satisfy
 * it. Three earlier versions of this file were text scans and all three
 * claimed that property without having it; `mountedVisibilityKey` records
 * what each one let through.
 *
 * A source assertion alone is satisfied by a string, so the second half
 * takes the property name the scan just found in the source and BUILDS each
 * real route factory with a dependency under that exact key, then asserts the
 * projection takes effect. That couples the two ends: delete the line in
 * `runtime-routes.ts` and the scan reds; rename the dependency in
 * `projects.ts` or `personal-layouts.ts` and the behavioural half reds,
 * because the key the mount passes no longer wires to anything.
 *
 * Reading this file as text is the same mechanism
 * `scripts/__tests__/path-read-pin-boundary.test.ts` already uses for it.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { humanPrincipal } from '@kontourai/station-contracts/principal';
import ts from 'typescript';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  projectOps: { add: vi.fn() },
  projectPaneCatalogDuration: { record: vi.fn() },
  projectResolutionRouteRequests: { add: vi.fn() },
  projectBindingOperations: { add: vi.fn() },
  workspacePaneAvailabilityResolutions: { add: vi.fn() },
}));

const { createProjectRoutes } = await import(
  '../../../routes/projects/projects.js'
);
const { createPersonalLayoutRoutes } = await import(
  '../../../routes/me/personal-layouts.js'
);
const { FileStorageAdapter } = await import(
  '../../../domain/file-storage-adapter.js'
);
const { ProjectService } = await import(
  '../../../services/projects/project-service.js'
);
const { ownedLayoutStore } = await import(
  '../../../services/layouts/personal-layout-service.js'
);

const RUNTIME_ROUTES = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'runtime-routes.ts',
);

const NOW = '2026-01-01T00:00:00.000Z';
const PLUGIN = 'secret-notes';
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

/**
 * The dependency key each real call to `callee` supplies, read from the
 * mount's own syntax tree.
 *
 * ## Why a parser and not a scan
 *
 * Two earlier versions of this file were hand-rolled text scans and both
 * claimed a property they did not have. The first counted parens with no
 * comment awareness, so a commented-out mount passed. The second blanked
 * comments and strings in the BODY but anchored with a raw `indexOf`, so a
 * commented-out call — or a docblock above the mount describing its shape,
 * which is an ordinary thing to write — became the match and the real mount
 * was never read; the behavioural half did not save it, because it then
 * built its dependencies under the key it had found in the comment.
 *
 * A third version blanked comments and strings before anchoring too, and the
 * docblock decoy STILL passed: a hand-rolled JavaScript tokenizer has to
 * know about regular-expression literals to stay in sync across three
 * thousand lines, and mine did not. Rather than keep repairing a tokenizer,
 * this asks the compiler. Comments are not nodes, a string is a
 * `StringLiteral` and never a `CallExpression`, and "which properties does
 * this call's object argument declare" has an exact answer. `typescript` is
 * already a test-time dependency for source assertions of this shape
 * (`pairing-route-leaf-scan.ts`, `tool-policy-delivery-tripwire.test.ts`).
 *
 * EVERY real call must supply the key, not merely one of them: two mounts of
 * the same factory where only one is projected is exactly the composition
 * this exists to refuse.
 */
function mountedVisibilityKey(callee: string): string {
  const source = ts.createSourceFile(
    RUNTIME_ROUTES,
    readFileSync(RUNTIME_ROUTES, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const calls: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === callee
    ) {
      calls.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (calls.length === 0) {
    throw new Error(
      `${callee} is not CALLED in the mount — a mention in a comment or a ` +
        'string is not a call.',
    );
  }

  for (const call of calls) {
    const declared = new Set<string>();
    let spread = false;
    for (const argument of call.arguments) {
      if (!ts.isObjectLiteralExpression(argument)) continue;
      for (const property of argument.properties) {
        if (ts.isSpreadAssignment(property)) {
          spread = true;
          continue;
        }
        const name = property.name;
        if (name && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
          declared.add(name.text);
        }
      }
    }
    if (declared.has('canSeePlugin')) continue;
    // Fails in the SAFE direction and says so rather than tolerating it: a
    // dependency object assembled elsewhere and spread in is invisible to
    // this check, so it refuses instead of guessing.
    throw new Error(
      `${callee} is mounted WITHOUT a plugin-visibility dependency` +
        (spread ? ' that this check can see (it arrives by spread)' : '') +
        '. Every layout answer this composition gives is then unprojected.',
    );
  }
  return 'canSeePlugin';
}

describe('the runtime mount supplies plugin visibility to both layout families', () => {
  test('the project routes are mounted with it, and the key it passes wires', async () => {
    const key = mountedVisibilityKey('createProjectRoutes');

    const home = mkdtempSync(join(tmpdir(), 'station-visibility-wiring-'));
    tempDirs.push(home);
    const storage = new FileStorageAdapter(home);
    await storage.createProject({
      id: 'project-1',
      slug: 'demo',
      name: 'Demo',
      createdAt: NOW,
      updatedAt: NOW,
    });
    // Built under the key the MOUNT passes, not under a key this file spells.
    const deps: Record<string, unknown> = {
      listAgents: async () => [],
      [key]: () => false,
    };
    const app = createProjectRoutes(
      new ProjectService(storage) as never,
      storage as never,
      home,
      deps as never,
    );
    await app.request('/demo/layouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'bound',
        name: 'Bound',
        config: { plugin: PLUGIN, tabs: [{ id: 'a', label: 'A' }] },
      }),
    });
    const body = await json<{ data: Record<string, any> }>(
      await app.request('/demo/layouts/bound'),
    );
    expect(body.data.config.plugin).toBeUndefined();
    expect(body.data.paneReferences).toEqual({ unavailableTabIds: ['a'] });
  });

  test('the Board routes are mounted with it, and the key it passes wires', async () => {
    const key = mountedVisibilityKey('createPersonalLayoutRoutes');

    const home = mkdtempSync(join(tmpdir(), 'station-visibility-wiring-me-'));
    tempDirs.push(home);
    const storage = new FileStorageAdapter(home);
    const deps: Record<string, unknown> = {
      resolvePrincipal: () => humanPrincipal('device', 'd1', 'Someone'),
      listAgents: async () => [],
      now: () => NOW,
      newId: () => 'board-1',
      [key]: () => false,
    };
    const app = createPersonalLayoutRoutes(
      ownedLayoutStore(storage),
      deps as never,
    );
    await app.request('/layouts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        slug: 'bound',
        name: 'Bound',
        config: { plugin: PLUGIN, tabs: [{ id: 'a', label: 'A' }] },
      }),
    });
    const body = await json<{ data: Record<string, any> }>(
      await app.request('/layouts/bound'),
    );
    expect(body.data.paneReferences).toEqual({ unavailableTabIds: ['a'] });
  });
});
