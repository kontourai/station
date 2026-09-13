/**
 * #1655 — the writability decision, projected onto the read models, through
 * the ROUTE and a REAL `SkillService`.
 *
 * The sibling suite in this directory mocks the service, which is the right
 * shape for asserting what the route does with an answer; it cannot say
 * anything about whether the answer is computed. These cases drive
 * `GET /`, `GET /:name` and `PUT /:name` against a real service over a real
 * temp home, so the projection and the ENFORCEMENT are read from the same
 * fixture set — the whole point being that a client must no longer offer a Save
 * the route will refuse.
 *
 * Every fixture is one where the projected fact and the fields a client would
 * be tempted to guess from DISAGREE. A fixture where `source`/`origin` and
 * writability coincide proves nothing at all: it passes under the projection
 * and under the `source === 'local'` derivation the projection replaces.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';
import type { ConfigLoader } from '../../../domain/config-loader.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  skillDiscoveries: { add: vi.fn() },
  skillActivations: { add: vi.fn() },
  skillActivationDuration: { record: vi.fn() },
  skillDiscoveryDuration: { record: vi.fn() },
  skillOps: { add: vi.fn() },
  canonicalSkillsDiscovered: { add: vi.fn() },
}));

const { SkillService } = await import(
  '../../../services/agents/skill-service.js'
);
const { createSkillRoutes } = await import('../skills.js');

let home: string;

/** A skill package on disk: `SKILL.md`, plus the install record when given. */
function writePackage(
  directory: string,
  name: string,
  record?: Record<string, unknown>,
) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} body\n---\nDo ${name}`,
    'utf-8',
  );
  if (record) {
    writeFileSync(
      join(directory, 'skill.json'),
      JSON.stringify({ name, path: directory, ...record }, null, 2),
      'utf-8',
    );
  }
}

/**
 * The two fixtures the issue names, built so the facts diverge:
 *
 * - `bought-in` is a REGISTRY install sitting in the workspace skills root.
 *   `source`/`origin` both say `registry`; Station writes it. The retired
 *   client derivation (`source === 'local'`) called this read-only.
 * - `vendor-tool` is a package in the PLUGINS root whose own install record
 *   states `source: 'local'`. Station does not write that root. The retired
 *   derivation offered it a Save, and `PUT` answers 409.
 *
 * Re-derived against the rule as it now stands rather than carried forward:
 * the rule asks which root holds the package, and neither of these two moves.
 * A plugins root is not one of the two writable shapes, and `<home>/skills` is.
 * Both also pass the directory-name check the rule makes before the root check,
 * because each package sits in a directory named for it.
 */
function seedFixtures() {
  writePackage(join(home, 'skills', 'bought-in'), 'bought-in', {
    source: 'registry',
    origin: 'registry',
    installedAt: '2026-01-01T00:00:00.000Z',
    version: '2.1.0',
  });
  writePackage(
    join(home, 'plugins', 'vendor', 'skills', 'vendor-tool'),
    'vendor-tool',
    {
      source: 'local',
      installedAt: '2026-01-02T00:00:00.000Z',
    },
  );
}

/**
 * The subset of `ConfigLoader` the write path calls, TYPED — not `as never`.
 *
 * Review L6: an unconstrained cast is what let this stub drift. It predated
 * `saveSkillIn`, so every write in the effect oracle threw AFTER `SKILL.md` was
 * already on disk and the oracle's positive case passed on a half-completed
 * write, with nothing on the type side to say so. Naming the members here makes
 * a missing or misspelt one a compile error instead.
 */
type StubbedConfigLoader = Pick<
  ConfigLoader,
  | 'getProjectHomeDir'
  | 'loadSkill'
  | 'saveSkillIn'
  | 'deleteSkillAt'
  | 'listSkills'
  | 'skillExists'
>;

const configLoader: StubbedConfigLoader = {
  getProjectHomeDir: () => home,
  loadSkill: vi.fn(async (name: string) => {
    const record = join(home, 'skills', name, 'skill.json');
    if (!existsSync(record)) throw new Error(`Skill '${name}' not found`);
    return JSON.parse(readFileSync(record, 'utf-8'));
  }),
  // The write path resolves the package's own directory and writes the record
  // THERE (#1619) rather than deriving a path from the name. Stubbing this is
  // not optional: without it every write throws after `SKILL.md` is already on
  // disk, and the oracle's positive case passes on a half-completed write.
  saveSkillIn: vi.fn(async (directory: string, config: unknown) => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, 'skill.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  }),
  deleteSkillAt: vi.fn(),
  listSkills: vi.fn().mockResolvedValue([]),
  skillExists: vi.fn().mockResolvedValue(false),
};
const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

async function setup(
  options: {
    canonicalRoot?: string;
    servedInPlace?: boolean;
    projectSlug?: string;
  } = {},
) {
  const service = new SkillService(
    configLoader as unknown as ConfigLoader,
    logger,
    {
      ...(options.canonicalRoot
        ? {
            canonicalSources: [
              {
                label: 'flow-agents' as const,
                root: options.canonicalRoot,
                version: '9.0.0',
              },
            ],
          }
        : {}),
      ...(options.servedInPlace
        ? {
            pluginCommandSource: () => [
              {
                name: 'vendor-prompt',
                description: 'Served straight out of a plugin',
                body: 'Prompt body',
                resources: [],
                // Author-controlled and hostile: the served-in-place refusal
                // reports this directory, and its detail must not carry it.
                location: join(
                  home,
                  'plugins',
                  'vendor--verify-at-evil.example',
                  'prompt.md',
                ),
                source: 'plugin:vendor',
              },
            ],
          }
        : {}),
    },
  );
  // Discovery is scope-aware; the ROUTE is not. Passing a slug here and never
  // to the route is production's real shape, and it is what creates the
  // residual the last block below covers.
  await service.discoverSkills(home, options.projectSlug);
  // The SAME resolution the production wiring gives the route: one closure over
  // one `ConfigLoader`, which is also the one the service holds.
  const app = createSkillRoutes(service, () =>
    configLoader.getProjectHomeDir(),
  );
  return { app, service };
}

/** The routed app `setup` builds — Hono's own type, not a narrower shape. */
type RouteApp = Awaited<ReturnType<typeof setup>>['app'];

async function listing(app: RouteApp) {
  const body = await json(await app.request('/'));
  return new Map<string, Record<string, unknown>>(
    (body.data as Array<Record<string, unknown>>).map((row) => [
      row.name as string,
      row,
    ]),
  );
}

/** The refusal a row must be carrying, read without optional chaining. */
function refusalOf(row: Record<string, unknown> | undefined): {
  reason: string;
  detail: string;
  // REQUIRED, matching the contract: a refusal that omitted it would be a
  // shape no conforming server emits, and typing it optional here would let
  // this suite assert against one.
  packageDirectory: string;
} {
  expect(row).toBeDefined();
  const refusal = (row as Record<string, unknown>).writeRefusal;
  expect(refusal).toBeDefined();
  return refusal as {
    reason: string;
    detail: string;
    packageDirectory: string;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  home = mkdtempSync(join(tmpdir(), 'skills-writable-'));
  seedFixtures();
});

describe('GET /api/skills projects the server writability decision', () => {
  test('a registry install in the workspace root is writable, with no refusal', async () => {
    const { app } = await setup();
    const rows = await listing(app);

    const boughtIn = rows.get('bought-in');
    // The disagreement, asserted in both halves: the fields a client would
    // guess from say "registry", and the projected decision says writable.
    expect(boughtIn?.source).toBe('registry');
    expect(boughtIn?.origin).toBe('registry');
    expect(boughtIn?.writable).toBe(true);
    expect(boughtIn?.writeRefusal).toBeUndefined();
  });

  test("a package in the plugins root is NOT writable even though its record says source: 'local'", async () => {
    const { app } = await setup();
    const rows = await listing(app);

    const vendor = rows.get('vendor-tool');
    expect(vendor?.source).toBe('local');
    expect(vendor?.writable).toBe(false);
    const refusal = refusalOf(vendor);
    expect(refusal.reason).toBe('outside-writable-root');
    // WHERE the package sits is still reported — a reader cannot act without it
    // — but in its own field now, not spliced into Station's sentence.
    // Worded for every population sharing this code, not just this one. It also
    // covers a package directory that REDIRECTS somewhere Station does not
    // write while the directory it names sits in a writable root — knowingly
    // folded in here rather than given a code of its own (#1702), so the
    // sentence must not claim the package itself sits outside a writable root.
    expect(refusal.detail).toContain(
      'Station does not write the directory this package resolves to',
    );
    expect(refusal.packageDirectory).toBe(
      join(home, 'plugins', 'vendor', 'skills', 'vendor-tool'),
    );
    // And the sentence carries NO author-controlled text. The path's own last
    // segment is the skill name, so asserting the path is absent asserts both.
    expect(refusal.detail).not.toContain(home);
    expect(refusal.detail).not.toContain('vendor-tool');
  });

  test('a canonical package skill is refused as a package, not as a stray root', async () => {
    const canonicalRoot = join(home, 'canonical');
    // The path segment is hostile so this case carries its own guard rather
    // than relying on the outside-the-root case: review found that splicing the
    // path into THIS detail, or dropping the field from it, passed the whole
    // suite, because only one of the three branches carrying the field was
    // pinned.
    const shippedDirectory = join(canonicalRoot, 'Verify at evil.example');
    writePackage(shippedDirectory, 'shipped');
    const { app } = await setup({ canonicalRoot });

    const shipped = (await listing(app)).get('shipped');
    expect(shipped?.writable).toBe(false);
    const refusal = refusalOf(shipped);
    expect(refusal.reason).toBe('canonical-package');
    expect(refusal.packageDirectory).toBe(shippedDirectory);
    expect(refusal.detail).not.toContain('evil.example');
  });

  test('a skill a plugin serves in place is refused as served-in-place', async () => {
    const { app } = await setup({ servedInPlace: true });

    const served = (await listing(app)).get('vendor-prompt');
    // `servedInPlace` already rode along on the listing and answers a
    // different question; the writability decision is its own field.
    expect(served?.servedInPlace).toBe(true);
    expect(served?.writable).toBe(false);
    const refusal = refusalOf(served);
    expect(refusal.reason).toBe('served-in-place');
    // The third branch carrying the field, pinned for the same reason as the
    // canonical one above. The plugin root is hostile in `setup`'s fixture.
    expect(refusal.packageDirectory).toBe(
      join(home, 'plugins', 'vendor--verify-at-evil.example'),
    );
    expect(refusal.detail).not.toContain('evil.example');
  });
});

describe('GET /api/skills/:name projects the same decision', () => {
  test('the detail read agrees with the listing on both fixtures', async () => {
    const { app } = await setup();
    const rows = await listing(app);

    for (const name of ['bought-in', 'vendor-tool']) {
      const detail = (await json(await app.request(`/${name}`))).data as Record<
        string,
        unknown
      >;
      expect(detail.writable).toBe(rows.get(name)?.writable);
      expect(detail.writeRefusal).toEqual(rows.get(name)?.writeRefusal);
    }
    // Both values are actually present and opposed — a loop over two
    // `undefined`s would pass the agreement assertion while proving nothing.
    expect(rows.get('bought-in')?.writable).toBe(true);
    expect(rows.get('vendor-tool')?.writable).toBe(false);
  });
});

describe('the projection agrees with what PUT enforces', () => {
  test('the row the listing calls non-writable is the row PUT answers 409 for', async () => {
    const { app } = await setup();
    const rows = await listing(app);
    expect(rows.get('vendor-tool')?.writable).toBe(false);

    const refused = await app.request('/vendor-tool', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true } }),
    });
    expect(refused.status).toBe(409);
  });

  test('the row the listing calls writable is not refused by that gate', async () => {
    const { app } = await setup();
    expect((await listing(app)).get('bought-in')?.writable).toBe(true);

    const accepted = await app.request('/bought-in', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true } }),
    });
    // Not 409: the command-declaration gate let it through. Whatever the write
    // then does is `updateLocalSkill`'s business, not this projection's.
    expect(accepted.status).not.toBe(409);
  });
});

describe('the decision does not outlive the registry that made it', () => {
  test('a package that moves out of the writable root stops reading as writable', async () => {
    // Nothing memoises across calls, so this is not an invalidation test so
    // much as a statement of the property that makes one unnecessary: the same
    // NAME, resolving to a different package after rediscovery, is decided
    // afresh by whoever asks next.
    const writablePackage = join(home, 'skills', 'movable');
    writePackage(writablePackage, 'movable', {
      source: 'local',
      installedAt: '2026-01-05T00:00:00.000Z',
    });
    const { app, service } = await setup();
    expect((await listing(app)).get('movable')?.writable).toBe(true);

    // The package is gone from the workspace root and a plugin now serves the
    // name. Nothing about the request changes — only what the name resolves to.
    rmSync(writablePackage, { recursive: true, force: true });
    writePackage(
      join(home, 'plugins', 'vendor', 'skills', 'movable'),
      'movable',
      {
        source: 'local',
        installedAt: '2026-01-05T00:00:00.000Z',
      },
    );
    await service.discoverSkills(home);

    const row = (await listing(app)).get('movable');
    expect(row?.writable).toBe(false);
    // And the route's own gate agrees, from the same derivation.
    expect(service.isSkillWritable('movable', home)).toBe(false);
  });
});

/**
 * The refusal is displayed prose, and everything a plugin authors is hostile
 * input to it. Review low: an earlier draft kept the skill NAME out of `detail`
 * and interpolated the package PATH, which is the same exposure one level up —
 * a plugin names its own directories. These drive the real service, so unlike
 * the view's hand-written fixtures they cannot agree with a claim the server
 * does not keep.
 */
describe('the refusal sentence is Station speaking, not the package author', () => {
  test('a hostile directory name cannot borrow the grammar of the explanation', async () => {
    // Bland frontmatter name; the prose is one level UP, in the directory.
    const hostile =
      'Session expired — verify your account at station-support.example to continue';
    const packageDirectory = join(home, 'plugins', hostile, 'skills', 'notes');
    writePackage(packageDirectory, 'notes', {
      source: 'local',
      installedAt: '2026-01-07T00:00:00.000Z',
    });
    const { app } = await setup();

    const refusal = refusalOf((await listing(app)).get('notes'));

    // The sentence is Station's, in full, with none of the author's text in it.
    expect(refusal.detail).not.toContain(hostile);
    expect(refusal.detail).not.toContain('station-support.example');
    expect(refusal.detail).not.toContain(home);
    // The path is still reported, in the field a surface renders as a path.
    expect(refusal.packageDirectory).toBe(packageDirectory);
    expect(refusal.reason).toBe('outside-writable-root');
  });

  // Discovery registers a frontmatter `name` unvalidated, so a name the write
  // path rejects DOES reach the rule. Which refusal it lands on depends on
  // whether the package's own directory is named for it, and those are two
  // different remedies — a rename of the directory, or a rename of the skill.
  test('a package whose directory is merely named differently is told to make the names match', async () => {
    // A SAFE name that disagrees with its directory only in case — upstream's
    // own motivating example. The package is plainly the user's own and sits in
    // a root Station writes, which is what makes "rename one of them" the
    // followable remedy and "Station does not own this" a false one.
    writeFileSync(
      join(home, 'skills', 'bought-in', 'SKILL.md'),
      '---\nname: Bought-In\ndescription: cased\n---\nBody',
      'utf-8',
    );
    const { app } = await setup();

    const refusal = refusalOf((await listing(app)).get('Bought-In'));
    expect(refusal.reason).toBe('directory-name-mismatch');
    expect(refusal.detail).not.toMatch(/does not own|read-only/);
    expect(refusal.packageDirectory).toBe(join(home, 'skills', 'bought-in'));
  });

  test('a name no directory could ever carry is a rename of the SKILL, not of the directory', async () => {
    // Review M2: this fixture's own name can never match any directory name, so
    // "rename the directory" would be unfollowable advice — for the very case
    // that used to publish it. Where the package sits is fine; the name is not.
    writeFileSync(
      join(home, 'skills', 'bought-in', 'SKILL.md'),
      '---\nname: ../../escape\ndescription: traversal\n---\nBody',
      'utf-8',
    );
    const { app } = await setup();

    const row = (await listing(app)).get('../../escape');
    expect(row).toBeDefined();
    const refusal = refusalOf(row);
    expect(refusal.reason).toBe('unresolvable-name');
    expect(refusal.detail).not.toMatch(/does not own|read-only/);
    expect(refusal.packageDirectory).toBe(join(home, 'skills', 'bought-in'));
    // The name is author-controlled and must not reach the sentence.
    expect(refusal.detail).not.toContain('../../escape');
    const res = await app.request(`/${encodeURIComponent('../../escape')}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true } }),
    });
    expect(res.status).toBe(409);
  });

  test('a broken path INSIDE a writable root is not told it sits outside one', async () => {
    // Review H1, probed: the floor refuses this because it cannot tell where a
    // write would land, and an earlier draft published that as "not a skills
    // root Station writes" with "install it into your workspace" as the remedy.
    // Both false — the package is already in the right root, and installing
    // cannot repair a broken link.
    // The package is real when discovery registers it and its path breaks
    // afterwards — a package moved or a link severed between a discovery and a
    // read, which is the shape this reaches in practice. Building it broken
    // does not work: discovery cannot register what it cannot read, so the
    // condition would be unreachable and the test vacuous.
    const packageDirectory = join(home, 'skills', 'ghost');
    writePackage(packageDirectory, 'ghost', {
      source: 'local',
      installedAt: '2026-01-09T00:00:00.000Z',
    });
    const { app } = await setup();
    expect((await listing(app)).get('ghost')?.writable).toBe(true);

    rmSync(packageDirectory, { recursive: true, force: true });
    symlinkSync(join(home, 'nowhere-at-all'), packageDirectory);

    const row = (await listing(app)).get('ghost');
    const refusal = refusalOf(row);
    expect(refusal.reason).toBe('containment-unreadable');
    // The two false statements the earlier draft published, both excluded.
    expect(refusal.detail).not.toMatch(/skills root|does not own/);
    expect(refusal.packageDirectory).toBe(packageDirectory);
  });

  test('a name the path rule rejects is refused as unresolvable, with no diagnostic', async () => {
    // Directory named EXACTLY for the skill, so the mismatch above cannot fire
    // and the floor's own name assertion is what refuses. `__proto__` is one of
    // the names it names.
    writePackage(join(home, 'skills', '__proto__'), '__proto__', {
      source: 'local',
      installedAt: '2026-01-08T00:00:00.000Z',
    });
    const { app } = await setup();

    const row = (await listing(app)).get('__proto__');
    expect(row).toBeDefined();
    const refusal = refusalOf(row);
    expect(refusal.reason).toBe('unresolvable-name');
    // The PACKAGE's directory is reported here like anywhere else. What could
    // not be resolved is the WRITE TARGET, and an earlier draft confused the two
    // — documenting the field as absent and then telling the reader to rename a
    // package it declined to identify (review medium). The remedy is only
    // actionable with this.
    expect(refusal.packageDirectory).toBe(join(home, 'skills', '__proto__'));
    // The underlying rejection names prototype keys and traversal. That is a
    // log line, not guidance, and it must not reach a field documented for
    // display.
    expect(refusal.detail).not.toMatch(/__proto__|prototype|constructor/);
    expect(refusal.detail).toContain('cannot be used as a directory name');
    // The route ANSWERS the refusal rather than letting the rejection propagate.
    const res = await app.request('/__proto__', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true } }),
    });
    expect(res.status).toBe(409);

    // NO log line is asserted, and none is emitted. Review low asked for two
    // things here: server-side coverage of this branch, which is this test, and
    // that the condition stop being announced once per row per listing. The
    // merged rule satisfies the second by not logging at all, and the reason
    // CODE is the channel a reader acts on — which was the justification for
    // demoting the log in the first place. Re-adding one now would be a second
    // report of a fact this refusal already carries.
    expect(logger.warn).not.toHaveBeenCalledWith(
      'Skill name cannot resolve to a package directory',
      expect.anything(),
    );
  });
});

/**
 * Packages in the project-scoped root, which the rule now WRITES: it asks which
 * root holds the package and accepts `<home>/projects/<slug>/skills` by shape,
 * so a package the user owns there is writable with no caller supplying a scope.
 *
 * The block's original premise was the opposite — that these were packages the
 * user owned and the server refused anyway — and that premise fell with the
 * mechanism it named. It survives as a fixture set because a name a plugin also
 * holds is STILL refused: the residual is now the collision alone (#1687), not
 * the project root.
 *
 * These assert AGREEMENT between the projected field and what `PUT` enforces,
 * not a literal. A test pinning the literal would have gone red on the correct
 * widening while saying nothing about the property that actually matters: `writable` must report what the server WILL do, never what
 * the user morally ought to be allowed to do. Under both trees the projection
 * and the gate call the same function with the same arguments, so agreement
 * holds whichever answer that function gives — and a projection re-derived from
 * `source`/`origin` breaks it in exactly this population, which is why the
 * fixtures live here rather than beside the ones whose value is stable.
 */
describe('packages in the project-scoped root, which the rule now writes', () => {
  /** Did the command-declaration gate let this write through? */
  async function gateAdmits(app: RouteApp, name: string) {
    const res = await app.request(`/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true } }),
    });
    return res.status !== 409;
  }

  test('a project-scoped package reports exactly what the route enforces', async () => {
    writePackage(
      join(home, 'projects', 'demo', 'skills', 'scoped-tool'),
      'scoped-tool',
      {
        source: 'local',
        origin: 'project',
        installedAt: '2026-01-03T00:00:00.000Z',
      },
    );
    const { app } = await setup({ projectSlug: 'demo' });

    const row = (await listing(app)).get('scoped-tool');
    // The package exists and is the user's own — the projection must not
    // silently drop it.
    expect(row).toBeDefined();
    expect(row?.origin).toBe('project');
    expect(row?.writable).toBe(await gateAdmits(app, 'scoped-tool'));
    // Whichever way it resolves, a refusal carries a reason and a grant does
    // not: the two fields cannot contradict each other.
    expect(row?.writeRefusal === undefined).toBe(row?.writable === true);
  });

  test('a project-scoped package whose name a plugin also holds reports what the route enforces', async () => {
    writePackage(
      join(home, 'projects', 'demo', 'skills', 'shared-name'),
      'shared-name',
      {
        source: 'local',
        origin: 'project',
        installedAt: '2026-01-04T00:00:00.000Z',
      },
    );
    writePackage(
      join(home, 'plugins', 'vendor', 'skills', 'shared-name'),
      'shared-name',
    );
    const { app } = await setup({ projectSlug: 'demo' });

    const row = (await listing(app)).get('shared-name');
    expect(row).toBeDefined();
    expect(row?.writable).toBe(await gateAdmits(app, 'shared-name'));
    expect(row?.writeRefusal === undefined).toBe(row?.writable === true);
  });
});

/**
 * The EFFECT oracle: `writable` is true if and only if a write through the route
 * modifies that package's own `SKILL.md` and creates no second package under the
 * machine root.
 *
 * The agreement assertions above are a cheap WIRING pin and nothing more — both
 * sides reach the same function with identical arguments, so they catch a reader
 * that stops going through it, which is the regression the issue is about, and
 * they cannot see both sides being wrong TOGETHER. Review found exactly that: a
 * decision memoised across a rediscovery made the projection and the gate agree
 * on a grant neither should have given, and every agreement assertion stayed
 * green while a write to a read-only package published a shadow copy.
 *
 * This oracle is the filesystem, so it is blind to what the rule believes. It
 * survives the #1619 policy change for the same reason the agreement assertions
 * do — whichever answer the rule gives, the effect has to match it.
 */
describe('writable iff the write lands in that package and nowhere else', () => {
  /**
   * The effect a `writable` value PREDICTS, as a whole tuple.
   *
   * Not `writable === (modified && !shadowed)`. That form is satisfied by a
   * refusal that published a shadow package anyway — `modified` is already
   * `false`, so the conjunction is `false` whatever the shadow did, and the
   * oracle goes blind on exactly the outcome the gate exists to prevent.
   * Proven, not reasoned: with the enforcement in `updateLocalSkillOwned`
   * deleted, both project-scoped cases stayed GREEN under the collapsed form
   * while a second package appeared under the machine root.
   *
   * A refusal must mean the write landed NOWHERE — not merely "not in that
   * package". Whichever way the rule resolves these fixtures, including after
   * #1619 widens it, the effect has to match this.
   */
  function effectPredictedBy(writable: unknown) {
    return writable === true
      ? {
          // A grant must SUCCEED, not merely leave the right bytes behind. The
          // status was computed and never asserted, so a clean write and a write
          // that landed and then threw were identical under this tuple — which
          // is exactly how a stub missing a method the write path calls passed
          // this case for the wrong reason (review M5). Asserting it makes that
          // class self-detecting rather than dependent on someone noticing.
          succeeded: true,
          modifiedItsOwnPackage: true,
          shadowedUnderMachineRoot: false,
          stoppedByTheOwnershipGate: false,
        }
      : {
          succeeded: false,
          modifiedItsOwnPackage: false,
          shadowedUnderMachineRoot: false,
          stoppedByTheOwnershipGate: true,
        };
  }

  /** What a write through the route actually DID, read off the disk. */
  async function writeEffect(
    app: RouteApp,
    name: string,
    packageDirectory: string,
  ) {
    const own = join(packageDirectory, 'SKILL.md');
    const before = readFileSync(own, 'utf-8');
    const response = await app.request(`/${name}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        description: 'Edited by the oracle',
        body: 'Edited body',
      }),
    });
    const answer = await response.text();
    return {
      status: response.status,
      succeeded: response.ok,
      modifiedItsOwnPackage: readFileSync(own, 'utf-8') !== before,
      // WHY the write did nothing, not merely THAT it did nothing. A fixture
      // whose write dies on an unrelated error satisfies "nothing was written"
      // without the gate ever running, and then proves nothing about it.
      // Measured, not assumed: with the ownership gate deleted, the
      // plugin-collision fixture answered 400 "not found" — its plugin package
      // carries no install record, so the load throws before any disk write —
      // and every "nothing happened" assertion stayed green. This is what makes
      // that fixture discriminate.
      //
      // Keyed on the gate's own sentence OPENER, not on a phrase inside its
      // variable clause. The first version matched "does not own", which is
      // wording the rule owns and duly reworded — so the probe reported "not
      // stopped by the gate" for writes the gate had stopped. A discriminator
      // that parses prose it does not own is a discriminator with a shelf life.
      stoppedByTheOwnershipGate:
        response.status === 400 && answer.includes(`Cannot edit '${name}':`),
      // A shadow package under the machine root is the specific damage the
      // refusal exists to prevent, so it is asserted rather than inferred from
      // the response.
      shadowedUnderMachineRoot:
        packageDirectory !== join(home, 'skills', name) &&
        existsSync(join(home, 'skills', name)),
    };
  }

  test('a project-scoped package the user owns', async () => {
    const packageDirectory = join(
      home,
      'projects',
      'demo',
      'skills',
      'scoped-tool',
    );
    writePackage(packageDirectory, 'scoped-tool', {
      source: 'local',
      origin: 'project',
      installedAt: '2026-01-06T00:00:00.000Z',
    });
    const { app } = await setup({ projectSlug: 'demo' });
    const writable = (await listing(app)).get('scoped-tool')?.writable;
    // The fixture is present and STATED a decision. Without this, a listing
    // that dropped the row would leave `writable` undefined, which
    // `effectPredictedBy` reads as a refusal — the oracle would then be
    // asserting a property of a package nobody reported.
    expect(typeof writable).toBe('boolean');

    const effect = await writeEffect(app, 'scoped-tool', packageDirectory);

    expect({
      succeeded: effect.succeeded,
      modifiedItsOwnPackage: effect.modifiedItsOwnPackage,
      shadowedUnderMachineRoot: effect.shadowedUnderMachineRoot,
      stoppedByTheOwnershipGate: effect.stoppedByTheOwnershipGate,
    }).toEqual(effectPredictedBy(writable));
  });

  test('a project-scoped package whose name a plugin also holds', async () => {
    const packageDirectory = join(
      home,
      'plugins',
      'vendor',
      'skills',
      'shared-name',
    );
    writePackage(
      join(home, 'projects', 'demo', 'skills', 'shared-name'),
      'shared-name',
      {
        source: 'local',
        origin: 'project',
        installedAt: '2026-01-06T00:00:00.000Z',
      },
    );
    writePackage(packageDirectory, 'shared-name');
    const { app } = await setup({ projectSlug: 'demo' });
    const row = (await listing(app)).get('shared-name');
    // Present and decided — see the sibling case above.
    expect(typeof row?.writable).toBe('boolean');

    // The plugin's package is what answers to the name — that IS the residual.
    const effect = await writeEffect(app, 'shared-name', packageDirectory);

    expect({
      succeeded: effect.succeeded,
      modifiedItsOwnPackage: effect.modifiedItsOwnPackage,
      shadowedUnderMachineRoot: effect.shadowedUnderMachineRoot,
      stoppedByTheOwnershipGate: effect.stoppedByTheOwnershipGate,
    }).toEqual(effectPredictedBy(row?.writable));
  });

  test('the oracle can distinguish: a machine-root package writes and is reported writable', async () => {
    // Without this the biconditional above could be satisfied by a rule that
    // answers `false` for everything, which is not the property being asserted.
    const packageDirectory = join(home, 'skills', 'bought-in');
    const { app } = await setup();
    const writable = (await listing(app)).get('bought-in')?.writable;

    const effect = await writeEffect(app, 'bought-in', packageDirectory);

    expect(writable).toBe(true);
    expect(effect.succeeded).toBe(true);
    expect(effect.modifiedItsOwnPackage).toBe(true);
    expect(effect.shadowedUnderMachineRoot).toBe(false);
  });

  test('the oracle can distinguish: a plugin-root package writes nowhere and is reported unwritable', async () => {
    const packageDirectory = join(
      home,
      'plugins',
      'vendor',
      'skills',
      'vendor-tool',
    );
    const { app } = await setup();
    const writable = (await listing(app)).get('vendor-tool')?.writable;

    const effect = await writeEffect(app, 'vendor-tool', packageDirectory);

    expect(writable).toBe(false);
    expect(effect.modifiedItsOwnPackage).toBe(false);
    expect(effect.shadowedUnderMachineRoot).toBe(false);
    expect(effect.stoppedByTheOwnershipGate).toBe(true);
  });
});

/**
 * The window review reproduced: `discoverSkills` clears the registry
 * SYNCHRONOUSLY and then awaits its scans, so anything landing in between
 * decides against an empty registry — where no name resolves to a package and
 * every name therefore reads writable. That transient answer is correct-ish and
 * harmless as long as it is transient; the first cut of #1655 memoised it for
 * the whole registry generation and had the write gate read the same memo, so
 * one question asked inside the window became a durable grant on a read-only
 * package.
 *
 * Which question, exactly, matters for this test's power: NOT a listing. With
 * the registry empty a listing emits no row for the name and never asks. It is
 * a call to the write-gate predicate itself that arms it — see the comments in
 * the body, which name the one load-bearing line.
 */
describe('a decision made while discovery is in flight does not outlive it', () => {
  test('a canonical package is refused after a read landed mid-rediscovery', async () => {
    const canonicalRoot = join(home, 'canonical');
    writePackage(join(canonicalRoot, 'shipped'), 'shipped');
    const { app, service } = await setup({ canonicalRoot });
    expect((await listing(app)).get('shipped')?.writable).toBe(false);

    // Not awaited: the registry is empty from here until the scans finish.
    const discovery = service.discoverSkills(home);

    // THIS IS THE ARMING READ, and the only one — do not delete it, and do not
    // read it as merely describing the window. Under the round-one memo it is
    // the single call that stores the wrong answer; removing it leaves this
    // test GREEN with the grant fully reintroduced, while removing the two
    // read-model calls below leaves it red. Measured that way, one line at a
    // time, against a faithful reproduction (the memo CLEARED at discovery, not
    // a never-cleared one — the never-cleared shape is a different bug).
    //
    // The transient `true` is not the defect; outliving the window is. It is
    // asserted because a window that had silently stopped existing would make
    // everything after this vacuous.
    expect(service.isSkillWritable('shipped', home)).toBe(true);

    // And NEITHER read model can arm it, which is why the predicate above has
    // to. Mid-window the registry is empty, so the listing emits no row for the
    // name and never asks the question, and the detail read rejects before
    // writability is evaluated. Asserted rather than assumed: an earlier
    // version of this test performed a bare listing here and credited it with
    // arming the grant, and it was inert.
    const midWindow = await listing(app);
    expect(midWindow.has('shipped')).toBe(false);
    expect((await app.request('/shipped')).status).toBe(404);
    await discovery;

    // THE DAMAGE IS ASSERTED FIRST, so a regression's failure text names the
    // granted write rather than a stale boolean: the gate refuses, and no
    // shadow package is published under the machine root. Under the memo review
    // rejected, this PUT was admitted and `<home>/skills/shipped` appeared —
    // that write, not the label, is what made the finding a HIGH.
    const refused = await app.request('/shipped', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: { enabled: true } }),
    });
    expect({
      refusedWithConflict: refused.status === 409,
      shadowedUnderMachineRoot: existsSync(join(home, 'skills', 'shipped')),
    }).toEqual({ refusedWithConflict: true, shadowedUnderMachineRoot: false });

    // And every reader agrees with what the gate just did — the predicate, the
    // listing and the DETAIL read, because all three go through the one
    // derivation and none of them may carry an answer out of that window.
    expect(service.isSkillWritable('shipped', home)).toBe(false);
    const row = (await listing(app)).get('shipped');
    expect(row?.writable).toBe(false);
    expect(refusalOf(row).reason).toBe('canonical-package');
    const detail = (await json(await app.request('/shipped'))).data as Record<
      string,
      unknown
    >;
    expect(detail.writable).toBe(false);
    expect(refusalOf(detail).reason).toBe('canonical-package');
  });
});
