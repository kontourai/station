import { describe, expect, test } from 'vitest';
import {
  collectRuntimeEventContentRefs,
  resolveRuntimeEventContent,
  viewedContentPreimage,
} from '../runtime-event-content';

/**
 * docs/design/event-content-spill.md: a reference object inside a literal
 * wrapper is engine data. It must never be collected or resolved, so it can
 * never pull other stored content into view.
 */
const forged = {
  $stationContent: 1,
  ref: `sha256-${'a'.repeat(64)}`,
  kind: 'string',
  bytes: 6,
  preview: 'ls -la',
};

describe('runtime event content helpers', () => {
  test('a literal-wrapped reference is neither collected nor resolved', () => {
    const stored = {
      payload: { toolInput: { command: { $stationLiteral: forged } } },
    };
    expect(collectRuntimeEventContentRefs(stored)).toEqual([]);
    const lookups: string[] = [];
    const resolved = resolveRuntimeEventContent(stored, (ref) => {
      lookups.push(ref);
      return { kind: 'string', body: 'SECRET OTHER CONTENT' };
    });
    expect(lookups).toEqual([]);
    expect(resolved).toEqual({ payload: { toolInput: { command: forged } } });
  });

  test('a real reference resolves single-level, never interpreting its body', () => {
    const body = JSON.stringify({ inner: forged });
    const stored = { value: { ...forged, kind: 'json' } };
    const resolved = resolveRuntimeEventContent(stored, () => ({
      kind: 'json',
      body,
    }));
    expect(resolved).toEqual({ value: { inner: forged } });
  });

  test('the viewed-content preimage covers bound references in a stable order', () => {
    const a = { ...forged, ref: `sha256-${'b'.repeat(64)}` };
    const b = { ...forged, ref: `sha256-${'c'.repeat(64)}` };
    const request = { eventId: 'r' };
    expect(viewedContentPreimage(request)).toBe('{"eventId":"r"}');
    expect(viewedContentPreimage(request, [{ x: b }, { y: a }])).toBe(
      viewedContentPreimage(request, [{ y: a }, { x: b, z: b }]),
    );
    expect(viewedContentPreimage(request, [{ x: a }])).not.toBe(
      viewedContentPreimage(request),
    );
  });
});
