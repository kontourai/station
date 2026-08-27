import { describe, expect, test } from 'vitest';
import { classifyCommandProbe } from '../system-status-routes.js';

describe('developer service command probes', () => {
  test('keeps ready, missing, unauthenticated, timeout, and execution failures distinct', () => {
    expect(classifyCommandProbe(null, true)).toBe('ready');
    expect(
      classifyCommandProbe(
        Object.assign(new Error('missing'), { code: 'ENOENT' }),
        true,
      ),
    ).toBe('not_installed');
    expect(
      classifyCommandProbe(
        Object.assign(new Error('not signed in'), { code: 1 }),
        true,
      ),
    ).toBe('sign_in_required');
    expect(
      classifyCommandProbe(
        Object.assign(new Error('timed out'), {
          code: 'ETIMEDOUT',
          killed: true,
        }),
        true,
      ),
    ).toBe('error');
    expect(
      classifyCommandProbe(
        Object.assign(new Error('cannot execute'), { code: 'EACCES' }),
        true,
      ),
    ).toBe('error');
  });
});
