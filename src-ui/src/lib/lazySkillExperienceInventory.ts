import type { SkillExperienceInventoryReader } from '@kontourai/station-sdk/client';

/**
 * Loads the SDK inventory reader, and with it the canonical skill-experience
 * validator, only when a send actually carries a visual skill start. Ordinary
 * sends are part of first paint; the validator is not (#3209).
 */
export const readSkillExperienceInventoryLazily: SkillExperienceInventoryReader =
  async (apiBase, opts) =>
    (
      await import('@kontourai/station-sdk/client/skill-experiences')
    ).fetchSkillExperienceInventory(apiBase, opts);
