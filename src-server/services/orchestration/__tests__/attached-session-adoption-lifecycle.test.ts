import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { OrchestrationCommandReceipt } from '@kontourai/station-contracts/orchestration';
import type { ProviderSession } from '@kontourai/station-contracts/provider';
import { expect, test, vi } from 'vitest';
import type {
  ProviderAdapterShape,
  ProviderAdoptionHooks,
  ProviderSessionAdoptInput,
} from '../../../providers/adapter-shape.js';
import {
  AttachedSessionAdoption,
  type AttachedSessionAdoptionDeps,
} from '../attached-session-adoption.js';
import { EventStore } from '../event-store.js';

function fixture(provider: 'claude' | 'codex' = 'claude') {
  const directory = realpathSync(
    mkdtempSync(join(tmpdir(), 'station-adoption-effects-')),
  );
  const cwd = join(directory, 'project');
  mkdirSync(cwd);
  const store = new EventStore(join(directory, 'events.sqlite'));
  const ledger = store.createAdoptionLedger();
  const now = '2026-09-06T00:00:00.000Z';
  const affinity = { kind: 'fixture-home', ref: 'admitted-source' };
  const source: ProviderSession = {
    provider,
    threadId: `external:${provider}:fixture`,
    cwd,
    status: 'ready',
    controlMode: 'read-only-attached',
    attachedSource: {
      kind: provider === 'codex' ? 'codex-rollout' : 'claude-transcript',
      externalSessionId: 'native-source',
      affinity,
    },
    createdAt: now,
    updatedAt: now,
  };
  store.upsertSession(source);
  const adopt =
    vi.fn<
      (
        input: ProviderSessionAdoptInput,
        hooks?: ProviderAdoptionHooks,
      ) => Promise<ProviderSession>
    >();
  const discard = vi.fn(async () => {});
  const adapter = {
    provider,
    adoptionLifecycle: 'reported',
    metadata: {
      displayName: 'Claude',
      description: 'controlled adoption transport',
      capabilities: [],
    },
    adoptSession: adopt,
    discardSession: discard,
  } as unknown as ProviderAdapterShape;
  const deps: AttachedSessionAdoptionDeps = {
    adapterRegistry: { get: () => adapter },
    logger: { warn: () => {} },
    canReadSessionForCommand: () => true,
    tenantContextFor: () => undefined,
    liveSessions: () => [],
    trackSession: () => {},
    evictCollidingAttachedAliases: () => {},
    persistReceipt: () => {},
    requireAdapter: () => adapter,
    assertAdapterCurrent: () => {},
    assertAdapterReady: async () => {},
    withAcceptedModelLaunchPlan: (_adapter, input) => input,
    recordAcceptedModelLaunchPlan: () => {},
    modelLaunchPlanFromInput: () => ({
      kind: 'engine-selected',
      evidence: 'adapter-declared',
    }),
    modelLaunchRequestedOverrideFromInput: () => false,
    forgetAbandonedAdoptionMemory: () => {},
    logCleanupFailure: () => {},
    eventStore: store,
    adoptionLedger: ledger,
    listProjects: () => [{ slug: 'project', workingDirectory: cwd }],
  };
  const owner = new AttachedSessionAdoption(deps);
  const receipt = (): OrchestrationCommandReceipt => ({
    commandId: randomUUID(),
    commandType: 'adoptSession',
    status: 'accepted',
    threadId: source.threadId,
    createdAt: now,
  });
  return {
    store,
    ledger,
    source,
    affinity,
    adopt,
    discard,
    owner,
    receipt,
    close: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('reported local rejection leaves no native-effect tombstone and performs no provider cleanup', async () => {
  const f = fixture();
  try {
    f.adopt.mockImplementation(async (input) => {
      expect(input.sourceAffinity).toEqual(f.affinity);
      expect(f.ledger.reservations()[0]?.status).toBe('pending');
      throw new Error('local source validation failed');
    });
    await expect(
      f.owner.adopt(f.source.threadId, f.receipt()),
    ).rejects.toThrow();
    expect(f.ledger.reservations()).toEqual([]);
    expect(f.discard).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});

test('lost creation result retains its source binding and blocks another provider invocation', async () => {
  const f = fixture();
  try {
    f.adopt.mockImplementation(async (_input, hooks) => {
      await hooks?.onProviderChildCreationStarted?.();
      expect(f.ledger.reservations()[0]).toMatchObject({
        status: 'forking',
        sourceAffinity: f.affinity,
      });
      throw new Error('result lost after invocation');
    });
    f.discard.mockRejectedValue(
      new Error('native result remains indeterminate'),
    );
    await expect(
      f.owner.adopt(f.source.threadId, f.receipt()),
    ).rejects.toThrow();
    expect(f.ledger.reservations()[0]).toMatchObject({
      status: 'rollback-pending',
      sourceAffinity: f.affinity,
      providerCleanupComplete: false,
    });
    await expect(
      f.owner.adopt(f.source.threadId, f.receipt()),
    ).rejects.toThrow();
    expect(f.adopt).toHaveBeenCalledTimes(1);
  } finally {
    f.close();
  }
});

test('late initialization failure cleans only the durably recorded child with the admitted source context', async () => {
  const f = fixture();
  try {
    f.adopt.mockImplementation(async (_input, hooks) => {
      await hooks?.onProviderChildCreationStarted?.();
      await hooks?.onProviderChildCreated('native-child');
      expect(f.ledger.reservations()[0]?.providerResumeCursor).toBe(
        'native-child',
      );
      throw new Error('late initialization failed');
    });
    await expect(
      f.owner.adopt(f.source.threadId, f.receipt()),
    ).rejects.toThrow();
    expect(f.discard).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        resumeCursor: 'native-child',
        sourceAffinity: f.affinity,
        sourceSessionId: 'native-source',
        sourceKind: 'claude-transcript',
      }),
    );
    expect(f.ledger.reservations()).toEqual([]);
  } finally {
    f.close();
  }
});

test('Codex adoption takes its cutoff from durable observations and commits an independent child', async () => {
  const f = fixture('codex');
  try {
    // A display projection is not authority for a native fork cutoff.
    f.source.attachedSource!.completedBoundary = {
      kind: 'completed-turn',
      providerTurnId: 'forged-display-turn',
      observedEventId: 'forged-display-event',
    };
    f.store.upsertSession(f.source);
    await expect(f.owner.adopt(f.source.threadId, f.receipt())).rejects.toThrow(
      'completed turn are required',
    );
    expect(f.adopt).not.toHaveBeenCalled();
    expect(f.ledger.reservations()).toEqual([]);
    f.store.appendEvent({
      eventId: 'durable-completion',
      provider: 'codex',
      threadId: f.source.threadId,
      createdAt: f.source.createdAt,
      method: 'turn.completed',
      turnId: 'opaque/completed-turn',
      finishReason: 'stop',
    });
    f.adopt.mockImplementation(async (input, hooks) => {
      expect(input.sourceAffinity).toEqual(f.affinity);
      expect(input.sourceBoundary).toEqual({
        kind: 'completed-turn',
        providerTurnId: 'opaque/completed-turn',
        observedEventId: 'durable-completion',
      });
      expect(f.ledger.reservations()[0]?.sourceBoundary).toEqual(
        input.sourceBoundary,
      );
      await hooks?.onProviderChildCreationStarted?.();
      const resumeCursor = {
        codexThreadId: 'independent-child',
        sourceAffinity: input.sourceAffinity,
      };
      await hooks?.onProviderChildCreated(resumeCursor);
      return {
        provider: 'codex',
        threadId: input.threadId,
        cwd: input.cwd,
        resumeCursor,
        status: 'ready',
        createdAt: f.source.createdAt,
        updatedAt: f.source.updatedAt,
      };
    });
    const result = await f.owner.adopt(f.source.threadId, f.receipt());
    expect(result.result?.threadId).not.toBe(f.source.threadId);
    const child = f.store
      .readSessions()
      .find(
        (session) => session.continuationSourceThreadId === f.source.threadId,
      );
    expect(child).toMatchObject({
      provider: 'codex',
      controlMode: 'station-owned',
      resumeCursor: {
        codexThreadId: 'independent-child',
        sourceAffinity: f.affinity,
      },
    });
    expect(
      f.store
        .readSessions()
        .find((session) => session.threadId === f.source.threadId)?.controlMode,
    ).toBe('read-only-attached');
    expect(f.ledger.reservations()).toEqual([]);
    expect(f.discard).not.toHaveBeenCalled();
  } finally {
    f.close();
  }
});
