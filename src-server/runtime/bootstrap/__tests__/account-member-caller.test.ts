/**
 * #3586: the member-caller decisions that HTTP cannot reach on demand.
 * `agentOwnerMemberCaller` is the synchronous rule the Task board and
 * knowledge roots use (runtime-routes' `agentOwnerMayUseProject`), and
 * `agentAudienceForMemberCaller` is the Agent audience gate's decision; the
 * production composition tests (guest-admin, agent audience, station-control
 * scope) exercise both through real requests.
 */
import { describe, expect, test, vi } from 'vitest';
import {
  agentAudienceForMemberCaller,
  agentOwnerMemberCaller,
} from '../account-member-caller.js';

const ACCOUNT = 'human:deployment:0123abcd';

describe('agentOwnerMemberCaller', () => {
  test('an account owner is a member, an owner-less call is no caller, anyone else keeps operator rules', () => {
    expect(agentOwnerMemberCaller(ACCOUNT)).toEqual({
      kind: 'member',
      via: 'agent-owner',
      principalId: ACCOUNT,
    });
    expect(agentOwnerMemberCaller(null)).toEqual({ kind: 'none' });
    expect(agentOwnerMemberCaller('human:local:operator')).toBeUndefined();
    expect(agentOwnerMemberCaller(undefined)).toBeUndefined();
  });
});

describe('agentAudienceForMemberCaller', () => {
  const deps = (current = 'human:deployment:current') => ({
    currentPrincipalId: vi.fn(async () => current),
    admissions: (principalId: string) => principalId,
  });

  test('an account session is re-resolved through the current principal', async () => {
    const d = deps();
    await expect(
      agentAudienceForMemberCaller(
        { kind: 'member', via: 'account-session', principalId: ACCOUNT },
        d,
      ),
    ).resolves.toEqual({
      kind: 'member',
      admissions: 'human:deployment:current',
    });
    expect(d.currentPrincipalId).toHaveBeenCalledTimes(1);
  });

  test('a station-control owner uses its recorded owner', async () => {
    const d = deps();
    await expect(
      agentAudienceForMemberCaller(
        { kind: 'member', via: 'agent-owner', principalId: ACCOUNT },
        d,
      ),
    ).resolves.toEqual({ kind: 'member', admissions: ACCOUNT });
    expect(d.currentPrincipalId).not.toHaveBeenCalled();
  });

  test('no caller is admitted to no Agent; an untied request keeps operator rules', async () => {
    await expect(
      agentAudienceForMemberCaller({ kind: 'none' }, deps()),
    ).resolves.toEqual({ kind: 'none' });
    await expect(
      agentAudienceForMemberCaller(undefined, deps()),
    ).resolves.toEqual({ kind: 'operator' });
  });
});
