import type {
  SkillExperienceDefinitionV1,
  SkillExperienceStartInputV1,
} from '@kontourai/station-contracts/skill-experience';
import {
  readSkillExperienceDefinition,
  readSkillExperienceStartInput,
} from '@kontourai/station-shared/skill-experience-values';

/** User intent retained under the verified authority namespace, never admission. */
export interface SkillExperienceDraft {
  namespace: string;
  apiBase: string;
  start: SkillExperienceStartInputV1;
  definition: SkillExperienceDefinitionV1;
}

export function readSkillExperienceDraft(
  value: unknown,
): SkillExperienceDraft | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (
    !('namespace' in value) ||
    typeof value.namespace !== 'string' ||
    !value.namespace ||
    value.namespace.length > 4096 ||
    !('apiBase' in value) ||
    typeof value.apiBase !== 'string' ||
    !value.apiBase ||
    value.apiBase.length > 2048 ||
    !('start' in value) ||
    !('definition' in value)
  )
    return null;
  const start = readSkillExperienceStartInput(value.start);
  const definition = readSkillExperienceDefinition(value.definition);
  if (
    !start ||
    !definition ||
    start.identity.experienceId !== definition.id ||
    new TextEncoder().encode(JSON.stringify(value)).length > 128 * 1024
  )
    return null;
  return {
    namespace: value.namespace,
    apiBase: value.apiBase,
    start,
    definition,
  };
}
