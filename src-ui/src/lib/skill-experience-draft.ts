import { CHAT_ATTACHMENT_MAX_COUNT } from '@kontourai/station-contracts/chat-attachment';
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
  attachmentAssignments?: Record<string, string[]>;
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
  const attachmentAssignments: Record<string, string[]> = {};
  if (
    'attachmentAssignments' in value &&
    value.attachmentAssignments !== undefined
  ) {
    const candidate = value.attachmentAssignments;
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate) ||
      Object.keys(candidate).length > 32
    )
      return null;
    for (const [role, ids] of Object.entries(candidate)) {
      if (
        !definition.inputs.some(
          (input) => input.id === role && input.kind === 'attachments',
        ) ||
        !Array.isArray(ids) ||
        ids.length > CHAT_ATTACHMENT_MAX_COUNT ||
        ids.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
        new Set(ids).size !== ids.length
      )
        return null;
      attachmentAssignments[role] = ids.map((id) => String(id));
    }
  }
  return {
    namespace: value.namespace,
    apiBase: value.apiBase,
    start,
    definition,
    ...(Object.keys(attachmentAssignments).length
      ? { attachmentAssignments }
      : {}),
  };
}
