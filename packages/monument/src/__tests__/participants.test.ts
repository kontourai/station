import { describe, expect, it } from 'vitest';
import type { KernelCommand } from '../commands.js';
import { openMemoryKernelStorage } from '../memory.js';
import { KERNEL_COMMAND_READ_ONLY } from '../step.js';
import { createFakeProcessTable } from '../testing/index.js';

const processes = createFakeProcessTable();
const owner = processes.spawn();
const id = { callerSessionId: 'c', tool: 't', key: 'k' };

/** One command of every type; the record below must name each of them. */
const SAMPLES: Record<KernelCommand['type'], KernelCommand> = {
  'turnDedup.claim': {
    type: 'turnDedup.claim',
    key: 'k',
    owner,
    now: 1,
    tracking: 'tracked',
  },
  'turnDedup.beginInvocation': {
    type: 'turnDedup.beginInvocation',
    key: 'k',
    ownerId: owner.id,
    now: 1,
  },
  'turnDedup.resolve': {
    type: 'turnDedup.resolve',
    key: 'k',
    ownerId: owner.id,
    now: 1,
    value: 'v',
  },
  'turnDedup.release': {
    type: 'turnDedup.release',
    key: 'k',
    ownerId: owner.id,
    now: 1,
  },
  'turnDedup.read': { type: 'turnDedup.read', key: 'k' },
  'turnDedup.forgetPrefix': { type: 'turnDedup.forgetPrefix', prefix: 'k' },
  'turnBoundary.create': {
    type: 'turnBoundary.create',
    boundaryId: 'b',
    threadId: 't',
    state: 'prepared',
    purpose: 'turn',
    owner,
    now: 'a',
  },
  'turnBoundary.transition': {
    type: 'turnBoundary.transition',
    boundaryId: 'b',
    ownerId: owner.id,
    from: ['prepared'],
    to: 'invoking',
    now: 'b',
  },
  'turnBoundary.remove': {
    type: 'turnBoundary.remove',
    boundaryId: 'b',
    ownerId: owner.id,
    from: ['invoking'],
  },
  'turnBoundary.recordAccepted': {
    type: 'turnBoundary.recordAccepted',
    boundaryId: 'a',
    threadId: 't',
    providerTurnId: 'p',
    owner,
    now: 'a',
  },
  'turnBoundary.observeTerminal': {
    type: 'turnBoundary.observeTerminal',
    threadId: 't',
    providerTurnId: 'p',
    sessionTerminal: false,
    terminalCreatedAt: 'z',
  },
  'turnBoundary.hasPossibleEffect': {
    type: 'turnBoundary.hasPossibleEffect',
    threadId: 't',
  },
  'turnBoundary.list': { type: 'turnBoundary.list' },
  'turnBoundary.reconcile': {
    type: 'turnBoundary.reconcile',
    now: 'c',
    observed: [],
  },
  'turnBoundary.forgetThread': {
    type: 'turnBoundary.forgetThread',
    threadId: 't',
  },
  'requestKeys.claim': { type: 'requestKeys.claim', id, digest: 'd', now: 1 },
  'requestKeys.recordDecision': {
    type: 'requestKeys.recordDecision',
    id,
    decision: 'x',
  },
  'requestKeys.complete': { type: 'requestKeys.complete', id, result: 'r' },
  'requestKeys.release': { type: 'requestKeys.release', id },
};

describe('participants and command kinds', () => {
  it('classifies every command type, and only the three reads as read-only', () => {
    expect(Object.keys(KERNEL_COMMAND_READ_ONLY).sort()).toEqual(
      Object.keys(SAMPLES).sort(),
    );
    expect(
      Object.entries(KERNEL_COMMAND_READ_ONLY)
        .filter(([, readOnly]) => readOnly)
        .map(([type]) => type)
        .sort(),
    ).toEqual([
      'turnBoundary.hasPossibleEffect',
      'turnBoundary.list',
      'turnDedup.read',
    ]);
  });

  it('every write command reaches a participant commit; reads do not', async () => {
    const seen: string[] = [];
    const storage = openMemoryKernelStorage({
      participants: [
        { name: 'audit', commit: ({ command }) => seen.push(command.type) },
      ],
    });
    for (const command of Object.values(SAMPLES))
      await storage.execute(command, { liveness: processes.liveness });
    expect(seen.sort()).toEqual(
      Object.keys(SAMPLES)
        .filter(
          (type) =>
            ![
              'turnDedup.read',
              'turnBoundary.list',
              'turnBoundary.hasPossibleEffect',
            ].includes(type),
        )
        .sort(),
    );
  });
});
