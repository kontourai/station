import type { KitRecord } from '@kontourai/station-contracts/knowledge-store';
import { describe, expect, test } from 'vitest';
import { freshnessLabel, recordFreshness } from '../freshness';

const record: KitRecord = {
  id: 'record-1',
  type: 'concept',
  title: 'Record',
  body: 'Body',
  category: 'product',
  provenance: { agent: 'knowledge.compile' },
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

describe('recordFreshness', () => {
  test('does not infer freshness when no expiry is declared', () => {
    expect(recordFreshness(record)).toEqual({ kind: 'not-declared' });
    expect(freshnessLabel({ kind: 'not-declared' })).toBe('No expiry declared');
  });

  test('honors explicit expiry and TTL declarations', () => {
    expect(
      recordFreshness({
        ...record,
        expires_at: '2026-08-01T00:00:00.000Z',
      }),
    ).toEqual({
      kind: 'declared',
      expiresAt: '2026-08-01T00:00:00.000Z',
    });
    expect(recordFreshness({ ...record, ttl_seconds: 60 })).toEqual({
      kind: 'declared',
      expiresAt: '2026-01-01T00:01:00.000Z',
    });
    expect(
      freshnessLabel({
        kind: 'declared',
        expiresAt: '2026-01-01T00:01:00.000Z',
      }),
    ).toBe('Expires at 2026-01-01T00:01:00.000Z');
  });

  test('surfaces malformed expiry instead of guessing', () => {
    expect(recordFreshness({ ...record, expires_at: 'not-a-date' })).toEqual({
      kind: 'invalid',
      value: 'not-a-date',
    });
  });
});
