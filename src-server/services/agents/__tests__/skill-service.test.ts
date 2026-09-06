import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SKILL_COMMAND_NAME_RULE } from '@kontourai/station-contracts/skill-command';
import { beforeEach, describe, expect, test, vi } from 'vitest';

vi.mock('../../../telemetry/metrics.js', () => ({
  skillDiscoveries: { add: vi.fn() },
  skillActivations: { add: vi.fn() },
  skillActivationDuration: { record: vi.fn() },
  skillDiscoveryDuration: { record: vi.fn() },
  skillOps: { add: vi.fn() },
  canonicalSkillsDiscovered: { add: vi.fn() },
}));
const { SkillService } = await import('../skill-service.js');
const { skillRecordClaimsName, saveSkillConfigIn, deleteSkillPackageAt } =
  await import('../../../domain/config-loader-storage.js');
const { localSkillRevisionFromDirectory } = await import(
  '../skill-revision.js'
);

let testDir: string;
const mockConfigLoader = {
  getProjectHomeDir: () => testDir,
  loadSkill: vi.fn(),
  // Writes the real `skill.json` the loader would, so tests that read the
  // install record back (origin, legacyIds) exercise the same bytes production
  // does rather than a stub that records a call and persists nothing.
  // `<home>/skills/<name>`, ALWAYS — what the real `saveSkillConfig` does, which
  // resolves by name with no slug. This stub used to write to `config.path`
  // instead, so a scoped write appeared to put its record beside its body here
  // while production split the package across two roots (#1582 D6 wrote it that
  // way because the split was the only way to reach the project root at all;
  // #1619 made the production path directory-addressed, so the stub can stop
  // compensating and the split becomes visible to every test in this file).
  saveSkill: vi.fn(async (name: string, config: unknown) => {
    const dir = join(testDir, 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify(config, null, 2),
      'utf-8',
    );
  }),
  // The directory-addressed pair the write path uses (#1619). These call the
  // REAL storage functions rather than imitating them, so the containment they
  // assert is asserted here too — a stub that only wrote a file would let a
  // write escape its root in every test in this file.
  saveSkillIn: vi.fn(async (directory: string, config: unknown) =>
    saveSkillConfigIn(testDir, directory, config as never),
  ),
  deleteSkillAt: vi.fn(async (name: string, directory: string) =>
    deleteSkillPackageAt(testDir, name, directory),
  ),
  deleteSkill: vi.fn(),
  listSkills: vi.fn().mockResolvedValue([]),
  skillExists: vi.fn().mockResolvedValue(false),
};
const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
};

let service: InstanceType<typeof SkillService>;

beforeEach(() => {
  // mkdtempSync guarantees a unique dir; `Date.now()` alone collided when two
  // tests ran in the same millisecond, leaking skills between them under
  // shuffled/fast execution.
  testDir = mkdtempSync(join(tmpdir(), 'skill-test-'));
  // `vi.clearAllMocks()` resets call history but NOT mock implementations set
  // via `mockResolvedValue`. A `loadSkill` return configured by an earlier
  // test would otherwise leak into later tests under shuffled order (or vice
  // versa). `getSkill` always falls through to `configLoader.loadSkill` when
  // there are no canonical sources, so reset its implementation to a
  // deterministic default that resolves a config rooted at the current
  // `testDir`. Tests that assert a specific `loadSkill` behavior override this
  // explicitly within the test body.
  vi.clearAllMocks();
  mockConfigLoader.loadSkill.mockReset();
  // Reads the real `skill.json` when one exists, so the install-record
  // fallback path is exercised against the same bytes `saveSkill` wrote rather
  // than an invented shape — and REFUSES when one does not, which is what
  // production does: `loadSkillConfig` throws `Skill '<name>' not found` for a
  // missing `<home>/skills/<name>/skill.json`. It used to answer a fabricated
  // config instead, which is why the project-scoped detail read (#1602) looked
  // like a wrong origin here while production 404'd the pane outright.
  mockConfigLoader.loadSkill.mockImplementation(async (name: string) => {
    const configPath = join(testDir, 'skills', name, 'skill.json');
    if (!existsSync(configPath)) throw new Error(`Skill '${name}' not found`);
    const record = JSON.parse(readFileSync(configPath, 'utf-8'));
    // The REAL rule, called rather than mirrored: a record that claims another
    // name is not this name's record, and `loadSkillConfig` answers that the
    // same way it answers a missing file.
    if (!skillRecordClaimsName(record, name))
      throw new Error(`Skill '${name}' not found`);
    return record;
  });
  service = new SkillService(mockConfigLoader as any, mockLogger);
});

describe('SkillService', () => {
  function interruptedInput(name: string, legacyId: string) {
    return {
      name,
      description: `Interrupted ${name}`,
      body: `Canonical ${name} body`,
      command: { enabled: true, global: true },
      legacyIds: [legacyId],
      origin: 'migrated-playbook' as const,
      installedAt: '2024-03-01T09:00:00.000Z',
    };
  }

  function seedInterruptedPackage(
    name: string,
    legacyId: string,
    overrides: Record<string, unknown> = {},
  ) {
    const input = interruptedInput(name, legacyId);
    const publication = service.projectLocalSkillPublication(input, testDir);
    const skillDir = join(testDir, 'skills', name);
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'skill.json'),
      JSON.stringify({ ...publication.config, ...overrides }, null, 2),
      'utf8',
    );
    return {
      input,
      skillDir,
      skillPath: join(skillDir, 'SKILL.md'),
      configPath: join(skillDir, 'skill.json'),
      publication,
      identity: { name, origin: 'migrated-playbook' as const, legacyId },
    };
  }

  test('completes two identity-bound interrupted originals without rewriting either install record', async () => {
    const first = seedInterruptedPackage(
      'first-original',
      '11111111-1111-4111-8111-111111111111',
    );
    const second = seedInterruptedPackage(
      'second-original',
      '22222222-2222-4222-8222-222222222222',
    );
    const firstConfig = readFileSync(first.configPath, 'utf8');
    const secondConfig = readFileSync(second.configPath, 'utf8');

    await expect(
      service.completeInterruptedLocalSkillPackage(
        first.input,
        first.identity,
        testDir,
      ),
    ).resolves.toMatchObject({ success: true, repaired: true });
    await expect(
      service.completeInterruptedLocalSkillPackage(
        second.input,
        second.identity,
        testDir,
      ),
    ).resolves.toMatchObject({ success: true, repaired: true });

    expect(readFileSync(first.configPath, 'utf8')).toBe(firstConfig);
    expect(readFileSync(second.configPath, 'utf8')).toBe(secondConfig);
    expect(readFileSync(first.skillPath, 'utf8')).toBe(
      first.publication.skillMarkdown,
    );
    expect(readFileSync(second.skillPath, 'utf8')).toBe(
      second.publication.skillMarkdown,
    );
  });

  test('refuses unrelated or wrong interrupted-package identities without publishing a body', async () => {
    const unrelated = seedInterruptedPackage(
      'unrelated',
      '33333333-3333-4333-8333-333333333333',
      { origin: 'user' },
    );
    const wrongUuid = seedInterruptedPackage(
      'wrong-uuid',
      '44444444-4444-4444-8444-444444444444',
    );

    await expect(
      service.completeInterruptedLocalSkillPackage(
        unrelated.input,
        unrelated.identity,
        testDir,
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });
    await expect(
      service.completeInterruptedLocalSkillPackage(
        { ...unrelated.input, origin: 'user' } as never,
        { ...unrelated.identity, origin: 'user' } as never,
        testDir,
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });
    await expect(
      service.completeInterruptedLocalSkillPackage(
        wrongUuid.input,
        {
          ...wrongUuid.identity,
          legacyId: '55555555-5555-4555-8555-555555555555',
        },
        testDir,
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });

    expect(existsSync(unrelated.skillPath)).toBe(false);
    expect(existsSync(wrongUuid.skillPath)).toBe(false);
  });

  test('refuses linked records and directory replacement before or after exclusive publication', async () => {
    const symlinked = seedInterruptedPackage(
      'symlinked-record',
      'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const linkedRecord = join(testDir, 'linked-record.json');
    writeFileSync(linkedRecord, readFileSync(symlinked.configPath));
    rmSync(symlinked.configPath);
    symlinkSync(linkedRecord, symlinked.configPath);
    await expect(
      service.completeInterruptedLocalSkillPackage(
        symlinked.input,
        symlinked.identity,
        testDir,
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });
    expect(existsSync(symlinked.skillPath)).toBe(false);

    const hardLinked = seedInterruptedPackage(
      'hard-linked-record',
      'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    const hardRecord = join(testDir, 'hard-record.json');
    writeFileSync(hardRecord, readFileSync(hardLinked.configPath));
    rmSync(hardLinked.configPath);
    linkSync(hardRecord, hardLinked.configPath);
    await expect(
      service.completeInterruptedLocalSkillPackage(
        hardLinked.input,
        hardLinked.identity,
        testDir,
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });
    expect(existsSync(hardLinked.skillPath)).toBe(false);

    const replacedBefore = seedInterruptedPackage(
      'replaced-before',
      'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    );
    const movedBefore = join(testDir, 'replaced-before-moved');
    await expect(
      service.completeInterruptedLocalSkillPackage(
        replacedBefore.input,
        replacedBefore.identity,
        testDir,
        undefined,
        {
          beforePublishForTest: () => {
            renameSync(replacedBefore.skillDir, movedBefore);
            mkdirSync(replacedBefore.skillDir);
          },
        },
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });
    expect(existsSync(join(movedBefore, 'SKILL.md'))).toBe(false);

    const replacedAfter = seedInterruptedPackage(
      'replaced-after',
      'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    );
    const movedAfter = join(testDir, 'replaced-after-moved');
    await expect(
      service.completeInterruptedLocalSkillPackage(
        replacedAfter.input,
        replacedAfter.identity,
        testDir,
        undefined,
        {
          afterPublishForTest: () => {
            renameSync(replacedAfter.skillDir, movedAfter);
            mkdirSync(replacedAfter.skillDir);
          },
        },
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });
    expect(existsSync(join(replacedAfter.skillDir, 'SKILL.md'))).toBe(false);
    expect(readFileSync(join(movedAfter, 'SKILL.md'), 'utf8')).toBe(
      replacedAfter.publication.skillMarkdown,
    );
  });

  test('accepts only canonical existing bodies and never overwrites a raced body', async () => {
    const noncanonical = seedInterruptedPackage(
      'noncanonical',
      '66666666-6666-4666-8666-666666666666',
    );
    writeFileSync(noncanonical.skillPath, 'user body', 'utf8');
    await expect(
      service.completeInterruptedLocalSkillPackage(
        noncanonical.input,
        noncanonical.identity,
        testDir,
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });
    expect(readFileSync(noncanonical.skillPath, 'utf8')).toBe('user body');

    const idempotent = seedInterruptedPackage(
      'idempotent',
      '77777777-7777-4777-8777-777777777777',
    );
    writeFileSync(idempotent.skillPath, idempotent.publication.skillMarkdown);
    await expect(
      service.completeInterruptedLocalSkillPackage(
        idempotent.input,
        idempotent.identity,
        testDir,
      ),
    ).resolves.toMatchObject({ success: true, repaired: false });

    const raced = seedInterruptedPackage(
      'raced',
      '88888888-8888-4888-8888-888888888888',
    );
    await expect(
      service.completeInterruptedLocalSkillPackage(
        raced.input,
        raced.identity,
        testDir,
        undefined,
        {
          beforePublishForTest: () =>
            writeFileSync(raced.skillPath, 'concurrent noncanonical body'),
        },
      ),
    ).resolves.toMatchObject({ success: false, repaired: false });
    expect(readFileSync(raced.skillPath, 'utf8')).toBe(
      'concurrent noncanonical body',
    );
  });

  test('ordinary creation still refuses an interrupted package directory', async () => {
    const interrupted = seedInterruptedPackage(
      'ordinary-refusal',
      '99999999-9999-4999-8999-999999999999',
    );
    await expect(
      service.createLocalSkill(interrupted.input, testDir),
    ).resolves.toMatchObject({ success: false });
    expect(existsSync(interrupted.skillPath)).toBe(false);
  });

  test('compare-delete retains an edited Skill after its canonical revision changed', async () => {
    await service.createLocalSkill(
      { name: 'conditional', body: 'original' },
      testDir,
    );
    const revision = await service.localSkillRevision('conditional', testDir);
    writeFileSync(
      join(testDir, 'skills', 'conditional', 'SKILL.md'),
      '# edited',
    );

    await expect(
      service.removeSkillIfRevision('conditional', revision, testDir),
    ).resolves.toEqual({ removed: false, conflict: true });
    expect(existsSync(join(testDir, 'skills', 'conditional', 'SKILL.md'))).toBe(
      true,
    );
  });
  test('listSkills returns empty initially', () => {
    expect(service.listSkills()).toEqual([]);
  });

  test('listGuidanceAssets normalizes installed skills into guidance assets', async () => {
    const skillDir = join(testDir, 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: A test skill\n---\nBody content',
    );
    writeFileSync(
      join(skillDir, '.station-meta.json'),
      JSON.stringify({ version: '1.0.0' }),
    );

    await service.discoverSkills(testDir);

    expect(service.listGuidanceAssets()).toEqual([
      expect.objectContaining({
        kind: 'skill',
        name: 'my-skill',
        body: expect.stringContaining('Body content'),
        description: 'A test skill',
        runtimeMode: 'skill-catalog',
        packaging: expect.objectContaining({
          path: skillDir,
        }),
      }),
    ]);
    rmSync(testDir, { recursive: true, force: true });
  });

  test('getSkillCount returns 0 initially', () => {
    expect(service.getSkillCount()).toBe(0);
  });

  test('getSkillCatalogPrompt returns empty with no skills', () => {
    expect(service.getSkillCatalogPrompt()).toBe('');
  });

  test('getSkillTool returns null with no skills', () => {
    expect(service.getSkillTool()).toBeNull();
  });

  test('getSkillCatalogPrompt with empty array returns empty', () => {
    expect(service.getSkillCatalogPrompt([])).toBe('');
  });

  test('discoverSkills handles missing directories', async () => {
    await service.discoverSkills('/nonexistent/path');
    expect(service.getSkillCount()).toBe(0);
  });

  test('discoverSkills finds skills in skills/ directory', async () => {
    const skillDir = join(testDir, 'skills', 'my-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: my-skill\ndescription: A test skill\n---\nBody content',
    );
    await service.discoverSkills(testDir);
    expect(service.getSkillCount()).toBe(1);
    expect(service.listSkills()[0].name).toBe('my-skill');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('discoverSkills clears registry on re-scan', async () => {
    const skillDir = join(testDir, 'skills', 'temp-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: temp-skill\ndescription: Temp\n---\n',
    );
    await service.discoverSkills(testDir);
    expect(service.getSkillCount()).toBe(1);
    rmSync(skillDir, { recursive: true, force: true });
    await service.discoverSkills(testDir);
    expect(service.getSkillCount()).toBe(0);
    rmSync(testDir, { recursive: true, force: true });
  });

  test('getSkillCatalogPrompt filters by skill names', async () => {
    const dir1 = join(testDir, 'skills', 'skill-a');
    const dir2 = join(testDir, 'skills', 'skill-b');
    mkdirSync(dir1, { recursive: true });
    mkdirSync(dir2, { recursive: true });
    writeFileSync(
      join(dir1, 'SKILL.md'),
      '---\nname: skill-a\ndescription: A\n---\n',
    );
    writeFileSync(
      join(dir2, 'SKILL.md'),
      '---\nname: skill-b\ndescription: B\n---\n',
    );
    await service.discoverSkills(testDir);
    expect(service.getSkillCount()).toBe(2);
    const filtered = service.getSkillCatalogPrompt(['skill-a']);
    expect(filtered).toContain('skill-a');
    expect(filtered).not.toContain('skill-b');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('getSkillTool returns tool when skills exist', async () => {
    const skillDir = join(testDir, 'skills', 'tool-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: tool-skill\ndescription: Has tool\n---\n',
    );
    await service.discoverSkills(testDir);
    const tool = service.getSkillTool();
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe('activate_skill');
    rmSync(testDir, { recursive: true, force: true });
  });

  test('getSkill delegates to configLoader.loadSkill', async () => {
    const config = {
      name: 'test',
      source: 'local',
      installedAt: '2026-01-01',
      path: '/test',
    };
    mockConfigLoader.loadSkill.mockResolvedValue(config);
    const result = await service.getSkill('test');
    expect(result).toMatchObject(config);
    // …and says plainly that there was no SKILL.md behind this answer.
    expect(result.declarationsDiagnostic).toContain('SKILL.md is missing');
    expect(mockConfigLoader.loadSkill).toHaveBeenCalledWith('test');
  });

  test('discoverSkills skips directories without SKILL.md', async () => {
    const noSkillDir = join(testDir, 'skills', 'not-a-skill');
    mkdirSync(noSkillDir, { recursive: true });
    writeFileSync(join(noSkillDir, 'README.md'), '# Not a skill');
    await service.discoverSkills(testDir);
    expect(service.getSkillCount()).toBe(0);
    rmSync(testDir, { recursive: true, force: true });
  });

  test('createLocalSkill writes canonical SKILL.md and discovers it', async () => {
    const result = await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Body text',
        tags: ['ops', 'deploy'],
        category: 'Operations',
        agent: 'deployer',
        global: true,
      },
      testDir,
    );

    expect(result.success).toBe(true);
    const content = readFileSync(
      join(testDir, 'skills', 'author-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('name: "author-skill"');
    expect(content).toContain('description: "Author me"');
    expect(content).toContain('tags:');
    expect(service.listSkills()[0]?.name).toBe('author-skill');
  });

  test('the install record is durable before the body is written', async () => {
    // Review H2. The two writes are not atomic together, so whichever lands
    // first is what a crash between them leaves — and it has to be the one
    // carrying `legacyIds`, because that is the only thing that lets
    // `station doctor --migrate-playbooks` recognise its own prior work
    // instead of writing the same record again under a `-2` suffix.
    // Through the DIRECTORY-addressed writer the create uses (#1619), so this
    // observes the write that actually happens rather than a name-addressed
    // one nothing calls any more.
    let bodyExistedWhenRecordWasWritten: boolean | undefined;
    mockConfigLoader.saveSkillIn.mockImplementationOnce(
      async (directory: string, config: unknown) => {
        bodyExistedWhenRecordWasWritten = existsSync(
          join(directory, 'SKILL.md'),
        );
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'skill.json'),
          JSON.stringify(config, null, 2),
          'utf-8',
        );
      },
    );
    await service.createLocalSkill(
      {
        name: 'ordered',
        description: 'Ordered',
        body: 'Body',
        legacyIds: ['some-legacy-uuid'],
      },
      testDir,
    );
    expect(bodyExistedWhenRecordWasWritten).toBe(false);
  });

  test('a failed body write is compensated, leaving no half-written package', async () => {
    // The other side of the ordering invariant, corrected. This case used to
    // assert that the record SURVIVES a failed body write — which was true
    // only because the harness stubbed `deleteSkill` as a no-op, so the
    // compensation the writer runs did nothing here. Production removes the
    // package it could not finish, and the recoverable partial state the
    // ordering above protects is the CRASH one, where no compensation gets to
    // run at all. Asserting the real behaviour of both is what this pair does
    // now; a caught failure leaves nothing behind.
    mockConfigLoader.saveSkillIn.mockImplementationOnce(
      async (directory: string, config: unknown) => {
        mkdirSync(directory, { recursive: true });
        writeFileSync(
          join(directory, 'skill.json'),
          JSON.stringify(config, null, 2),
          'utf-8',
        );
        // A directory where `SKILL.md` must go: the body write now fails the
        // way a full disk or a lost process would, after the record landed.
        mkdirSync(join(directory, 'SKILL.md'), { recursive: true });
      },
    );
    await expect(
      service.createLocalSkill(
        {
          name: 'half-written',
          description: 'Half',
          body: 'Body',
          legacyIds: ['another-legacy-uuid'],
        },
        testDir,
      ),
    ).rejects.toThrow();

    // Neither half survives: no orphan record claiming a legacy id, and no
    // unclaimed body.
    expect(existsSync(join(testDir, 'skills', 'half-written'))).toBe(false);
    // …and the compensation ran through the same directory the writes did.
    expect(mockConfigLoader.deleteSkillAt).toHaveBeenCalledWith(
      'half-written',
      join(testDir, 'skills', 'half-written'),
    );
  });

  test('a plugin prompt keeps its legacy id when a local skill holds its name', async () => {
    // Review M2. Both exist under distinct names; nothing is dropped, and
    // `<ns>:<id>` still resolves — which is the identity layouts and stored
    // references already hold.
    const localDir = join(testDir, 'skills', 'hello');
    mkdirSync(localDir, { recursive: true });
    writeFileSync(
      join(localDir, 'SKILL.md'),
      '---\nname: hello\ndescription: Mine\n---\nLocal body',
      'utf-8',
    );
    const withPlugin = new SkillService(mockConfigLoader as any, mockLogger, {
      pluginCommandSource: (_home, takenNames) =>
        takenNames.has('hello')
          ? [
              {
                name: 'hello-2',
                description: 'From a plugin',
                body: 'Plugin body',
                resources: [],
                location: join(testDir, 'plugins', 'demo', 'plugin.json'),
                source: 'plugin:demo',
                legacyIds: ['demo:hello'],
                command: { enabled: true },
              },
            ]
          : [],
    });
    await withPlugin.discoverSkills(testDir);

    expect(withPlugin.resolveSkillName('demo:hello')).toBe('hello-2');
    expect(
      withPlugin
        .listSkills()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(['hello', 'hello-2']);
    // The local skill keeps the command word; the plugin's declaration is
    // still visible with the reason it is not in effect.
    const local = withPlugin.listSkills().find((s) => s.name === 'hello');
    expect(local?.description).toBe('Mine');
    const detail = await withPlugin.getSkill('hello-2');
    expect(detail.body).toBe('Plugin body');
    expect(detail.legacyIds).toEqual(['demo:hello']);
  });

  test('a legacy id stops resolving when the skill claiming it is gone', async () => {
    // The index is rebuilt from the FINAL registry, so it can never answer
    // with a skill a later registration replaced or a removal took away.
    await service.createLocalSkill(
      {
        name: 'migrated',
        description: 'Migrated',
        body: 'Body',
        legacyIds: ['old-uuid'],
      },
      testDir,
    );
    expect(service.resolveSkillName('old-uuid')).toBe('migrated');
    rmSync(join(testDir, 'skills', 'migrated'), {
      recursive: true,
      force: true,
    });
    await service.discoverSkills(testDir);
    expect(service.resolveSkillName('old-uuid')).toBeUndefined();
  });

  test('a skill created without a description is still discoverable', async () => {
    // `description` is optional on every write path and REQUIRED by the skill
    // format: the parser discovery uses refuses a package without a non-empty
    // one. A skill written this way used to land on disk and then be invisible
    // to `listSkills()` forever — found by `station doctor
    // --migrate-playbooks`, whose source records mostly have no description
    // at all.
    const result = await service.createLocalSkill(
      { name: 'no-description', body: 'Body text' },
      testDir,
    );
    expect(result.success).toBe(true);
    expect(
      readFileSync(
        join(testDir, 'skills', 'no-description', 'SKILL.md'),
        'utf-8',
      ),
    ).toContain('description: "no-description"');
    expect(service.listSkills().map((skill) => skill.name)).toContain(
      'no-description',
    );
  });

  test('updateLocalSkill rewrites the skill body', async () => {
    await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Body text',
      },
      testDir,
    );

    const result = await service.updateLocalSkill(
      'author-skill',
      {
        body: 'Updated body',
        description: 'Updated description',
      },
      testDir,
    );

    expect(result.success).toBe(true);
    const content = readFileSync(
      join(testDir, 'skills', 'author-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain('description: "Updated description"');
    expect(content).toContain('Updated body');
  });

  test('updateLocalSkill preserves unmodeled frontmatter source lines verbatim', async () => {
    await service.createLocalSkill(
      { name: 'author-skill', description: 'Author me', body: 'Body text' },
      testDir,
    );
    const skillPath = join(testDir, 'skills', 'author-skill', 'SKILL.md');
    writeFileSync(
      skillPath,
      readFileSync(skillPath, 'utf-8').replace(
        '---\n\nBody text',
        '# keep this comment exactly\ncustom_nested:\n  enabled: true\n  modes:\n    - one\n    - two\ncustom_block: |\n  first line\n  second: line\n"quoted key":  "spaced value"\n---\n\nBody text',
      ),
    );

    await service.updateLocalSkill(
      'author-skill',
      { description: 'Updated description' },
      testDir,
    );

    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('# keep this comment exactly');
    expect(content).toContain(
      'custom_nested:\n  enabled: true\n  modes:\n    - one\n    - two',
    );
    expect(content).toContain('custom_block: |\n  first line\n  second: line');
    expect(content).toContain('"quoted key":  "spaced value"');
    expect(content).toContain('description: "Updated description"');
  });

  test('updateLocalSkill rejects malformed frontmatter without writing', async () => {
    await service.createLocalSkill(
      { name: 'author-skill', description: 'Author me', body: 'Body text' },
      testDir,
    );
    const skillPath = join(testDir, 'skills', 'author-skill', 'SKILL.md');
    const malformed =
      '---\nname: author-skill\ndescription: [unterminated\n---\n\nBody text';
    writeFileSync(skillPath, malformed);
    mockConfigLoader.saveSkill.mockClear();

    await expect(
      service.updateLocalSkill(
        'author-skill',
        { description: 'Must not be written' },
        testDir,
      ),
    ).rejects.toThrow(/frontmatter parse failed/i);
    expect(readFileSync(skillPath, 'utf-8')).toBe(malformed);
    expect(mockConfigLoader.saveSkill).not.toHaveBeenCalled();
  });

  test('createLocalSkill writes command and variables as block frontmatter', async () => {
    await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Ship {{ticket}} to {{env}}',
        command: { enabled: true, name: 'ship', global: true },
        variables: [
          { name: 'ticket', description: 'Issue key', default: 'A-1' },
        ],
      },
      testDir,
    );

    const content = readFileSync(
      join(testDir, 'skills', 'author-skill', 'SKILL.md'),
      'utf-8',
    );
    expect(content).toContain(
      'command:\n  enabled: true\n  name: "ship"\n  global: true',
    );
    expect(content).toContain(
      'variables:\n  - name: "ticket"\n    description: "Issue key"\n    default: "A-1"',
    );
  });

  test('command and variables round-trip losslessly through an unrelated update', async () => {
    await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Ship {{ticket}}',
        command: { enabled: true, name: 'ship', global: true },
        variables: [{ name: 'ticket', description: 'Issue key' }],
      },
      testDir,
    );

    await service.updateLocalSkill(
      'author-skill',
      { description: 'Updated description' },
      testDir,
    );

    const reloaded = await service.getSkill('author-skill');
    expect(reloaded.command).toEqual({
      enabled: true,
      name: 'ship',
      global: true,
    });
    expect(reloaded.variables).toEqual([
      { name: 'ticket', description: 'Issue key' },
    ]);
    expect(reloaded.description).toBe('Updated description');
  });

  test('an update writing command keeps unmodeled frontmatter, and vice versa', async () => {
    await service.createLocalSkill(
      { name: 'author-skill', description: 'Author me', body: 'Body {{x}}' },
      testDir,
    );
    const skillPath = join(testDir, 'skills', 'author-skill', 'SKILL.md');
    writeFileSync(
      skillPath,
      readFileSync(skillPath, 'utf-8').replace(
        '---\n\nBody {{x}}',
        'custom_nested:\n  keep: true\n---\n\nBody {{x}}',
      ),
    );

    await service.updateLocalSkill(
      'author-skill',
      { command: { enabled: true } },
      testDir,
    );

    const content = readFileSync(skillPath, 'utf-8');
    expect(content).toContain('custom_nested:\n  keep: true');
    expect(content).toContain('command:\n  enabled: true');
    // The modeled block must not be re-emitted a second time as "unknown".
    expect(content.match(/^command:$/gm)).toHaveLength(1);
  });

  test('getSkill derives variables from the body, not from declarations', async () => {
    await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Only {{used}} is substituted',
        variables: [
          { name: 'used', description: 'in the body' },
          { name: 'stale', description: 'no longer in the body' },
        ],
      },
      testDir,
    );

    expect((await service.getSkill('author-skill')).variables).toEqual([
      { name: 'used', description: 'in the body' },
    ]);
  });

  test('malformed command frontmatter is dropped, never coerced into a command', async () => {
    const skillDir = join(testDir, 'skills', 'hand-edited');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: hand-edited\ndescription: D\ncommand:\n  enabled: "yes"\n---\nBody',
    );
    await service.discoverSkills(testDir);

    expect(service.listSkills()[0].command).toBeUndefined();
  });

  test('listSkills reports declared command, derived variables and joined stats', async () => {
    await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Ship {{ticket}}',
        command: { enabled: true, name: 'ship' },
        variables: [{ name: 'ticket', description: 'Issue key' }],
      },
      testDir,
    );
    await service.trackSkillRun('author-skill');
    await service.recordSkillOutcome('author-skill', 'success');

    const listed = service.listSkills();
    expect(listed).toHaveLength(1);
    expect(listed[0].command).toEqual({ enabled: true, name: 'ship' });
    expect(listed[0].variables).toEqual([
      { name: 'ticket', description: 'Issue key' },
    ]);
    expect(listed[0].stats).toMatchObject({
      runs: 1,
      successes: 1,
      qualityScore: 100,
    });
    expect(listed[0].origin).toBe('user');
  });

  test('a skill with no recorded usage carries no stats field', async () => {
    await service.createLocalSkill(
      { name: 'author-skill', description: 'Author me', body: 'Body' },
      testDir,
    );
    expect(service.listSkills()[0].stats).toBeUndefined();
  });

  test('resolveSkillName resolves a recorded legacy identifier', async () => {
    await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Body',
        legacyIds: ['0e0d1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6'],
        origin: 'migrated-playbook',
      },
      testDir,
    );

    expect(
      service.resolveSkillName('0e0d1f2a-3b4c-5d6e-7f80-91a2b3c4d5e6'),
    ).toBe('author-skill');
    expect(service.resolveSkillName('author-skill')).toBe('author-skill');
    expect(service.resolveSkillName('nothing-like-this')).toBeUndefined();
    expect(service.listSkills()[0].origin).toBe('migrated-playbook');
  });

  // #1582 D6. Before `project` existed both roots reported `user`, so the
  // Guidance list could not tell a workspace skill from a machine-wide one and
  // called every one of them "workspace". Both halves are proved here: what
  // discovery derives from the root, and what the writer records.
  test('a project-scoped skill is distinguishable from a machine-wide one', async () => {
    // No `origin` in either record: this is exactly what a hand-authored or
    // pre-`project` package looks like, so the derivation is what answers.
    for (const [root, name] of [
      [join(testDir, 'skills'), 'machine-wide'],
      [join(testDir, 'projects', 'demo', 'skills'), 'workspace-only'],
    ] as const) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: Authored by hand\n---\nBody`,
      );
      writeFileSync(
        join(dir, 'skill.json'),
        JSON.stringify({ name, source: 'local' }),
        'utf-8',
      );
    }
    await service.discoverSkills(testDir, 'demo');

    const byName = new Map(
      service.listSkills().map((skill) => [skill.name, skill.origin]),
    );
    expect(byName.get('workspace-only')).toBe('project');
    expect(byName.get('machine-wide')).toBe('user');
  });

  // Review M1. Every read is `recorded ?? derived`, and every `skill.json`
  // written before `project` existed records `user` — including for a
  // project-scoped package, because `createLocalSkill` stamped it and
  // `updateLocalSkill` preserves it. Without the path correction these stay
  // "This machine" forever, which is most of the skills this change is for.
  test('a legacy record saying user under the project root reads as project', async () => {
    const dir = join(testDir, 'projects', 'demo', 'skills', 'legacy-scoped');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: legacy-scoped\ndescription: Written before project existed\n---\nBody',
    );
    // The exact bytes the pre-change writer produced.
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        name: 'legacy-scoped',
        source: 'local',
        path: dir,
        origin: 'user',
      }),
      'utf-8',
    );
    await service.discoverSkills(testDir, 'demo');

    expect(service.listSkills()[0].origin).toBe('project');
  });

  // #1602. THE detail read for a skill that exists only under the project
  // root. `ConfigLoader.loadSkill` resolves `<home>/skills/<name>` with no
  // project slug (`loadSkillConfig` -> `resolveSkillDirectory(home, name)`), so
  // this read used to raise `Skill '<name>' not found` — outside `getSkill`'s
  // try, so it never reached `fromInstallRecordOnly` either — and the route
  // answered 404 for a name the listing shows. `getSkill` now resolves the
  // record beside the body discovery found.
  test('a project-only skill has a detail read, from its own record', async () => {
    const dir = join(testDir, 'projects', 'demo', 'skills', 'workspace-only');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: workspace-only\ndescription: Workspace copy\ntags:\n  - scoped\n---\nWorkspace body',
      'utf-8',
    );
    // The shape a workspace package on disk actually has: its own record,
    // beside its own body, recording the pre-`project` `user` origin every
    // writer stamped (see the correction above).
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        name: 'workspace-only',
        description: 'Workspace copy',
        source: 'local',
        installedAt: '2026-01-01T00:00:00.000Z',
        path: dir,
        origin: 'user',
      }),
      'utf-8',
    );
    await service.discoverSkills(testDir, 'demo');

    const detail = await service.getSkill('workspace-only');

    expect(detail.origin).toBe('project');
    expect(detail.path).toBe(dir);
    expect(detail.body).toBe('Workspace body');
    expect(detail.tags).toEqual(['scoped']);
    // Its own `SKILL.md` was read, so nothing is being shown from a stale
    // mirror — the install-record-only answer is what this used to degrade to
    // once the throw was gone.
    expect(detail.declarationsDiagnostic).toBeUndefined();
    // The list already knew all of this; the point is that the detail no longer
    // knows less than the list.
    expect(service.listSkills()[0]).toMatchObject({
      name: 'workspace-only',
      origin: 'project',
      path: dir,
    });
  });

  // #1602 precedence, PINNED rather than changed. `discoverSkills` scans the
  // project root FIRST and `<home>/skills` after it, and a later registration
  // wins the name — so a name present in both roots is the machine-wide
  // package, in the listing and now in the detail read that resolves from the
  // same location.
  test('a name in both roots reads as the machine-wide package', async () => {
    await service.createLocalSkill(
      { name: 'dup', description: 'Machine copy', body: 'Machine body' },
      testDir,
    );
    const projectDir = join(testDir, 'projects', 'demo', 'skills', 'dup');
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(
      join(projectDir, 'SKILL.md'),
      '---\nname: dup\ndescription: Workspace copy\n---\nWorkspace body',
      'utf-8',
    );
    writeFileSync(
      join(projectDir, 'skill.json'),
      JSON.stringify({
        name: 'dup',
        description: 'Workspace copy',
        source: 'local',
        installedAt: '2026-01-01T00:00:00.000Z',
        path: projectDir,
        origin: 'user',
      }),
      'utf-8',
    );
    await service.discoverSkills(testDir, 'demo');

    const detail = await service.getSkill('dup');

    expect(detail.description).toBe('Machine copy');
    expect(detail.body).toBe('Machine body');
    expect(detail.path).toBe(join(testDir, 'skills', 'dup'));
    expect(detail.origin).toBe('user');
  });

  // The same `user` -> `project` correction at the DETAIL fold, which is a
  // second reader of the same field and is where the two diverge if only one is
  // fixed. Asserted here in the negative direction: the correction must not
  // over-correct a genuinely machine-wide skill into a workspace one.
  test('the detail fold leaves a machine-wide user record alone', async () => {
    await service.createLocalSkill(
      { name: 'machine-wide', description: 'Mine', body: 'Body' },
      testDir,
    );

    expect(
      JSON.parse(
        readFileSync(
          join(testDir, 'skills', 'machine-wide', 'skill.json'),
          'utf-8',
        ),
      ).origin,
    ).toBe('user');
    expect((await service.getSkill('machine-wide')).origin).toBe('user');
  });

  /** A workspace package as it sits on disk: its own body, its own record. */
  function seedProjectSkill(
    name: string,
    overrides: Record<string, unknown> = {},
  ) {
    const dir = join(testDir, 'projects', 'demo', 'skills', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: Workspace copy\n---\nWorkspace body`,
      'utf-8',
    );
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        name,
        description: 'Workspace copy',
        source: 'local',
        installedAt: '2026-01-01T00:00:00.000Z',
        path: dir,
        origin: 'user',
        ...overrides,
      }),
      'utf-8',
    );
    return dir;
  }

  // Delta-review L3. The write path corrects the record too. Reaching it needs
  // a scoped call on a package the scope actually owns — which #1602 is what
  // made possible: before it, `updateLocalSkill`'s opening `getSkill(name)`
  // threw for a project-only package and this heal could only be reached
  // through a machine-wide duplicate of the same name, a shape the guard below
  // now (correctly) refuses. Disclosed: no route passes a slug today
  // (`routes/agents/skills.ts:184-188` calls `updateLocalSkill(name, updates,
  // getProjectHomeDir())`), so this heal is reachable from the service only
  // (#1619).
  test('updating a project-scoped skill heals a stale user record', async () => {
    const projectDir = seedProjectSkill('scoped');
    await service.discoverSkills(testDir, 'demo');

    const result = await service.updateLocalSkill(
      'scoped',
      { description: 'Workspace copy, edited' },
      testDir,
      'demo',
    );

    expect(result.success).toBe(true);
    const record = JSON.parse(
      readFileSync(join(projectDir, 'skill.json'), 'utf-8'),
    );
    expect(record.origin).toBe('project');
    expect(record.description).toBe('Workspace copy, edited');
    // And nothing was written to the machine root under that name.
    expect(existsSync(join(testDir, 'skills', 'scoped'))).toBe(false);
  });

  // #1619. `discoverSkills` clears the registry and re-scans exactly the roots
  // its arguments name. Every write re-discovered with the CALLER's slug, which
  // is `undefined` from every route, so any PUT dropped the project root and
  // workspace skills disappeared from the listing until something else
  // re-discovered with a slug.
  test('an unscoped write keeps the roots the registry was built with', async () => {
    seedProjectSkill('workspace-kept');
    await service.createLocalSkill(
      { name: 'machine-one', description: 'Mine', body: 'Body' },
      testDir,
    );
    await service.discoverSkills(testDir, 'demo');
    expect(
      service
        .listSkills()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(['machine-one', 'workspace-kept']);

    // The route's shape: a home, no slug.
    const result = await service.updateLocalSkill(
      'machine-one',
      { description: 'Edited' },
      testDir,
    );
    expect(result.success).toBe(true);

    expect(
      service
        .listSkills()
        .map((skill) => skill.name)
        .sort(),
      'the workspace package fell out of the listing after an unrelated write',
    ).toEqual(['machine-one', 'workspace-kept']);
  });

  // The same defect wearing its other face. A refusal returns BEFORE any
  // rediscovery, so two refusals in a row prove nothing — the write that drops
  // the project root has to be one that SUCCEEDS. Sequence: refuse the
  // workspace package, edit a machine package (which re-discovers), then refuse
  // the workspace package again. Unfixed, the second answer is "not found",
  // because the registry no longer holds the package the refusal is about.
  test('a workspace package is still editable after an unrelated write', async () => {
    const projectDir = seedProjectSkill('workspace-twice');
    await service.createLocalSkill(
      { name: 'machine-two', description: 'Mine', body: 'Body' },
      testDir,
    );
    await service.discoverSkills(testDir, 'demo');

    const before = await service.updateLocalSkill(
      'workspace-twice',
      { description: 'First' },
      testDir,
    );
    const unrelated = await service.updateLocalSkill(
      'machine-two',
      { description: 'Edited' },
      testDir,
    );
    const after = await service.updateLocalSkill(
      'workspace-twice',
      { description: 'Second' },
      testDir,
    );

    expect(before.success).toBe(true);
    expect(unrelated.success, 'the write that re-discovers did not run').toBe(
      true,
    );
    // Unfixed, this one answers "not found": the rediscovery after the
    // unrelated write dropped the project root, so the registry no longer held
    // the package this write resolves its directory from.
    expect(
      after.success,
      'the workspace package stopped being writable after an unrelated write',
    ).toBe(true);
    expect(readFileSync(join(projectDir, 'SKILL.md'), 'utf-8')).toContain(
      'Second',
    );
  });

  // #1619. The write now resolves the package DISCOVERY found, so an unscoped
  // PUT — the only kind a route makes — edits the workspace package in place.
  // Round 1 refused this, because the write derived `<home>/skills/<name>` from
  // a name and an absent slug and would have written a second package there;
  // the fix is to stop deriving it, and the refusal it needed goes with it.
  test('an unscoped update edits the workspace package where it lives', async () => {
    const projectDir = seedProjectSkill('workspace-owned');
    await service.discoverSkills(testDir, 'demo');

    const result = await service.updateLocalSkill(
      'workspace-owned',
      { description: 'Edited through the route, which passes no slug' },
      testDir,
    );

    // The filesystem first: the edit landed in the workspace package…
    expect(readFileSync(join(projectDir, 'SKILL.md'), 'utf-8')).toContain(
      'Edited through the route',
    );
    const record = JSON.parse(
      readFileSync(join(projectDir, 'skill.json'), 'utf-8'),
    );
    expect(record.description).toBe(
      'Edited through the route, which passes no slug',
    );
    expect(record.path).toBe(projectDir);
    // …its record went in BESIDE its body rather than into the machine root,
    // which is the split package #1619's second finding names…
    expect(
      existsSync(join(testDir, 'skills', 'workspace-owned')),
      'a second package appeared in the machine root',
    ).toBe(false);
    // …and the origin follows the root it is written to.
    expect(record.origin).toBe('project');
    expect(result.success).toBe(true);
  });

  // #1619 finding (a), the create mirror: called WITH a slug, the body went to
  // the project directory and the record — through a name-addressed save with
  // no slug — to `<home>/skills/<name>`. One package in two roots, each half
  // describing the other's location.
  test('a scoped create writes both halves into the same directory', async () => {
    const result = await service.createLocalSkill(
      { name: 'scoped-create', description: 'Workspace', body: 'Body' },
      testDir,
      'demo',
    );

    const projectDir = join(
      testDir,
      'projects',
      'demo',
      'skills',
      'scoped-create',
    );
    expect(existsSync(join(projectDir, 'SKILL.md'))).toBe(true);
    expect(
      existsSync(join(projectDir, 'skill.json')),
      'the record did not land beside its body',
    ).toBe(true);
    expect(
      existsSync(join(testDir, 'skills', 'scoped-create')),
      'a record was written into the machine root instead',
    ).toBe(false);
    expect(result.success).toBe(true);
    // …and the package it wrote is the package the read answers from.
    const detail = await service.getSkill('scoped-create');
    expect(detail.path).toBe(projectDir);
    expect(detail.origin).toBe('project');
  });

  // A rename moves a package WITHIN its own root. Derived from a name and a
  // slug, the destination was `<home>/skills/<newName>` for a workspace
  // package — a move across roots nobody asked for.
  test('renaming a workspace package keeps it in its own root', async () => {
    seedProjectSkill('before-rename');
    await service.discoverSkills(testDir, 'demo');

    const result = await service.updateLocalSkill(
      'before-rename',
      { name: 'after-rename' },
      testDir,
    );

    const projectRoot = join(testDir, 'projects', 'demo', 'skills');
    expect(existsSync(join(projectRoot, 'after-rename', 'SKILL.md'))).toBe(
      true,
    );
    expect(existsSync(join(projectRoot, 'before-rename'))).toBe(false);
    expect(
      existsSync(join(testDir, 'skills', 'after-rename')),
      'the rename moved the package into the machine root',
    ).toBe(false);
    expect(result.success).toBe(true);
    expect(service.listSkills()[0].origin).toBe('project');
  });

  // The lock names the directory the write touches, so two callers holding
  // different slugs for one package can no longer take two different locks.
  test('the mutation capability is taken on the package directory', async () => {
    const projectDir = seedProjectSkill('locked');
    await service.discoverSkills(testDir, 'demo');
    // Observed from INSIDE the write, which is the only moment the capability
    // is held — no polling, no race.
    let held: { own: boolean; machineRoot: boolean } | undefined;
    mockConfigLoader.saveSkillIn.mockImplementationOnce(
      async (directory: string, config: unknown) => {
        held = {
          own: existsSync(`${projectDir}.mutation`),
          machineRoot: existsSync(join(testDir, 'skills', 'locked.mutation')),
        };
        return saveSkillConfigIn(testDir, directory, config as never);
      },
    );

    await service.updateLocalSkill(
      'locked',
      { description: 'Edited' },
      testDir,
    );

    expect(
      held?.own,
      'the workspace package was not locked in its own root',
    ).toBe(true);
    expect(
      held?.machineRoot,
      'a lock was taken in the machine root, where the package is not',
    ).toBe(false);
    // Released on the way out.
    expect(existsSync(`${projectDir}.mutation`)).toBe(false);
  });

  // Review M2, a regression against main. `<home>/plugins` is scanned AFTER
  // `<home>/skills`, so a plugin package sharing a name takes the registry key
  // from the user's own package. Refusing a remove on the registry entry alone
  // then meant the user could not delete their own skill, and the message
  // blamed a plugin they may never have heard of. Main removed it, because its
  // target was name-derived.
  test('a package of ours is removable even when a plugin holds its name', async () => {
    const mine = join(testDir, 'skills', 'hello');
    mkdirSync(mine, { recursive: true });
    writeFileSync(
      join(mine, 'SKILL.md'),
      '---\nname: hello\ndescription: Mine\n---\nMy body',
      'utf-8',
    );
    const pluginCopy = join(testDir, 'plugins', 'acme', 'skills', 'hello');
    mkdirSync(pluginCopy, { recursive: true });
    writeFileSync(
      join(pluginCopy, 'SKILL.md'),
      '---\nname: hello\ndescription: From a plugin\n---\nPlugin body',
      'utf-8',
    );
    await service.discoverSkills(testDir);
    // The plugin package holds the name — the precondition, asserted so this
    // cannot pass by the collision never happening.
    expect(service.listSkills().find((s) => s.name === 'hello')?.origin).toBe(
      'plugin',
    );

    const result = await service.removeSkill('hello', testDir);

    expect(
      existsSync(mine),
      'the user could not delete their own package',
    ).toBe(false);
    expect(existsSync(pluginCopy), "the plugin's own package was deleted").toBe(
      true,
    );
    expect(result.success).toBe(true);
  });

  // …and with nothing of ours there, the refusal is what answers, naming the
  // root rather than reporting the skill as absent.
  test('a plugin-only package is refused, not reported missing', async () => {
    const pluginOnly = join(
      testDir,
      'plugins',
      'acme',
      'skills',
      'only-theirs',
    );
    mkdirSync(pluginOnly, { recursive: true });
    writeFileSync(
      join(pluginOnly, 'SKILL.md'),
      '---\nname: only-theirs\ndescription: From a plugin\n---\nBody',
      'utf-8',
    );
    await service.discoverSkills(testDir);

    const result = await service.removeSkill('only-theirs', testDir);

    expect(existsSync(pluginOnly)).toBe(true);
    expect(result.success).toBe(false);
    expect(result.message).toContain('is not a skills root Station writes');
  });

  // Review H1, the worst defect this branch produced. `removeSkillIfRevision`
  // digested `resolveSkillDir(home, name, slug)` — name-derived — and then
  // called a remove that resolved through `packageDirectoryFor`, so it verified
  // one tree and deleted another. Setup-import's rollback then recorded a
  // successful compensation for a tree it never verified, and a package it
  // never created was gone.
  //
  // The precondition is ordinary: discovery keys on the FRONTMATTER name, so a
  // machine package whose directory is named differently registers under the
  // frontmatter name, and a workspace package genuinely of that name registers
  // second in the same key.
  test('compare-delete verifies and deletes the same package', async () => {
    // The divergence, built deliberately: the package that answers to `shared`
    // is the WORKSPACE one (discovery scans the project root and the machine
    // root, and this name exists only in the project root), while
    // `<home>/skills/shared` is a directory holding a DIFFERENT package —
    // discovery keys on the frontmatter name, so it registers as
    // `machine-only` and never claims `shared`.
    //
    // `packageDirectoryFor` therefore answers with the project directory and
    // `resolveSkillDir(home, name, undefined)` answers with the machine one.
    // Verifying through one and deleting through the other is H1.
    const projectDir = seedProjectSkill('shared');
    const nameDerived = join(testDir, 'skills', 'shared');
    mkdirSync(nameDerived, { recursive: true });
    writeFileSync(
      join(nameDerived, 'SKILL.md'),
      '---\nname: machine-only\ndescription: A different package\n---\nMachine body',
      'utf-8',
    );
    await service.discoverSkills(testDir, 'demo');

    const revision = await service.localSkillRevision('shared', testDir);
    const result = await service.removeSkillIfRevision(
      'shared',
      revision,
      testDir,
    );

    // The filesystem first. The verified package is the deleted one, and the
    // package that was never verified is untouched, byte for byte.
    expect(
      readFileSync(join(nameDerived, 'SKILL.md'), 'utf-8'),
      'compare-delete destroyed a package it never verified',
    ).toContain('Machine body');
    expect(existsSync(projectDir)).toBe(false);
    expect(result).toEqual({ removed: true, conflict: false });
  });

  // The destructive half, in the shape the reviewer's probe took: the caller
  // holds the revision of the package IT created — `<home>/skills/<name>`,
  // which setup-import's rollback made — while the name now resolves to a
  // workspace package. Verifying through the name-derived directory then
  // matches, and the delete lands on a package that was never verified and
  // never created by this caller.
  test("compare-delete will not delete one package on another package's revision", async () => {
    const projectDir = seedProjectSkill('rollback-target');
    const nameDerived = join(testDir, 'skills', 'rollback-target');
    mkdirSync(nameDerived, { recursive: true });
    writeFileSync(
      join(nameDerived, 'SKILL.md'),
      '---\nname: setup-import-created\ndescription: Created by rollback\n---\nImported body',
      'utf-8',
    );
    await service.discoverSkills(testDir, 'demo');
    // The revision of the package the CALLER created, not of the one the name
    // resolves to.
    const revision = await localSkillRevisionFromDirectory(nameDerived);

    const result = await service.removeSkillIfRevision(
      'rollback-target',
      revision,
      testDir,
    );

    expect(
      existsSync(projectDir),
      'a package was deleted on a revision taken from a different package',
    ).toBe(true);
    expect(readFileSync(join(projectDir, 'SKILL.md'), 'utf-8')).toContain(
      'Workspace body',
    );
    expect(result).toEqual({ removed: false, conflict: true });
  });

  // A stale revision still refuses, and refusing must not delete either tree.
  test('compare-delete on a changed package deletes nothing', async () => {
    const projectDir = seedProjectSkill('changed');
    await service.discoverSkills(testDir, 'demo');
    const revision = await service.localSkillRevision('changed', testDir);
    writeFileSync(
      join(projectDir, 'SKILL.md'),
      '---\nname: changed\ndescription: Edited by hand\n---\nEdited',
      'utf-8',
    );

    const result = await service.removeSkillIfRevision(
      'changed',
      revision,
      testDir,
    );

    expect(existsSync(projectDir)).toBe(true);
    expect(result).toEqual({ removed: false, conflict: true });
  });

  // A remove deletes a package TREE, so the rule that decides whether Station
  // owns a package decides this too.
  test('a remove deletes the discovered package, and refuses a foreign root', async () => {
    const projectDir = seedProjectSkill('removable');
    const pluginSkillDir = join(testDir, 'plugins', 'acme', 'skills', 'served');
    mkdirSync(pluginSkillDir, { recursive: true });
    writeFileSync(
      join(pluginSkillDir, 'SKILL.md'),
      '---\nname: served\ndescription: From a plugin\n---\nBody',
      'utf-8',
    );
    await service.discoverSkills(testDir, 'demo');

    const refused = await service.removeSkill('served', testDir);
    expect(existsSync(pluginSkillDir), 'a plugin root was deleted').toBe(true);
    expect(refused.success).toBe(false);
    expect(refused.message).toContain('is not a skills root Station writes');

    const removed = await service.removeSkill('removable', testDir);
    expect(existsSync(projectDir)).toBe(false);
    expect(removed.success).toBe(true);
  });

  // The refusal that remains: a root Station serves from and does not own.
  test('an update of a package in a root Station does not own is refused', async () => {
    const pluginSkillDir = join(
      testDir,
      'plugins',
      'acme',
      'skills',
      'shipper',
    );
    mkdirSync(pluginSkillDir, { recursive: true });
    writeFileSync(
      join(pluginSkillDir, 'SKILL.md'),
      '---\nname: shipper\ndescription: From a plugin\n---\nPlugin body',
      'utf-8',
    );
    await service.discoverSkills(testDir);

    const result = await service.updateLocalSkill(
      'shipper',
      { description: 'Edited' },
      testDir,
    );

    expect(existsSync(join(testDir, 'skills', 'shipper'))).toBe(false);
    expect(readFileSync(join(pluginSkillDir, 'SKILL.md'), 'utf-8')).toContain(
      'Plugin body',
    );
    expect(result.success).toBe(false);
    expect(result.message).toContain(pluginSkillDir);
    expect(result.message).toContain('is not a skills root Station writes');
  });

  // The shape that made the machine root dangerous in the first place: a
  // record-only directory left there by a scoped `createLocalSkill` before
  // #1619 (`configLoader.saveSkill` had no slug either). The write must not go
  // near it — it belongs to no discovered package — and the workspace package
  // it shadows is edited where it lives.
  test('a stray record in the machine root is not what an update writes to', async () => {
    const projectDir = seedProjectSkill('shadowed');
    const machineDir = join(testDir, 'skills', 'shadowed');
    mkdirSync(machineDir, { recursive: true });
    const stray = JSON.stringify({ name: 'shadowed', source: 'local' });
    writeFileSync(join(machineDir, 'skill.json'), stray, 'utf-8');
    await service.discoverSkills(testDir, 'demo');

    const result = await service.updateLocalSkill(
      'shadowed',
      { description: 'Edited' },
      testDir,
    );

    expect(result.success).toBe(true);
    // The stray record is untouched, byte for byte…
    expect(readFileSync(join(machineDir, 'skill.json'), 'utf-8')).toBe(stray);
    expect(existsSync(join(machineDir, 'SKILL.md'))).toBe(false);
    // …and the edit went to the package that actually exists.
    expect(readFileSync(join(projectDir, 'SKILL.md'), 'utf-8')).toContain(
      'Edited',
    );
  });

  // Review L2. A package copied into a new directory keeps the record it was
  // copied with. That record's `legacyIds`/`provenance`/`installedAt` are the
  // ORIGINAL skill's, so answering the new name with them hands a caller
  // another skill's identity — and `resolveSkillName` would route that skill's
  // legacy ids here. A record that does not claim this name is no record.
  test("a record that names a different skill is not this skill's record", async () => {
    const dir = join(testDir, 'skills', 'renamed');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: renamed\ndescription: Copied and renamed\n---\nBody',
      'utf-8',
    );
    // The bytes a copy of `origin-skill` carries with it.
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        name: 'origin-skill',
        description: 'The skill this record was written for',
        source: 'registry',
        installedAt: '2020-01-01T00:00:00.000Z',
        path: join(testDir, 'skills', 'origin-skill'),
        legacyIds: ['11111111-2222-3333-4444-555555555555'],
      }),
      'utf-8',
    );
    await service.discoverSkills(testDir);

    const detail = await service.getSkill('renamed');

    // The package answers — it exists, and #1614 is that a package on disk is
    // an answer — but NOT with the other skill's identity.
    expect(detail.body).toBe('Body');
    expect(detail.description).toBe('Copied and renamed');
    expect(detail.source).toBeUndefined();
    expect(detail.installedAt).toBeUndefined();
    expect(detail.legacyIds).toBeUndefined();
    expect(detail.path).toBe(dir);
    expect(detail.installRecordDiagnostic).toContain("claims 'origin-skill'");
    // …and neither does the listing, which used to read the same bytes without
    // the claim check and hand out the other skill's source and version.
    const listed = service.listSkills()[0];
    expect(listed.source).toBeUndefined();
    expect(listed.legacyIds).toBeUndefined();
    expect(listed.path).toBe(dir);
    // The clinching one: that skill's legacy id no longer resolves to this
    // package, so a caller holding it is not silently handed the wrong skill.
    expect(
      service.resolveSkillName('11111111-2222-3333-4444-555555555555'),
    ).toBeUndefined();
  });

  // #1614. The package the listing has always answered for and the detail
  // refused: a `SKILL.md` authored by hand, with no `skill.json` beside it.
  test('a hand-authored package with no install record has a detail read', async () => {
    const dir = join(testDir, 'skills', 'hand-authored');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: hand-authored\ndescription: Written by hand\ntags:\n  - mine\n---\nHand-written body',
      'utf-8',
    );
    await service.discoverSkills(testDir);

    const detail = await service.getSkill('hand-authored');

    expect(detail.body).toBe('Hand-written body');
    expect(detail.description).toBe('Written by hand');
    expect(detail.tags).toEqual(['mine']);
    expect(detail.path).toBe(dir);
    // Derived from the ROOT it sits in, exactly as the listing derives it and
    // exactly as a workspace package derives `project` from its root.
    expect(detail.origin).toBe('user');
    // NOTHING states where it came from, so nothing is claimed.
    expect(detail.source).toBeUndefined();
    expect(detail.installedAt).toBeUndefined();
    expect(detail.version).toBeUndefined();
    expect(detail.provenance).toBeUndefined();
    expect(detail.installRecordDiagnostic).toContain('no install record');
    // The declarations DID come from SKILL.md, which is a different fact and
    // keeps its own field — the reason these are two fields and not one.
    expect(detail.declarationsDiagnostic).toBeUndefined();
    // And the list says the same things about the same package.
    expect(service.listSkills()[0]).toMatchObject({
      name: 'hand-authored',
      description: 'Written by hand',
      origin: 'user',
      path: dir,
    });
  });

  test('a hand-authored package under the project root reads as project', async () => {
    const dir = join(testDir, 'projects', 'demo', 'skills', 'workspace-hand');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: workspace-hand\ndescription: Workspace, by hand\n---\nBody',
      'utf-8',
    );
    await service.discoverSkills(testDir, 'demo');

    const detail = await service.getSkill('workspace-hand');

    expect(detail.origin).toBe('project');
    expect(detail.path).toBe(dir);
    expect(detail.source).toBeUndefined();
    expect(detail.installRecordDiagnostic).toContain('no install record');
  });

  // The one case that genuinely has nothing to answer from: the registry
  // remembers a package whose body has since gone, and no record ever existed.
  test('neither a record nor a body is still not found', async () => {
    const dir = join(testDir, 'skills', 'vanished');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: vanished\ndescription: Here for now\n---\nBody',
      'utf-8',
    );
    await service.discoverSkills(testDir);
    rmSync(join(dir, 'SKILL.md'));

    await expect(service.getSkill('vanished')).rejects.toThrow(
      "Skill 'vanished' not found",
    );
  });

  test('a recorded origin that is not user still wins over the path', async () => {
    // `registry`/`plugin`/`package`/`migrated-playbook` say where a skill CAME
    // FROM, which no path can restate: a registry install sitting in a project
    // root is still a registry install. Only the writable pair is scope.
    const dir = join(testDir, 'projects', 'demo', 'skills', 'installed-here');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: installed-here\ndescription: Installed from Registry\n---\nBody',
    );
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        name: 'installed-here',
        source: 'registry',
        path: dir,
        origin: 'registry',
      }),
      'utf-8',
    );
    await service.discoverSkills(testDir, 'demo');

    expect(service.listSkills()[0].origin).toBe('registry');
  });

  test('creating a skill under a project records the scope it was written into', async () => {
    await service.createLocalSkill(
      { name: 'scoped-skill', description: 'Ours', body: 'Body' },
      testDir,
      'demo',
    );

    // The record on disk, not just the listing: `skill.json`'s `origin`
    // outranks the path derivation on every later read, so a `user` stamped
    // here would survive being discovered from the project root.
    const record = JSON.parse(
      readFileSync(
        join(
          testDir,
          'projects',
          'demo',
          'skills',
          'scoped-skill',
          'skill.json',
        ),
        'utf-8',
      ),
    );
    expect(record.origin).toBe('project');
    expect(service.listSkills()[0].origin).toBe('project');
  });

  test('isSkillWritable is false for a skill served from a plugin root', async () => {
    const pluginSkillDir = join(
      testDir,
      'plugins',
      'acme',
      'skills',
      'shipper',
    );
    mkdirSync(pluginSkillDir, { recursive: true });
    writeFileSync(
      join(pluginSkillDir, 'SKILL.md'),
      '---\nname: shipper\ndescription: From a plugin\n---\nBody',
    );
    await service.createLocalSkill(
      { name: 'mine', description: 'Local', body: 'Body' },
      testDir,
    );
    await service.discoverSkills(testDir);

    expect(service.isSkillWritable('shipper', testDir)).toBe(false);
    expect(service.isSkillWritable('mine', testDir)).toBe(true);
    expect(service.isSkillWritable('not-discovered-yet', testDir)).toBe(true);
    expect(
      service.listSkills().find((skill) => skill.name === 'shipper')?.origin,
    ).toBe('plugin');
  });

  test('an imported description cannot forge frontmatter (review finding 2)', async () => {
    // The exact scenario: a decoded scalar whose text is itself a `command:`
    // block. It must round-trip AS A DESCRIPTION, and must not enable a
    // command nobody declared.
    const hostile = 'Normal summary\ncommand:\n  enabled: true';
    await service.createLocalSkill(
      {
        name: 'imported-skill',
        description: hostile,
        category: 'a: b # not a comment',
        tags: ['tag: with colon', '- leading dash'],
        agent: 'agent\nglobal: true',
        body: 'Body',
      },
      testDir,
    );
    await service.discoverSkills(testDir);

    const listed = service.listSkills();
    expect(listed).toHaveLength(1);
    expect(listed[0].command).toBeUndefined();

    const reloaded = await service.getSkill('imported-skill');
    expect(reloaded.description).toBe(hostile);
    expect(reloaded.category).toBe('a: b # not a comment');
    expect(reloaded.tags).toEqual(['tag: with colon', '- leading dash']);
    expect(reloaded.agent).toBe('agent\nglobal: true');
    expect(reloaded.global).toBeUndefined();
    expect(reloaded.command).toBeUndefined();
  });

  test('a name or description that would close the frontmatter early is quoted', async () => {
    await service.createLocalSkill(
      {
        name: 'edgy',
        description: '---\nnot-a-key: value',
        body: 'Body',
      },
      testDir,
    );
    await service.discoverSkills(testDir);

    expect(service.getSkillCount()).toBe(1);
    expect((await service.getSkill('edgy')).description).toBe(
      '---\nnot-a-key: value',
    );
  });

  test('a command removed from SKILL.md stays removed in BOTH list and detail', async () => {
    await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Body',
        command: { enabled: true, name: 'ship' },
      },
      testDir,
    );
    const skillPath = join(testDir, 'skills', 'author-skill', 'SKILL.md');

    // The mirror in skill.json still says `enabled: true` — that is the point.
    expect(
      JSON.parse(
        readFileSync(
          join(testDir, 'skills', 'author-skill', 'skill.json'),
          'utf-8',
        ),
      ).command,
    ).toEqual({ enabled: true, name: 'ship' });

    writeFileSync(
      skillPath,
      '---\nname: author-skill\ndescription: Author me\n---\n\nBody',
    );
    await service.discoverSkills(testDir);

    expect(service.listSkills()[0].command).toBeUndefined();
    const detail = await service.getSkill('author-skill');
    expect(detail.command).toBeUndefined();
    expect(detail.declarationsDiagnostic).toBeUndefined();
  });

  test('an unreadable SKILL.md falls back to the mirror WITH a diagnostic', async () => {
    await service.createLocalSkill(
      {
        name: 'author-skill',
        description: 'Author me',
        body: 'Body',
        command: { enabled: true, name: 'ship' },
      },
      testDir,
    );
    rmSync(join(testDir, 'skills', 'author-skill', 'SKILL.md'));

    const detail = await service.getSkill('author-skill');
    expect(detail.command).toEqual({ enabled: true, name: 'ship' });
    expect(detail.declarationsDiagnostic).toContain('SKILL.md is missing');
    expect(detail.declarationsDiagnostic).toContain('may be stale');
  });

  test('two skills claiming one command word: one wins, the other says why', async () => {
    for (const name of ['zebra-skill', 'alpha-skill']) {
      const dir = join(testDir, 'skills', name);
      mkdirSync(dir, { recursive: true });
      // Hand-authored BODIES, because the write path refuses the second claim
      // outright (`assertSkillCommandAllowed`) — a clash only exists on disk.
      writeFileSync(
        join(dir, 'SKILL.md'),
        `---\nname: ${name}\ndescription: D\ncommand:\n  enabled: true\n  name: "ship"\n---\nBody`,
      );
      // …each with the install record a real package has, so the detail
      // assertion below reads a record rather than the recordless answer
      // #1614 added (which has its own cases above). The gap that comment used
      // to describe — a discovered package with no `skill.json` having no
      // detail read at all — is fixed; this fixture simply is not that case.
      writeFileSync(
        join(dir, 'skill.json'),
        JSON.stringify({
          name,
          description: 'D',
          source: 'local',
          installedAt: '2026-01-01T00:00:00.000Z',
          path: dir,
        }),
        'utf-8',
      );
    }
    await service.discoverSkills(testDir);

    const byName = new Map(
      service.listSkills().map((skill) => [skill.name, skill]),
    );
    expect(byName.get('alpha-skill')?.command?.enabled).toBe(true);
    expect(byName.get('alpha-skill')?.commandDiagnostic).toBeUndefined();
    expect(byName.get('zebra-skill')?.command?.enabled).toBe(false);
    expect(byName.get('zebra-skill')?.commandDiagnostic).toContain(
      "'alpha-skill'",
    );

    // Detail agrees with the listing — one derivation, not two.
    const detail = await service.getSkill('zebra-skill');
    expect(detail.command?.enabled).toBe(false);
    expect(detail.commandDiagnostic).toContain("'alpha-skill'");
  });

  test('an untypable command declared on disk is disabled, never silently enabled', async () => {
    const dir = join(testDir, 'skills', 'shouty');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'SKILL.md'),
      '---\nname: shouty\ndescription: D\ncommand:\n  enabled: true\n  name: "Ship It"\n---\nBody',
    );
    await service.discoverSkills(testDir);

    const listed = service.listSkills()[0];
    expect(listed.command?.enabled).toBe(false);
    expect(listed.commandDiagnostic).toContain(SKILL_COMMAND_NAME_RULE);
  });

  test('createLocalSkill refuses a prototype-affecting name at the SERVICE seam', async () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      await expect(
        service.createLocalSkill(
          { name, description: 'D', body: 'Body' },
          testDir,
        ),
      ).rejects.toThrow(/Invalid skill name/);
      expect(existsSync(join(testDir, 'skills', name))).toBe(false);
    }
    expect(mockConfigLoader.saveSkill).not.toHaveBeenCalled();
  });

  test('createLocalSkill refuses a name that escapes the skills directory', async () => {
    await expect(
      service.createLocalSkill(
        { name: '../escaped', description: 'D', body: 'Body' },
        testDir,
      ),
    ).rejects.toThrow(/Invalid skill name/);
  });

  test('a rename to a prototype-affecting name is refused too', async () => {
    await service.createLocalSkill(
      { name: 'author-skill', description: 'D', body: 'Body' },
      testDir,
    );
    await expect(
      service.updateLocalSkill('author-skill', { name: '__proto__' }, testDir),
    ).rejects.toThrow(/Invalid skill name/);
    expect(existsSync(join(testDir, 'skills', '__proto__'))).toBe(false);
  });

  test("a package skill arriving later cannot take the user's /command", async () => {
    // The user owns /ship.
    await service.createLocalSkill(
      {
        name: 'zebra-release',
        description: 'Mine',
        body: 'Body',
        command: { enabled: true, name: 'ship' },
      },
      testDir,
    );
    expect(service.listSkills()[0].command?.enabled).toBe(true);

    // A package update ships a skill claiming the same word, under a name that
    // sorts FIRST — the case a name-only tiebreak got wrong.
    const packageRoot = join(testDir, 'canonical');
    const packageSkill = join(packageRoot, 'alpha-release');
    mkdirSync(packageSkill, { recursive: true });
    writeFileSync(
      join(packageSkill, 'SKILL.md'),
      '---\nname: alpha-release\ndescription: From a package\ncommand:\n  enabled: true\n  name: "ship"\n---\nBody',
    );
    const withPackage = new SkillService(mockConfigLoader as any, mockLogger, {
      canonicalSources: [
        { label: 'flow-agents' as const, root: packageRoot, version: '1.0.0' },
      ],
    });
    await withPackage.discoverSkills(testDir);

    const byName = new Map(
      withPackage.listSkills().map((skill) => [skill.name, skill]),
    );
    expect(byName.get('zebra-release')?.origin).toBe('user');
    expect(byName.get('zebra-release')?.command?.enabled).toBe(true);
    expect(byName.get('zebra-release')?.commandDiagnostic).toBeUndefined();
    expect(byName.get('alpha-release')?.origin).toBe('package');
    expect(byName.get('alpha-release')?.command?.enabled).toBe(false);
    expect(byName.get('alpha-release')?.commandDiagnostic).toContain(
      "'zebra-release'",
    );

    // Detail agrees with the listing for both.
    expect((await withPackage.getSkill('alpha-release')).command?.enabled).toBe(
      false,
    );
  });

  test('a mirrored command that clashes is disabled with a diagnostic, not served raw', async () => {
    // Delta finding 3: with SKILL.md gone the detail returned the install
    // record verbatim, so a mirrored `enabled: true` came back active even
    // though another skill owns the word and the listing had dropped this
    // skill entirely. The write path refuses a second claimant, so the only
    // way this state arises is a hand-edited (or stale) mirror — which is
    // exactly the case being pinned.
    await service.createLocalSkill(
      {
        name: 'owner-skill',
        description: 'Owns it',
        body: 'Body',
        command: { enabled: true, name: 'ship' },
      },
      testDir,
    );
    await service.createLocalSkill(
      { name: 'stale-skill', description: 'Stale mirror', body: 'Body' },
      testDir,
    );
    const configPath = join(testDir, 'skills', 'stale-skill', 'skill.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.command = { enabled: true, name: 'ship' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    rmSync(join(testDir, 'skills', 'stale-skill', 'SKILL.md'));
    await service.discoverSkills(testDir);

    expect(service.listSkills().map((skill) => skill.name)).not.toContain(
      'stale-skill',
    );

    const detail = await service.getSkill('stale-skill');
    expect(detail.declarationsDiagnostic).toContain('SKILL.md is missing');
    expect(detail.command?.enabled).toBe(false);
    expect(detail.commandDiagnostic).toContain("'owner-skill'");
  });

  test('a mirrored command word nobody can type is disabled in the detail too', async () => {
    await service.createLocalSkill(
      { name: 'shouty', description: 'D', body: 'Body' },
      testDir,
    );
    // Hand-edit the mirror to a word the write path would have refused.
    const configPath = join(testDir, 'skills', 'shouty', 'skill.json');
    const config = JSON.parse(readFileSync(configPath, 'utf-8'));
    config.command = { enabled: true, name: 'Ship It' };
    writeFileSync(configPath, JSON.stringify(config, null, 2));
    rmSync(join(testDir, 'skills', 'shouty', 'SKILL.md'));
    await service.discoverSkills(testDir);

    const detail = await service.getSkill('shouty');
    expect(detail.command?.enabled).toBe(false);
    expect(detail.commandDiagnostic).toContain(SKILL_COMMAND_NAME_RULE);
  });

  test('the mirror still derives variables from the body, not from declarations', async () => {
    await service.createLocalSkill(
      {
        name: 'varied',
        description: 'D',
        body: 'Only {{used}} substitutes',
        variables: [{ name: 'used' }, { name: 'stale' }],
      },
      testDir,
    );
    rmSync(join(testDir, 'skills', 'varied', 'SKILL.md'));

    const detail = await service.getSkill('varied');
    expect(detail.variables).toEqual([{ name: 'used' }]);
    expect(detail.declarationsDiagnostic).toContain('SKILL.md is missing');
  });

  test('a rename cannot take a command word another skill holds (delta-2 b)', async () => {
    // A package owns /beta. The local skill `alpha` is command-enabled with no
    // explicit name, so its word is DERIVED — renaming it to `beta` changes
    // that word without the request ever mentioning a command.
    const packageRoot = join(testDir, 'canonical');
    const packageSkill = join(packageRoot, 'beta');
    mkdirSync(packageSkill, { recursive: true });
    writeFileSync(
      join(packageSkill, 'SKILL.md'),
      '---\nname: beta\ndescription: From a package\ncommand:\n  enabled: true\n---\nBody',
    );
    const withPackage = new SkillService(mockConfigLoader as any, mockLogger, {
      canonicalSources: [
        { label: 'flow-agents' as const, root: packageRoot, version: '1.0.0' },
      ],
    });
    await withPackage.createLocalSkill(
      {
        name: 'alpha',
        description: 'Mine',
        body: 'Body',
        command: { enabled: true },
      },
      testDir,
    );
    await withPackage.discoverSkills(testDir);

    await expect(
      withPackage.updateLocalSkill('alpha', { name: 'beta' }, testDir),
    ).rejects.toThrow(/already used by the skill 'beta'/);
    // Nothing was written under the new name.
    expect(existsSync(join(testDir, 'skills', 'beta'))).toBe(false);
  });

  test('a rename MOVES the package: old directory gone, new one whole', async () => {
    await service.createLocalSkill(
      {
        name: 'alpha',
        description: 'Mine',
        body: 'Body text',
        command: { enabled: true },
      },
      testDir,
    );

    await expect(
      service.updateLocalSkill('alpha', { name: 'gamma' }, testDir),
    ).resolves.toMatchObject({ success: true });

    const oldDir = join(testDir, 'skills', 'alpha');
    const newDir = join(testDir, 'skills', 'gamma');
    // Split state was the defect: body under the old name, install record
    // under the new one, pointing back at the old directory.
    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(newDir, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(newDir, 'skill.json'))).toBe(true);
    expect(readFileSync(join(newDir, 'SKILL.md'), 'utf-8')).toContain(
      'name: "gamma"',
    );
    const record = JSON.parse(
      readFileSync(join(newDir, 'skill.json'), 'utf-8'),
    );
    expect(record.name).toBe('gamma');
    expect(record.path).toBe(newDir);

    // Discovery sees exactly one skill, under the new name.
    await service.discoverSkills(testDir);
    expect(service.listSkills().map((skill) => skill.name)).toEqual(['gamma']);

    // …and uninstalling the new name actually removes the skill.
    await service.removeSkill('gamma', testDir);
    expect(existsSync(newDir)).toBe(false);
  });

  // A rename is a create under a new name, so it refuses on the same rule
  // `createLocalSkill` does — the NAME, wherever that name's package lives.
  test('a rename onto a name another package holds is refused, moving nothing', async () => {
    await service.createLocalSkill(
      { name: 'alpha', description: 'Mine', body: 'Body' },
      testDir,
    );
    await service.createLocalSkill(
      { name: 'taken', description: 'Theirs', body: 'Other body' },
      testDir,
    );

    const result = await service.updateLocalSkill(
      'alpha',
      { name: 'taken' },
      testDir,
    );

    // The packages first, so removing the refusal reds on the move rather than
    // on the answer that would have prevented it.
    expect(existsSync(join(testDir, 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(
      readFileSync(join(testDir, 'skills', 'taken', 'SKILL.md'), 'utf-8'),
    ).toContain('Other body');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/already exists/);
  });

  // The DIRECTORY half of that refusal, which the name rule above cannot reach:
  // a directory with no `SKILL.md` is not a discovered package, so `hasSkill`
  // says nothing about it and only the path check stands between a rename and
  // whatever is sitting there.
  test('a rename onto a directory that is not a discovered package still refuses', async () => {
    await service.createLocalSkill(
      { name: 'alpha', description: 'Mine', body: 'Body' },
      testDir,
    );
    const squatted = join(testDir, 'skills', 'taken');
    mkdirSync(squatted, { recursive: true });
    writeFileSync(join(squatted, 'notes.txt'), 'Not a skill', 'utf-8');

    await expect(
      service.updateLocalSkill('alpha', { name: 'taken' }, testDir),
    ).rejects.toThrow(/already exists/);

    expect(existsSync(join(testDir, 'skills', 'alpha', 'SKILL.md'))).toBe(true);
    expect(readFileSync(join(squatted, 'notes.txt'), 'utf-8')).toBe(
      'Not a skill',
    );
  });

  // Review round 2, M2. The name a rename takes can belong to a package in a
  // root this write never looks at: `existsSync(nextDir)` only sees
  // `<home>/skills`, and `<home>/skills` is scanned LAST, so the renamed local
  // package took the canonical package's name and the canonical one dropped out
  // of the listing entirely.
  test('a rename onto a canonical package name is refused and the package stays listed', async () => {
    const packageRoot = join(testDir, 'canonical');
    const packageSkill = join(packageRoot, 'pdf');
    mkdirSync(packageSkill, { recursive: true });
    writeFileSync(
      join(packageSkill, 'SKILL.md'),
      '---\nname: pdf\ndescription: From a package\n---\nPackage body',
      'utf-8',
    );
    const withPackage = new SkillService(mockConfigLoader as any, mockLogger, {
      canonicalSources: [
        { label: 'flow-agents' as const, root: packageRoot, version: '1.0.0' },
      ],
    });
    await withPackage.createLocalSkill(
      { name: 'notes', description: 'Mine', body: 'Body' },
      testDir,
    );
    expect(
      withPackage
        .listSkills()
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(['notes', 'pdf']);

    const result = await withPackage.updateLocalSkill(
      'notes',
      { name: 'pdf' },
      testDir,
    );

    // The listing first: unguarded, the local package moves to
    // `<home>/skills/pdf`, is registered last, wins the name, and the canonical
    // package is simply gone from the answer — which is the defect, not the
    // refusal's absence.
    const listed = new Map(
      withPackage.listSkills().map((skill) => [skill.name, skill]),
    );
    expect(
      listed.get('pdf')?.origin,
      'the local package took the canonical package name',
    ).toBe('package');
    expect(listed.get('pdf')?.path).toBe(packageSkill);
    expect(listed.get('notes'), 'the renamed package vanished').toBeDefined();
    expect(existsSync(join(testDir, 'skills', 'notes', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(testDir, 'skills', 'pdf'))).toBe(false);
    expect(result.success).toBe(false);
    expect(result.message).toContain('pdf');
  });

  // Review round 2, L3, at the seam it actually reaches: with no `SKILL.md`
  // nothing discovers this package, so the detail read falls to the loader's
  // name-derived path — the branch the registry cannot cover. `nextName` is
  // read back off that record, so a disowned one renamed `bar` to `foo` on a
  // request that asked for no rename at all.
  test('an update never renames a skill from a record that claims another name', async () => {
    const dir = join(testDir, 'skills', 'bar');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'skill.json'),
      JSON.stringify({
        name: 'foo',
        source: 'local',
        installedAt: '2020-01-01T00:00:00.000Z',
        path: join(testDir, 'skills', 'foo'),
      }),
      'utf-8',
    );
    await service.discoverSkills(testDir);

    await expect(
      service.updateLocalSkill('bar', { body: 'Edited' }, testDir),
    ).rejects.toThrow("Skill 'bar' not found");

    expect(
      existsSync(join(testDir, 'skills', 'foo')),
      'the update renamed a package nobody asked to rename',
    ).toBe(false);
    expect(existsSync(join(testDir, 'skills', 'bar'))).toBe(true);
  });

  test('an update that is not a rename leaves the directory where it is', async () => {
    await service.createLocalSkill(
      { name: 'alpha', description: 'Mine', body: 'Body' },
      testDir,
    );
    await service.updateLocalSkill('alpha', { body: 'Edited' }, testDir);

    const dir = join(testDir, 'skills', 'alpha');
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toContain('Edited');
    expect(
      JSON.parse(readFileSync(join(dir, 'skill.json'), 'utf-8')).path,
    ).toBe(dir);
  });

  test('createLocalSkill refuses a taken command word before writing anything', async () => {
    await service.createLocalSkill(
      {
        name: 'owner-skill',
        description: 'Owns it',
        body: 'Body',
        command: { enabled: true, name: 'ship' },
      },
      testDir,
    );

    await expect(
      service.createLocalSkill(
        {
          name: 'second',
          description: 'D',
          body: 'Body',
          command: { enabled: true, name: 'ship' },
        },
        testDir,
      ),
    ).rejects.toThrow(/already used by the skill 'owner-skill'/);
    expect(existsSync(join(testDir, 'skills', 'second'))).toBe(false);
  });

  test('a user mirror outranks a registry skill for the same command word', async () => {
    // Delta-2 finding (d): a skill whose SKILL.md is unreadable is absent from
    // discovery, so the resolver saw it as `unknown` and let `registry` win —
    // while the same response reported `origin: user`. The tier must come from
    // the record being served.
    const registryDir = join(testDir, 'skills', 'registry-skill');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'SKILL.md'),
      '---\nname: registry-skill\ndescription: Installed\ncommand:\n  enabled: true\n  name: "ship"\n---\nBody',
    );
    writeFileSync(
      join(registryDir, 'skill.json'),
      JSON.stringify({
        name: 'registry-skill',
        source: 'registry',
        origin: 'registry',
        installedAt: '',
        path: registryDir,
      }),
    );

    await service.createLocalSkill(
      { name: 'mine', description: 'Mine', body: 'Body' },
      testDir,
    );
    const minePath = join(testDir, 'skills', 'mine', 'skill.json');
    const mine = JSON.parse(readFileSync(minePath, 'utf-8'));
    mine.command = { enabled: true, name: 'ship' };
    writeFileSync(minePath, JSON.stringify(mine, null, 2));
    rmSync(join(testDir, 'skills', 'mine', 'SKILL.md'));
    await service.discoverSkills(testDir);

    const detail = await service.getSkill('mine');
    expect(detail.origin).toBe('user');
    // The tier it reports and the tier it was resolved at are the same tier.
    expect(detail.command?.enabled).toBe(true);
    expect(detail.commandDiagnostic).toBeUndefined();
  });

  test('a registry mirror still yields to a user skill holding the word', async () => {
    await service.createLocalSkill(
      {
        name: 'mine',
        description: 'Mine',
        body: 'Body',
        command: { enabled: true, name: 'ship' },
      },
      testDir,
    );
    const registryDir = join(testDir, 'skills', 'registry-skill');
    mkdirSync(registryDir, { recursive: true });
    writeFileSync(
      join(registryDir, 'skill.json'),
      JSON.stringify({
        name: 'registry-skill',
        source: 'registry',
        origin: 'registry',
        installedAt: '',
        path: registryDir,
        command: { enabled: true, name: 'ship' },
      }),
    );
    await service.discoverSkills(testDir);

    const detail = await service.getSkill('registry-skill');
    expect(detail.origin).toBe('registry');
    expect(detail.command?.enabled).toBe(false);
    expect(detail.commandDiagnostic).toContain("'mine'");
  });
});
