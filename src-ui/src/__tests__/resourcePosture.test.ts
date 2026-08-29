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

  test('distinguishes very busy from busy without claiming hard capacity', () => {
    expect(hostPressureBadge('critical')).toBe('Very busy');
    expect(hostPressureBadge('degraded')).toBe('Busy');
    expect(hostPressureSubject('critical')).toBe('host very busy');
    expect(hostPressureSubject('degraded')).toBe('host busy');
  });
});
