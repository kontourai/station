import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  installSkillFromRegistry,
  removeInstalledSkill,
} from '../skill-service-install.js';

const { SkillService } = await import('../skill-service.js');

describe('skill-service-install', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'skill-install-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('installs a skill through the first successful registry provider', async () => {
    const skillDir = join(tempDir, 'skills', 'deep-research');
    const saveSkillIn = vi.fn().mockResolvedValue(undefined);
    const rediscover = vi.fn().mockResolvedValue(undefined);
    const provider = {
      install: vi
        .fn()
        .mockImplementation(async (_name: string, targetDir: string) => {
          mkdirSync(join(targetDir, 'deep-research'), { recursive: true });
          writeFileSync(
            join(targetDir, 'deep-research', 'SKILL.md'),
            '# Research',
          );
          return { success: true, message: 'ok' };
        }),
      listAvailable: vi.fn().mockResolvedValue([
        {
          id: 'deep-research',
          description: 'Research skill',
          version: '1.2.3',
        },
      ]),
    };

    const result = await installSkillFromRegistry({
      name: 'deep-research',
      projectHomeDir: tempDir,
      configLoader: { saveSkillIn },
      providers: [{ provider }] as any,
      rediscover,
    });

    expect(result).toEqual({ success: true, message: 'ok' });
    expect(provider.install).toHaveBeenCalledWith(
      'deep-research',
      expect.stringContaining('.deep-research.install-'),
    );
    expect(saveSkillIn).toHaveBeenCalledWith(
      skillDir,
      expect.objectContaining({
        version: '1.2.3',
        path: skillDir,
      }),
    );
    expect(
      JSON.parse(readFileSync(join(skillDir, '.station-meta.json'), 'utf-8')),
    ).toEqual(
      expect.objectContaining({
        version: '1.2.3',
        source: 'registry',
      }),
    );
    expect(rediscover).toHaveBeenCalledOnce();
  });

  it('installs a scoped skill with its record beside its body', async () => {
    // Review M3 / #1619 finding (b): the install was the last production write
    // resolving its record by NAME, so a scoped install put the package in the
    // project root and its record in `<home>/skills/<name>` — one package in
    // two roots. Unscoped, the two directories are the same and prove nothing,
    // which is why this case passes a slug.
    const projectDir = join(
      tempDir,
      'projects',
      'demo',
      'skills',
      'scoped-install',
    );
    const saveSkillIn = vi.fn().mockResolvedValue(undefined);
    const provider = {
      install: vi
        .fn()
        .mockImplementation(async (_name: string, targetDir: string) => {
          mkdirSync(join(targetDir, 'scoped-install'), { recursive: true });
          writeFileSync(
            join(targetDir, 'scoped-install', 'SKILL.md'),
            '# Scoped',
          );
          return { success: true, message: 'ok' };
        }),
      listAvailable: vi.fn().mockResolvedValue([]),
    };

    const result = await installSkillFromRegistry({
      name: 'scoped-install',
      projectHomeDir: tempDir,
      projectSlug: 'demo',
      configLoader: { saveSkillIn },
      providers: [{ provider }] as any,
      rediscover: vi.fn().mockResolvedValue(undefined),
    });

    expect(result.success).toBe(true);
    expect(existsSync(join(projectDir, 'SKILL.md'))).toBe(true);
    expect(
      saveSkillIn,
      'the record was written somewhere other than the package',
    ).toHaveBeenCalledWith(
      projectDir,
      expect.objectContaining({ path: projectDir }),
    );
    expect(existsSync(join(tempDir, 'skills', 'scoped-install'))).toBe(false);
  });

  it('reports a failed record write instead of returning success', async () => {
    // Delta review 3, L3. The record's writer asserts containment now (#1619),
    // and its throw landed in an empty catch — so an install that could not
    // write its record, or wrote a package outside the roots, returned success
    // with no manifest behind it. The provider's own metadata stays
    // best-effort; the record is not.
    const saveSkillIn = vi
      .fn()
      .mockRejectedValue(new Error('containment refused'));
    const provider = {
      install: vi
        .fn()
        .mockImplementation(async (_name: string, targetDir: string) => {
          mkdirSync(join(targetDir, 'deep-research'), { recursive: true });
          writeFileSync(
            join(targetDir, 'deep-research', 'SKILL.md'),
            '# Research',
          );
          return { success: true, message: 'ok' };
        }),
      listAvailable: vi.fn().mockResolvedValue([]),
    };

    const rediscover = vi.fn().mockResolvedValue(undefined);
    await expect(
      installSkillFromRegistry({
        name: 'deep-research',
        projectHomeDir: tempDir,
        configLoader: { saveSkillIn },
        providers: [{ provider }] as any,
        rediscover,
      }),
    ).rejects.toThrow(/containment refused/);

    // The package was renamed into place BEFORE the record was attempted, and
    // this branch makes a recordless package answerable from discovery
    // (#1614) — so skipping rediscovery left a skill the install reported as
    // failed turning up in the listing at whatever discovery ran next (delta
    // review 4, L1). The published tree is deliberately not deleted: for the
    // containment case it sits outside the roots Station just refused to
    // touch.
    expect(existsSync(join(tempDir, 'skills', 'deep-research'))).toBe(true);
    expect(rediscover).toHaveBeenCalled();
  });

  // The other side of that line: the version metadata is genuinely
  // best-effort, and a registry that cannot answer `listAvailable` is not a
  // failed install — for EVERY way it can fail to answer. Narrowed to
  // `.catch()`, this held only for a rejected promise: a provider that threw
  // synchronously failed an install whose package was already published
  // (delta review 4, M1). Each shape is its own case because the earlier test
  // used the one that still worked, so the gap read as covered.
  it.each([
    [
      'a rejected promise',
      () => vi.fn().mockRejectedValue(new Error('registry offline')),
    ],
    [
      'a synchronous throw',
      () =>
        vi.fn(() => {
          throw new Error('registry exploded');
        }),
    ],
    ['a non-promise return', () => vi.fn(() => undefined as never)],
  ])(
    'still installs when the provider answers with %s',
    async (_label, listAvailable) => {
      const saveSkillIn = vi.fn().mockResolvedValue(undefined);
      const rediscover = vi.fn().mockResolvedValue(undefined);
      const provider = {
        install: vi
          .fn()
          .mockImplementation(async (_name: string, targetDir: string) => {
            mkdirSync(join(targetDir, 'quiet'), { recursive: true });
            writeFileSync(join(targetDir, 'quiet', 'SKILL.md'), '# Quiet');
            return { success: true, message: 'ok' };
          }),
        listAvailable: listAvailable(),
      };

      const result = await installSkillFromRegistry({
        name: 'quiet',
        projectHomeDir: tempDir,
        configLoader: { saveSkillIn },
        providers: [{ provider }] as any,
        rediscover,
      });

      expect(result.success).toBe(true);
      expect(saveSkillIn).toHaveBeenCalledWith(
        join(tempDir, 'skills', 'quiet'),
        expect.objectContaining({ version: 'unknown' }),
      );
      expect(rediscover).toHaveBeenCalled();
    },
  );

  it('removes an installed skill directory and rediscoveries skills', async () => {
    const skillDir = join(tempDir, 'skills', 'deep-research');
    mkdirSync(skillDir, { recursive: true });
    const rediscover = vi.fn().mockResolvedValue(undefined);

    const result = await removeInstalledSkill({
      name: 'deep-research',
      projectHomeDir: tempDir,
      // The caller resolves the package's own directory now (#1619); a remove
      // that derived it from the name and a slug answered "not found" for
      // every workspace package.
      targetDir: skillDir,
      rediscover,
    });

    expect(existsSync(skillDir)).toBe(false);
    expect(result).toEqual({
      success: true,
      message: 'Removed deep-research',
    });
    expect(rediscover).toHaveBeenCalledOnce();
  });

  it('refuses to remove a directory outside a skills root Station writes', async () => {
    // The floor beneath a caller-resolved directory: a remove deletes a whole
    // package tree, so a plugin's root — which is inside the home and has a
    // `skills` parent — must not be one of them.
    const pluginSkill = join(tempDir, 'plugins', 'acme', 'skills', 'shipper');
    mkdirSync(pluginSkill, { recursive: true });
    const rediscover = vi.fn().mockResolvedValue(undefined);

    await expect(
      removeInstalledSkill({
        name: 'shipper',
        projectHomeDir: tempDir,
        targetDir: pluginSkill,
        rediscover,
      }),
    ).rejects.toThrow(/does not sit in a skills root Station writes/);

    expect(existsSync(pluginSkill)).toBe(true);
    expect(rediscover).not.toHaveBeenCalled();
  });

  it('refuses a registry id that would escape the skills root, touching nothing', async () => {
    // Delta-2 finding (a): the id lands in `join(registryRoot, id)` AND
    // `join(targetDir, id)`, so `../candidate` read a directory beside the
    // registry and wrote outside `<home>/skills`.
    const outside = join(tempDir, 'candidate');
    mkdirSync(outside, { recursive: true });
    const saveSkillIn = vi.fn().mockResolvedValue(undefined);
    const rediscover = vi.fn().mockResolvedValue(undefined);
    const provider = {
      install: vi.fn().mockResolvedValue({ success: true, message: 'ok' }),
      listAvailable: vi.fn().mockResolvedValue([]),
    };

    for (const name of ['../candidate', 'a/b', '__proto__', '..']) {
      await expect(
        installSkillFromRegistry({
          name,
          projectHomeDir: tempDir,
          configLoader: { saveSkillIn },
          providers: [{ provider }] as any,
          rediscover,
        }),
      ).rejects.toThrow(/Invalid skill name/);
    }

    // No provider was reached, so nothing was copied and nothing recorded.
    expect(provider.install).not.toHaveBeenCalled();
    expect(saveSkillIn).not.toHaveBeenCalled();
    expect(rediscover).not.toHaveBeenCalled();
    expect(readdirSync(outside)).toEqual([]);
  });

  it('records registry provenance the writer knows', async () => {
    const saveSkillIn = vi.fn().mockResolvedValue(undefined);
    const provider = {
      install: vi
        .fn()
        .mockImplementation(async (_name: string, targetDir: string) => {
          mkdirSync(join(targetDir, 'deep-research'), { recursive: true });
          writeFileSync(
            join(targetDir, 'deep-research', 'SKILL.md'),
            '# Research',
          );
          return { success: true, message: 'ok' };
        }),
      listAvailable: vi.fn().mockResolvedValue([]),
    };

    await installSkillFromRegistry({
      name: 'deep-research',
      projectHomeDir: tempDir,
      configLoader: { saveSkillIn },
      providers: [{ provider }] as any,
      rediscover: vi.fn().mockResolvedValue(undefined),
    });

    expect(saveSkillIn).toHaveBeenCalledWith(
      join(tempDir, 'skills', 'deep-research'),
      expect.objectContaining({ origin: 'registry' }),
    );
  });

  it('refuses an unsafe name on removal too', async () => {
    await expect(
      removeInstalledSkill({
        name: '../candidate',
        projectHomeDir: tempDir,
        // Even handed a directory that looks ordinary, the NAME is refused —
        // the assertion that used to happen inside the name-derived resolution
        // now happens on the caller's directory instead.
        targetDir: join(tempDir, 'skills', 'candidate'),
        rediscover: vi.fn(),
      }),
    ).rejects.toThrow(/Invalid skill name/);
  });

  it('makes registry install and conditional local create share one target capability', async () => {
    const loader = {
      getProjectHomeDir: () => tempDir,
      loadSkill: vi.fn(),
      listSkills: vi.fn().mockResolvedValue([]),
      skillExists: vi.fn().mockResolvedValue(false),
      deleteSkillAt: vi.fn(),
      // Writes where it is told, like the real directory-addressed writer.
      saveSkillIn: vi.fn(async (directory: string, config: unknown) => {
        mkdirSync(directory, { recursive: true });
        writeFileSync(join(directory, 'skill.json'), JSON.stringify(config));
      }),
    };
    const service = new SkillService(loader as never, {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
    });
    const provider = {
      install: vi.fn(async (name: string, targetDir: string) => {
        const staged = join(targetDir, name);
        mkdirSync(join(staged, 'resources'), { recursive: true });
        writeFileSync(join(staged, 'SKILL.md'), '# registry');
        writeFileSync(join(staged, 'resources', 'marker'), 'registry');
        return { success: true, message: 'registry installed' };
      }),
      listAvailable: vi.fn().mockResolvedValue([]),
    };
    const [registry, setup] = await Promise.all([
      installSkillFromRegistry({
        name: 'shared',
        projectHomeDir: tempDir,
        configLoader: loader,
        providers: [{ provider }] as never,
        rediscover: async () => service.discoverSkills(tempDir),
      }),
      service.createLocalSkillIfAbsent(
        { name: 'shared', body: 'setup' },
        tempDir,
      ),
    ]);

    expect(Number(registry.success) + Number(setup.success)).toBe(1);
    const target = join(tempDir, 'skills', 'shared');
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
    // A provider's staged resource only appears with its complete registry
    // package; conditional creation never leaves a mixed tree.
    const registryWon = registry.success;
    expect(existsSync(join(target, 'resources', 'marker'))).toBe(registryWon);
  });

  it('cleans only its owned registry staging directory when the provider fails', async () => {
    const provider = {
      install: vi.fn(async (name: string, targetDir: string) => {
        mkdirSync(join(targetDir, name), { recursive: true });
        writeFileSync(join(targetDir, name, 'partial'), 'partial');
        return { success: false, message: 'injected staging failure' };
      }),
      listAvailable: vi.fn().mockResolvedValue([]),
    };
    const survivor = join(tempDir, 'skills', '.do-not-delete');
    mkdirSync(survivor, { recursive: true });
    await expect(
      installSkillFromRegistry({
        name: 'cleanup',
        projectHomeDir: tempDir,
        configLoader: { saveSkillIn: vi.fn() },
        providers: [{ provider }] as never,
        rediscover: vi.fn(),
      }),
    ).resolves.toEqual(expect.objectContaining({ success: false }));
    expect(existsSync(survivor)).toBe(true);
    expect(
      readdirSync(join(tempDir, 'skills')).filter((name) =>
        name.startsWith('.cleanup.install-'),
      ),
    ).toEqual([]);
  });
});
