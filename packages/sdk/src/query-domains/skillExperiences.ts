import type {
  SkillExperienceInventoryV1,
  SkillExperienceSessionViewV1,
} from '@kontourai/station-contracts/skill-experience';
import { _getApiBase } from '../api';
import {
  fetchSkillExperienceInventory,
  fetchSkillExperienceSession,
} from '../client/skill-experiences';
import { type QueryConfig, useApiQuery } from '../query-core';

export function useSkillExperienceInventoryQuery(
  config?: QueryConfig<SkillExperienceInventoryV1>,
) {
  return useApiQuery(
    ['skills', 'experiences', 'inventory'],
    async () => fetchSkillExperienceInventory(await _getApiBase()),
    config,
  );
}

export function useSkillExperienceSessionQuery(
  threadId: string | null | undefined,
  config?: QueryConfig<SkillExperienceSessionViewV1>,
  cursor?: string,
) {
  return useApiQuery(
    ['skills', 'experiences', 'session', threadId ?? null, cursor ?? null],
    async () => {
      if (!threadId)
        throw new Error(
          'An experience requires its canonical session identity.',
        );
      return fetchSkillExperienceSession(await _getApiBase(), threadId, cursor);
    },
    { ...config, enabled: Boolean(threadId) && config?.enabled !== false },
  );
}
