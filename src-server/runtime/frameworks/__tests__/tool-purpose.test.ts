import { describe, expect, test } from 'vitest';
import {
  extractToolPurpose,
  rememberToolPurpose,
  STATION_TOOL_PURPOSE_KEY,
  takeToolPurpose,
  toolPurposeForCall,
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

  test('isolates reused call ids by invocation and clears aborted invocation state', () => {
    const cleanupA: Array<() => void> = [];
    const cleanupB: Array<() => void> = [];
    const scopeA = { onClose: (cleanup: () => void) => cleanupA.push(cleanup) };
    const scopeB = { onClose: (cleanup: () => void) => cleanupB.push(cleanup) };

    rememberToolPurpose('same-call', 'purpose A', scopeA);
    rememberToolPurpose('same-call', 'purpose B', scopeB);
    expect(toolPurposeForCall('same-call', scopeA)).toBe('purpose A');
    expect(takeToolPurpose('same-call', scopeB)).toBe('purpose B');

    // A failed/cancelled foreground invocation closes its companion without a
    // tool result. Its pending metadata must not survive that boundary.
    cleanupA.forEach((cleanup) => cleanup());
    expect(toolPurposeForCall('same-call', scopeA)).toBeUndefined();
    expect(toolPurposeForCall('same-call', scopeB)).toBeUndefined();
  });
});
