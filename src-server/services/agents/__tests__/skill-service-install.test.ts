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
    const saveSkill = vi.fn().mockResolvedValue(undefined);
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
      configLoader: { saveSkill },
      providers: [{ provider }] as any,
      rediscover,
    });

    expect(result).toEqual({ success: true, message: 'ok' });
    expect(provider.install).toHaveBeenCalledWith(
      'deep-research',
      expect.stringContaining('.deep-research.install-'),
    );
    expect(saveSkill).toHaveBeenCalledWith(
      'deep-research',
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

  it('removes an installed skill directory and rediscoveries skills', async () => {
    const skillDir = join(tempDir, 'skills', 'deep-research');
    mkdirSync(skillDir, { recursive: true });
    const rediscover = vi.fn().mockResolvedValue(undefined);

    const result = await removeInstalledSkill({
      name: 'deep-research',
      projectHomeDir: tempDir,
      rediscover,
    });

    expect(result).toEqual({
      success: true,
      message: 'Removed deep-research',
    });
    expect(rediscover).toHaveBeenCalledOnce();
  });

  it('refuses a registry id that would escape the skills root, touching nothing', async () => {
    // Delta-2 finding (a): the id lands in `join(registryRoot, id)` AND
    // `join(targetDir, id)`, so `../candidate` read a directory beside the
    // registry and wrote outside `<home>/skills`.
    const outside = join(tempDir, 'candidate');
    mkdirSync(outside, { recursive: true });
    const saveSkill = vi.fn().mockResolvedValue(undefined);
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
          configLoader: { saveSkill },
          providers: [{ provider }] as any,
          rediscover,
        }),
      ).rejects.toThrow(/Invalid skill name/);
    }

    // No provider was reached, so nothing was copied and nothing recorded.
    expect(provider.install).not.toHaveBeenCalled();
    expect(saveSkill).not.toHaveBeenCalled();
    expect(rediscover).not.toHaveBeenCalled();
    expect(readdirSync(outside)).toEqual([]);
  });

  it('records registry provenance the writer knows', async () => {
    const saveSkill = vi.fn().mockResolvedValue(undefined);
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
      configLoader: { saveSkill },
      providers: [{ provider }] as any,
      rediscover: vi.fn().mockResolvedValue(undefined),
    });

    expect(saveSkill).toHaveBeenCalledWith(
      'deep-research',
      expect.objectContaining({ origin: 'registry' }),
    );
  });

  it('refuses an unsafe name on removal too', async () => {
    await expect(
      removeInstalledSkill({
        name: '../candidate',
        projectHomeDir: tempDir,
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
      deleteSkill: vi.fn(),
      saveSkill: vi.fn(async (name: string, config: unknown) => {
        const target = join(tempDir, 'skills', name);
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'skill.json'), JSON.stringify(config));
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
        configLoader: { saveSkill: vi.fn() },
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
