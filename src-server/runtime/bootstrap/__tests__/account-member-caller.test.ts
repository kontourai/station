/**
 * #3586: the member-caller decisions that HTTP cannot reach on demand. The
 * production composition is exercised by
 * `runtime-routes-project-guest-admin.test.ts` (sessions),
 * `runtime-routes-account-personal-tokens.test.ts` (tokens) and the agent
 * audience and station-control scope suites; this pins the branches they
 * cannot reach: a token that stops resolving between the gate and a Project
 * read is no caller, `agentOwnerMemberCaller` (the Task board and knowledge
 * roots' synchronous rule) and `agentAudienceForMemberCaller` (the Agent
 * audience gate's decision, including tokens, which the gate refuses on
 * every Agent path before audience is consulted).
 */
import { describe, expect, test, vi } from 'vitest';
import {
  accountMemberCaller,
  agentAudienceForMemberCaller,
  agentOwnerMemberCaller,
} from '../account-member-caller.js';

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

  test('an account-tied token is re-resolved through the current principal too', async () => {
    const d = deps();
    await expect(
      agentAudienceForMemberCaller(
        { kind: 'member', via: 'personal-token', principalId: ACCOUNT },
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
