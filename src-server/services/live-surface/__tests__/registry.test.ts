import { describe, expect, test } from 'vitest';
import { SyntheticLiveSurfaceProducer } from '../../../__test-utils__/synthetic-live-surface-producer.js';
import {
  dispatchAgentInput,
  dispatchHumanInput,
  LiveSurfaceRegistry,
} from '../registry.js';

const agent = {
  kind: 'agent',
  principal: 'agent:builtin:coder',
  sessionId: 'session-a',
} as const;
const move = (x: number) =>
  ({ kind: 'pointer', type: 'move', x, y: 1 }) as const;

describe('live surface registry', () => {
  test('an agent drives a surface with zero viewers; the frame stream never starts', async () => {
    const registry = new LiveSurfaceRegistry();
    const producer = new SyntheticLiveSurfaceProducer('surface-1');
    registry.register(producer, { authorize: () => true });
    const entry = registry.get('surface-1')!;
    expect(entry.hub.viewerCount).toBe(0);
    const claim = entry.lease.claimForAgent(agent.principal, agent.sessionId);
    const result = await dispatchAgentInput(entry, agent, claim.lease.epoch, [
      move(1),
      { kind: 'text', text: 'hello' },
    ]);
    expect(result).toMatchObject({ ok: true, accepted: 2 });
    expect(producer.dispatched).toEqual([
      move(1),
      { kind: 'text', text: 'hello' },
    ]);
    expect(producer.starts).toEqual([]);
    expect(producer.running).toBe(false);
  });

  test('an agent batch stops at the event where a human took over', async () => {
    const registry = new LiveSurfaceRegistry();
    const producer = new SyntheticLiveSurfaceProducer('surface-1');
    registry.register(producer, { authorize: () => true });
    const entry = registry.get('surface-1')!;
    const epoch = entry.lease.claimForAgent(agent.principal, agent.sessionId)
      .lease.epoch;
    producer.dispatchImpl = async () => {
      // The human reaches for the surface while the agent's first event runs.
      if (producer.dispatched.length === 1)
        entry.lease.claimForHumanInput('human:local:operator', epoch);
    };
    const result = await dispatchAgentInput(entry, agent, epoch, [
      move(1),
      move(2),
      move(3),
    ]);
    expect(result).toMatchObject({
      ok: false,
      code: 'stale-epoch',
      accepted: 1,
      lease: { holder: { kind: 'human' } },
    });
    expect(producer.dispatched).toEqual([move(1)]);
  });

  test('an agent that does not hold the lease cannot dispatch', async () => {
    const registry = new LiveSurfaceRegistry();
    const producer = new SyntheticLiveSurfaceProducer('surface-1');
    registry.register(producer, { authorize: () => true });
    const entry = registry.get('surface-1')!;
    expect(await dispatchAgentInput(entry, agent, 0, [move(1)])).toMatchObject({
      ok: false,
      code: 'not-holder',
      accepted: 0,
    });
    expect(producer.dispatched).toEqual([]);
  });

  test('concurrent batches for one surface never interleave', async () => {
    const registry = new LiveSurfaceRegistry();
    const producer = new SyntheticLiveSurfaceProducer('surface-1');
    registry.register(producer, { authorize: () => true });
    const entry = registry.get('surface-1')!;
    producer.dispatchImpl = () =>
      new Promise((resolve) => setTimeout(resolve, 1));
    const principal = 'human:local:operator';
    const first = dispatchHumanInput(entry, principal, 0, [move(1), move(2)]);
    const second = dispatchHumanInput(entry, principal, 1, [move(3), move(4)]);
    expect(await first).toMatchObject({ ok: true, accepted: 2 });
    expect(await second).toMatchObject({ ok: true, accepted: 2 });
    expect(producer.dispatched).toEqual([move(1), move(2), move(3), move(4)]);
  });

  test('an authorizer that throws, or registration without one, denies', async () => {
    const registry = new LiveSurfaceRegistry();
    registry.register(new SyntheticLiveSurfaceProducer('none'));
    registry.register(new SyntheticLiveSurfaceProducer('throws'), {
      authorize: () => {
        throw new Error('membership store unavailable');
      },
    });
    registry.register(new SyntheticLiveSurfaceProducer('truthy'), {
      authorize: () => 'yes' as unknown as boolean,
    });
    for (const id of ['none', 'throws', 'truthy'])
      for (const action of ['view', 'input', 'control'] as const)
        expect(
          await registry.get(id)!.authorize('human:local:operator', action),
        ).toBe(false);
  });
});
