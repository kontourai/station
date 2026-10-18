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
  'turnBoundary.prepare': {
    type: 'turnBoundary.prepare',
    boundaryId: 'b',
    ownerId: owner.id,
    intent: {
      invocationId: 'i',
      inputDigest: 'd',
      intentDigest: 'e',
      bodyRef: 'body',
    },
    now: 'b',
  },
  'turnBoundary.beginInvocation': {
    type: 'turnBoundary.beginInvocation',
    boundaryId: 'b',
    ownerId: owner.id,
    intent: {
      invocationId: 'i',
      inputDigest: 'd',
      intentDigest: 'e',
      bodyRef: 'body',
    },
    now: 'b',
  },
  'turnBoundary.resumePrepared': {
    type: 'turnBoundary.resumePrepared',
    boundaryId: 'b',
    owner,
    intent: {
      invocationId: 'i',
      inputDigest: 'd',
      intentDigest: 'e',
      bodyRef: 'body',
    },
    observed: { owner, createdAt: 'a', updatedAt: 'b', verdict: 'dead' },
    now: 'c',
  },
  'turnBoundary.cancelPrepared': {
    type: 'turnBoundary.cancelPrepared',
    boundaryId: 'b',
    intent: {
      invocationId: 'i',
      inputDigest: 'd',
      intentDigest: 'e',
      bodyRef: 'body',
    },
    boundary: { owner, createdAt: 'a', updatedAt: 'b' },
    settlementId: 's',
    now: 'c',
  },
  'turnBoundary.recordDefinitiveRefusal': {
    type: 'turnBoundary.recordDefinitiveRefusal',
    boundaryId: 'b',
    intent: {
      invocationId: 'i',
      inputDigest: 'd',
      intentDigest: 'e',
      bodyRef: 'body',
    },
    boundary: { owner, createdAt: 'a', updatedAt: 'b' },
    settlementId: 's',
    now: 'c',
  },
  'turnBoundary.acceptInvocation': {
    type: 'turnBoundary.acceptInvocation',
    expected: {
      boundaryId: 'b',
      threadId: 't',
      state: 'invoking',
      purpose: 'turn',
      owner,
      createdAt: 'a',
      updatedAt: 'b',
      intent: {
        invocationId: 'i',
        inputDigest: 'd',
        intentDigest: 'e',
        bodyRef: 'body',
      },
    },
    providerTurnId: 'N',
    now: 'c',
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
  'inbox.submit': {
    type: 'inbox.submit',
    inboxId: 'i',
    key: 'k',
    kind: 'follow-up',
    digest: 'd',
    payload: 'p',
    now: 1,
  },
  'inbox.claimNext': {
    type: 'inbox.claimNext',
    inboxId: 'i',
    placement: 's',
    now: 2,
  },
  'inbox.settle': {
    type: 'inbox.settle',
    inboxId: 'i',
    key: 'k',
    to: 'placed',
    outcome: null,
    now: 3,
  },
  'inbox.release': {
    type: 'inbox.release',
    inboxId: 'i',
    key: 'k',
    keepPlacement: false,
    now: 4,
  },
  'inbox.cancel': { type: 'inbox.cancel', inboxId: 'i', key: 'k', now: 5 },
  'inbox.read': { type: 'inbox.read', inboxId: 'i', key: 'k' },
  'inbox.list': { type: 'inbox.list', inboxId: 'i' },
  'inbox.listOpen': { type: 'inbox.listOpen' },
  'inbox.forget': { type: 'inbox.forget', inboxId: 'i' },
  'inbox.resolveUnconfirmed': {
    type: 'inbox.resolveUnconfirmed',
    inboxId: 'i',
    key: 'k',
    to: 'placed',
    outcome: null,
    now: 6,
  },
};

const READS = [
  'inbox.list',
  'inbox.listOpen',
  'inbox.read',
  'turnBoundary.hasPossibleEffect',
  'turnBoundary.list',
  'turnDedup.read',
];

describe('participants and command kinds', () => {
  it('classifies every command type, and only the reads as read-only', () => {
    expect(Object.keys(KERNEL_COMMAND_READ_ONLY).sort()).toEqual(
      Object.keys(SAMPLES).sort(),
    );
    expect(
      Object.entries(KERNEL_COMMAND_READ_ONLY)
        .filter(([, readOnly]) => readOnly)
        .map(([type]) => type)
        .sort(),
    ).toEqual(READS);
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
        .filter((type) => !READS.includes(type))
        .sort(),
    );
  });
});
