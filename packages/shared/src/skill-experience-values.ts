import { CHAT_ATTACHMENT_MAX_COUNT } from '@kontourai/station-contracts/chat-attachment';
import type {
  SkillExperienceDefinitionV1,
  SkillExperienceIdentityV1,
  SkillExperienceInventoryV1,
  SkillExperienceSessionViewV1,
  SkillExperienceStartInputV1,
} from '@kontourai/station-contracts/skill-experience';
import { validateSkillExperience } from './agent-plugin-validators.generated.mjs';

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
    record(value) &&
    text(value.pluginId) &&
    text(value.pluginVersion) &&
    text(value.experienceId) &&
    text(value.incarnation) &&
    text(value.materialization) &&
    text(value.contentDigest) &&
    text(value.definitionDigest)
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

export function skillExperiencesCanExecute(
  value: SkillExperienceInventoryV1 | undefined,
): boolean {
  return record(value) && value.executionContract === '1.0';
}

export function sameSkillExperienceIdentity(
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

export function skillExperienceInputDefaults(
  definition: SkillExperienceDefinitionV1,
): Record<string, string> {
  return Object.fromEntries(
    definition.inputs.flatMap((input) =>
      input.kind === 'attachments' ? [] : [[input.id, input.default ?? '']],
    ),
  );
}

export function skillExperienceInputErrors(
  definition: SkillExperienceDefinitionV1,
  values: Record<string, string>,
  attachmentCount = 0,
): Record<string, string> {
  const errors = new Map<string, string>();
  const suppliedValues = new Map(Object.entries(values));
  const attachmentInputs = definition.inputs.filter(
    (input) => input.kind === 'attachments',
  );
  if (attachmentInputs.length > 1)
    errors.set(
      'attachments',
      'This workflow assigns files to separate roles. Choose a supported interface before starting.',
    );
  for (const input of definition.inputs) {
    if (input.kind === 'attachments') {
      if (input.required && attachmentCount === 0)
        errors.set(
          input.id,
          `Attach ${input.label.toLowerCase()} in the composer before starting.`,
        );
      if (attachmentCount > Math.min(input.maxCount, CHAT_ATTACHMENT_MAX_COUNT))
        errors.set(
          input.id,
          `Attach at most ${Math.min(input.maxCount, CHAT_ATTACHMENT_MAX_COUNT)} files.`,
        );
      continue;
    }
    const value = suppliedValues.get(input.id) ?? input.default ?? '';
    if (input.required && !value.trim())
      errors.set(input.id, `Enter ${input.label.toLowerCase()}.`);
    else if (
      input.kind === 'text' &&
      (Array.from(value).length > input.maxLength ||
        (value.length > 0 && Array.from(value).length < (input.minLength ?? 0)))
    )
      errors.set(
        input.id,
        `Use ${input.minLength ?? 0} to ${input.maxLength} characters.`,
      );
    else if (
      input.kind === 'single-choice' &&
      value &&
      !input.options.some((option) => option.value === value)
    )
      errors.set(input.id, 'Choose an available option.');
  }
  return Object.fromEntries(errors);
}

function inputs(value: unknown): value is Record<string, string> {
  return (
    record(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([key, input]) =>
        text(key, 128) &&
        !['__proto__', 'constructor', 'prototype'].includes(key) &&
        typeof input === 'string' &&
        input.length <= 65536,
    ) &&
    JSON.stringify(value).length <= 65536
  );
}

function attachmentInputs(value: unknown): boolean {
  return (
    record(value) &&
    Object.keys(value).length <= 32 &&
    Object.entries(value).every(
      ([key, indices]) =>
        text(key, 128) &&
        !['__proto__', 'constructor', 'prototype'].includes(key) &&
        Array.isArray(indices) &&
        indices.length <= CHAT_ATTACHMENT_MAX_COUNT &&
        indices.every(
          (index) =>
            Number.isInteger(index) &&
            index >= 0 &&
            index < CHAT_ATTACHMENT_MAX_COUNT,
        ) &&
        new Set(indices).size === indices.length,
    )
  );
}

function start(value: unknown): value is SkillExperienceStartInputV1 {
  return (
    record(value) &&
    identity(value.identity) &&
    inputs(value.inputs) &&
    Object.keys(value).every((key) =>
      [
        'identity',
        'inputs',
        'expectedPreviousInvocationEventId',
        'attachmentInputs',
      ].includes(key),
    ) &&
    (value.expectedPreviousInvocationEventId === undefined ||
      text(value.expectedPreviousInvocationEventId)) &&
    (value.attachmentInputs === undefined ||
      attachmentInputs(value.attachmentInputs))
  );
}

/** A persisted selection is user intent, never proof of current source admission. */
export function readSkillExperienceStartInput(
  value: unknown,
): SkillExperienceStartInputV1 | null {
  return start(value) ? value : null;
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
    inputs(snapshot.inputs) &&
    (snapshot.attachmentInputs === undefined ||
      attachmentInputs(snapshot.attachmentInputs)) &&
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
