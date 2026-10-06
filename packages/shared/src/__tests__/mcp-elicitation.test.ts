import { describe, expect, test } from 'vitest';
import {
  MCP_ELICITATION_MAX_FIELDS,
  mcpElicitationFormFromRequest,
  readMcpElicitationForm,
  validateMcpElicitationContent,
} from '../mcp-elicitation.js';

// The exact params shape the SDK hands Station's `elicitation/create` handler.
const REQUEST = {
  mode: 'form',
  message: 'Who should the report be addressed to?',
  requestedSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', title: 'Name', minLength: 1, maxLength: 5 },
      email: { type: 'string', format: 'email' },
      age: { type: 'integer', minimum: 0, maximum: 150 },
      subscribe: { type: 'boolean', default: false },
      color: {
        type: 'string',
        oneOf: [
          { const: 'red', title: 'Red' },
          { const: 'blue', title: 'Blue' },
        ],
      },
      legacyColor: { type: 'string', enum: ['r', 'g'], enumNames: ['R', 'G'] },
      tags: {
        type: 'array',
        items: { type: 'string', enum: ['a', 'b', 'c'] },
        maxItems: 2,
      },
    },
    required: ['name'],
  },
};

function form() {
  const read = mcpElicitationFormFromRequest('fixture', REQUEST);
  if (!read) throw new Error('fixture form did not read');
  return read;
}

describe('mcpElicitationFormFromRequest', () => {
  test('normalizes every primitive the spec allows', () => {
    expect(form().fields.map((field) => [field.name, field.kind])).toEqual([
      ['name', 'string'],
      ['email', 'string'],
      ['age', 'integer'],
      ['subscribe', 'boolean'],
      ['color', 'choice'],
      ['legacyColor', 'choice'],
      ['tags', 'multi-choice'],
    ]);
    expect(form().fields[5]).toMatchObject({
      options: [
        { value: 'r', label: 'R' },
        { value: 'g', label: 'G' },
      ],
    });
    expect(readMcpElicitationForm(form())).toEqual(form());
  });

  test('refuses what it cannot render faithfully', () => {
    const nested = structuredClone(REQUEST);
    (nested.requestedSchema.properties as Record<string, unknown>).address = {
      type: 'object',
    };
    expect(mcpElicitationFormFromRequest('fixture', nested)).toBeNull();
    const url = { ...REQUEST, mode: 'url' };
    expect(mcpElicitationFormFromRequest('fixture', url)).toBeNull();
    const ghost = structuredClone(REQUEST);
    ghost.requestedSchema.required = ['nobody'];
    expect(mcpElicitationFormFromRequest('fixture', ghost)).toBeNull();
    const wide = structuredClone(REQUEST);
    wide.requestedSchema.properties = Object.fromEntries(
      Array.from({ length: MCP_ELICITATION_MAX_FIELDS + 1 }, (_, i) => [
        `f${i}`,
        { type: 'string' },
      ]),
    ) as typeof wide.requestedSchema.properties;
    expect(mcpElicitationFormFromRequest('fixture', wide)).toBeNull();
  });
});

describe('readMcpElicitationForm', () => {
  test.each([
    { kind: 'string', format: 'password' },
    { kind: 'string', minLength: -1 },
    { kind: 'string', default: 42 },
    { kind: 'integer', minimum: Number.POSITIVE_INFINITY },
    { kind: 'number', default: '42' },
    { kind: 'boolean', default: 'yes' },
    { kind: 'choice', options: [] },
    { kind: 'choice', options: [{ value: 'a', label: 42 }] },
    { kind: 'choice', options: [{ value: 'a' }, { value: 'a' }] },
    { kind: 'choice', options: [{ value: 'a' }], default: 'b' },
    { kind: 'multi-choice', options: [{ value: 'a' }], minItems: 1.5 },
    { kind: 'multi-choice', options: [{ value: 'a' }], default: ['b'] },
    { kind: 'object' },
  ])('refuses malformed stored field %j', (field) => {
    expect(
      readMcpElicitationForm({
        serverId: 'fixture',
        message: 'Question',
        fields: [{ name: 'answer', required: false, ...field }],
      }),
    ).toBeNull();
  });
});

describe('validateMcpElicitationContent', () => {
  test('accepts valid content without changing it', () => {
    const content = {
      name: 'Ada',
      email: 'ada@example.com',
      age: 36,
      subscribe: true,
      color: 'blue',
      tags: ['a', 'c'],
    };
    expect(validateMcpElicitationContent(form(), content)).toEqual(content);
  });

  test.each([
    [{}, /Name is required/],
    [{ name: '   ' }, /Name is required/],
    [{ name: 'Adelaide' }, /Name allows at most 5 characters/],
    [{ name: 'Ada', email: 'nope' }, /email must be an email address/],
    [{ name: 'Ada', age: 3.5 }, /age must be a whole number/],
    [{ name: 'Ada', age: 151 }, /age must be at most 150/],
    [{ name: 'Ada', age: '36' }, /age must be a number/],
    [{ name: 'Ada', subscribe: 'yes' }, /subscribe must be yes or no/],
    [{ name: 'Ada', color: 'green' }, /color must be one of the offered/],
    [{ name: 'Ada', tags: ['a', 'b', 'c'] }, /tags allows at most 2/],
    [{ name: 'Ada', tags: ['a', 'a'] }, /once each/],
    [{ name: 'Ada', extra: 1 }, /no field named extra/],
  ])('refuses %j with a reason', (content, reason) => {
    expect(() => validateMcpElicitationContent(form(), content)).toThrow(
      reason,
    );
  });
});
