import { describe, expect, it, vi } from 'vitest';
import { resolveRef } from '../lib/git-ref.mjs';

describe('git ref resolution', () => {
  it('resolves an exact commit without changing repository state', () => {
    const run = vi.fn(() => 'a'.repeat(40));

    expect(resolveRef('origin/main', run)).toBe('a'.repeat(40));
    expect(run).toHaveBeenCalledWith([
      'rev-parse',
      '--verify',
      'origin/main^{commit}',
    ]);
  });

  it('returns null when the ref is unavailable', () => {
    expect(
      resolveRef('missing', () => {
        throw new Error('unknown revision');
      }),
    ).toBeNull();
  });
});
