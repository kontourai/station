import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, vi } from 'vitest';
import { installSkillFromRegistry } from '../skill-service-install.js';

const { SkillService } = await import('../skill-service.js');

async function oneRound(i: number): Promise<string | null> {
  const tempDir = mkdtempSync(join(tmpdir(), 'skill-install-'));
  try {
    const loader = {
      getProjectHomeDir: () => tempDir,
      loadSkill: vi.fn(),
      listSkills: vi.fn().mockResolvedValue([]),
      skillExists: vi.fn().mockResolvedValue(false),
      deleteSkillAt: vi.fn(),
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
    try {
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
      const total = Number(registry.success) + Number(setup.success);
      if (total !== 1) {
        return `ITER ${i}: unexpected total=${total} registry=${JSON.stringify(registry)} setup=${JSON.stringify(setup)}`;
      }
      return null;
    } catch (error) {
      return `ITER ${i}: THREW ${String((error as Error)?.stack ?? error)}`;
    }
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

describe('zz-repro', () => {
  it('reproduces the race N times concurrently', async () => {
    const REPS = 600;
    const results = await Promise.all(
      Array.from({ length: REPS }, (_, i) => oneRound(i)),
    );
    const failures = results.filter((r): r is string => r !== null);
    for (const f of failures) console.log(f);
    console.log(`TOTAL FAILURES: ${failures.length}/${REPS}`);
  }, 120_000);
});
