import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { FilesystemSkillRegistryProvider } from '../filesystem-skill-registry.js';

/**
 * #896 wave 2 (docs/design/connections-onboarding.md §1.1's named gap):
 * `defaultSkillRoots()` also lists the Station-owned app-home profile
 * skills dirs — additive, read-only listing sources, absent profiles are a
 * silent no-op via the existing `existsSync` guard.
 */
describe('FilesystemSkillRegistryProvider', () => {
  let scratch: string;
  let previousStationHome: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'station-skill-registry-'));
    previousStationHome = process.env.STATION_HOME;
    previousHome = process.env.HOME;
    process.env.STATION_HOME = scratch;
    // `defaultSkillRoots()`'s pre-existing `.codex`/`.claude` roots use
    // `homedir()` directly — isolate those too, or a dev machine's real
    // `~/.claude` contaminates the "absent" assertion below.
    process.env.HOME = scratch;
  });

  afterEach(() => {
    if (previousStationHome === undefined) {
      delete process.env.STATION_HOME;
    } else {
      process.env.STATION_HOME = previousStationHome;
    }
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    rmSync(scratch, { recursive: true, force: true });
  });

  test('lists skills from an app-home profile skills root', async () => {
    const skillDir = join(
      scratch,
      'app-homes',
      'codex-runtime',
      'skills',
      'pizza',
    );
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: pizza\ndescription: Bakes a pizza\n---\n# Pizza',
    );

    const provider = new FilesystemSkillRegistryProvider();
    const items = await provider.listAvailable();

    expect(items.some((item) => item.id === 'pizza')).toBe(true);
  });

  test('absent profile roots are skipped silently', async () => {
    // No app-homes dir exists under `scratch` at all.
    const provider = new FilesystemSkillRegistryProvider();
    await expect(provider.listAvailable()).resolves.toEqual([]);
  });

  test('constructor-injected roots still work unchanged', async () => {
    const customRoot = join(scratch, 'custom-skills');
    const skillDir = join(customRoot, 'salad');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      join(skillDir, 'SKILL.md'),
      '---\nname: salad\ndescription: Tosses a salad\n---\n# Salad',
    );

    const provider = new FilesystemSkillRegistryProvider([customRoot]);
    const items = await provider.listAvailable();

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe('salad');
  });
});
