/**
 * The Playbooks→Skills pass, against a fixture home shaped like the plan's
 * §3.10 case list: JSON rows, a markdown-file row, a plugin row, two rows whose
 * names collide, an agent carrying a playbook `agent:` pin, and an agent
 * carrying `prompts: [uuid]`.
 *
 * The skill side is the REAL `SkillService` writing real `SKILL.md`/`skill.json`
 * bytes, because "the body survives byte for byte" and "`installedAt` is the
 * playbook's own date" are claims about files, not about calls. The agent side
 * is a file-backed port that reads and writes the same
 * `<home>/agents/<slug>/agent.json` the config loader does — the subject here is
 * the migration, and standing up the loader's home-schema/registry machinery
 * would test that instead.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  skillDiscoveries: { add: vi.fn() },
  skillActivations: { add: vi.fn() },
  skillActivationDuration: { record: vi.fn() },
  skillDiscoveryDuration: { record: vi.fn() },
  skillOps: { add: vi.fn() },
  canonicalSkillsDiscovered: { add: vi.fn() },
  promptOps: { add: vi.fn() },
}));

const { SkillService } = await import('../skill-service.js');
const { migratePlaybooksToSkills } = await import(
  '../playbook-skill-migration.js'
);

const PLAYBOOK_IDS = {
  standup: '11111111-1111-4111-8111-111111111111',
  shipIt: '22222222-2222-4222-8222-222222222222',
  reviewA: '33333333-3333-4333-8333-333333333333',
  reviewB: '44444444-4444-4444-8444-444444444444',
  markdown: '55555555-5555-4555-8555-555555555555',
} as const;

const STANDUP_BODY =
  'Ask each person:\n\n- what shipped\n- what is blocked\n\n{{team}} stand-up.\n   trailing spaces kept   ';

let home: string;
let service: InstanceType<typeof SkillService>;

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

const configLoader = {
  getProjectHomeDir: () => home,
  loadSkill: vi.fn(async (name: string) => {
    const configPath = join(home, 'skills', name, 'skill.json');
    if (existsSync(configPath)) {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    }
    return {
      name,
      description: '',
      source: 'local',
      installedAt: '',
      path: join(home, 'skills', name),
    };
  }),
  saveSkill: vi.fn(async (name: string, config: unknown) => {
    const dir = join(home, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  }),
  deleteSkill: vi.fn(),
  listSkills: vi.fn().mockResolvedValue([]),
  skillExists: vi.fn().mockResolvedValue(false),
};

function writeAgent(slug: string, spec: Record<string, unknown>): void {
  const dir = join(home, 'agents', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'agent.json'),
    JSON.stringify(spec, null, 2),
    'utf-8',
  );
}

function readAgent(slug: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(join(home, 'agents', slug, 'agent.json'), 'utf-8'),
  );
}

const agents = {
  listAgents: async () => {
    const dir = join(home, 'agents');
    if (!existsSync(dir)) return [];
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(dir, entry.name, 'agent.json')))
      .map((entry) => ({ slug: entry.name }));
  },
  loadAgent: async (slug: string) => readAgent(slug),
  /** Read → derive → write, the shape the store's locked updater has. */
  mutateAgent: async (
    slug: string,
    updater: (
      current: Record<string, unknown>,
    ) => Record<string, unknown> | null,
  ) => {
    const next = updater(structuredClone(readAgent(slug)));
    if (next === null) return null;
    writeAgent(slug, next);
    return next;
  },
};

/** Every file under `dir`, by relative path, with its exact bytes. */
function snapshotTree(dir: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.set(relative(dir, full), readFileSync(full, 'base64'));
    }
  };
  if (existsSync(dir)) walk(dir);
  return files;
}

function seedPlaybookStoreOnly(): void {
  const promptsDir = join(home, 'prompts');
  mkdirSync(join(promptsDir, 'files'), { recursive: true });
  writeFileSync(
    join(promptsDir, 'prompts.json'),
    JSON.stringify(
      [
        {
          id: PLAYBOOK_IDS.standup,
          name: 'Daily Standup',
          content: STANDUP_BODY,
          description: 'Run the stand-up',
          category: 'rituals',
          tags: ['team'],
          global: true,
          source: 'local',
          createdAt: '2024-03-01T09:00:00.000Z',
          updatedAt: '2024-05-02T09:00:00.000Z',
          stats: {
            runs: 7,
            successes: 5,
            failures: 1,
            qualityScore: 0.7,
            lastRunAt: '2024-05-02T09:00:00.000Z',
          },
        },
        {
          id: PLAYBOOK_IDS.shipIt,
          name: 'Ship It!',
          content: 'Cut the release.',
          agent: 'coder',
          source: 'local',
          createdAt: '2024-03-02T09:00:00.000Z',
          updatedAt: '2024-03-02T09:00:00.000Z',
        },
        {
          id: PLAYBOOK_IDS.reviewA,
          name: 'Review',
          content: 'First review playbook.',
          source: 'local',
          createdAt: '2024-03-03T09:00:00.000Z',
          updatedAt: '2024-03-03T09:00:00.000Z',
        },
        {
          id: PLAYBOOK_IDS.reviewB,
          name: 'review',
          content: 'Second review playbook.',
          source: 'local',
          createdAt: '2024-03-04T09:00:00.000Z',
          updatedAt: '2024-03-04T09:00:00.000Z',
        },
        {
          id: 'demo:hello',
          name: 'Plugin Hello',
          content: 'From a plugin.',
          source: 'plugin:demo',
          createdAt: '2024-03-05T09:00:00.000Z',
          updatedAt: '2024-03-05T09:00:00.000Z',
        },
      ],
      null,
      2,
    ),
    'utf-8',
  );
  writeFileSync(
    join(promptsDir, 'files', `${PLAYBOOK_IDS.markdown}.md`),
    [
      '---',
      'name: "Markdown Playbook"',
      'description: "From a file"',
      'category: "Ops"',
      'tags:',
      '  - deploy',
      '  - release',
      'global: true',
      '---',
      '',
      'Body from a markdown row.',
    ].join('\n'),
    'utf-8',
  );
  writeFileSync(
    join(promptsDir, 'files', `${PLAYBOOK_IDS.markdown}.meta.json`),
    JSON.stringify({
      id: PLAYBOOK_IDS.markdown,
      source: 'local',
      createdAt: '2024-03-06T09:00:00.000Z',
      updatedAt: '2024-03-06T09:00:00.000Z',
      storageMode: 'markdown-file',
    }),
    'utf-8',
  );
}

function seedFixtureHome(): void {
  seedPlaybookStoreOnly();
  writeAgent('coder', { slug: 'coder', name: 'Coder', skills: ['existing'] });
  writeAgent('writer', {
    slug: 'writer',
    name: 'Writer',
    prompts: [PLAYBOOK_IDS.standup, '99999999-0000-0000-0000-000000000000'],
  });
}

async function run(options: { dryRun?: boolean } = {}) {
  return migratePlaybooksToSkills({
    homeDir: home,
    skills: {
      listSkills: () => service.listSkills(),
      createLocalSkill: (input, projectHomeDir) =>
        service.createLocalSkill(input, projectHomeDir),
      completeInterruptedLocalSkillPackage: (input, identity, projectHomeDir) =>
        service.completeInterruptedLocalSkillPackage(
          input,
          identity,
          projectHomeDir,
        ),
      adoptSkillStats: (name, stats) => service.adoptSkillStats(name, stats),
    },
    agents,
    logger,
    dryRun: options.dryRun,
    now: () => new Date('2025-01-02T03:04:05.678Z'),
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'playbook-migration-'));
  vi.clearAllMocks();
  service = new SkillService(configLoader as never, logger);
  seedFixtureHome();
});

describe('migratePlaybooksToSkills', () => {
  test('writes one skill package per non-plugin playbook, body byte-for-byte', async () => {
    const report = await run();
    expect(report.status).toBe('migrated');

    const skillMd = readFileSync(
      join(home, 'skills', 'daily-standup', 'SKILL.md'),
      'utf-8',
    );
    // Not `toContain`: the body must be the file's tail exactly, with its
    // blank lines and trailing spaces, or the migration reformatted it.
    expect(skillMd.endsWith(`\n\n${STANDUP_BODY}`)).toBe(true);

    const record = JSON.parse(
      readFileSync(
        join(home, 'skills', 'daily-standup', 'skill.json'),
        'utf-8',
      ),
    );
    expect(record.legacyIds).toEqual([PLAYBOOK_IDS.standup]);
    expect(record.origin).toBe('migrated-playbook');
    expect(record.command).toEqual({ enabled: true, global: true });
    // The playbook's own creation date, not the moment the upgrade ran.
    expect(record.installedAt).toBe('2024-03-01T09:00:00.000Z');
  });

  test('every migrated playbook is command-enabled; global is the playbook global', async () => {
    await run();
    const listing = service.listSkills();
    const standup = listing.find((skill) => skill.name === 'daily-standup');
    const shipIt = listing.find((skill) => skill.name === 'ship-it');
    expect(standup?.command).toEqual({ enabled: true, global: true });
    expect(shipIt?.command).toEqual({ enabled: true, global: false });
  });

  // The pass ARCHIVES the whole prompts/ directory when it succeeds, so a
  // reader that only opens prompts.json reports success and takes the only
  // copy of these rows with it. Body, identity and declarations are all
  // asserted: a reader that found the file but dropped its sidecar or its
  // frontmatter would still satisfy a body-only check (review H1).
  test('a markdown-file row migrates alongside the JSON rows', async () => {
    await run();
    expect(
      readFileSync(
        join(home, 'skills', 'markdown-playbook', 'SKILL.md'),
        'utf-8',
      ),
    ).toContain('Body from a markdown row.');

    const record = JSON.parse(
      readFileSync(
        join(home, 'skills', 'markdown-playbook', 'skill.json'),
        'utf-8',
      ),
    );
    // Identity comes from the `.meta.json` sidecar, not from the filename.
    expect(record.legacyIds).toEqual([PLAYBOOK_IDS.markdown]);
    expect(record.origin).toBe('migrated-playbook');
    expect(record.installedAt).toBe('2024-03-06T09:00:00.000Z');
    // Declarations come from the frontmatter, including the list continuation
    // and the boolean that decides whether the command is offered everywhere.
    expect(record.description).toBe('From a file');
    expect(record.category).toBe('Ops');
    expect(record.tags).toEqual(['deploy', 'release']);
    expect(record.command).toEqual({ enabled: true, global: true });
  });

  test('plugin rows are left in place, not copied into <home>/skills', async () => {
    const report = await run();
    expect(report.pluginRowsLeftInPlace).toBe(1);
    expect(
      service.listSkills().some((skill) => skill.name === 'plugin-hello'),
    ).toBe(false);
  });

  test('two playbooks with the same slug get -2, and the report says so', async () => {
    const report = await run();
    const rows = report.skills.filter(
      (row) => row.playbookName.toLowerCase() === 'review',
    );
    expect(rows.map((row) => row.skillName).sort()).toEqual([
      'review',
      'review-2',
    ]);
    expect(rows.find((row) => row.skillName === 'review-2')?.renamedFrom).toBe(
      'review',
    );
    expect(existsSync(join(home, 'skills', 'review', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(home, 'skills', 'review-2', 'SKILL.md'))).toBe(true);
  });

  test('stats move into the usage side store, not into skill.json', async () => {
    await run();
    const usage = JSON.parse(
      readFileSync(join(home, 'skills', '.usage.json'), 'utf-8'),
    );
    expect(usage['daily-standup'].runs).toBe(7);
    expect(usage['daily-standup'].successes).toBe(5);
    const record = JSON.parse(
      readFileSync(
        join(home, 'skills', 'daily-standup', 'skill.json'),
        'utf-8',
      ),
    );
    expect(record.stats).toBeUndefined();
  });

  test('a playbook that never ran gets no usage row at all', async () => {
    // The playbook reader seeds every row with a zeroed `stats` object, so an
    // unconditional adoption records "0 runs" for something nobody counted —
    // a different fact from "never counted", which is what the usage store's
    // absent-entry contract means.
    await run();
    const usage = JSON.parse(
      readFileSync(join(home, 'skills', '.usage.json'), 'utf-8'),
    );
    expect(Object.hasOwn(usage, 'daily-standup')).toBe(true);
    expect(Object.hasOwn(usage, 'ship-it')).toBe(false);
  });

  test("a playbook's agent pin becomes an agent.skills binding", async () => {
    const report = await run();
    expect(readAgent('coder').skills).toEqual(['existing', 'ship-it']);
    expect(
      report.agents.find((agent) => agent.slug === 'coder')?.addedSkills,
    ).toEqual(['ship-it']);
  });

  test('agent.prompts UUIDs become agent.skills and the key is deleted', async () => {
    const report = await run();
    const writer = readAgent('writer');
    expect(writer.skills).toEqual(['daily-standup']);
    // The whole point of `saveAgent` over `updateAgent`: a merge cannot remove
    // a key, and a `prompts` array left behind still reads as a live binding.
    expect(Object.hasOwn(writer, 'prompts')).toBe(false);
    const row = report.agents.find((agent) => agent.slug === 'writer');
    expect(row?.resolvedPromptIds).toEqual([PLAYBOOK_IDS.standup]);
    expect(row?.droppedPromptIds).toEqual([
      '99999999-0000-0000-0000-000000000000',
    ]);
  });

  test('the marker is written and the playbook store is archived, never deleted', async () => {
    const report = await run();
    const archive = join(home, 'prompts.migrated-2025-01-02T03-04-05-678Z');
    expect(report.promptsArchivedTo).toBe(archive);
    expect(existsSync(join(home, 'prompts'))).toBe(false);
    // Rolling back is a rename: every original byte is still on disk.
    expect(existsSync(join(archive, 'prompts.json'))).toBe(true);
    expect(existsSync(join(archive, '.migrated.json'))).toBe(true);
  });

  test('a second run is a no-op', async () => {
    await run();
    const before = snapshotTree(home);
    const second = await run();
    expect(second.status).toBe('skipped');
    expect(second.reason).toContain('no playbook store');
    expect(snapshotTree(home)).toEqual(before);
  });

  test('a resumed run adopts what the interrupted one already wrote', async () => {
    // Exactly the state a crash between "skill written" and "marker written"
    // leaves: the skill exists with its `legacyIds`, the playbook store does
    // not know that.
    await service.createLocalSkill(
      {
        name: 'daily-standup',
        body: STANDUP_BODY,
        command: { enabled: true, global: true },
        legacyIds: [PLAYBOOK_IDS.standup],
        origin: 'migrated-playbook',
      },
      home,
    );
    const report = await run();
    const row = report.skills.find(
      (entry) => entry.playbookId === PLAYBOOK_IDS.standup,
    );
    expect(row?.alreadyMigrated).toBe(true);
    expect(row?.skillName).toBe('daily-standup');
    // Not re-created under a collision-suffixed name.
    expect(existsSync(join(home, 'skills', 'daily-standup-2'))).toBe(false);
    // And the binding it implies still lands.
    expect(readAgent('writer').skills).toEqual(['daily-standup']);
  });

  test('a pass that died between skill.json and SKILL.md is adopted and finished', async () => {
    // Review H2: the exact state a crash between `createLocalSkill`'s two
    // writes leaves. The install record carries the playbook UUID, and that is
    // what stops the retry writing the same playbook again as `daily-standup-2`
    // with an orphan command beside it.
    const dir = join(home, 'skills', 'daily-standup');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        name: 'daily-standup',
        source: 'local',
        installedAt: '2024-03-01T09:00:00.000Z',
        path: dir,
        legacyIds: [PLAYBOOK_IDS.standup],
        origin: 'migrated-playbook',
        command: { enabled: true, global: true },
      }),
      'utf-8',
    );
    const originalInstallRecord = readFileSync(
      join(dir, 'skill.json'),
      'utf-8',
    );
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);

    const report = await run();
    const row = report.skills.find(
      (entry) => entry.playbookId === PLAYBOOK_IDS.standup,
    );
    expect(row?.skillName).toBe('daily-standup');
    expect(row?.alreadyMigrated).toBe(true);
    expect(row?.repaired).toBe(true);
    expect(existsSync(join(home, 'skills', 'daily-standup-2'))).toBe(false);
    expect(readFileSync(join(dir, 'skill.json'), 'utf-8')).toBe(
      originalInstallRecord,
    );
    // Finished, not merely recognised: the body is on disk and the skill is
    // discoverable, byte-identical to a package written in one pass.
    const skillMd = readFileSync(join(dir, 'SKILL.md'), 'utf-8');
    expect(skillMd.endsWith(`\n\n${STANDUP_BODY}`)).toBe(true);
    expect(service.listSkills().map((skill) => skill.name)).toContain(
      'daily-standup',
    );
  });

  test('a package this migration did not write is never adopted or overwritten', async () => {
    // Review delta MEDIUM: a legacy id is just a string a user can put in
    // their own skill.json. Adopting on the id alone overwrote an unrelated
    // package's install record and published the playbook's body into it.
    const dir = join(home, 'skills', 'daily-standup');
    mkdirSync(dir, { recursive: true });
    const userRecord = {
      name: 'daily-standup',
      description: 'A user skill that happens to record this id',
      source: 'local',
      installedAt: '2020-01-01T00:00:00.000Z',
      path: dir,
      legacyIds: [PLAYBOOK_IDS.standup],
      origin: 'user',
    };
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify(userRecord, null, 2),
      'utf-8',
    );

    const report = await run();
    // Untouched: same bytes, still no body published into it.
    expect(JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf-8'))).toEqual(
      userRecord,
    );
    expect(existsSync(join(dir, 'SKILL.md'))).toBe(false);
    // The playbook migrated under its own free name, and the clash is named.
    const row = report.skills.find(
      (entry) => entry.playbookId === PLAYBOOK_IDS.standup,
    );
    expect(row?.alreadyMigrated).toBe(false);
    expect(row?.skillName).toBe('daily-standup-2');
    expect(report.conflicts).toEqual([
      {
        playbookId: PLAYBOOK_IDS.standup,
        playbookName: 'Daily Standup',
        claimedBy: 'daily-standup',
        migratedAs: 'daily-standup-2',
      },
    ]);
  });

  test('a COMPLETE user skill carrying a coincident id is a conflict, not a resumption', async () => {
    // Review delta-2 MEDIUM: the origin gate covered the raw scan but not
    // discovered skills, so a finished user-authored skill with `origin: user`
    // and a coincident playbook UUID was read as `alreadyMigrated` — the
    // playbook's pin was routed to somebody else's skill and the source was
    // archived without its package ever being written.
    await service.createLocalSkill(
      {
        name: 'daily-standup',
        description: 'A user skill that happens to record this id',
        body: 'Not the playbook body.',
        legacyIds: [PLAYBOOK_IDS.standup],
        origin: 'user',
      },
      home,
    );

    const report = await run();
    const row = report.skills.find(
      (entry) => entry.playbookId === PLAYBOOK_IDS.standup,
    );
    expect(row?.alreadyMigrated).toBe(false);
    expect(row?.skillName).toBe('daily-standup-2');
    expect(report.conflicts).toEqual([
      {
        playbookId: PLAYBOOK_IDS.standup,
        playbookName: 'Daily Standup',
        claimedBy: 'daily-standup',
        migratedAs: 'daily-standup-2',
      },
    ]);
    // The user's skill keeps its own body; the playbook got its own package.
    expect(
      readFileSync(join(home, 'skills', 'daily-standup', 'SKILL.md'), 'utf-8'),
    ).toContain('Not the playbook body.');
    expect(
      readFileSync(
        join(home, 'skills', 'daily-standup-2', 'SKILL.md'),
        'utf-8',
      ).endsWith(`\n\n${STANDUP_BODY}`),
    ).toBe(true);
    // And the agent pin follows the PLAYBOOK's package, not the stranger's.
    expect(readAgent('writer').skills).toEqual(['daily-standup-2']);
  });

  test('a half-written package is not re-created under a suffix even when its command word is free', async () => {
    // The name reservation has to consider packages discovery cannot see, or
    // the retry both duplicates the playbook and leaves the orphan behind.
    const dir = join(home, 'skills', 'review');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        name: 'review',
        source: 'local',
        installedAt: '',
        path: dir,
        legacyIds: [PLAYBOOK_IDS.reviewA],
        origin: 'migrated-playbook',
      }),
      'utf-8',
    );
    const report = await run();
    const names = report.skills
      .filter((entry) => entry.playbookName.toLowerCase() === 'review')
      .map((entry) => entry.skillName)
      .sort();
    // `review` is adopted for reviewA; only the second same-named playbook
    // takes a suffix — there is no `review-3`.
    expect(names).toEqual(['review', 'review-2']);
    expect(existsSync(join(home, 'skills', 'review-3'))).toBe(false);
    expect(report.errors).toEqual([]);
  });

  test('a plugin prompt sharing a playbook name does not rename the playbook', async () => {
    // Seen on a live boot: the in-place plugin skill was registered during the
    // discovery that precedes the migration, reserved `daily-standup`, and the
    // USER's playbook was written as `daily-standup-2` — changing the
    // `/command` word they type because of something ambient. An in-place
    // name is re-derived at the next discovery; a directory is not.
    const report = await migratePlaybooksToSkills({
      homeDir: home,
      skills: {
        listSkills: () => [
          ...service.listSkills(),
          {
            name: 'daily-standup',
            command: { enabled: true },
            servedInPlace: true as const,
          },
        ],
        createLocalSkill: (input, dir) => service.createLocalSkill(input, dir),
        completeInterruptedLocalSkillPackage: (input, identity, dir) =>
          service.completeInterruptedLocalSkillPackage(input, identity, dir),
        adoptSkillStats: (name, stats) => service.adoptSkillStats(name, stats),
      },
      agents,
      logger,
    });
    const row = report.skills.find(
      (entry) => entry.playbookId === PLAYBOOK_IDS.standup,
    );
    expect(row?.skillName).toBe('daily-standup');
    expect(row?.renamedFrom).toBeUndefined();
    expect(existsSync(join(home, 'skills', 'daily-standup', 'SKILL.md'))).toBe(
      true,
    );
  });

  test('a dry run reports the same plan and writes nothing at all', async () => {
    const before = snapshotTree(home);
    const report = await run({ dryRun: true });
    expect(report.status).toBe('dry-run');
    expect(report.skills.map((row) => row.skillName).sort()).toEqual([
      'daily-standup',
      'markdown-playbook',
      'review',
      'review-2',
      'ship-it',
    ]);
    expect(
      report.agents.find((agent) => agent.slug === 'writer')?.addedSkills,
    ).toEqual(['daily-standup']);
    // The home's bytes, not just "no skills directory": a dry run that wrote a
    // marker or touched an agent record would be caught here.
    expect(snapshotTree(home)).toEqual(before);
  });

  test('a home with no playbook store is skipped without writing a marker', async () => {
    rmSync(join(home, 'prompts'), { recursive: true, force: true });
    const report = await run();
    expect(report.status).toBe('skipped');
    expect(existsSync(join(home, 'prompts'))).toBe(false);
  });

  test('an unreadable playbook store stops the pass and leaves everything alone', async () => {
    writeFileSync(join(home, 'prompts', 'prompts.json'), '{ not json', 'utf-8');
    const report = await run();
    expect(report.status).toBe('failed');
    expect(report.reason).toContain('could not be read');
    // No marker, so a repaired store is picked up next boot.
    expect(existsSync(join(home, 'prompts', '.migrated.json'))).toBe(false);
    expect(existsSync(join(home, 'skills'))).toBe(false);
  });

  test('a home that refuses writes reports pending and leaves no marker', async () => {
    const report = await migratePlaybooksToSkills({
      homeDir: home,
      skills: {
        listSkills: () => service.listSkills(),
        createLocalSkill: async () => {
          throw Object.assign(new Error('read-only file system'), {
            code: 'EROFS',
          });
        },
        completeInterruptedLocalSkillPackage: async () => {
          throw Object.assign(new Error('read-only file system'), {
            code: 'EROFS',
          });
        },
        adoptSkillStats: (name, stats) => service.adoptSkillStats(name, stats),
      },
      agents,
      logger,
    });
    expect(report.status).toBe('pending');
    expect(report.reason).toContain('writes are not permitted');
    expect(existsSync(join(home, 'prompts', '.migrated.json'))).toBe(false);
    expect(existsSync(join(home, 'prompts', 'prompts.json'))).toBe(true);
  });

  test('an agent record the writer refuses withholds the marker and the archive', async () => {
    // Review H1: completing here would archive `prompts/` and never retry —
    // with the flag on the agent's `prompts` key is inert, with the flag off
    // the store it names is gone, and the binding is stranded forever.
    const refusing = {
      ...agents,
      mutateAgent: async (
        slug: string,
        updater: (
          current: Record<string, unknown>,
        ) => Record<string, unknown> | null,
      ) => {
        if (slug === 'writer') {
          throw Object.assign(new Error('permission denied'), {
            code: 'EACCES',
          });
        }
        return agents.mutateAgent(slug, updater);
      },
    };
    const report = await migratePlaybooksToSkills({
      homeDir: home,
      skills: {
        listSkills: () => service.listSkills(),
        createLocalSkill: (input, dir) => service.createLocalSkill(input, dir),
        completeInterruptedLocalSkillPackage: (input, identity, dir) =>
          service.completeInterruptedLocalSkillPackage(input, identity, dir),
        adoptSkillStats: (name, stats) => service.adoptSkillStats(name, stats),
      },
      agents: refusing,
      logger,
    });

    expect(report.status).toBe('pending');
    expect(report.failedAgents).toEqual([
      { slug: 'writer', reason: 'permission denied' },
    ]);
    expect(report.reason).toContain('retry on the next start');
    expect(existsSync(join(home, 'prompts', '.migrated.json'))).toBe(false);
    expect(existsSync(join(home, 'prompts', 'prompts.json'))).toBe(true);
    expect(
      readdirSync(home).some((entry) => entry.startsWith('prompts.migrated-')),
    ).toBe(false);
    // The agent that DID save is not re-attempted, and the one that failed is.
    expect(readAgent('coder').skills).toEqual(['existing', 'ship-it']);

    const second = await run();
    expect(second.status).toBe('migrated');
    expect(second.failedAgents).toEqual([]);
    expect(readAgent('writer').skills).toEqual(['daily-standup']);
    expect(Object.hasOwn(readAgent('writer'), 'prompts')).toBe(false);
    // The retry did not duplicate a single skill.
    expect(readdirSync(join(home, 'skills')).sort()).toEqual([
      '.usage.json',
      'daily-standup',
      'markdown-playbook',
      'review',
      'review-2',
      'ship-it',
    ]);
  });

  test('a retry does not rewrite an agent record it already translated', async () => {
    // A republish of an untouched record is a write that can fail for a new
    // reason and would hold the whole migration open.
    await run();
    const saved: string[] = [];
    const watching = {
      ...agents,
      mutateAgent: async (
        slug: string,
        updater: (
          current: Record<string, unknown>,
        ) => Record<string, unknown> | null,
      ) => {
        const next = updater(structuredClone(readAgent(slug)));
        // Only a real write counts: `null` means the updater found nothing to
        // change, which is exactly the no-op this test is asserting.
        if (next === null) return null;
        saved.push(slug);
        writeAgent(slug, next);
        return next;
      },
    };
    // Re-seed the playbook store so the pass runs again over the same home.
    seedPlaybookStoreOnly();
    await migratePlaybooksToSkills({
      homeDir: home,
      skills: {
        listSkills: () => service.listSkills(),
        createLocalSkill: (input, dir) => service.createLocalSkill(input, dir),
        completeInterruptedLocalSkillPackage: (input, identity, dir) =>
          service.completeInterruptedLocalSkillPackage(input, identity, dir),
        adoptSkillStats: (name, stats) => service.adoptSkillStats(name, stats),
      },
      agents: watching,
      logger,
      now: () => new Date('2025-01-03T00:00:00.000Z'),
    });
    expect(saved).toEqual([]);
  });

  test('a pin naming an agent this home has no record of is reported, not silently dropped', async () => {
    rmSync(join(home, 'agents', 'coder'), { recursive: true, force: true });
    const report = await run();
    expect(report.unboundAgentPins).toEqual([
      { agentSlug: 'coder', skillName: 'ship-it' },
    ]);
  });
});
