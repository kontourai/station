import { expect, it } from 'vitest';
import type {
  KernelCommand,
  TurnBoundaryAcceptInvocationCommand,
} from '../commands.js';
import { MemoryKernelVolume, openMemoryKernelStorage } from '../memory.js';
import type { InvocationTerminalFact, TurnBoundaryRecord } from '../records.js';

const owner = {
  id: 'owner',
  pid: 77,
  identityKind: 'exact',
  birth: 'birth',
} as const;
const context = { liveness: () => 'live' as const };
const intent = {
  invocationId: 'B',
  inputDigest: 'input',
  intentDigest: 'envelope',
  bodyRef: 'body',
};
const expected: TurnBoundaryRecord = {
  boundaryId: 'b',
  threadId: 't',
  state: 'invoking',
  purpose: 'turn',
  owner,
  createdAt: '10',
  updatedAt: '12',
  intent,
};
const accept: TurnBoundaryAcceptInvocationCommand = {
  type: 'turnBoundary.acceptInvocation',
  expected,
  providerTurnId: 'N',
  now: '13',
};
const terminal: InvocationTerminalFact = {
  threadId: 't',
  invocationId: 'B',
  terminalEventId: 'e',
  terminalCreatedAt: '01',
  retire: true,
};
const observe = {
  type: 'turnBoundary.observeTerminal',
  ...terminal,
  sessionTerminal: false,
} as const;
const prerequisites: KernelCommand[] = [
  {
    type: 'turnBoundary.create',
    boundaryId: 'b',
    threadId: 't',
    state: 'reserved',
    purpose: 'turn',
    owner,
    now: '10',
  },
  {
    type: 'turnBoundary.prepare',
    boundaryId: 'b',
    ownerId: owner.id,
    intent,
    now: '11',
  },
  {
    type: 'turnBoundary.beginInvocation',
    boundaryId: 'b',
    ownerId: owner.id,
    intent,
    now: '12',
  },
];
it('memory publishes no fact, witness or deletion after post-dispatch participant failure', async () => {
  const volume = new MemoryKernelVolume();
  let dispatched = false;
  let storage = openMemoryKernelStorage({
    volume,
    participants: [
      {
        name: 'fail after dispatch',
        commit({ command, result }) {
          if (command.type !== 'turnBoundary.observeTerminal') return;
          expect(result).toEqual({ kind: 'applied' });
          dispatched = true;
          throw new Error('after dispatch writes');
        },
      },
    ],
  });
  try {
    for (const input of prerequisites)
      expect(await storage.execute(input, context)).toEqual({
        kind: 'applied',
      });
    await expect(storage.execute(observe, context)).rejects.toThrow(
      'after dispatch writes',
    );
    expect(dispatched).toBe(true);
    await storage.close();
    storage = openMemoryKernelStorage({ volume });
    expect(
      await storage.execute({ type: 'turnBoundary.list' }, context),
    ).toEqual({ kind: 'records', records: [expected] });
    expect(await storage.execute(accept, context)).toEqual({
      kind: 'accepted',
    });
    // If the failed fact or witness leaked, this native-bearing terminal conflicts with it.
    expect(
      await storage.execute({ ...observe, providerTurnId: 'N' }, context),
    ).toEqual({ kind: 'applied' });
    expect(await storage.execute(accept, context)).toEqual({
      kind: 'terminal',
      terminal: { ...terminal, providerTurnId: 'N' },
    });
  } finally {
    await storage.close();
  }
});
it('memory owns command snapshots, returned terminal facts and retained witnesses', async () => {
  const volume = new MemoryKernelVolume();
  let storage = openMemoryKernelStorage({ volume });
  try {
    const inputs = structuredClone(prerequisites);
    for (const input of inputs)
      expect(await storage.execute(input, context)).toEqual({
        kind: 'applied',
      });
    const input = structuredClone(observe);
    expect(await storage.execute(input, context)).toEqual({ kind: 'applied' });
    Object.assign(input, {
      terminalCreatedAt: 'changed',
      invocationId: 'changed',
    });
    for (const item of inputs)
      if ('intent' in item) Object.assign(item.intent, { bodyRef: 'changed' });
    const result = await storage.execute(accept, context);
    expect(result).toEqual({ kind: 'terminal', terminal });
    if (result.kind !== 'terminal') throw new Error('terminal prerequisite');
    Object.assign(result.terminal, {
      invocationId: 'mutated result',
      terminalCreatedAt: 'changed',
    });
    await storage.close();
    storage = openMemoryKernelStorage({ volume });
    expect(await storage.execute(accept, context)).toEqual({
      kind: 'terminal',
      terminal,
    });
    await expect(
      storage.execute({ ...observe, terminalCreatedAt: 'changed' }, context),
    ).rejects.toThrow('Conflicting invocation terminal event');
    expect(await storage.execute(accept, context)).toEqual({
      kind: 'terminal',
      terminal,
    });
    expect(
      await storage.execute(
        { type: 'turnBoundary.forgetThread', threadId: 't' },
        context,
      ),
    ).toEqual({ kind: 'applied' });
    expect(await storage.execute(accept, context)).toEqual({ kind: 'stale' });
  } finally {
    await storage.close();
  }
});
