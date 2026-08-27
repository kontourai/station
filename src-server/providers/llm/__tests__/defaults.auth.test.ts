import { describe, expect, test } from 'vitest';
import { DefaultAuthProvider } from '../defaults.js';

describe('DefaultAuthProvider', () => {
  test('reports absent authentication as not configured, never valid', async () => {
    await expect(new DefaultAuthProvider().getStatus()).resolves.toEqual({
      provider: 'none',
      status: 'not-configured',
      expiresAt: null,
      message: 'No auth provider configured',
    });
  });
});
