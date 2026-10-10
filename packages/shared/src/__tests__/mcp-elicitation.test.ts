import { describe, expect, test } from 'vitest';
import {
  INPUT_REQUEST_MAX_FIELDS,
  readInputRequestForm,
  validateInputRequestContent,
} from '../input-request.js';
import { inputRequestFromMcpElicitation } from '../mcp-elicitation.js';

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
  const read = inputRequestFromMcpElicitation('fixture', REQUEST);
  if (!read) throw new Error('fixture form did not read');
  return read;
}

describe('inputRequestFromMcpElicitation (#3284 → #3390)', () => {
  test('maps every primitive the spec allows into a form body', () => {
    expect(form()).toMatchObject({
      schema: 'station.input-request/v1',
      source: 'mcp:fixture',
      requester: 'fixture',
      message: REQUEST.message,
      body: { kind: 'form' },
    });
    expect(form().body.fields.map((field) => [field.name, field.kind])).toEqual(
      [
        ['name', 'string'],
        ['email', 'string'],
        ['age', 'integer'],
        ['subscribe', 'boolean'],
        ['color', 'choice'],
        ['legacyColor', 'choice'],
        ['tags', 'multi-choice'],
      ],
    );
    expect(form().body.fields[5]).toMatchObject({
      options: [
        { value: 'r', label: 'R' },
        { value: 'g', label: 'G' },
      ],
    });
    // What the adapter produces is exactly what storage reads back.
    expect(readInputRequestForm(structuredClone(form()))).toEqual(form());
    // No MCP field can take a custom answer: MCP content stays MCP-shaped.
    expect(form().body.fields.some((field) => 'allowCustom' in field)).toBe(
      false,
    );
  });

  test('refuses what it cannot render faithfully', () => {
    const nested = structuredClone(REQUEST);
    (nested.requestedSchema.properties as Record<string, unknown>).address = {
      type: 'object',
    };
    expect(inputRequestFromMcpElicitation('fixture', nested)).toBeNull();
    const url = { ...REQUEST, mode: 'url' };
    expect(inputRequestFromMcpElicitation('fixture', url)).toBeNull();
    const ghost = structuredClone(REQUEST);
    ghost.requestedSchema.required = ['nobody'];
    expect(inputRequestFromMcpElicitation('fixture', ghost)).toBeNull();
    const wide = structuredClone(REQUEST);
    wide.requestedSchema.properties = Object.fromEntries(
      Array.from({ length: INPUT_REQUEST_MAX_FIELDS + 1 }, (_, i) => [
        `f${i}`,
        { type: 'string' },
      ]),
    ) as typeof wide.requestedSchema.properties;
    expect(inputRequestFromMcpElicitation('fixture', wide)).toBeNull();
  });

  test('a custom answer is refused for an MCP choice, so a tool server only gets MCP values', () => {
    expect(() =>
      validateInputRequestContent(form(), {
        name: 'Ada',
        color: { custom: 'green' },
      }),
    ).toThrow(/color must be one of the offered choices/);
  });
});

/**
 * Fix round 2 (#3410 review): the MCP edge reads the server's request by its
 * own keys at every level, so nothing inherited is mapped into the form.
 */
describe('inputRequestFromMcpElicitation reads only own keys', () => {
  const viaJsonProto = (inherited: unknown) =>
    Object.assign(
      {},
      JSON.parse(`{"__proto__": ${JSON.stringify(inherited)}}`),
    );
  const schema = () => structuredClone(REQUEST.requestedSchema) as any;
  test.each([
    ['params', () => Object.create(structuredClone(REQUEST))],
    ['params (JSON __proto__)', () => viaJsonProto(REQUEST)],
    [
      'requestedSchema',
      () => ({ ...REQUEST, requestedSchema: Object.create(schema()) }),
    ],
    [
      'properties',
      () => ({
        ...REQUEST,
        requestedSchema: {
          ...schema(),
          properties: Object.create(schema().properties),
        },
      }),
    ],
    [
      'a property schema',
      () => {
        const s = schema();
        s.properties.name = Object.create({ type: 'string', title: 'Name' });
        return { ...REQUEST, requestedSchema: s };
      },
    ],
    [
      'array items',
      () => {
        const s = schema();
        s.properties.tags.items = viaJsonProto({ type: 'string', enum: ['a'] });
        return { ...REQUEST, requestedSchema: s };
      },
    ],
    [
      'a oneOf entry',
      () => {
        const s = schema();
        s.properties.color.oneOf[0] = Object.create({
          const: 'red',
          title: 'Red',
        });
        return { ...REQUEST, requestedSchema: s };
      },
    ],
  ])('refuses an inherited %s', (_label, build) => {
    expect(inputRequestFromMcpElicitation('fixture', build())).toBeNull();
  });

  test('positive control: the same request as own keys maps', () => {
    expect(
      inputRequestFromMcpElicitation('fixture', structuredClone(REQUEST)),
    ).not.toBeNull();
  });
});
