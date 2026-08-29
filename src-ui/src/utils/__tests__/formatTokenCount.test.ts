/**
 * #765 A8 — the compact token-count formatter behind chat answers'
 * collapsed usage figure ("50856" → "50.9k"). Pinned directly because the
 * formatter is what keeps a context-heavy total from reading as a cost bomb,
 * and the exact companion is what the tooltip promises.
 */
import { describe, expect, test } from 'vitest';
import { exactTokenCount, formatTokenCount } from '../formatTokenCount';

describe('formatTokenCount', () => {
  test('renders counts under 1000 exactly', () => {
    expect(formatTokenCount(0)).toBe('0');
    expect(formatTokenCount(24)).toBe('24');
    expect(formatTokenCount(999)).toBe('999');
  });

  test('renders thousands with one decimal, trimming a trailing .0', () => {
    expect(formatTokenCount(50856)).toBe('50.9k');
    expect(formatTokenCount(1000)).toBe('1k');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(50000)).toBe('50k');
  });

  test('drops the decimal at three digits of a unit', () => {
    expect(formatTokenCount(250856)).toBe('251k');
  });

  test('carries a round-up into the next unit rather than printing 1000k', () => {
    expect(formatTokenCount(999960)).toBe('1M');
    expect(formatTokenCount(1_200_000)).toBe('1.2M');
    expect(formatTokenCount(2_500_000_000)).toBe('2.5B');
  });

  test('keeps sign', () => {
    expect(formatTokenCount(-1500)).toBe('-1.5k');
  });
});

describe('exactTokenCount', () => {
  test('groups the exact figure for tooltips', () => {
    expect(exactTokenCount(50856)).toBe('50,856');
    expect(exactTokenCount(24)).toBe('24');
  });
});
