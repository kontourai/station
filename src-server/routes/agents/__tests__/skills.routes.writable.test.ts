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
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { readJson as json } from '../../../__test-utils__/read-json.js';

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
 * Neither answer changes under #1619, which widens writability to the
 * project-scoped root: a plugin root is not one, and a package already in
 * `<home>/skills` was writable before and after.
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

const configLoader = {
  getProjectHomeDir: () => home,
  loadSkill: vi.fn(async (name: string) => {
    throw new Error(`Skill '${name}' not found`);
  }),
  saveSkill: vi.fn(),
  deleteSkill: vi.fn(),
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
  const service = new SkillService(configLoader as never, logger, {
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
              location: join(home, 'plugins', 'vendor', 'prompt.md'),
              source: 'plugin:vendor',
            },
          ],
        }
      : {}),
  });
  // Discovery is scope-aware; the ROUTE is not. Passing a slug here and never
  // to the route is production's real shape, and it is what creates the
  // residual the last block below covers.
  await service.discoverSkills(home, options.projectSlug);
  // The SAME resolution the production wiring gives the route: one closure over
  // one `ConfigLoader`, which is also the one the service holds.
  const app = createSkillRoutes(service as never, () =>
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
} {
  expect(row).toBeDefined();
  const refusal = (row as Record<string, unknown>).writeRefusal;
  expect(refusal).toBeDefined();
  return refusal as { reason: string; detail: string };
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
    // The reason names the actual root, which is the only part of it a reader
    // can act on.
    expect(refusal.detail).toContain('is not a skills root Station writes');
    expect(refusal.detail).toContain(
      join(home, 'plugins', 'vendor', 'skills', 'vendor-tool'),
    );
  });

  test('a canonical package skill is refused as a package, not as a stray root', async () => {
    const canonicalRoot = join(home, 'canonical');
    writePackage(join(canonicalRoot, 'shipped'), 'shipped');
    const { app } = await setup({ canonicalRoot });

    const shipped = (await listing(app)).get('shipped');
    expect(shipped?.writable).toBe(false);
    expect(refusalOf(shipped).reason).toBe('canonical-package');
  });

  test('a skill a plugin serves in place is refused as served-in-place', async () => {
    const { app } = await setup({ servedInPlace: true });

    const served = (await listing(app)).get('vendor-prompt');
    // `servedInPlace` already rode along on the listing and answers a
    // different question; the writability decision is its own field.
    expect(served?.servedInPlace).toBe(true);
    expect(served?.writable).toBe(false);
    expect(refusalOf(served).reason).toBe('served-in-place');
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
    // The projection is read once per row, so the decision is cached for the
    // registry generation it was computed in. This is the invalidation: the
    // same NAME, resolving to a different package after rediscovery.
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
    // And the route agrees, from the same cache.
    expect(service.isSkillWritable('movable', home)).toBe(false);
  });
});

/**
 * The residual: packages the user genuinely OWNS that the server refuses to
 * write anyway, because discovery is scope-aware and the route's predicate call
 * is not — it passes no project slug, so the writable directory resolves under
 * the machine root and never matches a project-scoped package (#1619).
 *
 * These assert AGREEMENT between the projected field and what `PUT` enforces,
 * not a literal `false`. The literal is what #1619 changes, and a test pinning
 * it would go red on a correct fix while saying nothing about the property that
 * actually matters: `writable` must report what the server WILL do, never what
 * the user morally ought to be allowed to do. Under both trees the projection
 * and the gate call the same function with the same arguments, so agreement
 * holds whichever answer that function gives — and a projection re-derived from
 * `source`/`origin` breaks it in exactly this population, which is why the
 * fixtures live here rather than beside the ones whose value is stable.
 */
describe('a package the user owns that the server nonetheless refuses', () => {
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
