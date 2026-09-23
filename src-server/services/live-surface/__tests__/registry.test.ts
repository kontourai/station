import type { LiveSurfaceInput } from '@kontourai/station-contracts/live-surface';
import { describe, expect, test } from 'vitest';
import { SyntheticLiveSurfaceProducer } from '../../../__test-utils__/synthetic-live-surface-producer.js';
import type { LiveSurfaceHeldInput } from '../producer.js';
import {
  claimAgentControl,
  claimHumanControl,
  dispatchAgentInput,
  dispatchHumanInput,
  type LiveSurfaceAuthorizer,
  LiveSurfaceRegistry,
  type LiveSurfaceRegistryOptions,
  releaseHumanControl,
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
const press = (type: 'down' | 'up', x: number, y: number) =>
  ({ kind: 'pointer', type, x, y, button: 'left', clickCount: 1 }) as const;
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

async function agentFence(entry: ReturnType<typeof setup>['entry']) {
  const claim = await claimAgentControl(entry, agent, OPERATOR);
  expect(claim.ok).toBe(true);
  return claim.lease.fence!;
}

/** Wait until the input chain has drained (the cancel is queued work). */
async function settleChain() {
  await sleep(0);
  await sleep(0);
}

const keysOf = (events: LiveSurfaceInput[]) =>
  events.map((event) =>
    event.kind === 'key'
      ? `${event.type}:${event.key}`
      : event.kind === 'pointer'
        ? `${event.type}@${event.x},${event.y}`
        : event.text,
  );

describe('live surface registry', () => {
  test('an agent drives a surface with zero viewers; the frame stream never starts (D6)', async () => {
    const { producer, entry } = setup();
    expect(entry.hub.viewerCount).toBe(0);
    const fence = await agentFence(entry);
    const result = await dispatchAgentInput(entry, agent, OPERATOR, fence, [
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

  test('human input arriving mid-batch preempts a running agent batch at its next event (B3)', async () => {
    const { producer, entry } = setup();
    producer.dispatchImpl = () => sleep(20);
    const fence = await agentFence(entry);
    const agentRun = dispatchAgentInput(entry, agent, OPERATOR, fence, [
      key('a'),
      key('a', 'up'),
      key('b'),
      key('b', 'up'),
      key('c'),
    ]);
    await sleep(5); // the agent's first event is in flight
    const humanRun = dispatchHumanInput(entry, human, 1, [key('h')]);
    const [agentResult, humanResult] = await Promise.all([agentRun, humanRun]);
    expect(agentResult).toMatchObject({
      ok: false,
      code: 'stale-fence',
      accepted: 1,
    });
    expect(humanResult).toMatchObject({
      ok: true,
      lease: { holder: human, epoch: 2 },
    });
    // The agent's key was down when the human took over: it is released
    // before the human's input runs.
    expect(keysOf(producer.dispatched)).toEqual(['down:a', 'up:a', 'down:h']);
  });

  test("a takeover cancels an agent's in-flight click instead of completing it (D1)", async () => {
    const { producer, entry } = setup();
    producer.dispatchImpl = () => sleep(20);
    const fence = await agentFence(entry);
    // The agent is clicking Delete at (100, 50).
    const agentRun = dispatchAgentInput(entry, agent, OPERATOR, fence, [
      press('down', 100, 50),
      press('up', 100, 50),
    ]);
    await sleep(5); // its down is in flight
    // The human grabs control to stop it.
    const humanRun = dispatchHumanInput(entry, human, 1, [move(300)]);
    await Promise.all([agentRun, humanRun]);
    const ups = producer.dispatched.filter(
      (event) => event.kind === 'pointer' && event.type === 'up',
    );
    // No up where the down was: that would be the click.
    expect(ups).not.toContainEqual(expect.objectContaining({ x: 100, y: 50 }));
    expect(keysOf(producer.dispatched)).toEqual([
      'down@100,50',
      'move@-1,-1',
      'up@-1,-1',
      'move@300,1',
    ]);
  });

  test('a producer with cancelHeldInput is handed what was held and nothing is synthesized', async () => {
    const { producer, entry } = setup();
    const cancelled: LiveSurfaceHeldInput[] = [];
    producer.cancelHeldInput = async (held) => {
      cancelled.push(held);
    };
    const fence = await agentFence(entry);
    await dispatchAgentInput(entry, agent, OPERATOR, fence, [
      press('down', 5, 6),
      key('shift'),
    ]);
    await dispatchHumanInput(entry, human, 1, [move(9)]);
    expect(cancelled).toEqual([
      {
        buttons: ['left'],
        keys: [{ key: 'shift', code: 'KeySHIFT' }],
        pointer: { x: 5, y: 6 },
        pointerType: 'mouse',
        buttonPointerTypes: { left: 'mouse' },
      },
    ]);
    expect(keysOf(producer.dispatched)).toEqual([
      'down@5,6',
      'down:shift',
      'move@9,1',
    ]);
  });

  test('a released button is not cancelled again at the handoff', async () => {
    const { producer, entry } = setup();
    const fence = await agentFence(entry);
    await dispatchAgentInput(entry, agent, OPERATOR, fence, [
      press('down', 5, 6),
      press('up', 5, 6),
    ]);
    await dispatchHumanInput(entry, human, 1, [move(9)]);
    expect(producer.dispatched).toHaveLength(3);
  });

  test('releasing the lease while a button is held cancels it (N-c)', async () => {
    const { producer, entry } = setup();
    const result = await dispatchHumanInput(entry, human, 0, [
      press('down', 7, 8),
    ]);
    expect(result.ok).toBe(true);
    expect(releaseHumanControl(entry, human, result.lease.epoch).ok).toBe(true);
    await settleChain();
    expect(keysOf(producer.dispatched)).toEqual([
      'down@7,8',
      'move@-1,-1',
      'up@-1,-1',
    ]);
  });

  test('an agent batch stops at the event where a human took over', async () => {
    const { producer, entry } = setup();
    const fence = await agentFence(entry);
    let humanRun: Promise<unknown> | undefined;
    producer.dispatchImpl = async () => {
      if (producer.dispatched.length === 1)
        humanRun = dispatchHumanInput(entry, human, 1, [move(100)]);
    };
    const result = await dispatchAgentInput(entry, agent, OPERATOR, fence, [
      move(1),
      move(2),
      move(3),
    ]);
    await humanRun;
    expect(result).toMatchObject({
      ok: false,
      code: 'stale-fence',
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
      await dispatchAgentInput(entry, agent, OPERATOR, claim.lease.fence!, [
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

  test('a timed-out dispatch wedges the surface: nothing overlaps it, and input resumes once it settles (S7, D3)', async () => {
    const { producer, entry } = setup(() => true, { dispatchTimeoutMs: 20 });
    let inFlight = 0;
    let maxInFlight = 0;
    let finishHung!: () => void;
    producer.dispatchImpl = (event) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const done = () => {
        inFlight -= 1;
      };
      if (event.kind === 'pointer' && event.x === 1)
        return new Promise<void>((resolve) => {
          finishHung = () => {
            done();
            resolve();
          };
        });
      done();
      return Promise.resolve();
    };
    const first = await dispatchHumanInput(entry, human, 0, [move(1), move(2)]);
    expect(first).toMatchObject({
      ok: false,
      code: 'dispatch-failed',
      accepted: 0,
    });
    // Wedged: refused outright, and nothing reached the producer.
    const during = await dispatchHumanInput(entry, human, 1, [move(3)]);
    expect(during).toMatchObject({ ok: false, code: 'surface-wedged' });
    expect(producer.dispatched).toEqual([move(1)]);
    finishHung();
    await settleChain();
    const after = await dispatchHumanInput(entry, human, 1, [move(4)]);
    expect(after).toMatchObject({ ok: true, accepted: 1 });
    expect(maxInFlight).toBe(1);
  });

  test('a down that times out and lands late is still cancelled at the handoff (D3)', async () => {
    const { producer, entry } = setup(() => true, { dispatchTimeoutMs: 20 });
    let land!: () => void;
    producer.dispatchImpl = (event) =>
      event.kind === 'pointer' && event.type === 'down'
        ? new Promise<void>((resolve) => {
            land = resolve;
          })
        : Promise.resolve();
    const fence = await agentFence(entry);
    await dispatchAgentInput(entry, agent, OPERATOR, fence, [
      press('down', 40, 40),
    ]);
    // The human takes over while the down is still unsettled.
    expect(await dispatchHumanInput(entry, human, 1, [move(9)])).toMatchObject({
      code: 'surface-wedged',
    });
    land();
    await settleChain();
    expect(await dispatchHumanInput(entry, human, 1, [move(9)])).toMatchObject({
      ok: true,
    });
    expect(keysOf(producer.dispatched)).toEqual([
      'down@40,40',
      'move@-1,-1',
      'up@-1,-1',
      'move@9,1',
    ]);
  });

  test('an up that times out is not released a second time (D3)', async () => {
    const { producer, entry } = setup(() => true, { dispatchTimeoutMs: 20 });
    let land!: () => void;
    producer.dispatchImpl = (event) =>
      event.kind === 'pointer' && event.type === 'up'
        ? new Promise<void>((resolve) => {
            land = resolve;
          })
        : Promise.resolve();
    const fence = await agentFence(entry);
    await dispatchAgentInput(entry, agent, OPERATOR, fence, [
      press('down', 40, 40),
      press('up', 40, 40),
    ]);
    land();
    await settleChain();
    await dispatchHumanInput(entry, human, 1, [move(9)]);
    expect(keysOf(producer.dispatched)).toEqual([
      'down@40,40',
      'up@40,40',
      'move@9,1',
    ]);
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
  test("an agent's lease that expires while it holds input cancels it, with nobody reading the lease (W2)", async () => {
    // (A HUMAN who is pressing never expires — see N1. An agent does.)
    const { producer, entry } = setup(() => true, {
      lease: { agentTtlMs: 30 },
    });
    const fence = await agentFence(entry);
    await dispatchAgentInput(entry, agent, OPERATOR, fence, [
      press('down', 7, 8),
    ]);
    // Nobody watches or drives the surface: the expiry timer must fire.
    await sleep(80);
    await settleChain();
    expect(keysOf(producer.dispatched)).toEqual([
      'down@7,8',
      'move@-1,-1',
      'up@-1,-1',
    ]);
    expect(entry.lease.snapshot().holder).toBeNull();
  });

  test('a touch is cancelled as a touch: the pointer type rides to the producer', async () => {
    const { producer, entry } = setup();
    const fence = await agentFence(entry);
    await dispatchAgentInput(entry, agent, OPERATOR, fence, [
      { ...press('down', 5, 6), pointerType: 'touch' },
    ]);
    await dispatchHumanInput(entry, human, 1, [move(9)]);
    // Default path: the neutral cancel keeps the touch pointer type.
    expect(producer.dispatched.slice(1, 3)).toEqual([
      { kind: 'pointer', type: 'move', x: -1, y: -1, pointerType: 'touch' },
      {
        kind: 'pointer',
        type: 'up',
        x: -1,
        y: -1,
        button: 'left',
        clickCount: 1,
        pointerType: 'touch',
      },
    ]);
    // Hook path: the producer is told it was a touch.
    const cancelled: LiveSurfaceHeldInput[] = [];
    const second = setup();
    second.producer.cancelHeldInput = async (held) => {
      cancelled.push(held);
    };
    const fence2 = await agentFence(second.entry);
    await dispatchAgentInput(second.entry, agent, OPERATOR, fence2, [
      { ...press('down', 5, 6), pointerType: 'touch' },
    ]);
    await dispatchHumanInput(second.entry, human, 1, [move(9)]);
    expect(cancelled[0]?.pointerType).toBe('touch');
  });

  test('viewers are told when the surface wedges and when it recovers (W1a)', async () => {
    // A long heartbeat, so the only thing that can deliver a state record
    // is the wedge being announced.
    const { producer, entry } = setup(() => true, {
      dispatchTimeoutMs: 20,
      hub: { heartbeatMs: 60_000 },
    });
    const viewer = entry.hub.attach({
      maxFps: 10,
      quality: 70,
      maxWidth: 640,
      maxHeight: 640,
    });
    expect(await viewer.next()).toMatchObject({
      kind: 'state',
      state: { wedged: false, wedgedSince: null },
    });
    // Take control first and consume that announcement, so the lease does
    // not change again below.
    await dispatchHumanInput(entry, human, 0, [move(0)]);
    expect(await viewer.next()).toMatchObject({
      kind: 'state',
      state: { wedged: false },
    });
    const nextWithin = (ms: number) =>
      Promise.race([
        viewer.next(),
        new Promise<'nothing'>((resolve) =>
          setTimeout(() => resolve('nothing'), ms),
        ),
      ]);
    let finish!: () => void;
    producer.dispatchImpl = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    await dispatchHumanInput(entry, human, 1, [move(1)]);
    expect(await nextWithin(1_000)).toMatchObject({
      kind: 'state',
      state: { wedged: true, wedgedSince: expect.any(Number) },
    });
    finish();
    await settleChain();
    expect(await nextWithin(1_000)).toMatchObject({
      kind: 'state',
      state: { wedged: false, wedgedSince: null },
    });
    viewer.close();
  });
  test('a long press or drag does not lapse the lease; releasing lets it lapse (N1)', async () => {
    const { producer, entry } = setup(() => true, {
      lease: { humanHoldMs: 30 },
    });
    await dispatchHumanInput(entry, human, 0, [press('down', 7, 8)]);
    await sleep(90); // three hold periods, button still down
    expect(entry.lease.snapshot().holder).toMatchObject(human);
    expect(producer.dispatched).toHaveLength(1); // nothing cancelled it
    await dispatchHumanInput(entry, human, 1, [press('up', 7, 8)]);
    await sleep(90);
    expect(entry.lease.snapshot().holder).toBeNull();
  });

  test('an unregistered surface refuses claims (N2)', async () => {
    const registry = new LiveSurfaceRegistry();
    const unregister = registry.register(
      new SyntheticLiveSurfaceProducer('closing'),
      { authorize: () => true },
    );
    const entry = registry.get('closing')!;
    await unregister();
    expect(await claimAgentControl(entry, agent, OPERATOR)).toMatchObject({
      ok: false,
      code: 'surface-closed',
    });
    expect(await dispatchHumanInput(entry, human, 0, [move(1)])).toMatchObject({
      ok: false,
      code: 'surface-closed',
    });
  });

  test('each held button is cancelled in the modality its down used (N3)', async () => {
    const { producer, entry } = setup();
    const fence = await agentFence(entry);
    await dispatchAgentInput(entry, agent, OPERATOR, fence, [
      { ...press('down', 5, 6), pointerType: 'touch' },
      { kind: 'pointer', type: 'down', x: 5, y: 6, button: 'right' },
    ]);
    await dispatchHumanInput(entry, human, 1, [move(9)]);
    const ups = producer.dispatched.filter(
      (event) => event.kind === 'pointer' && event.type === 'up',
    );
    expect(ups).toEqual([
      {
        kind: 'pointer',
        type: 'up',
        x: -1,
        y: -1,
        button: 'left',
        clickCount: 1,
        pointerType: 'touch',
      },
      {
        kind: 'pointer',
        type: 'up',
        x: -1,
        y: -1,
        button: 'right',
        clickCount: 1,
      },
    ]);
  });
  test("another controller's stuck press does not keep a new holder live", async () => {
    const { producer, entry } = setup(() => true, {
      lease: { humanHoldMs: 10 },
    });
    // The agent's down is slow to dispatch (but within the timeout), so the
    // handoff's cancel of it waits behind it.
    producer.dispatchImpl = () => sleep(150);
    const fence = await agentFence(entry);
    const agentRun = dispatchAgentInput(entry, agent, OPERATOR, fence, [
      press('down', 7, 8),
      press('up', 7, 8),
    ]);
    await sleep(5);
    // A human takes control with the button (not a click): nothing pressed.
    expect(claimHumanControl(entry, human).ok).toBe(true);
    await sleep(40); // past the human's hold; the agent's down is still held
    expect(entry.lease.snapshot().holder).toBeNull();
    await agentRun;
  });

  test('a wedged surface never extends a human hold', async () => {
    const { producer, entry } = setup(() => true, {
      lease: { humanHoldMs: 30 },
      dispatchTimeoutMs: 10,
    });
    // The human's own down never returns (a dialog): wedged, and their press
    // can never be released, so it must not keep them live.
    producer.dispatchImpl = () => new Promise(() => {});
    await dispatchHumanInput(entry, human, 0, [press('down', 7, 8)]);
    await sleep(80);
    expect(entry.lease.snapshot().holder).toBeNull();
  });
});
