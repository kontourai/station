import { describe, expect, test } from 'vitest';
import {
  extractToolPurpose,
  STATION_TOOL_PURPOSE_KEY,
  toolSchemaWithPurpose,
} from '../tool-purpose.js';

describe('tool purpose schema metadata', () => {
  test('decorates a plain object schema without mutating it and strips only the reserved key', () => {
    const schema = { type: 'object', properties: { path: { type: 'string' } } };
    const decorated = toolSchemaWithPurpose(schema) as any;
    expect(decorated).not.toBe(schema);
    expect(schema.properties).not.toHaveProperty(STATION_TOOL_PURPOSE_KEY);
    expect(decorated.properties[STATION_TOOL_PURPOSE_KEY]).toMatchObject({
      type: 'string',
      maxLength: 240,
    });
    expect(
      extractToolPurpose({
        path: 'README.md',
        [STATION_TOOL_PURPOSE_KEY]: '  inspect   project docs ',
      }),
    ).toEqual({
      input: { path: 'README.md' },
      purpose: 'inspect project docs',
    });
  });

  test.each([
    { type: 'string' },
    { type: 'object', $ref: '#/$defs/x', properties: {} },
    { type: 'object', oneOf: [], properties: {} },
    {
      type: 'object',
      properties: { [STATION_TOOL_PURPOSE_KEY]: { type: 'number' } },
    },
  ])('declines ambiguous, nonobject, and collision schemas', (schema) => {
    expect(toolSchemaWithPurpose(schema)).toBe(schema);
  });
});
