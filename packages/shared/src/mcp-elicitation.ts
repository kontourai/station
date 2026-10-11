import type {
  InputRequestField,
  InputRequestForm,
  InputRequestOption,
  InputRequestStringFormat,
} from '@kontourai/station-contracts/input-request';
import { INPUT_REQUEST_SCHEMA } from '@kontourai/station-contracts/input-request';
import {
  INPUT_REQUEST_MAX_FIELDS,
  INPUT_REQUEST_MAX_OPTIONS,
  INPUT_REQUEST_MAX_TEXT_CHARS,
  ownArray,
  ownRecord,
  readInputRequestForm,
} from './input-request.js';

/**
 * #3284/#3390: the MCP edge of `station.input-request/v1`. A form-mode
 * `elicitation/create` request maps into a `form` body here; the answer goes
 * back unchanged, because the contract's response IS MCP's result shape and
 * a field from this adapter never allows a custom answer. Reading and
 * validating the form is the shared input-request module's job.
 */
const MAX_NAME_CHARS = 128;
const MAX_LABEL_CHARS = 512;
const MAX_DESCRIPTION_CHARS = 2000;

const FORMATS = new Set<InputRequestStringFormat>([
  'email',
  'uri',
  'date',
  'date-time',
]);

// Every level of the server's request is read through the shared own-key
// snapshots (`ownRecord` / `ownArray`) before any value is copied, so an
// inherited schema property, option or bound is never mapped into the form.

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
  rawValues: unknown,
  rawLabels?: unknown,
): InputRequestOption[] | null {
  const values = ownArray(rawValues);
  const labels = rawLabels === undefined ? undefined : ownArray(rawLabels);
  if (!values || values.length < 1) return null;
  if (values.length > INPUT_REQUEST_MAX_OPTIONS) return null;
  if (labels === null || (labels && labels.length !== values.length))
    return null;
  const options: InputRequestOption[] = [];
  for (const [index, value] of values.entries()) {
    const label = labels ? labels[index] : value;
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

function readTitledOptions(raw: unknown): InputRequestOption[] | null {
  const entries = ownArray(raw);
  if (!entries) return null;
  const values: unknown[] = [];
  const labels: unknown[] = [];
  for (const item of entries) {
    const entry = ownRecord(item);
    if (!entry) return null;
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
  raw: unknown,
  required: boolean,
): InputRequestField | null {
  const schema = ownRecord(raw);
  if (!schema) return null;
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
      !FORMATS.has(schema.format as InputRequestStringFormat)
    )
      return null;
    const fallback = optionalText(schema.default, INPUT_REQUEST_MAX_TEXT_CHARS);
    if (fallback === null) return null;
    return {
      ...base,
      kind: 'string',
      ...(minLength !== undefined ? { minLength } : {}),
      ...(maxLength !== undefined ? { maxLength } : {}),
      ...(schema.format !== undefined
        ? { format: schema.format as InputRequestStringFormat }
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
    const items = ownRecord(schema.items);
    if (!items) return null;
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
    const fallback =
      schema.default === undefined ? undefined : ownArray(schema.default);
    if (
      schema.default !== undefined &&
      (!fallback ||
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
 * Map a form-mode `elicitation/create` request into an input request. Returns
 * null for a request Station cannot render faithfully: URL mode, an
 * unsupported property type, a bound exceeded, or a `required` entry that
 * names no property.
 */
export function inputRequestFromMcpElicitation(
  serverId: string,
  rawParams: unknown,
): InputRequestForm | null {
  const params = ownRecord(rawParams);
  if (!params || (params.mode !== undefined && params.mode !== 'form'))
    return null;
  const message = params.message;
  const schema = ownRecord(params.requestedSchema);
  const properties = ownRecord(schema?.properties);
  if (
    typeof message !== 'string' ||
    !schema ||
    schema.type !== 'object' ||
    !properties
  )
    return null;
  const required =
    schema.required === undefined ? [] : ownArray(schema.required);
  if (
    !required ||
    required.some(
      (name) => typeof name !== 'string' || !Object.hasOwn(properties, name),
    )
  )
    return null;
  const entries = Object.entries(properties);
  if (entries.length > INPUT_REQUEST_MAX_FIELDS) return null;
  const fields: InputRequestField[] = [];
  for (const [name, property] of entries) {
    if (!name || name.length > MAX_NAME_CHARS) return null;
    const field = fieldFromSchema(name, property, required.includes(name));
    if (!field) return null;
    fields.push(field);
  }
  return readInputRequestForm({
    schema: INPUT_REQUEST_SCHEMA,
    source: `mcp:${serverId}`,
    requester: serverId,
    message,
    body: { kind: 'form', fields },
  });
}
