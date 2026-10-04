import { describe, expect, test, vi } from 'vitest';

const subpathLoaded = vi.hoisted(() => vi.fn());
const fetchSkillExperienceInventory = vi.hoisted(() =>
  vi.fn(async () => ({ experiences: [], diagnostics: [] })),
);
vi.mock('@kontourai/station-sdk/client/skill-experiences', () => {
  subpathLoaded();
  return { fetchSkillExperienceInventory };
});

const { readSkillExperienceInventoryLazily } = await import(
  '../lib/lazySkillExperienceInventory'
);

describe('readSkillExperienceInventoryLazily', () => {
  test('loads the SDK skill-experience subpath only when a send reads inventory', async () => {
    expect(subpathLoaded).not.toHaveBeenCalled();
    const opts = { headers: { 'x-test': '1' } };

    await expect(
      readSkillExperienceInventoryLazily('http://station.test', opts),
    ).resolves.toEqual({ experiences: [], diagnostics: [] });

    expect(subpathLoaded).toHaveBeenCalledTimes(1);
    expect(fetchSkillExperienceInventory).toHaveBeenCalledWith(
      'http://station.test',
      opts,
    );
  });
});
