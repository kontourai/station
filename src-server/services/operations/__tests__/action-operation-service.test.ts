import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACTION_OPERATION_MAX_ACTIVE } from '@kontourai/station-contracts/action-operation';
import { describe, expect, test, vi } from 'vitest';
import {
  type ActionOperationCancellationAdapter,
  ActionOperationCursorError,
  type ActionOperationLedger,
  ActionOperationService,
  type ActionOperationStore,
  type ActionOperationTransaction,
  FileActionOperationStore,
} from '../action-operation-service.js';

class MemoryStore implements ActionOperationStore {
  ledger: ActionOperationLedger = {
    version: 1,
    creationSequence: 0,
    changeSequence: 0,
    records: [],
  };
  private tail = Promise.resolve();

  async read() {
    await this.tail;
    return structuredClone(this.ledger);
  }
  async transact<T>(
    update: (current: ActionOperationLedger) => ActionOperationTransaction<T>,
  ) {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<T>((done, failed) => {
      resolve = done;
      reject = failed;
    });
    this.tail = this.tail.then(() => {
      try {
        const outcome = update(structuredClone(this.ledger));
        if (outcome.next) this.ledger = structuredClone(outcome.next);
        resolve(outcome.result);
      } catch (error) {
        reject(error);
      }
    });
    await this.tail;
    return result;
  }
}

function clock(start = 0) {
  let tick = start;
  return () =>
    new Date(`2026-08-23T00:${String(tick++).padStart(2, '0')}:00.000Z`);
}
const owner = {
  accountId: 'account-a',
  machineId: 'machine-a',
  canReadSession: (id: string) => id === 'session-a',
};
const baseInput = (id: string) => ({
  id,
  scope: { accountId: 'account-a' },
  title: 'Fork conversation',
  cancellation: 'unsupported' as const,
  domain: {
    kind: 'conversation-fork' as const,
    sourceConversationId: `source-${id}`,
    targetConversationId: `target-${id}`,
  },
  reentry: {
    kind: 'conversation' as const,
    agentId: 'codex',
    conversationId: `target-${id}`,
  },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('ActionOperationService transactions and reconstruction', () => {
  test('two services over one file serialize concurrent creates without a lost write', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'station-actions-concurrent-'),
    );
    const first = new ActionOperationService(
      new FileActionOperationStore(directory),
    );
    const second = new ActionOperationService(
      new FileActionOperationStore(directory),
    );
    await Promise.all([
      first.create(owner, baseInput('one')),
      second.create(owner, baseInput('two')),
    ]);
    const restarted = new ActionOperationService(
      new FileActionOperationStore(directory),
    );
    const page = await restarted.list(owner);
    expect(page.items.map((operation) => operation.id).sort()).toEqual([
      'one',
      'two',
    ]);
    expect(
      new Set(page.items.map((operation) => operation.sequence)).size,
    ).toBe(2);
    expect(
      new Set(page.items.map((operation) => operation.changeSequence)).size,
    ).toBe(2);
  });

  test('a publication failure returns no in-memory or durable ghost', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'station-actions-fault-'));
    const failing = new ActionOperationService(
      new FileActionOperationStore(directory, {
        beforeCommit: () => {
          throw new Error('injected pre-rename fault');
        },
      }),
    );
    await expect(failing.create(owner, baseInput('ghost'))).rejects.toThrow(
      'injected pre-rename fault',
    );
    expect(await failing.get(owner, 'ghost')).toBeUndefined();
    expect(await new FileActionOperationStore(directory).read()).toMatchObject({
      records: [],
    });
  });

  test('watch uses change sequence, returns updates after reconnect, and exposes no foreign head', async () => {
    const store = new MemoryStore();
    const service = new ActionOperationService(store, { now: clock() });
    const one = (await service.create(owner, baseInput('one')))!;
    const initial = await service.watch(owner);
    await service.create(
      { accountId: 'account-b' },
      { ...baseInput('foreign'), scope: { accountId: 'account-b' } },
    );
    const foreignOnly = await service.watch(owner, initial.cursor);
    expect(foreignOnly.items).toEqual([]);
    expect(foreignOnly.cursor).toBe(initial.cursor);
    await service.update(owner, one.id, {
      expectedRevision: one.revision,
      status: 'running',
      progress: { kind: 'phase', code: 'preparing' },
    });
    const delta = await service.watch(owner, foreignOnly.cursor);
    expect(delta.mode).toBe('delta');
    expect(delta.items).toMatchObject([
      { id: 'one', revision: 2, progress: { code: 'preparing' } },
    ]);
    expect(JSON.stringify(delta)).not.toContain('foreign');
    const quiet = await service.watch(owner, delta.cursor);
    expect(quiet.items).toEqual([]);
    expect(quiet.cursor).toBe(delta.cursor);
  });

  test('watch persists stale reconciliation once so an old cursor receives the transition', async () => {
    let nowMs = Date.parse('2026-08-23T00:00:00.000Z');
    const service = new ActionOperationService(new MemoryStore(), {
      now: () => new Date(nowMs),
      staleActiveMs: 1_000,
    });
    const operation = (await service.create(owner, baseInput('stale-watch')))!;
    const initial = await service.watch(owner);

    nowMs += 1_001;
    const delta = await service.watch(owner, initial.cursor);
    expect(delta).toMatchObject({
      mode: 'delta',
      items: [
        {
          id: operation.id,
          revision: operation.revision + 1,
          changeSequence: operation.changeSequence + 1,
          progress: { kind: 'phase', code: 'reconciliation-required' },
        },
      ],
    });
    const quiet = await service.watch(owner, delta.cursor);
    expect(quiet.items).toEqual([]);
    expect(quiet.cursor).toBe(delta.cursor);
  });

  test('list retains older-page semantics while malformed cursors fail closed', async () => {
    const service = new ActionOperationService(new MemoryStore());
    await service.create(owner, baseInput('one'));
    await service.create(owner, baseInput('two'));
    await service.create(owner, baseInput('three'));
    const first = await service.list(owner, { limit: 2 });
    expect(first.items.map((operation) => operation.id)).toEqual([
      'three',
      'two',
    ]);
    const second = await service.list(owner, {
      cursor: first.nextCursor,
      limit: 2,
    });
    expect(second.items.map((operation) => operation.id)).toEqual(['one']);
    await expect(
      service.list(owner, { cursor: 'bounded-but-invalid' }),
    ).rejects.toBeInstanceOf(ActionOperationCursorError);
    await expect(
      service.watch(owner, 'bounded-but-invalid'),
    ).rejects.toBeInstanceOf(ActionOperationCursorError);
  });
});

describe('ActionOperationService cancellation and lifecycle', () => {
  test('supported cancellation requires a domain adapter', async () => {
    const service = new ActionOperationService(new MemoryStore());
    await expect(
      service.create(owner, {
        ...baseInput('unsupported-claim'),
        cancellation: 'supported',
      }),
    ).resolves.toBeUndefined();
  });

  test('owner cancellation is confirmed before settlement and loses safely to completion', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'station-actions-cancel-race-'),
    );
    const ownerResult = deferred<{ kind: 'cancelled' }>();
    const adapter: ActionOperationCancellationAdapter = {
      domainKind: 'platform-action',
      cancel: vi.fn(() => ownerResult.promise),
    };
    const cancelling = new ActionOperationService(
      new FileActionOperationStore(directory),
      { cancellationAdapters: [adapter] },
    );
    const completing = new ActionOperationService(
      new FileActionOperationStore(directory),
    );
    const operation = (await cancelling.create(owner, {
      id: 'race',
      scope: { accountId: 'account-a' },
      title: 'Platform action',
      cancellation: 'supported',
      domain: { kind: 'platform-action', actionId: 'owner-action' },
      reentry: { kind: 'session', sessionId: 'session-a' },
    }))!;
    const cancellation = cancelling.cancel(owner, operation.id);
    await vi.waitFor(() => expect(adapter.cancel).toHaveBeenCalledOnce());
    await completing.update(owner, operation.id, {
      expectedRevision: operation.revision,
      status: 'succeeded',
    });
    ownerResult.resolve({ kind: 'cancelled' });
    await expect(cancellation).resolves.toMatchObject({
      kind: 'already-terminal',
      operation: { status: 'succeeded' },
    });
    expect((await cancelling.get(owner, operation.id))?.status).toBe(
      'succeeded',
    );
  });

  test('a refused owner cancellation rereads concurrent completion instead of returning a stale refusal', async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'station-actions-refused-race-'),
    );
    const ownerResult = deferred<{ kind: 'refused' }>();
    const adapter: ActionOperationCancellationAdapter = {
      domainKind: 'platform-action',
      cancel: vi.fn(() => ownerResult.promise),
    };
    const cancelling = new ActionOperationService(
      new FileActionOperationStore(directory),
      { cancellationAdapters: [adapter] },
    );
    const completing = new ActionOperationService(
      new FileActionOperationStore(directory),
    );
    const operation = (await cancelling.create(owner, {
      id: 'refused-race',
      scope: { accountId: 'account-a' },
      title: 'Platform action',
      cancellation: 'supported',
      domain: { kind: 'platform-action', actionId: 'owner-action' },
      reentry: { kind: 'session', sessionId: 'session-a' },
    }))!;
    const cancellation = cancelling.cancel(owner, operation.id);
    await vi.waitFor(() => expect(adapter.cancel).toHaveBeenCalledOnce());
    await completing.update(owner, operation.id, {
      expectedRevision: operation.revision,
      status: 'succeeded',
    });
    ownerResult.resolve({ kind: 'refused' });

    await expect(cancellation).resolves.toMatchObject({
      kind: 'already-terminal',
      operation: { status: 'succeeded' },
    });
  });

  test('an owner cancellation fault becomes reconciliation-needed unless completion won first', async () => {
    const adapter: ActionOperationCancellationAdapter = {
      domainKind: 'platform-action',
      cancel: vi.fn().mockRejectedValue(new Error('owner transport failed')),
    };
    const service = new ActionOperationService(new MemoryStore(), {
      cancellationAdapters: [adapter],
    });
    const operation = (await service.create(owner, {
      id: 'owner-fault',
      scope: { accountId: 'account-a' },
      title: 'Platform action',
      cancellation: 'supported',
      domain: { kind: 'platform-action', actionId: 'owner-action' },
      reentry: { kind: 'session', sessionId: 'session-a' },
    }))!;

    await expect(service.cancel(owner, operation.id)).resolves.toMatchObject({
      kind: 'indeterminate',
      operation: {
        status: 'running',
        progress: { kind: 'phase', code: 'reconciliation-required' },
      },
    });
  });

  test('indeterminate owner cancellation remains nonterminal and requires reconciliation', async () => {
    const adapter: ActionOperationCancellationAdapter = {
      domainKind: 'platform-action',
      cancel: vi.fn().mockResolvedValue({ kind: 'indeterminate' }),
    };
    const service = new ActionOperationService(new MemoryStore(), {
      cancellationAdapters: [adapter],
    });
    const operation = (await service.create(owner, {
      id: 'indeterminate',
      scope: { accountId: 'account-a' },
      title: 'Platform action',
      cancellation: 'supported',
      domain: { kind: 'platform-action', actionId: 'owner-action' },
      reentry: { kind: 'session', sessionId: 'session-a' },
    }))!;
    await expect(service.cancel(owner, operation.id)).resolves.toMatchObject({
      kind: 'indeterminate',
      operation: {
        status: 'running',
        progress: { kind: 'phase', code: 'reconciliation-required' },
      },
    });
  });

  test('stale revisions and terminal regression are refused', async () => {
    const service = new ActionOperationService(new MemoryStore());
    const operation = (await service.create(owner, baseInput('terminal')))!;
    await service.update(owner, operation.id, {
      expectedRevision: 1,
      status: 'succeeded',
    });
    await expect(
      service.update(owner, operation.id, {
        expectedRevision: 1,
        status: 'running',
      }),
    ).resolves.toMatchObject({
      kind: 'stale',
      operation: { status: 'succeeded' },
    });
    await expect(
      service.update(owner, operation.id, {
        expectedRevision: 2,
        status: 'running',
      }),
    ).resolves.toMatchObject({ kind: 'terminal' });
  });

  test('a repeated handoff coordinate reuses its evolved target row', async () => {
    const store = new MemoryStore();
    const service = new ActionOperationService(store);
    const input = {
      id: 'handoff-stable',
      scope: { accountId: 'account-a', sessionId: 'session-a' },
      title: 'Continue attached session',
      cancellation: 'unsupported' as const,
      domain: {
        kind: 'session-handoff' as const,
        sourceSessionId: 'session-a',
      },
      reentry: { kind: 'session' as const, sessionId: 'session-a' },
    };
    const created = (await service.create(owner, input))!;
    await service.update(owner, created.id, {
      expectedRevision: created.revision,
      status: 'succeeded',
      domain: {
        kind: 'session-handoff',
        sourceSessionId: 'session-a',
        targetSessionId: 'session-b',
      },
      reentry: { kind: 'session', sessionId: 'session-b' },
    });
    await expect(service.create(owner, input)).resolves.toMatchObject({
      id: 'handoff-stable',
      status: 'succeeded',
      domain: { targetSessionId: 'session-b' },
    });
    expect(store.ledger.records).toHaveLength(1);
  });
});

describe('ActionOperationService boundaries', () => {
  test('machine and session coordinates are independently enforced', async () => {
    const service = new ActionOperationService(new MemoryStore());
    await service.create(owner, {
      ...baseInput('scoped'),
      scope: {
        accountId: 'account-a',
        machineId: 'machine-a',
        sessionId: 'session-a',
      },
    });
    expect((await service.list(owner)).items).toHaveLength(1);
    expect(
      (
        await service.list({
          ...owner,
          machineId: 'machine-b',
        })
      ).items,
    ).toEqual([]);
    expect(
      (
        await service.list({
          ...owner,
          canReadSession: () => false,
        })
      ).items,
    ).toEqual([]);
  });

  test('hostile input, unsafe text, invalid progress, IDs, and extra fields never persist', async () => {
    const store = new MemoryStore();
    const service = new ActionOperationService(store);
    const invalid: unknown[] = [
      { ...baseInput('extra'), unexpected: true },
      { ...baseInput('bad/id') },
      { ...baseInput('path'), title: 'Failed at /Users/private/key' },
      { ...baseInput('secret'), title: 'token=private' },
      {
        ...baseInput('progress'),
        progress: {
          kind: 'determinate',
          completed: 3,
          total: 2,
          unit: 'steps',
        },
      },
      {
        ...baseInput('url'),
        reentry: {
          kind: 'session',
          sessionId: 'session-a',
          href: '/secret?q=x',
        },
      },
    ];
    for (const input of invalid) {
      await expect(
        service.create(owner, input as ReturnType<typeof baseInput>),
      ).resolves.toBeUndefined();
    }
    expect(store.ledger.records).toEqual([]);
  });

  test('fleet operations cannot exist without both exact session and receipt joins', async () => {
    const service = new ActionOperationService(new MemoryStore());
    await expect(
      service.create(owner, {
        ...baseInput('fleet'),
        domain: { kind: 'fleet-dispatch', sessionId: 'session-a' } as never,
        reentry: { kind: 'monitoring', routingReceiptId: 'receipt-a' },
      }),
    ).resolves.toBeUndefined();
  });

  test('active capacity is bounded and stale active state is projected as reconciliation-needed', async () => {
    const store = new MemoryStore();
    const now = clock();
    const service = new ActionOperationService(store, {
      now,
      staleActiveMs: 1,
    });
    for (let index = 0; index < ACTION_OPERATION_MAX_ACTIVE; index += 1) {
      await service.create(owner, baseInput(`cap-${index}`));
    }
    await expect(service.create(owner, baseInput('overflow'))).rejects.toThrow(
      'capacity is exhausted',
    );
    const projected = (await service.list(owner)).items;
    expect(projected[0]?.status).not.toBe('failed');
    expect(projected[0]?.progress).toEqual({
      kind: 'phase',
      code: 'reconciliation-required',
    });
  });
});
