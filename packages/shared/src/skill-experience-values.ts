import { CHAT_ATTACHMENT_MAX_COUNT } from '@kontourai/station-contracts/chat-attachment';
import type {
  SkillExperienceDefinitionV1,
  SkillExperienceIdentityV1,
  SkillExperienceInventoryV1,
  SkillExperienceStartInputV1,
} from '@kontourai/station-contracts/skill-experience';

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
  definition: Pick<SkillExperienceDefinitionV1, 'inputs'>,
): Record<string, string> {
  return Object.fromEntries(
    definition.inputs.flatMap((input) =>
      input.kind === 'attachments' ? [] : [[input.id, input.default ?? '']],
    ),
  );
}

export function skillExperienceInputErrors(
  definition: Pick<SkillExperienceDefinitionV1, 'inputs'>,
  values: Record<string, string>,
  attachmentCount = 0,
  assignedAttachments?: Record<string, number[]>,
): Record<string, string> {
  const errors = new Map<string, string>();
  const suppliedValues = new Map(Object.entries(values));
  const attachmentInputs = definition.inputs.filter(
    (input) => input.kind === 'attachments',
  );
  for (const input of definition.inputs) {
    if (input.kind === 'attachments') {
      const assigned = assignedAttachments
        ? (new Map(Object.entries(assignedAttachments)).get(input.id) ?? [])
        : attachmentInputs.length === 1
          ? Array.from({ length: attachmentCount }, (_, index) => index)
          : [];
      if (assigned.some((index) => index < 0 || index >= attachmentCount))
        errors.set(input.id, 'Choose current composer files for this role.');
      else if (input.required && assigned.length === 0)
        errors.set(
          input.id,
          `Attach ${input.label.toLowerCase()} in the composer before starting.`,
        );
      if (assigned.length > Math.min(input.maxCount, CHAT_ATTACHMENT_MAX_COUNT))
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

/** Inert composer identifiers become positions only in the actual outgoing attachment order. */
export function skillExperienceAttachmentInputs(
  roles: readonly string[],
  attachmentIds: readonly string[],
  assignments?: Record<string, string[]>,
): Record<string, number[]> {
  const selected = new Map(Object.entries(assignments ?? {}));
  return Object.fromEntries(
    roles.map((role) => [
      role,
      (assignments
        ? (selected.get(role) ?? [])
        : roles.length === 1
          ? attachmentIds
          : []
      ).map((id) => attachmentIds.indexOf(id)),
    ]),
  );
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
