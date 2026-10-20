import { describe, expect, it } from 'vitest';
import { formatBytes } from '../formatBytes';

describe('formatBytes', () => {
  it('keeps bytes below one KiB exact', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('steps to the largest unit that keeps the value under 1024', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1_048_576)).toBe('1.0 MB');
    expect(formatBytes(1_610_612_736)).toBe('1.5 GB');
  });

  // AgentConnectionView's former private copy had a TB step; the shared
  // format carries it so that surface reads the same after the merge.
  it('reports a TiB as TB rather than 1024.0 GB', () => {
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
  });
});
