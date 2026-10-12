/**
 * #3586: the member-caller decision table. The production composition is
 * exercised by `runtime-routes-project-guest-admin.test.ts` (sessions) and
 * `runtime-routes-account-personal-tokens.test.ts` (tokens); this pins the
 * branch neither can reach on demand: a token that stops resolving between
 * the gate and a Project read must be no caller, never operator rules.
 */
import { describe, expect, test } from 'vitest';
import { accountMemberCaller } from '../account-member-caller.js';

const ACCOUNT = 'human:deployment:0123abcd';
const request = new Request('https://station.example.test/api/projects');

describe('accountMemberCaller', () => {
  test('a token that no longer resolves is no caller, not the operator', async () => {
    expect(
      await accountMemberCaller(request, {
        accountToken: () => null,
        agentOwnerId: () => undefined,
      }),
    ).toEqual({ kind: 'none' });
  });

  test('a current account token is a member; an untied request keeps operator rules', async () => {
    expect(
      await accountMemberCaller(request, {
        accountToken: () => ACCOUNT,
        agentOwnerId: () => undefined,
      }),
    ).toEqual({ kind: 'member', via: 'personal-token', principalId: ACCOUNT });
    expect(
      await accountMemberCaller(request, {
        accountToken: () => undefined,
        agentOwnerId: () => undefined,
      }),
    ).toBeUndefined();
  });

  test('an invalid account credential is no caller even with a token', async () => {
    expect(
      await accountMemberCaller(request, {
        authenticate: async () => ({ kind: 'invalid', reason: 'expired' }),
        accountToken: () => ACCOUNT,
        agentOwnerId: () => undefined,
      }),
    ).toEqual({ kind: 'none' });
  });
});
