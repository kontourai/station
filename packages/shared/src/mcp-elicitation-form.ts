import type {
  McpElicitationField,
  McpElicitationForm,
  McpElicitationOption,
  McpElicitationStringFormat,
} from '@kontourai/station-contracts/mcp-elicitation';

/**
 * Bounds on what Station renders. A request over a bound is refused, never
 * cut down: a form missing a field the server asked for would return content
 * the server did not get to ask about.
 */
export const MCP_ELICITATION_MAX_FIELDS = 32;
export const MCP_ELICITATION_MAX_OPTIONS = 64;
export const MCP_ELICITATION_MAX_MESSAGE_CHARS = 8000;
export const MCP_ELICITATION_MAX_TEXT_CHARS = 12000;
const MAX_NAME_CHARS = 128;
const MAX_LABEL_CHARS = 512;
const MAX_DESCRIPTION_CHARS = 2000;

const FORMATS = new Set<McpElicitationStringFormat>([
  'email',
  'uri',
  'date',
  'date-time',
]);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function optionalText(value: unknown, max: number): string | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > max) return null;
  return value;
}

function optionalCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

function optionalFinite(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readOptions(entries: unknown): McpElicitationOption[] | null {
  if (
    !Array.isArray(entries) ||
    entries.length < 1 ||
    entries.length > MCP_ELICITATION_MAX_OPTIONS
  )
    return null;
  const options: McpElicitationOption[] = [];
  for (const entry of entries) {
    if (!record(entry)) return null;
    const value = entry.value;
    const label = entry.label ?? value;
    if (
      typeof value !== 'string' ||
      value.length > MAX_LABEL_CHARS ||
      typeof label !== 'string' ||
      label.length > MAX_LABEL_CHARS ||
      options.some((option) => option.value === value)
    )
      return null;
    options.push({ value, label });
  }
  return options;
}

/**
 * Re-read a normalized form from untrusted storage (an event payload). Shared
 * by the server that validates an answer and the browser that renders it.
 */
export function readMcpElicitationForm(
  value: unknown,
): McpElicitationForm | null {
  if (
    !record(value) ||
    typeof value.serverId !== 'string' ||
    !value.serverId ||
    value.serverId.length > MAX_LABEL_CHARS ||
    typeof value.message !== 'string' ||
    value.message.length > MCP_ELICITATION_MAX_MESSAGE_CHARS ||
    !Array.isArray(value.fields) ||
    value.fields.length > MCP_ELICITATION_MAX_FIELDS
  )
    return null;
  const fields: McpElicitationField[] = [];
  for (const field of value.fields) {
    const read = readField(field);
    if (!read || fields.some((item) => item.name === read.name)) return null;
    fields.push(read);
  }
  return { serverId: value.serverId, message: value.message, fields };
}

function readField(value: unknown): McpElicitationField | null {
  if (
    !record(value) ||
    typeof value.name !== 'string' ||
    !value.name ||
    value.name.length > MAX_NAME_CHARS ||
    typeof value.required !== 'boolean'
  )
    return null;
  const title = optionalText(value.title, MAX_LABEL_CHARS);
  const description = optionalText(value.description, MAX_DESCRIPTION_CHARS);
  if (title === null || description === null) return null;
  const base = {
    name: value.name,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    required: value.required,
  };
  if (value.kind === 'string') {
    const minLength = optionalCount(value.minLength);
    const maxLength = optionalCount(value.maxLength);
    if (minLength === null || maxLength === null) return null;
    if (
      value.format !== undefined &&
      !FORMATS.has(value.format as McpElicitationStringFormat)
    )
      return null;
    const fallback = optionalText(
      value.default,
      MCP_ELICITATION_MAX_TEXT_CHARS,
    );
    if (fallback === null) return null;
    return {
      ...base,
      kind: 'string',
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(value.format !== undefined
        ? { format: value.format as McpElicitationStringFormat }
        : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  if (value.kind === 'number' || value.kind === 'integer') {
    const minimum = optionalFinite(value.minimum);
    const maximum = optionalFinite(value.maximum);
    const fallback = optionalFinite(value.default);
    if (minimum === null || maximum === null || fallback === null) return null;
    return {
      ...base,
      kind: value.kind,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  if (value.kind === 'boolean') {
    if (value.default !== undefined && typeof value.default !== 'boolean')
      return null;
    return {
      ...base,
      kind: 'boolean',
      ...(value.default !== undefined
        ? { default: value.default as boolean }
        : {}),
    };
  }
  if (value.kind === 'choice' || value.kind === 'multi-choice') {
    const options = readOptions(value.options);
    if (!options) return null;
    if (value.kind === 'choice') {
      if (
        value.default !== undefined &&
        (typeof value.default !== 'string' ||
          !options.some((option) => option.value === value.default))
      )
        return null;
      return {
        ...base,
        kind: 'choice',
        options,
        ...(value.default !== undefined
          ? { default: value.default as string }
          : {}),
      };
    }
    const minItems = optionalCount(value.minItems);
    const maxItems = optionalCount(value.maxItems);
    if (minItems === null || maxItems === null) return null;
    const fallback = value.default;
    if (
      fallback !== undefined &&
      (!Array.isArray(fallback) ||
        fallback.some(
          (value) =>
            typeof value !== 'string' ||
            !options.some((option) => option.value === value),
        ))
    )
      return null;
    return {
      ...base,
      kind: 'multi-choice',
      options,
      ...(minItems !== undefined ? { minItems } : {}),
      ...(maxItems !== undefined ? { maxItems } : {}),
      ...(fallback !== undefined ? { default: fallback as string[] } : {}),
    };
  }
  return null;
}
