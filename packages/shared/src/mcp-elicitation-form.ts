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

function readOptions(
  values: unknown,
  labels?: unknown,
): McpElicitationOption[] | null {
  if (!Array.isArray(values) || values.length < 1) return null;
  if (values.length > MCP_ELICITATION_MAX_OPTIONS) return null;
  if (
    labels !== undefined &&
    (!Array.isArray(labels) || labels.length !== values.length)
  )
    return null;
  const options: McpElicitationOption[] = [];
  for (const [index, value] of values.entries()) {
    const label = Array.isArray(labels) ? labels[index] : value;
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

function readTitledOptions(entries: unknown): McpElicitationOption[] | null {
  if (!Array.isArray(entries)) return null;
  const values: unknown[] = [];
  const labels: unknown[] = [];
  for (const entry of entries) {
    if (!record(entry)) return null;
    values.push(entry.const);
    labels.push(entry.title ?? entry.const);
  }
  return readOptions(values, labels);
}

/**
 * Convert one MCP `PrimitiveSchemaDefinition` into a Station field, or null
 * when it is outside the restricted subset the spec defines.
 */
function fieldFromSchema(
  name: string,
  schema: unknown,
  required: boolean,
): McpElicitationField | null {
  if (!record(schema)) return null;
  const title = optionalText(schema.title, MAX_LABEL_CHARS);
  const description = optionalText(schema.description, MAX_DESCRIPTION_CHARS);
  if (title === null || description === null) return null;
  const base = {
    name,
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    required,
  };
  if (schema.type === 'string') {
    const options =
      schema.oneOf !== undefined
        ? readTitledOptions(schema.oneOf)
        : schema.enum !== undefined
          ? readOptions(schema.enum, schema.enumNames)
          : undefined;
    if (options === null) return null;
    if (options) {
      if (
        schema.default !== undefined &&
        (typeof schema.default !== 'string' ||
          !options.some((option) => option.value === schema.default))
      )
        return null;
      return {
        ...base,
        kind: 'choice',
        options,
        ...(schema.default !== undefined
          ? { default: schema.default as string }
          : {}),
      };
    }
    const minLength = optionalCount(schema.minLength);
    const maxLength = optionalCount(schema.maxLength);
    if (minLength === null || maxLength === null) return null;
    if (
      schema.format !== undefined &&
      !FORMATS.has(schema.format as McpElicitationStringFormat)
    )
      return null;
    const fallback = optionalText(
      schema.default,
      MCP_ELICITATION_MAX_TEXT_CHARS,
    );
    if (fallback === null) return null;
    return {
      ...base,
      kind: 'string',
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(schema.format !== undefined
        ? { format: schema.format as McpElicitationStringFormat }
        : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  if (schema.type === 'number' || schema.type === 'integer') {
    const minimum = optionalFinite(schema.minimum);
    const maximum = optionalFinite(schema.maximum);
    const fallback = optionalFinite(schema.default);
    if (minimum === null || maximum === null || fallback === null) return null;
    return {
      ...base,
      kind: schema.type,
      ...(minimum !== undefined ? { minimum } : {}),
      ...(maximum !== undefined ? { maximum } : {}),
      ...(fallback !== undefined ? { default: fallback } : {}),
    };
  }
  if (schema.type === 'boolean') {
    if (schema.default !== undefined && typeof schema.default !== 'boolean')
      return null;
    return {
      ...base,
      kind: 'boolean',
      ...(schema.default !== undefined
        ? { default: schema.default as boolean }
        : {}),
    };
  }
  if (schema.type === 'array') {
    const items = schema.items;
    if (!record(items)) return null;
    const options =
      items.anyOf !== undefined
        ? readTitledOptions(items.anyOf)
        : items.type === 'string'
          ? readOptions(items.enum)
          : null;
    if (!options) return null;
    const minItems = optionalCount(schema.minItems);
    const maxItems = optionalCount(schema.maxItems);
    if (minItems === null || maxItems === null) return null;
    const fallback = schema.default;
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

/**
 * Normalize a form-mode `elicitation/create` request into the fields Station
 * renders. Returns null for a request Station cannot render faithfully: an
 * unsupported property type, a bound exceeded, or a `required` entry that
 * names no property.
 */
export function mcpElicitationFormFromRequest(
  serverId: string,
  params: unknown,
): McpElicitationForm | null {
  if (!record(params) || (params.mode !== undefined && params.mode !== 'form'))
    return null;
  const message = params.message;
  const schema = params.requestedSchema;
  if (
    typeof message !== 'string' ||
    message.length > MCP_ELICITATION_MAX_MESSAGE_CHARS ||
    !record(schema) ||
    schema.type !== 'object' ||
    !record(schema.properties)
  )
    return null;
  const required = schema.required ?? [];
  if (
    !Array.isArray(required) ||
    required.some(
      (name) =>
        typeof name !== 'string' ||
        !Object.hasOwn(schema.properties as object, name),
    )
  )
    return null;
  const entries = Object.entries(schema.properties);
  if (entries.length > MCP_ELICITATION_MAX_FIELDS) return null;
  const fields: McpElicitationField[] = [];
  for (const [name, property] of entries) {
    if (!name || name.length > MAX_NAME_CHARS) return null;
    const field = fieldFromSchema(name, property, required.includes(name));
    if (!field) return null;
    fields.push(field);
  }
  return readMcpElicitationForm({ serverId, message, fields });
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
  // Rebuild through the same schema reader, so storage cannot hold a field
  // the request reader would have refused.
  const schema: Record<string, unknown> = {
    ...(title !== undefined ? { title } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(value.default !== undefined ? { default: value.default } : {}),
  };
  switch (value.kind) {
    case 'string':
      Object.assign(schema, {
        type: 'string',
        minLength: value.minLength,
        maxLength: value.maxLength,
        format: value.format,
      });
      break;
    case 'number':
    case 'integer':
      Object.assign(schema, {
        type: value.kind,
        minimum: value.minimum,
        maximum: value.maximum,
      });
      break;
    case 'boolean':
      schema.type = 'boolean';
      break;
    case 'choice':
    case 'multi-choice': {
      if (!Array.isArray(value.options)) return null;
      const oneOf = value.options.map((option) =>
        record(option) ? { const: option.value, title: option.label } : null,
      );
      if (value.kind === 'choice')
        Object.assign(schema, { type: 'string', oneOf });
      else
        Object.assign(schema, {
          type: 'array',
          items: { anyOf: oneOf },
          minItems: value.minItems,
          maxItems: value.maxItems,
        });
      break;
    }
    default:
      return null;
  }
  for (const key of Object.keys(schema))
    if (schema[key] === undefined) delete schema[key];
  return fieldFromSchema(value.name, schema, value.required);
}
