import { describe, expect, test } from 'vitest';
import {
  isReservedObjectKey,
  nullPrototypeCopy,
  nullPrototypeDeep,
} from '../reserved-object-keys.js';

/**
 * Builds `{"a":{"a":{…null}}}` `depth` levels deep as TEXT, so the fixture
 * itself never recurses and never depends on `JSON.stringify` (which has its
 * own, much lower, call-depth ceiling than `JSON.parse`).
 */
function nestedJson(depth: number): string {
  let text = 'null';
  for (let level = 0; level < depth; level += 1) text = `{"a":${text}}`;
  return text;
}

describe('reserved-object-keys', () => {
  test('isReservedObjectKey names exactly the three Object.prototype hazards', () => {
    expect(isReservedObjectKey('__proto__')).toBe(true);
    expect(isReservedObjectKey('constructor')).toBe(true);
    expect(isReservedObjectKey('prototype')).toBe(true);
    expect(isReservedObjectKey('apiKey')).toBe(false);
  });

  test('nullPrototypeCopy is shallow: the top level loses its prototype, a nested map does not', () => {
    const copy = nullPrototypeCopy({ nested: { a: 1 } });
    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(Object.getPrototypeOf(copy.nested)).toBe(Object.prototype);
  });

  test('nullPrototypeDeep strips every plain object on the way down and keeps arrays as arrays', () => {
    const source = JSON.parse(
      '{"demo":{"disabled":["auth","beta"],"settings":{"nested":{"a":1}}}}',
    );

    const copy = nullPrototypeDeep(source);

    expect(Object.getPrototypeOf(copy)).toBeNull();
    expect(Object.getPrototypeOf(copy.demo)).toBeNull();
    expect(Object.getPrototypeOf(copy.demo.settings)).toBeNull();
    expect(Object.getPrototypeOf(copy.demo.settings.nested)).toBeNull();
    // Arrays are indexed, not keyed by external identifiers, so they keep
    // their `Array` prototype — and stay arrays, not index-keyed objects.
    expect(Array.isArray(copy.demo.disabled)).toBe(true);
    expect(copy.demo.disabled).toEqual(['auth', 'beta']);
    expect(copy).toEqual(source);
  });

  test('objects INSIDE arrays are converted too, and a shared subtree twice over', () => {
    // The shape an iterative rewrite regresses on: an element gets enqueued
    // and its children missed. The previous fixture held only primitives in
    // its array, so it could not have noticed (archive#4307 delta review).
    const source = JSON.parse(
      '{"list":[{"deep":{"a":1}},[{"b":2}]],"x":{"shared":{"c":3}},"y":{"shared":{"c":3}}}',
    );

    const copy = nullPrototypeDeep(source);

    expect(Array.isArray(copy.list)).toBe(true);
    expect(Object.getPrototypeOf(copy.list[0])).toBeNull();
    expect(Object.getPrototypeOf(copy.list[0].deep)).toBeNull();
    expect(Array.isArray(copy.list[1])).toBe(true);
    expect(Object.getPrototypeOf(copy.list[1][0])).toBeNull();
    // A subtree reachable by two paths is copied independently, and both
    // copies are converted — no memo, matching the recursive form it replaced.
    expect(Object.getPrototypeOf(copy.x.shared)).toBeNull();
    expect(Object.getPrototypeOf(copy.y.shared)).toBeNull();
    expect(copy.x.shared).not.toBe(copy.y.shared);
    expect(copy).toEqual(source);
  });

  test('a literal __proto__ member survives as an OWN key rather than reparenting the copy', () => {
    const source = JSON.parse('{"settings":{"__proto__":{"polluted":"yes"}}}');

    const copy = nullPrototypeDeep(source);

    expect(Object.hasOwn(copy.settings, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(copy.settings)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    // The whole point of the copy: it round-trips byte-for-byte.
    expect(JSON.parse(JSON.stringify(copy))).toEqual(source);
  });

  /**
   * archive#4307 review. The recursive form spent one call frame per level and
   * threw `RangeError: Maximum call stack size exceeded` at ~3.5k, while
   * `JSON.parse` — the only producer that reaches this helper — is iterative
   * and survives ~200k. A settings body nested between those limits therefore
   * PERSISTED (`JSON.stringify` reaches ~6.2k) and then made every read of
   * `plugin-overrides.json` throw, including `loadPluginOverrides` on the
   * boot path, permanently and across restarts.
   *
   * 50k is deliberately an order of magnitude past the old ceiling and past
   * anything `JSON.stringify` can emit: the claim is that this helper is
   * bounded by `JSON.parse`, not by the call stack.
   */
  test('consumes input far deeper than the call stack allows (station#4307 review)', () => {
    const parsed = JSON.parse(nestedJson(50_000));

    const copy = nullPrototypeDeep(parsed);

    let depth = 0;
    let plainPrototypes = 0;
    let cursor: Record<string, unknown> | null = copy;
    while (cursor !== null) {
      if (Object.getPrototypeOf(cursor) !== null) plainPrototypes += 1;
      cursor = cursor.a as Record<string, unknown> | null;
      depth += 1;
    }
    expect(depth).toBe(50_000);
    expect(plainPrototypes).toBe(0);
  });
});
