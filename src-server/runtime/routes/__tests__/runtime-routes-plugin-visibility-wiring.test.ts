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
 * runtime. So the first half is a SOURCE assertion — scoped to the factory's
 * own balanced argument list rather than to the file, and with comments and
 * string literals blanked, so a `canSeePlugin` that is commented out, inside
 * a string, in a different call, or in an unrelated object does not satisfy
 * it. The comment case is not hypothetical: the first version of this file
 * claimed it and did not do it, and a commented-out mount passed.
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
 * One factory call's own argument list, with every comment and string
 * literal BLANKED to spaces.
 *
 * Both halves matter and the first version had only one. It counted parens
 * without knowing about comments or strings, and claimed in this docblock
 * that a mention in a comment would not satisfy the assertion — it would:
 * replacing the mount lines with commented-out copies left the whole file
 * green while production composed with no projection at all. The paren
 * counting is the same state machine
 * `scripts/plugin-identity-enumeration-scan.mjs`'s `handlerBody` uses (that
 * one is not exported, so it is reproduced here rather than duplicated by
 * accident), and blanking rather than deleting keeps every offset stable so
 * a reported position still means something.
 */
function factoryCallArguments(source: string, callee: string): string {
  const start = source.indexOf(`${callee}(`);
  if (start === -1) throw new Error(`${callee} is not called in the mount`);
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let comment: 'line' | 'block' | null = null;
  for (let i = start + callee.length; i < source.length; i += 1) {
    const ch = source[i] as string;
    const next = source[i + 1];
    const keep = (value: string) => {
      if (depth > 0) out.push(value);
    };
    if (comment === 'line') {
      keep(ch === '\n' ? '\n' : ' ');
      if (ch === '\n') comment = null;
      continue;
    }
    if (comment === 'block') {
      keep(ch === '\n' ? '\n' : ' ');
      if (ch === '*' && next === '/') {
        keep(' ');
        comment = null;
        i += 1;
      }
      continue;
    }
    if (quote) {
      keep(' ');
      if (ch === '\\') {
        keep(' ');
        i += 1;
        continue;
      }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '/' && next === '/') {
      keep('  ');
      comment = 'line';
      i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      keep('  ');
      comment = 'block';
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      keep(' ');
      quote = ch;
      continue;
    }
    if (ch === '(') {
      depth += 1;
      if (depth > 1) out.push(ch);
      continue;
    }
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) return out.join('');
      out.push(ch);
      continue;
    }
    keep(ch);
  }
  throw new Error(`${callee}'s argument list is unbalanced`);
}

/** The dependency key, read out of the mount rather than restated here. */
function mountedVisibilityKey(callee: string): string {
  const args = factoryCallArguments(
    readFileSync(RUNTIME_ROUTES, 'utf8'),
    callee,
  );
  const match = args.match(/(?<!\w)(canSeePlugin)\s*:/);
  if (!match) {
    throw new Error(
      `${callee} is mounted WITHOUT a plugin-visibility dependency. ` +
        'Every layout answer this composition gives is then unprojected.',
    );
  }
  return match[1] as string;
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
