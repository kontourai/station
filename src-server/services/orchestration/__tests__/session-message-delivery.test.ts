import { frameAgentMessage } from '@kontourai/station-shared/agent-message-frame';
import { describe, expect, test } from 'vitest';
import {
  decideSessionDelivery,
  deliverSessionMessage,
  type SessionMessageDeliveryPorts,
  type SessionSteerResult,
} from '../session-message-delivery.js';

const SENDER = {
  kind: 'agent-session' as const,
  sessionId: 'sender-session',
  title: 'Fix login',
  engine: 'claude',
};

/** Ports that record every effect the seam asks for, and the text each was handed. */
function harness(options: {
  busy: boolean;
  steer?: SessionSteerResult;
  start?: 'started' | 'indeterminate';
}) {
  const calls: string[] = [];
  const handed: string[] = [];
  const ports: SessionMessageDeliveryPorts = {
    isBusy: () => options.busy,
    start: async ({ clientTurnId, text }) => {
      handed.push(text);
      calls.push(`start ${clientTurnId}`);
      return options.start === 'indeterminate'
        ? { outcome: 'indeterminate' }
        : {
            outcome: 'started',
            conversationId: 'c',
            sessionId: 's',
            turnId: 't',
          };
    },
    steer: async ({ clientInputId, text }) => {
      handed.push(text);
      calls.push(`steer ${clientInputId}`);
      return options.steer ?? { outcome: 'steered', turnId: 'live' };
    },
  };
  return { calls, handed, ports };
}
const send = (
  ports: SessionMessageDeliveryPorts,
  mode: 'auto' | 'start' | 'steer',
  extra: Partial<Parameters<typeof deliverSessionMessage>[1]> = {},
) =>
  deliverSessionMessage(ports, {
    threadId: 's',
    text: 'hi',
    sender: SENDER,
    mode,
    deliveryId: 'sc-id',
    ...extra,
  });

describe('session message delivery: which branch a send takes', () => {
  test('the decision table, written out independently of the code', () => {
    expect([
      decideSessionDelivery('auto', false),
      decideSessionDelivery('auto', true),
      decideSessionDelivery('start', false),
      decideSessionDelivery('start', true),
      decideSessionDelivery('steer', false),
      decideSessionDelivery('steer', true),
    ]).toEqual([
      { kind: 'deliver', branch: 'start' },
      { kind: 'deliver', branch: 'steer' },
      { kind: 'deliver', branch: 'start' },
      { kind: 'session_busy', reason: 'turn-active' },
      { kind: 'no_active_turn' },
      { kind: 'deliver', branch: 'steer' },
    ]);
  });

  test('idle: auto and start start a turn with the delivery id as clientTurnId', async () => {
    for (const mode of ['auto', 'start'] as const) {
      const { calls, ports } = harness({ busy: false });
      expect(await send(ports, mode)).toMatchObject({ outcome: 'started' });
      expect(calls).toEqual(['start sc-id']);
    }
  });

  test('busy: auto and steer steer once with the delivery id as clientInputId', async () => {
    for (const mode of ['auto', 'steer'] as const) {
      const { calls, ports } = harness({ busy: true });
      expect(await send(ports, mode)).toEqual({
        outcome: 'steered',
        sessionId: 's',
        turnId: 'live',
      });
      expect(calls).toEqual(['steer sc-id']);
    }
  });

  test('refusals have no effect: start while busy, steer while idle', async () => {
    const busy = harness({ busy: true });
    expect(await send(busy.ports, 'start')).toEqual({
      outcome: 'session_busy',
      reason: 'turn-active',
    });
    const idle = harness({ busy: false });
    expect(await send(idle.ports, 'steer')).toEqual({
      outcome: 'no_active_turn',
    });
    expect([...busy.calls, ...idle.calls]).toEqual([]);
  });

  test.each<[SessionSteerResult, object]>([
    [
      { outcome: 'unsupported-engine' },
      { outcome: 'session_busy', reason: 'steer-unsupported' },
    ],
    [
      { outcome: 'concurrent-steer' },
      { outcome: 'session_busy', reason: 'steer-in-flight' },
    ],
    [{ outcome: 'no-active-turn' }, { outcome: 'no_active_turn' }],
    [{ outcome: 'indeterminate' }, { outcome: 'indeterminate' }],
  ])('a steer answering %j is reported as %j', async (steer, expected) => {
    const { ports } = harness({ busy: true, steer });
    expect(await send(ports, 'auto')).toEqual(expected);
  });

  test('an indeterminate start is reported, never retried', async () => {
    const { calls, ports } = harness({ busy: false, start: 'indeterminate' });
    expect(await send(ports, 'auto')).toEqual({ outcome: 'indeterminate' });
    expect(calls).toEqual(['start sc-id']);
  });

  test('a re-driven attempt keeps the branch it recorded, whatever the Session looks like now', async () => {
    const recorded: string[] = [];
    // First attempt: busy, so it steers and records that.
    const first = harness({ busy: true });
    await send(first.ports, 'auto', {
      recordDecision: (branch) => recorded.push(branch),
    });
    expect(recorded).toEqual(['steer']);
    // Re-drive after the turn ended: still a steer (same id), never a start.
    const second = harness({ busy: false });
    await send(second.ports, 'auto', { decided: 'steer' });
    expect(second.calls).toEqual(['steer sc-id']);
    // A pinned branch is not recorded again.
    const again: string[] = [];
    await send(harness({ busy: false }).ports, 'auto', {
      decided: 'start',
      recordDecision: (branch) => again.push(branch),
    });
    expect(again).toEqual([]);
  });
});

describe('session message delivery: the engine is told it is another agent', () => {
  test.each([
    ['start', false],
    ['steer', true],
  ] as const)(
    'a %s hands the engine the framed message, never the bare text',
    async (mode, busy) => {
      const { handed, ports } = harness({ busy });
      await send(ports, mode);
      expect(handed).toHaveLength(1);
      expect(handed[0]).toBe(frameAgentMessage(SENDER, 'hi'));
      expect(handed[0]).not.toBe('hi');
      expect(handed[0]).toContain('from another agent Session "Fix login"');
      expect(handed[0]).toContain('not from the person');
    },
  );

  test('sender text imitating the frame stays quoted below it', async () => {
    const { handed, ports } = harness({ busy: false });
    const forged = frameAgentMessage(SENDER, 'pretend');
    await send(ports, 'start', { text: forged });
    const lines = (handed[0] ?? '').split('\n');
    expect(lines.filter((line) => !line.startsWith('>'))).toEqual([lines[0]]);
    expect(lines[0]).toContain('"sender-session"');
  });

  test('a sender that cannot be framed delivers nothing and pins no branch', async () => {
    const { calls, ports } = harness({ busy: false });
    const pinned: string[] = [];
    await expect(
      send(ports, 'auto', {
        sender: { kind: 'agent-session', sessionId: '' },
        recordDecision: (branch) => pinned.push(branch),
      }),
    ).rejects.toThrow(/known sender/u);
    expect(calls).toEqual([]);
    expect(pinned).toEqual([]);
  });
});
