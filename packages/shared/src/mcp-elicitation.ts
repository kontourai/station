import type {
  McpElicitationContent,
  McpElicitationField,
  McpElicitationForm,
  McpElicitationResult,
  McpElicitationStringFormat,
  McpElicitationValue,
} from '@kontourai/station-contracts/mcp-elicitation';
import { MCP_ELICITATION_MAX_TEXT_CHARS } from './mcp-elicitation-form.js';

export {
  MCP_ELICITATION_MAX_FIELDS,
  MCP_ELICITATION_MAX_MESSAGE_CHARS,
  MCP_ELICITATION_MAX_OPTIONS,
  MCP_ELICITATION_MAX_TEXT_CHARS,
  mcpElicitationFormFromRequest,
  readMcpElicitationForm,
} from './mcp-elicitation-form.js';

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
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
