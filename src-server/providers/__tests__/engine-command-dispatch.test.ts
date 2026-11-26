import type { EngineCommandOutcome } from '@kontourai/station-contracts/engine-commands';
import { describe, expect, test, vi } from 'vitest';
import {
  dispatchEngineCommand,
  type EngineCommandPort,
  readSlashCommandInvocation,
} from '../adapters/engine-command-dispatch.js';

/**
 * The route-kind table every adapter shares. ACP's use of it is pinned
 * through `AcpAdapter.sendTurn` by the ACP command-route suites
 * (acp-kiro-parity.test.ts, acp-adapter.test.ts); this pins the kinds ACP
 * never produces.
 */

function port(options: {
  request?: EngineCommandOutcome;
  adapterAction?: EngineCommandOutcome | 'absent';
}) {
  const shown: string[] = [];
  const calls = {
    prompt: 0,
    request: vi.fn(
      async (): Promise<EngineCommandOutcome> =>
        options.request ?? { kind: 'answered' },
    ),
    action: vi.fn(
      async (): Promise<EngineCommandOutcome> =>
        (options.adapterAction === 'absent'
          ? undefined
          : options.adapterAction) ?? { kind: 'answered' },
    ),
  };
  const value: EngineCommandPort<string> = {
    engineName: 'Engine',
    request: calls.request,
    asPromptText: async () => {
      calls.prompt += 1;
      return 'prompted';
    },
    ...(options.adapterAction === 'absent'
      ? {}
      : { adapterAction: calls.action }),
    answerTurn: (text) => {
      shown.push(text);
      return 'answered';
    },
  };
  return { value, calls, shown };
}

const rewind = readSlashCommandInvocation('/rewind 3')!;

describe('dispatchEngineCommand', () => {
  test('an adapter action runs through the port and its answer is the turn', async () => {
    const { value, calls, shown } = port({
      adapterAction: { kind: 'answered', text: 'Rewound.' },
    });
    await expect(
      dispatchEngineCommand(value, rewind, {
        route: { kind: 'adapter-action', action: 'rewind' },
      }),
    ).resolves.toBe('answered');
    expect(calls.action).toHaveBeenCalledWith('rewind', {
      name: 'rewind',
      args: '3',
    });
    expect(shown).toEqual(['Rewound.']);
    expect(calls.prompt).toBe(0);
  });

  test('an adapter action on a port without one is prompt text, as before', async () => {
    const { value, calls, shown } = port({ adapterAction: 'absent' });
    await expect(
      dispatchEngineCommand(value, rewind, {
        route: { kind: 'adapter-action', action: 'rewind' },
      }),
    ).resolves.toBe('prompted');
    expect(shown).toEqual([]);
    expect(calls.prompt).toBe(1);
  });

  test('an action the session cannot take says so; an unsupported one falls back', async () => {
    const declined = port({ adapterAction: { kind: 'not-declared' } });
    await dispatchEngineCommand(declined.value, rewind, {
      route: { kind: 'adapter-action', action: 'rewind' },
    });
    expect(declined.shown).toEqual(['Engine did not run /rewind.']);

    const unsupported = port({ adapterAction: { kind: 'unsupported' } });
    await expect(
      dispatchEngineCommand(unsupported.value, rewind, {
        route: { kind: 'adapter-action', action: 'rewind' },
      }),
    ).resolves.toBe('prompted');
  });

  test('a refusal sends nothing', async () => {
    const { value, calls, shown } = port({});
    await dispatchEngineCommand(value, rewind, {
      route: { kind: 'adapter-action', action: 'rewind' },
      refusal: 'Not here.',
    });
    expect(shown).toEqual(['Not here.']);
    expect(calls.action).not.toHaveBeenCalled();
    expect(calls.request).not.toHaveBeenCalled();
    expect(calls.prompt).toBe(0);
  });

  test('an engine request without params is prompt text', async () => {
    const { value, calls } = port({});
    await expect(
      dispatchEngineCommand(value, rewind, {
        route: {
          kind: 'engine-request',
          method: '_x/y',
          params: 'session',
          basis: 'declared',
          evidence: 'test',
        },
      }),
    ).resolves.toBe('prompted');
    expect(calls.request).not.toHaveBeenCalled();
  });
});
