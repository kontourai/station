import { describe, expect, test, vi } from 'vitest';
import { readJson } from '../../../__test-utils__/read-json.js';
import { createAppHomeRoutes } from '../app-home.js';

/**
 * station#3552, review round 2 (independent, Codex).
 *
 * The route catches each account's read individually so one failure cannot 500
 * the others. Proving that needs a REJECTED read — and the reader is now fenced
 * so thoroughly (`getJson` catches fetch/body failures, `normalizedOrUnknown`
 * catches parsing) that it does not reject in practice. The reviewer removed
 * the route's `.catch()` and every route test stayed green for exactly that
 * reason: they exercised a fulfilled `unknown`.
 *
 * So the reader is mocked to reject here. That makes this a test of the ROUTE's
 * guard rather than of the reader, which is the point: the route must not
 * depend on the reader's fence being total. A future reader — a third provider,
 * a refactor — that rejects must degrade to one account's `unknown`, not to a
 * 500 for every account.
 */
vi.mock('../../../services/connections/credential-usage.js', () => ({
  readCredentialUsage: vi.fn(async () => {
    throw new Error('reader rejected');
  }),
}));

function recoveryFixture() {
  return {
    getCredentialRecovery: vi.fn(async () => ({
      profiles: [{ ref: 'profile-a', label: 'Account A' }],
      group: { profileRefs: [], enrolledProfileRefs: [] },
      policy: { automatic: false },
      application: { capability: 'restart_resume' },
    })),
    getConnection: vi.fn(async () => ({
      kind: 'agent',
      capabilities: ['agent-runtime'],
    })),
  };
}

describe('credential usage route — a rejected read is isolated', () => {
  test('a reader that rejects yields per-account unknown, not a 500', async () => {
    const app = createAppHomeRoutes({
      connectionService: recoveryFixture() as never,
    });

    const res = await app.request('/agent/codex/credential-usage');
    const body = await readJson<{
      success: boolean;
      data: {
        credentials: Array<{
          ref: string | null;
          usage: { status: string; reason?: string };
        }>;
      };
    }>(res);

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    // Both the connection's own account and the enrolled profile are present.
    expect(body.data.credentials).toHaveLength(2);
    for (const entry of body.data.credentials) {
      expect(entry.usage.status).toBe('unknown');
      expect(entry.usage.reason).toBeTruthy();
    }
  });
});
