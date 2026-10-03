import type {
  SkillExperienceDefinitionV1,
  SkillExperienceInputV1,
  SkillExperienceProvenanceV1,
} from '@kontourai/station-contracts/skill-experience';

/** Bounded display data, never an author definition or source admission. */
export type SkillExperiencePreview = Pick<
  SkillExperienceDefinitionV1,
  'id' | 'title' | 'purpose' | 'example'
> & {
  inputs: SkillExperienceInputV1[];
  presentation: Pick<
    SkillExperienceDefinitionV1['presentation'],
    'modes' | 'defaultMode'
  >;
};
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function text(value: unknown, max = 65536): value is string {
  return typeof value === 'string' && value.length <= max;
}
function integer(value: unknown, min: number, max: number): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= min &&
    value <= max
  );
}
function provenance(value: unknown): SkillExperienceProvenanceV1 | null {
  if (!record(value) || !text(value.explanation)) return null;
  if (value.origin === 'skill-declared')
    return text(value.skillRef, 256)
      ? {
          origin: value.origin,
          explanation: value.explanation,
          skillRef: value.skillRef,
        }
      : null;
  if (value.origin === 'reviewer-inferred' || value.origin === 'station-added')
    return { origin: value.origin, explanation: value.explanation };
  return null;
}
function input(value: unknown): SkillExperienceInputV1 | null {
  if (
    !record(value) ||
    !text(value.id, 128) ||
    !value.id ||
    ['constructor', 'prototype', '__proto__'].includes(value.id) ||
    !text(value.label) ||
    typeof value.required !== 'boolean' ||
    (value.description !== undefined && !text(value.description))
  )
    return null;
  const source = provenance(value.provenance);
  if (!source) return null;
  const base = {
    id: value.id,
    label: value.label,
    required: value.required,
    provenance: source,
    ...(typeof value.description === 'string'
      ? { description: value.description }
      : {}),
  };
  if (value.kind === 'attachments')
    return integer(value.maxCount, 1, 5)
      ? { ...base, kind: value.kind, maxCount: value.maxCount }
      : null;
  if (value.default !== undefined && !text(value.default)) return null;
  const preset =
    typeof value.default === 'string' ? { default: value.default } : {};
  if (value.kind === 'text') {
    if (
      !integer(value.maxLength, 1, 65536) ||
      (value.minLength !== undefined &&
        !integer(value.minLength, 0, value.maxLength))
    )
      return null;
    return {
      ...base,
      kind: value.kind,
      maxLength: value.maxLength,
      ...(typeof value.minLength === 'number'
        ? { minLength: value.minLength }
        : {}),
      ...preset,
    };
  }
  if (
    value.kind !== 'single-choice' ||
    !Array.isArray(value.options) ||
    value.options.length > 64
  )
    return null;
  const options: Array<{ value: string; label: string }> = [];
  for (const choice of value.options) {
    if (!record(choice) || !text(choice.value) || !text(choice.label))
      return null;
    options.push({ value: choice.value, label: choice.label });
  }
  return { ...base, kind: value.kind, options, ...preset };
}

export function readSkillExperiencePreview(
  value: unknown,
): SkillExperiencePreview | null {
  if (
    !record(value) ||
    !text(value.id, 256) ||
    !value.id ||
    !text(value.title) ||
    !text(value.purpose) ||
    !text(value.example) ||
    !Array.isArray(value.inputs) ||
    value.inputs.length > 32 ||
    !record(value.presentation) ||
    !Array.isArray(value.presentation.modes) ||
    value.presentation.modes.length > 2
  )
    return null;
  const fields: SkillExperienceInputV1[] = [];
  for (const candidate of value.inputs) {
    const parsed = input(candidate);
    if (!parsed) return null;
    fields.push(parsed);
  }
  if (new Set(fields.map((field) => field.id)).size !== fields.length)
    return null;
  const modes: Array<'guided' | 'alongside'> = [];
  for (const mode of value.presentation.modes) {
    if (mode !== 'guided' && mode !== 'alongside') return null;
    modes.push(mode);
  }
  const defaultMode = value.presentation.defaultMode;
  if (
    (defaultMode !== 'guided' && defaultMode !== 'alongside') ||
    !modes.includes(defaultMode)
  )
    return null;
  return {
    id: value.id,
    title: value.title,
    purpose: value.purpose,
    example: value.example,
    inputs: fields,
    presentation: { modes, defaultMode },
  };
}
