import { describe, expect, test } from 'vitest';
import { LiveSurfaceControlLeaseState } from '../control-lease.js';

function lease(clock = { t: 0 }) {
  return {
    clock,
    state: new LiveSurfaceControlLeaseState('surface-1', {
      now: () => clock.t,
      humanHoldMs: 1_000,
      agentTtlMs: 2_000,
    }),
  };
}

const agent = {
  kind: 'agent',
  principal: 'agent:builtin:coder',
  sessionId: 'session-a',
} as const;

describe('live surface control lease', () => {
  test('human input auto-claims with epoch + 1 and fences the in-flight agent', () => {
    const { state } = lease();
    const claimed = state.claimForAgent(agent.principal, agent.sessionId);
    expect(claimed.ok).toBe(true);
    const agentEpoch = claimed.lease.epoch;
    expect(agentEpoch).toBe(1);
    // The agent's op checks the fence before its step: still current.
    expect(state.isCurrent(agentEpoch, agent).ok).toBe(true);

    const human = state.claimForHumanInput('human:local:operator', agentEpoch);
    expect(human).toMatchObject({
      ok: true,
      lease: {
        epoch: agentEpoch + 1,
        holder: { kind: 'human', principal: 'human:local:operator' },
      },
    });
    // ...and after its step: fenced. This is what makes the op abort.
    expect(state.isCurrent(agentEpoch, agent)).toMatchObject({
      ok: false,
      code: 'stale-epoch',
    });
  });

  test('an agent claim never preempts a live human; it may claim once the hold lapses', () => {
    const { state, clock } = lease();
    state.claimForHumanInput('human:local:operator', 0);
    clock.t = 800;
    // More input renews the hold: live is measured from the LAST input.
    state.claimForHumanInput('human:local:operator', 1);
    clock.t = 1_700;
    expect(state.claimForAgent(agent.principal, agent.sessionId)).toMatchObject(
      {
        ok: false,
        code: 'human-controlling',
        lease: { epoch: 1, holder: { kind: 'human' } },
      },
    );
    clock.t = 1_800;
    expect(state.claimForAgent(agent.principal, agent.sessionId)).toMatchObject(
      { ok: true, lease: { epoch: 3, holder: agent } },
    );
  });

  test('a human acting on a stale view is rejected, not auto-claimed', () => {
    const { state } = lease();
    // The human last observed epoch 0; an agent has since taken the surface.
    state.claimForAgent(agent.principal, agent.sessionId);
    const result = state.claimForHumanInput('human:local:operator', 0);
    expect(result).toMatchObject({ ok: false, code: 'stale-epoch' });
    expect(state.snapshot()).toMatchObject({ epoch: 1, holder: agent });
  });

  test('a continuing human holder renews without moving the epoch', () => {
    const { state, clock } = lease();
    state.claimForHumanInput('human:local:operator', 0);
    clock.t = 500;
    const again = state.claimForHumanInput('human:local:operator', 1);
    expect(again).toMatchObject({
      ok: true,
      lease: { epoch: 1, expiresAt: 1_500 },
    });
  });

  test('expiry releases the holder and advances the epoch, fencing it', () => {
    const { state, clock } = lease();
    const claimed = state.claimForAgent(agent.principal, agent.sessionId);
    const changes: number[] = [];
    state.onChange((next) => changes.push(next.epoch));
    clock.t = 1_999;
    expect(state.isCurrent(claimed.lease.epoch, agent).ok).toBe(true);
    clock.t = 2_000;
    expect(state.snapshot()).toMatchObject({
      epoch: 2,
      holder: null,
      expiresAt: null,
    });
    expect(state.isCurrent(claimed.lease.epoch, agent)).toMatchObject({
      ok: false,
      code: 'stale-epoch',
    });
    expect(changes).toEqual([2]);
    // Once expired, another agent may claim.
    expect(state.claimForAgent('agent:other', 'session-b')).toMatchObject({
      ok: true,
      lease: { epoch: 3 },
    });
  });

  test('only the current holder at the current epoch can release', () => {
    const { state } = lease();
    state.claimForAgent(agent.principal, agent.sessionId);
    expect(
      state.release({ kind: 'human', principal: 'human:local:operator' }, 1),
    ).toMatchObject({ ok: false, code: 'not-holder' });
    expect(state.release(agent, 0)).toMatchObject({
      ok: false,
      code: 'stale-epoch',
    });
    expect(state.release(agent, 1)).toMatchObject({
      ok: true,
      lease: { epoch: 2, holder: null },
    });
  });

  test('the same agent principal in a different session is a different holder', () => {
    const { state } = lease();
    state.claimForAgent(agent.principal, agent.sessionId);
    expect(state.claimForAgent(agent.principal, 'session-b')).toMatchObject({
      ok: false,
      code: 'held-by-other',
    });
    expect(
      state.isCurrent(1, { ...agent, sessionId: 'session-b' }),
    ).toMatchObject({ ok: false, code: 'not-holder' });
  });
});
