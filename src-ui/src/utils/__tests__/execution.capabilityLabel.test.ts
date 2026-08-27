import { describe, expect, test } from 'vitest';
import { capabilityLabel } from '../execution';

/**
 * `capability` arrives from a plugin manifest's `capabilities` array, and this
 * function's return value is rendered directly as a React child in
 * `AgentConnectionView`. A plain object literal answers Object's inherited
 * keys, so `map['__proto__']` is `Object.prototype` — truthy, so a `??`
 * default never fires — and a non-string React child throws "Objects are not
 * valid as a React child", crashing the view.
 *
 * Same class as `describePermission`; found by the delta review of
 * station#4275's fix, which asked what other lookup tables are keyed by
 * manifest-supplied strings.
 */
describe('capabilityLabel fails safe on inherited keys', () => {
  test.each([
    '__proto__',
    'toString',
    'constructor',
    'hasOwnProperty',
    'valueOf',
  ])('an inherited key %s returns a string, never an object', (key) => {
    const label = capabilityLabel(key);
    expect(typeof label).toBe('string');
  });

  test('the real vocabulary is unaffected', () => {
    expect(capabilityLabel('llm')).toBe('Language model');
    expect(capabilityLabel('agent-runtime')).toBe('Agent execution');
  });

  test('an unknown capability still humanises its identifier', () => {
    expect(capabilityLabel('some-new-thing')).toBe('some new thing');
  });
});
