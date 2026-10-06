import { isCanonicalPluginId } from '@kontourai/station-contracts/plugin';
import type {
  SkillExperienceIdentityV1,
  SkillExperienceInvocationReferenceV1,
  SkillExperienceInvocationV1,
} from '@kontourai/station-contracts/skill-experience';
import { isSkillExperienceDefinition } from '@kontourai/station-shared/skill-experience-author';
import { isRecord } from '../../utils/is-record.js';

export function experienceIdentityEqual(
  left: SkillExperienceIdentityV1,
  right: SkillExperienceIdentityV1,
): boolean {
  return (
    left.pluginId === right.pluginId &&
    left.pluginVersion === right.pluginVersion &&
    left.experienceId === right.experienceId &&
    left.incarnation === right.incarnation &&
    left.materialization === right.materialization &&
    left.contentDigest === right.contentDigest &&
    left.definitionDigest === right.definitionDigest
  );
}

function identifier(value: unknown, maximum = 512): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}

export function parseExperienceIdentity(
  value: unknown,
): SkillExperienceIdentityV1 | undefined {
  if (
    !isRecord(value) ||
    !identifier(value.pluginId, 128) ||
    !isCanonicalPluginId(value.pluginId) ||
    !identifier(value.pluginVersion, 128) ||
    !identifier(value.experienceId, 128) ||
    !identifier(value.incarnation, 128) ||
    !identifier(value.materialization, 128) ||
    typeof value.contentDigest !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.contentDigest) ||
    typeof value.definitionDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.definitionDigest)
  )
    return undefined;
  return {
    pluginId: value.pluginId,
    pluginVersion: value.pluginVersion,
    experienceId: value.experienceId,
    incarnation: value.incarnation,
    materialization: value.materialization,
    contentDigest: value.contentDigest,
    definitionDigest: value.definitionDigest,
  };
}

export function parseExperienceReference(
  value: unknown,
): SkillExperienceInvocationReferenceV1 | undefined {
  if (
    !isRecord(value) ||
    value.version !== '1.0' ||
    !identifier(value.invocationId, 200) ||
    !identifier(value.snapshotSessionId) ||
    typeof value.snapshotDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.snapshotDigest)
  )
    return undefined;
  const identity = parseExperienceIdentity(value.identity);
  return identity
    ? {
        version: '1.0',
        invocationId: value.invocationId,
        snapshotSessionId: value.snapshotSessionId,
        snapshotDigest: value.snapshotDigest,
        identity,
      }
    : undefined;
}

export function parseExperienceSnapshot(
  value: unknown,
): SkillExperienceInvocationV1 | undefined {
  if (
    !isRecord(value) ||
    value.version !== '1.0' ||
    !identifier(value.clientTurnId, 200) ||
    (value.previousInvocationEventId !== undefined &&
      !identifier(value.previousInvocationEventId)) ||
    !isSkillExperienceDefinition(value.definition) ||
    !isRecord(value.inputs) ||
    Object.keys(value.inputs).length > 32 ||
    Object.values(value.inputs).some((input) => typeof input !== 'string') ||
    !['canonical-request', 'chat-fallback'].includes(
      String(value.questionnaireDelivery),
    )
  )
    return undefined;
  const identity = parseExperienceIdentity(value.identity);
  if (!identity) return undefined;
  const inputs: Record<string, string> = {};
  for (const [key, input] of Object.entries(value.inputs)) {
    if (typeof input !== 'string') return undefined;
    inputs[key] = input;
  }
  let attachmentInputs: Record<string, number[]> | undefined;
  if (value.attachmentInputs !== undefined) {
    if (
      !isRecord(value.attachmentInputs) ||
      Object.keys(value.attachmentInputs).length > 32
    )
      return undefined;
    attachmentInputs = {};
    for (const [key, indices] of Object.entries(value.attachmentInputs)) {
      if (
        !Array.isArray(indices) ||
        indices.length > 5 ||
        indices.some(
          (index) => !Number.isInteger(index) || index < 0 || index > 4,
        )
      )
        return undefined;
      attachmentInputs[key] = indices;
    }
  }
  return {
    version: '1.0',
    identity,
    definition: value.definition,
    inputs,
    clientTurnId: value.clientTurnId,
    ...(typeof value.previousInvocationEventId === 'string'
      ? { previousInvocationEventId: value.previousInvocationEventId }
      : {}),
    ...(attachmentInputs ? { attachmentInputs } : {}),
    questionnaireDelivery:
      value.questionnaireDelivery === 'canonical-request'
        ? 'canonical-request'
        : 'chat-fallback',
  };
}
