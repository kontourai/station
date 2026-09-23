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
const alice = {
  kind: 'human',
  principal: 'human:local:alice',
  device: 'device:laptop',
} as const;
const bob = {
  kind: 'human',
  principal: 'human:local:bob',
  device: 'device:phone',
} as const;

describe('live surface control lease', () => {
  test('human input auto-claims with epoch + 1 and fences the in-flight agent', () => {
    const { state } = lease();
    const claimed = state.claimForAgent(agent.principal, agent.sessionId);
    expect(claimed.ok).toBe(true);
    const agentFence = claimed.lease.fence!;
    expect(claimed.lease.epoch).toBe(1);
    // The agent's op checks the fence before its step: still current.
    expect(state.isCurrent(agentFence, agent).ok).toBe(true);

    const human = state.claimForHumanInput(alice, claimed.lease.epoch);
    expect(human).toMatchObject({
      ok: true,
      lease: { epoch: 2, holder: alice },
    });
    // ...and after its step: fenced. This is what makes the op abort.
    expect(state.isCurrent(agentFence, agent)).toMatchObject({
      ok: false,
      code: 'stale-fence',
    });
  });

  test('an agent claim never preempts a live human; it may claim once the hold lapses', () => {
    const { state, clock } = lease();
    state.claimForHumanInput(alice, 0);
    clock.t = 800;
    // More input renews the hold: live is measured from the LAST input.
    state.claimForHumanInput(alice, 1);
    clock.t = 1_700;
    expect(state.claimForAgent(agent.principal, agent.sessionId)).toMatchObject(
      {
        ok: false,
        code: 'human-controlling',
        lease: { epoch: 1, holder: alice },
      },
    );
    clock.t = 1_800;
    expect(state.claimForAgent(agent.principal, agent.sessionId)).toMatchObject(
      { ok: true, lease: { epoch: 2, holder: agent } },
    );
  });

  test('a human acting on a stale view is rejected, not auto-claimed', () => {
    const { state } = lease();
    // The human last observed epoch 0; an agent has since taken the surface.
    state.claimForAgent(agent.principal, agent.sessionId);
    const result = state.claimForHumanInput(alice, 0);
    expect(result).toMatchObject({ ok: false, code: 'stale-epoch' });
    expect(state.snapshot()).toMatchObject({ epoch: 1, holder: agent });
  });

  test('a continuing human holder renews without moving the epoch or the fence', () => {
    const { state, clock } = lease();
    const first = state.claimForHumanInput(alice, 0);
    clock.t = 500;
    const again = state.claimForHumanInput(alice, 1);
    expect(again).toMatchObject({
      ok: true,
      lease: { epoch: 1, fence: first.lease.fence, expiresAt: 1_500 },
    });
  });

  test("a lapsed lease does not refuse the same holder's next input (S3)", () => {
    const { state, clock } = lease();
    const first = state.claimForHumanInput(alice, 0);
    clock.t = 1_000; // the hold lapses: no holder, nobody else acted
    expect(state.snapshot()).toMatchObject({ epoch: 1, holder: null });
    const next = state.claimForHumanInput(alice, first.lease.epoch);
    expect(next).toMatchObject({
      ok: true,
      lease: { epoch: 1, holder: alice },
    });
  });

  test('a straggler from before a release is refused, even after the same session reclaims (D2)', () => {
    const { state } = lease();
    const op1 = state.claimForAgent(agent.principal, agent.sessionId).lease;
    // Operation 1 releases; its straggler must not pass.
    expect(state.release(agent, { fence: op1.fence! }).ok).toBe(true);
    expect(state.isCurrent(op1.fence!, agent)).toMatchObject({
      ok: false,
      code: 'stale-fence',
    });
    // The same session reclaims for operation 2: same viewer epoch...
    const op2 = state.claimForAgent(agent.principal, agent.sessionId).lease;
    expect(op2.epoch).toBe(op1.epoch);
    // ...but operation 1's straggler is still refused, and 2's passes.
    expect(state.isCurrent(op1.fence!, agent)).toMatchObject({
      ok: false,
      code: 'stale-fence',
    });
    expect(state.isCurrent(op2.fence!, agent).ok).toBe(true);
  });

  test('a straggler from before an expiry is refused after the same session reclaims (D2)', () => {
    const { state, clock } = lease();
    const op1 = state.claimForAgent(agent.principal, agent.sessionId).lease;
    clock.t = 2_000; // expires
    const op2 = state.claimForAgent(agent.principal, agent.sessionId).lease;
    expect(op2.epoch).toBe(op1.epoch);
    expect(state.isCurrent(op1.fence!, agent).ok).toBe(false);
    expect(state.isCurrent(op2.fence!, agent).ok).toBe(true);
  });

  test('expiry leaves no holder and still fences the expired agent', () => {
    const { state, clock } = lease();
    const claimed = state.claimForAgent(agent.principal, agent.sessionId);
    const changes: (string | null)[] = [];
    state.onChange((next) => changes.push(next.holder?.principal ?? null));
    clock.t = 1_999;
    expect(state.isCurrent(claimed.lease.fence!, agent).ok).toBe(true);
    clock.t = 2_000;
    expect(state.snapshot()).toMatchObject({
      epoch: 1,
      holder: null,
      expiresAt: null,
    });
    expect(state.isCurrent(claimed.lease.fence!, agent).ok).toBe(false);
    expect(changes).toEqual([null]);
    // Another agent taking over is a handoff: the epoch advances.
    expect(state.claimForAgent('agent:other', 'session-b')).toMatchObject({
      ok: true,
      lease: { epoch: 2 },
    });
  });

  test('a second human takes control, fences the first, and cannot release their lease (M4)', () => {
    const { state } = lease();
    const a = state.claimForHumanInput(alice, 0);
    expect(a.lease).toMatchObject({ epoch: 1, holder: alice });
    // Bob cannot release Alice's lease.
    expect(state.release(bob, { epoch: 1 })).toMatchObject({
      ok: false,
      code: 'not-holder',
      lease: { holder: alice },
    });
    const b = state.claimForHumanInput(bob, 1);
    expect(b.lease).toMatchObject({ epoch: 2, holder: bob });
    expect(state.isCurrent(a.lease.fence!, alice)).toMatchObject({
      ok: false,
      code: 'stale-fence',
    });
    // Alice's view is now stale: her next batch is refused, not a takeover.
    expect(state.claimForHumanInput(alice, 1)).toMatchObject({
      ok: false,
      code: 'stale-epoch',
    });
  });

  test('the same person on another device is a different controller', () => {
    const { state } = lease();
    state.claimForHumanInput(alice, 0);
    const otherDevice = { ...alice, device: 'device:tablet' };
    const other = state.claimForHumanInput(otherDevice, 1);
    expect(other).toMatchObject({
      ok: true,
      lease: { epoch: 2, holder: otherDevice },
    });
    expect(state.isCurrent(other.lease.fence!, alice)).toMatchObject({
      ok: false,
      code: 'not-holder',
    });
  });

  test('handoff listeners fire on a change of controller, not on renewals or lapses', () => {
    const { state, clock } = lease();
    const handoffs: [number, string | null][] = [];
    state.onHandoff((next, previous) =>
      handoffs.push([next.epoch, previous?.principal ?? null]),
    );
    state.claimForHumanInput(alice, 0);
    state.claimForHumanInput(alice, 1); // renewal
    clock.t = 5_000; // lapse
    state.snapshot();
    state.claimForHumanInput(alice, 1); // same holder returns
    state.claimForHumanInput(bob, 1); // handoff
    expect(handoffs).toEqual([
      [1, null],
      [2, 'human:local:alice'],
    ]);
  });

  test('only the current holder, with a current stamp, can release', () => {
    const { state } = lease();
    const claimed = state.claimForAgent(agent.principal, agent.sessionId);
    expect(state.release(alice, { fence: claimed.lease.fence! })).toMatchObject(
      {
        ok: false,
        code: 'not-holder',
      },
    );
    expect(
      state.release(agent, { fence: claimed.lease.fence! - 1 }),
    ).toMatchObject({
      ok: false,
      code: 'stale-fence',
    });
    expect(state.release(agent, { fence: claimed.lease.fence! })).toMatchObject(
      {
        ok: true,
        lease: { epoch: 1, holder: null },
      },
    );
  });

  test('the same agent principal in a different session is a different holder', () => {
    const { state } = lease();
    const claimed = state.claimForAgent(agent.principal, agent.sessionId);
    expect(state.claimForAgent(agent.principal, 'session-b')).toMatchObject({
      ok: false,
      code: 'held-by-other',
    });
    expect(
      state.isCurrent(claimed.lease.fence!, {
        ...agent,
        sessionId: 'session-b',
      }),
    ).toMatchObject({ ok: false, code: 'not-holder' });
  });
  test('a human with something pressed stays live past the hold time (N1)', () => {
    const { state, clock } = lease();
    let pressing = true;
    state.setHoldProbe(() => pressing);
    state.claimForHumanInput(alice, 0);
    clock.t = 5_000; // long past humanHoldMs, but still holding
    expect(state.snapshot()).toMatchObject({ holder: alice });
    expect(state.claimForAgent(agent.principal, agent.sessionId)).toMatchObject(
      {
        ok: false,
        code: 'human-controlling',
      },
    );
    pressing = false; // released: the hold runs from here and then lapses
    clock.t = 5_999;
    expect(state.snapshot()).toMatchObject({ holder: alice });
    clock.t = 6_000;
    expect(state.snapshot()).toMatchObject({ holder: null });
  });

  test('a disposed lease refuses every claim with a typed code (N2)', () => {
    const { state } = lease();
    state.dispose();
    for (const result of [
      state.claimHuman(alice),
      state.claimForHumanInput(alice, 0),
      state.claimForAgent(agent.principal, agent.sessionId),
    ])
      expect(result).toMatchObject({
        ok: false,
        code: 'surface-closed',
        lease: { holder: null, expiresAt: null },
      });
  });
});
