import type { LiveSurfaceInput } from '@kontourai/station-contracts/live-surface';
import { describe, expect, test } from 'vitest';
import { SyntheticLiveSurfaceProducer } from '../../../__test-utils__/synthetic-live-surface-producer.js';
import {
  claimAgentControl,
  dispatchAgentInput,
  dispatchHumanInput,
  type LiveSurfaceAuthorizer,
  LiveSurfaceRegistry,
  type LiveSurfaceRegistryOptions,
} from '../registry.js';

const agent = {
  kind: 'agent',
  principal: 'agent:builtin:coder',
  sessionId: 'session-a',
} as const;
const OPERATOR = 'human:local:operator';
const human = {
  kind: 'human',
  principal: OPERATOR,
  device: 'device:a',
} as const;
const move = (x: number) =>
  ({ kind: 'pointer', type: 'move', x, y: 1 }) as const;
const key = (k: string, type: 'down' | 'up' = 'down') =>
  ({ kind: 'key', type, key: k, code: `Key${k.toUpperCase()}` }) as const;
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function setup(
  authorize: LiveSurfaceAuthorizer = () => true,
  options: LiveSurfaceRegistryOptions = {},
) {
  const registry = new LiveSurfaceRegistry(options);
  const producer = new SyntheticLiveSurfaceProducer('surface-1');
  registry.register(producer, { authorize });
  return { registry, producer, entry: registry.get('surface-1')! };
}

const keysOf = (events: LiveSurfaceInput[]) =>
  events.map((event) =>
    event.kind === 'key'
      ? `${event.type}:${event.key}`
      : event.kind === 'pointer'
        ? `${event.type}:${event.button ?? event.x}`
        : event.text,
  );

describe('live surface registry', () => {
  test('an agent drives a surface with zero viewers; the frame stream never starts (D6)', async () => {
    const { producer, entry } = setup();
    expect(entry.hub.viewerCount).toBe(0);
    const claim = await claimAgentControl(entry, agent, OPERATOR);
    const result = await dispatchAgentInput(
      entry,
      agent,
      OPERATOR,
      claim.lease.epoch,
      [move(1), { kind: 'text', text: 'hello' }],
    );
    expect(result).toMatchObject({ ok: true, accepted: 2 });
    expect(producer.dispatched).toEqual([
      move(1),
      { kind: 'text', text: 'hello' },
    ]);
    expect(producer.starts).toEqual([]);
    expect(producer.running).toBe(false);
  });

  test('human input arriving mid-batch preempts a running agent batch at its next event (B3)', async () => {
    const { producer, entry } = setup();
    producer.dispatchImpl = () => sleep(20);
    const epoch = (await claimAgentControl(entry, agent, OPERATOR)).lease.epoch;
    const agentRun = dispatchAgentInput(entry, agent, OPERATOR, epoch, [
      key('a'),
      key('a', 'up'),
      key('b'),
      key('b', 'up'),
      key('c'),
    ]);
    await sleep(5); // the agent's first event is in flight
    const humanRun = dispatchHumanInput(entry, human, epoch, [key('h')]);
    const [agentResult, humanResult] = await Promise.all([agentRun, humanRun]);
    expect(agentResult).toMatchObject({
      ok: false,
      code: 'stale-epoch',
      accepted: 1,
    });
    expect(humanResult).toMatchObject({
      ok: true,
      lease: { holder: human, epoch: epoch + 1 },
    });
    // The agent's first key was down when the human took over: the handoff
    // released it before the human's input ran.
    expect(keysOf(producer.dispatched)).toEqual(['down:a', 'up:a', 'down:h']);
  });

  test('a handoff releases every button and key the previous controller held (S4)', async () => {
    const { producer, entry } = setup();
    const epoch = (await claimAgentControl(entry, agent, OPERATOR)).lease.epoch;
    await dispatchAgentInput(entry, agent, OPERATOR, epoch, [
      { kind: 'pointer', type: 'down', x: 5, y: 6, button: 'left' },
      key('shift'),
    ]);
    await dispatchHumanInput(entry, human, epoch, [move(9)]);
    expect(producer.dispatched.slice(2)).toEqual([
      {
        kind: 'pointer',
        type: 'up',
        x: 5,
        y: 6,
        button: 'left',
        clickCount: 1,
      },
      { kind: 'key', type: 'up', key: 'shift', code: 'KeySHIFT' },
      move(9),
    ]);
  });

  test('a released button is not released again at the handoff', async () => {
    const { producer, entry } = setup();
    const epoch = (await claimAgentControl(entry, agent, OPERATOR)).lease.epoch;
    await dispatchAgentInput(entry, agent, OPERATOR, epoch, [
      { kind: 'pointer', type: 'down', x: 5, y: 6, button: 'left' },
      { kind: 'pointer', type: 'up', x: 5, y: 6, button: 'left' },
    ]);
    await dispatchHumanInput(entry, human, epoch, [move(9)]);
    expect(producer.dispatched).toHaveLength(3);
  });

  test('an agent batch stops at the event where a human took over', async () => {
    const { producer, entry } = setup();
    const epoch = (await claimAgentControl(entry, agent, OPERATOR)).lease.epoch;
    let humanRun: Promise<unknown> | undefined;
    producer.dispatchImpl = async () => {
      if (producer.dispatched.length === 1)
        humanRun = dispatchHumanInput(entry, human, epoch, [move(100)]);
    };
    const result = await dispatchAgentInput(entry, agent, OPERATOR, epoch, [
      move(1),
      move(2),
      move(3),
    ]);
    await humanRun;
    expect(result).toMatchObject({
      ok: false,
      code: 'stale-epoch',
      accepted: 1,
    });
    expect(producer.dispatched).toEqual([move(1), move(100)]);
  });

  test('an agent that does not hold the lease cannot dispatch', async () => {
    const { producer, entry } = setup();
    expect(
      await dispatchAgentInput(entry, agent, OPERATOR, 0, [move(1)]),
    ).toMatchObject({ ok: false, code: 'not-holder', accepted: 0 });
    expect(producer.dispatched).toEqual([]);
  });

  test("the agent's acting-for principal must be authorized for control and input (S6)", async () => {
    const granted: string[] = [];
    const { producer, entry } = setup((principal, _surface, action) => {
      granted.push(`${principal}:${action}`);
      return principal === OPERATOR && action === 'control';
    });
    expect(
      await claimAgentControl(entry, agent, 'human:local:stranger'),
    ).toMatchObject({ ok: false, code: 'not-authorized', lease: { epoch: 0 } });
    const claim = await claimAgentControl(entry, agent, OPERATOR);
    expect(claim).toMatchObject({ ok: true, lease: { holder: agent } });
    expect(
      await dispatchAgentInput(entry, agent, OPERATOR, claim.lease.epoch, [
        move(1),
      ]),
    ).toMatchObject({ ok: false, code: 'not-authorized', accepted: 0 });
    expect(producer.dispatched).toEqual([]);
    expect(granted).toEqual([
      'human:local:stranger:control',
      `${OPERATOR}:control`,
      `${OPERATOR}:input`,
    ]);
  });

  test('a hung producer dispatch fails the batch and never blocks the chain (S7)', async () => {
    const { producer, entry } = setup(() => true, { dispatchTimeoutMs: 30 });
    producer.dispatchImpl = () => new Promise(() => {});
    const first = await dispatchHumanInput(entry, human, 0, [move(1), move(2)]);
    expect(first).toMatchObject({
      ok: false,
      code: 'dispatch-failed',
      accepted: 0,
    });
    producer.dispatchImpl = async () => {};
    const second = await dispatchHumanInput(entry, human, 1, [move(3)]);
    expect(second).toMatchObject({ ok: true, accepted: 1 });
  });

  test('concurrent batches for one surface never interleave', async () => {
    const { producer, entry } = setup();
    producer.dispatchImpl = () => sleep(1);
    const first = dispatchHumanInput(entry, human, 0, [move(1), move(2)]);
    const second = dispatchHumanInput(entry, human, 1, [move(3), move(4)]);
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
        expect(await registry.get(id)!.authorize(OPERATOR, action)).toBe(false);
  });
});
