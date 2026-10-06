import type {
  McpElicitationContent,
  McpElicitationField,
  McpElicitationForm,
  McpElicitationResult,
  McpElicitationStringFormat,
  McpElicitationValue,
} from '@kontourai/station-contracts/mcp-elicitation';
import {
  MCP_ELICITATION_MAX_FIELDS,
  MCP_ELICITATION_MAX_MESSAGE_CHARS,
  MCP_ELICITATION_MAX_TEXT_CHARS,
  readMcpElicitationForm,
} from './mcp-elicitation-form.js';

export {
  MCP_ELICITATION_MAX_FIELDS,
  MCP_ELICITATION_MAX_MESSAGE_CHARS,
  MCP_ELICITATION_MAX_OPTIONS,
  MCP_ELICITATION_MAX_TEXT_CHARS,
  readMcpElicitationForm,
} from './mcp-elicitation-form.js';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function schemaOptions(values: unknown, labels?: unknown): unknown {
  if (!Array.isArray(values)) return null;
  if (
    labels !== undefined &&
    (!Array.isArray(labels) || labels.length !== values.length)
  )
    return null;
  return values.map((value, index) => ({
    value,
    label: Array.isArray(labels) ? labels[index] : value,
  }));
}

function titledSchemaOptions(entries: unknown): unknown {
  if (!Array.isArray(entries)) return null;
  return entries.map((entry) =>
    record(entry)
      ? { value: entry.const, label: entry.title ?? entry.const }
      : null,
  );
}

function fieldFromSchema(
  name: string,
  schema: unknown,
  required: boolean,
): unknown {
  if (!record(schema)) return null;
  const base = {
    name,
    title: schema.title,
    description: schema.description,
    required,
    default: schema.default,
  };
  switch (schema.type) {
    case 'string': {
      const options =
        schema.oneOf !== undefined
          ? titledSchemaOptions(schema.oneOf)
          : schema.enum !== undefined
            ? schemaOptions(schema.enum, schema.enumNames)
            : undefined;
      return options !== undefined
        ? { ...base, kind: 'choice', options }
        : {
            ...base,
            kind: 'string',
            minLength: schema.minLength,
            maxLength: schema.maxLength,
            format: schema.format,
          };
    }
    case 'number':
    case 'integer':
      return {
        ...base,
        kind: schema.type,
        minimum: schema.minimum,
        maximum: schema.maximum,
      };
    case 'boolean':
      return { ...base, kind: 'boolean' };
    case 'array': {
      if (!record(schema.items)) return null;
      const options =
        schema.items.anyOf !== undefined
          ? titledSchemaOptions(schema.items.anyOf)
          : schema.items.type === 'string'
            ? schemaOptions(schema.items.enum)
            : null;
      return {
        ...base,
        kind: 'multi-choice',
        options,
        minItems: schema.minItems,
        maxItems: schema.maxItems,
      };
    }
    default:
      return null;
  }
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
  const fields: unknown[] = [];
  for (const [name, property] of entries) {
    if (!name || name.length > MAX_NAME_CHARS) return null;
    const field = fieldFromSchema(name, property, required.includes(name));
    if (!field) return null;
    fields.push(field);
  }
  return readMcpElicitationForm({ serverId, message, fields });
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function validDate(text: string): boolean {
  const match = DATE.exec(text);
  if (!match) return false;
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function formatProblem(
  format: McpElicitationStringFormat,
  text: string,
): string | null {
  switch (format) {
    case 'email':
      return EMAIL.test(text) ? null : 'must be an email address';
    case 'uri':
      try {
        new URL(text);
        return null;
      } catch {
        return 'must be a URI';
      }
    case 'date':
      return validDate(text) ? null : 'must be a date (YYYY-MM-DD)';
    case 'date-time':
      return DATE_TIME.test(text) && Number.isFinite(Date.parse(text))
        ? null
        : 'must be a date and time (ISO 8601 with a time zone)';
  }
}

function label(field: McpElicitationField): string {
  return field.title?.trim() || field.name;
}

function fieldValue(
  field: McpElicitationField,
  value: unknown,
): McpElicitationValue {
  const name = label(field);
  switch (field.kind) {
    case 'string': {
      if (typeof value !== 'string') throw new Error(`${name} must be text.`);
      if (value.length > MCP_ELICITATION_MAX_TEXT_CHARS)
        throw new Error(
          `${name} is longer than ${MCP_ELICITATION_MAX_TEXT_CHARS} characters.`,
        );
      if (field.minLength !== undefined && value.length < field.minLength)
        throw new Error(
          `${name} needs at least ${field.minLength} characters.`,
        );
      if (field.maxLength !== undefined && value.length > field.maxLength)
        throw new Error(
          `${name} allows at most ${field.maxLength} characters.`,
        );
      const problem = field.format ? formatProblem(field.format, value) : null;
      if (problem) throw new Error(`${name} ${problem}.`);
      return value;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value))
        throw new Error(`${name} must be a number.`);
      if (field.kind === 'integer' && !Number.isInteger(value))
        throw new Error(`${name} must be a whole number.`);
      if (field.minimum !== undefined && value < field.minimum)
        throw new Error(`${name} must be at least ${field.minimum}.`);
      if (field.maximum !== undefined && value > field.maximum)
        throw new Error(`${name} must be at most ${field.maximum}.`);
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean')
        throw new Error(`${name} must be yes or no.`);
      return value;
    case 'choice':
      if (
        typeof value !== 'string' ||
        !field.options.some((option) => option.value === value)
      )
        throw new Error(`${name} must be one of the offered choices.`);
      return value;
    case 'multi-choice': {
      if (
        !Array.isArray(value) ||
        value.some(
          (item) =>
            typeof item !== 'string' ||
            !field.options.some((option) => option.value === item),
        ) ||
        new Set(value).size !== value.length
      )
        throw new Error(
          `${name} must use only the offered choices, once each.`,
        );
      if (field.minItems !== undefined && value.length < field.minItems)
        throw new Error(`${name} needs at least ${field.minItems} choices.`);
      if (field.maxItems !== undefined && value.length > field.maxItems)
        throw new Error(`${name} allows at most ${field.maxItems} choices.`);
      return value as string[];
    }
  }
}

/**
 * Validate accepted content against the requested form. Refuses — with a
 * reason a person can act on — any unknown field, missing required field, or
 * value outside its field's type and bounds. Never coerces or truncates.
 */
export function validateMcpElicitationContent(
  form: McpElicitationForm,
  value: unknown,
): McpElicitationContent {
  if (!record(value)) throw new Error('The answer must be a set of fields.');
  for (const key of Object.keys(value))
    if (!form.fields.some((field) => field.name === key))
      throw new Error(`The form has no field named ${key}.`);
  const content: McpElicitationContent = {};
  for (const field of form.fields) {
    const present =
      Object.hasOwn(value, field.name) && value[field.name] !== undefined;
    if (!present) {
      if (field.required) throw new Error(`${label(field)} is required.`);
      continue;
    }
    const read = fieldValue(field, value[field.name]);
    if (field.required && typeof read === 'string' && read.trim() === '')
      throw new Error(`${label(field)} is required.`);
    content[field.name] = read;
  }
  return content;
}

/** Read an answer carried through storage or a reply, or null if malformed. */
export function readMcpElicitationResult(
  value: unknown,
): McpElicitationResult | null {
  if (!record(value)) return null;
  if (value.action === 'decline' || value.action === 'cancel')
    return Object.keys(value).length === 1 ? { action: value.action } : null;
  if (value.action === 'accept' && record(value.content))
    return {
      action: 'accept',
      content: value.content as McpElicitationContent,
    };
  return null;
}
