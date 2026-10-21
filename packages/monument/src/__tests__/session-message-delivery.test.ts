import { describe, expect, test } from 'vitest';
import {
  decideSessionDelivery,
  deliverSessionMessage,
  parseSessionDeliveryDecision,
  type SessionMessageDeliveryPorts,
  type SessionSteerResult,
} from '../index.js';

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
    mode,
    deliveryId: 'sc-id',
    ...extra,
  });

describe('session message delivery: which branch a send takes', () => {
  test.each([
    [undefined, undefined],
    ['', undefined],
    ['start', undefined],
    [':session', undefined],
    ['other:session', undefined],
    ['start:session', { branch: 'start', threadId: 'session' }],
    ['steer:task:child', { branch: 'steer', threadId: 'task:child' }],
    ['start:', { branch: 'start', threadId: '' }],
  ])(
    'parses the persisted decision %j without changing its thread id',
    (stored, expected) => {
      expect(parseSessionDeliveryDecision(stored)).toEqual(expected);
    },
  );

  test.each(['start', 'steer'] as const)(
    'records %s before invoking its effect port',
    async (branch) => {
      const { calls, ports } = harness({ busy: branch === 'steer' });
      await send(ports, 'auto', {
        recordDecision: (decided) => calls.push(`record ${decided}`),
      });
      expect(calls).toEqual([`record ${branch}`, `${branch} sc-id`]);
    },
  );

  test.each(['start', 'steer'] as const)(
    'a failed decision write prevents the %s effect',
    async (branch) => {
      const { calls, ports } = harness({ busy: branch === 'steer' });
      const failure = new Error('decision write refused');
      await expect(
        send(ports, 'auto', {
          recordDecision: () => {
            throw failure;
          },
        }),
      ).rejects.toBe(failure);
      expect(calls).toEqual([]);
    },
  );

  test.each(['start', 'steer'] as const)(
    'propagates a rejected %s port without trying the other branch',
    async (branch) => {
      const { calls, ports } = harness({ busy: branch === 'steer' });
      const failure = new Error('host port refused');
      ports[branch] = async () => {
        calls.push(branch);
        throw failure;
      };
      await expect(send(ports, 'auto')).rejects.toBe(failure);
      expect(calls).toEqual([branch]);
    },
  );

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

describe('session message delivery: opaque host-prepared text', () => {
  test.each(['start', 'steer'] as const)(
    '%s preserves the host message bytes',
    async (mode) => {
      const { handed, ports } = harness({ busy: mode === 'steer' });
      const text = 'Host header\n> already framed message\r\n\u2028';
      await send(ports, mode, { text });
      expect(handed).toEqual([text]);
    },
  );
});

describe('session message delivery: host preparation ordering', () => {
  test.each(['start', 'steer'] as const)(
    'prepares %s text before recording or effect',
    async (mode) => {
      const { calls, handed, ports } = harness({ busy: mode === 'steer' });
      ports.prepareText = (text) => {
        calls.push('prepare');
        return `prepared:${text}`;
      };
      await send(ports, mode, { recordDecision: () => calls.push('record') });
      expect(calls).toEqual(['prepare', 'record', `${mode} sc-id`]);
      expect(handed).toEqual(['prepared:hi']);
    },
  );
  test.each(['start', 'steer'] as const)(
    'a preparation refusal prevents the %s decision and effect',
    async (mode) => {
      const { calls, ports } = harness({ busy: mode === 'steer' });
      ports.prepareText = () => {
        throw new Error('host preparation refused');
      };
      await expect(
        send(ports, mode, { recordDecision: () => calls.push('record') }),
      ).rejects.toThrow('host preparation refused');
      expect(calls).toEqual([]);
    },
  );
  test.each([
    ['start', true],
    ['steer', false],
  ] as const)('does not prepare a refused %s branch', async (mode, busy) => {
    const { calls, ports } = harness({ busy });
    ports.prepareText = () => {
      throw new Error('must not prepare');
    };
    await expect(send(ports, mode)).resolves.toMatchObject({
      outcome: mode === 'start' ? 'session_busy' : 'no_active_turn',
    });
    expect(calls).toEqual([]);
  });
});
