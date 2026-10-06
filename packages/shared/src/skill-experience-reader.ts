import type {
  SkillExperienceDefinitionV1,
  SkillExperienceIdentityV1,
  SkillExperienceInventoryV1,
  SkillExperienceSessionViewV1,
} from '@kontourai/station-contracts/skill-experience';
import { validateSkillExperience } from './agent-plugin-validators.generated.mjs';
import {
  readSkillExperienceStartInput,
  sameSkillExperienceIdentity,
} from './skill-experience-values';

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, maximum = 256): value is string {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= maximum
  );
}
function identity(value: unknown): value is SkillExperienceIdentityV1 {
  return (
    readSkillExperienceStartInput({ identity: value, inputs: {} }) !== null
  );
}
function definition(value: unknown): value is SkillExperienceDefinitionV1 {
  return validateSkillExperience(value);
}
export function readSkillExperienceDefinition(
  value: unknown,
): SkillExperienceDefinitionV1 | null {
  return definition(value) ? value : null;
}
function inventory(value: unknown): value is SkillExperienceInventoryV1 {
  return (
    record(value) &&
    Array.isArray(value.experiences) &&
    Array.isArray(value.diagnostics) &&
    value.experiences.every(
      (entry) =>
        record(entry) &&
        identity(entry.identity) &&
        definition(entry.definition) &&
        entry.definition.id === entry.identity.experienceId,
    ) &&
    value.diagnostics.every(
      (entry) =>
        record(entry) &&
        text(entry.pluginId) &&
        typeof entry.message === 'string' &&
        (entry.code === 'unavailable' || entry.code === 'definition-invalid'),
    ) &&
    (value.executionContract === undefined || value.executionContract === '1.0')
  );
}

export function readSkillExperienceInventory(
  value: unknown,
): SkillExperienceInventoryV1 | null {
  return inventory(value) ? value : null;
}

function invocation(value: unknown): boolean {
  if (
    !record(value) ||
    !text(value.eventId) ||
    !text(value.threadId) ||
    !record(value.availability) ||
    !['available', 'source-unavailable', 'snapshot-unavailable'].includes(
      String(value.availability.status),
    ) ||
    (value.turnId !== undefined && !text(value.turnId)) ||
    (value.reference !== undefined && !invocationReference(value.reference)) ||
    (value.availability.message !== undefined &&
      typeof value.availability.message !== 'string')
  )
    return false;
  if (value.snapshot === null)
    return value.availability.status === 'snapshot-unavailable';
  const snapshot = value.snapshot;
  return (
    record(snapshot) &&
    snapshot.version === '1.0' &&
    identity(snapshot.identity) &&
    definition(snapshot.definition) &&
    snapshot.definition.id === snapshot.identity.experienceId &&
    (value.reference === undefined ||
      (record(value.reference) &&
        identity(value.reference.identity) &&
        sameSkillExperienceIdentity(
          value.reference.identity,
          snapshot.identity,
        ))) &&
    readSkillExperienceStartInput({
      identity: snapshot.identity,
      inputs: snapshot.inputs,
      ...(snapshot.attachmentInputs !== undefined
        ? { attachmentInputs: snapshot.attachmentInputs }
        : {}),
    }) !== null &&
    text(snapshot.clientTurnId) &&
    (snapshot.previousInvocationEventId === undefined ||
      text(snapshot.previousInvocationEventId)) &&
    (snapshot.questionnaireDelivery === 'canonical-request' ||
      snapshot.questionnaireDelivery === 'chat-fallback')
  );
}

function invocationReference(value: unknown): boolean {
  return (
    record(value) &&
    value.version === '1.0' &&
    text(value.invocationId) &&
    text(value.snapshotDigest) &&
    identity(value.identity) &&
    text(value.snapshotSessionId)
  );
}

function sessionView(value: unknown): value is SkillExperienceSessionViewV1 {
  return (
    record(value) &&
    (value.current === null || invocation(value.current)) &&
    Array.isArray(value.history) &&
    value.history.length <= 100 &&
    value.history.every(invocation) &&
    typeof value.hasMore === 'boolean' &&
    (!value.hasMore || text(value.nextCursor)) &&
    (value.nextCursor === undefined || text(value.nextCursor))
  );
}

export function readSkillExperienceSession(
  value: unknown,
): SkillExperienceSessionViewV1 | null {
  return sessionView(value) ? value : null;
}
