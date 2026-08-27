import { describe, expect, test } from 'vitest';
import {
  hostPressureBadge,
  hostPressureKind,
  hostPressureSubject,
} from '../utils/resourcePosture';

describe('host pressure wording', () => {
  test('narrows to the two postures that defer scheduled runs', () => {
    expect(hostPressureKind({ kind: 'degraded' })).toBe('degraded');
    expect(hostPressureKind({ kind: 'critical' })).toBe('critical');
    expect(hostPressureKind({ kind: 'healthy' })).toBeUndefined();
    expect(hostPressureKind({ kind: 'unavailable' })).toBeUndefined();
    expect(hostPressureKind(undefined)).toBeUndefined();
  });

  test('only critical is "at capacity" — degraded is busy', () => {
    // The chrome banner has always drawn this line; Schedule now draws it
    // from the same place, so 86% CPU cannot read "Busy" above the page and
    // "host at capacity" inside it.
    expect(hostPressureBadge('critical')).toBe('At capacity');
    expect(hostPressureBadge('degraded')).toBe('Busy');
    expect(hostPressureSubject('critical')).toBe('host at capacity');
    expect(hostPressureSubject('degraded')).toBe('host busy');
  });
});
