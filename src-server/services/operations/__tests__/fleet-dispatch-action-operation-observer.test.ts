import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
import {
  ActionOperationService,
  FileActionOperationStore,
} from '../action-operation-service.js';
import { FleetDispatchActionOperationObserver } from '../fleet-dispatch-action-operation-observer.js';

const turn = {
  accountId: 'account-a',
  sessionId: 'session-a',
  turnId: 'turn-a',
  correlationId: 'correlation-a',
  planDigest: 'plan-a',
} as const;

function actor(accountId = 'account-a', sessionId = 'session-a') {
  return {
    accountId,
    canReadSession: (candidate: string) => candidate === sessionId,
  };
}

describe('FleetDispatchActionOperationObserver', () => {
  test('begins a visible Activity operation and settles it from the sealed receipt', async () => {
    const service = new ActionOperationService(
      new FileActionOperationStore(await mkdtemp(join(tmpdir(), 'fleet-op-'))),
    );
    const observer = new FleetDispatchActionOperationObserver(service);

    await observer.begin(turn);
    const [active] = (await service.list(actor())).items;
    expect(active).toMatchObject({
      status: 'accepted',
      title: 'Route fleet dispatch',
      cancellation: 'unsupported',
      scope: { accountId: 'account-a', sessionId: 'session-a' },
      domain: {
        kind: 'fleet-dispatch',
        sessionId: 'session-a',
        correlationId: 'correlation-a',
      },
      reentry: { kind: 'session', sessionId: 'session-a' },
    });

    await observer.settle({
      ...turn,
      receiptId: 'receipt-a',
      outcome: 'succeeded',
    });
    const [settled] = (await service.list(actor())).items;
    expect(settled).toMatchObject({
      id: active!.id,
      status: 'succeeded',
      domain: {
        kind: 'fleet-dispatch',
        correlationId: 'correlation-a',
        routingReceiptId: 'receipt-a',
      },
      reentry: { kind: 'session', sessionId: 'session-a' },
    });
  });

  test('settle-before-begin and duplicate delivery reuse one stable operation', async () => {
    const service = new ActionOperationService(
      new FileActionOperationStore(await mkdtemp(join(tmpdir(), 'fleet-op-'))),
    );
    const observer = new FleetDispatchActionOperationObserver(service);

    await observer.settle({
      ...turn,
      receiptId: 'receipt-a',
      outcome: 'exhausted',
    });
    await observer.begin(turn);
    await observer.settle({
      ...turn,
      receiptId: 'receipt-a',
      outcome: 'exhausted',
    });

    const page = await service.list(actor());
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      status: 'failed',
      errorSummary: 'Fleet routing attempts did not produce a completion.',
      domain: { routingReceiptId: 'receipt-a' },
    });
  });

  test('keeps concurrent sessions and account visibility isolated', async () => {
    const service = new ActionOperationService(
      new FileActionOperationStore(await mkdtemp(join(tmpdir(), 'fleet-op-'))),
    );
    const observer = new FleetDispatchActionOperationObserver(service);
    await Promise.all([
      observer.begin(turn),
      observer.begin({
        ...turn,
        accountId: 'account-b',
        sessionId: 'session-b',
        turnId: 'turn-b',
        correlationId: 'correlation-b',
        planDigest: 'plan-b',
      }),
    ]);

    expect((await service.list(actor())).items).toHaveLength(1);
    expect(
      (await service.list(actor('account-b', 'session-b'))).items,
    ).toHaveLength(1);
    expect((await service.list(actor('account-c', 'session-a'))).items).toEqual(
      [],
    );
  });

  test('persists a restart-safe active row that reconciles stale without a callback order assumption', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fleet-op-'));
    let now = Date.parse('2026-08-23T00:00:00.000Z');
    const first = new ActionOperationService(
      new FileActionOperationStore(directory),
      {
        now: () => new Date(now),
        staleActiveMs: 1_000,
      },
    );
    await new FleetDispatchActionOperationObserver(first).begin(turn);

    now += 1_001;
    const restarted = new ActionOperationService(
      new FileActionOperationStore(directory),
      { now: () => new Date(now), staleActiveMs: 1_000 },
    );
    expect((await restarted.list(actor())).items[0]).toMatchObject({
      progress: { kind: 'phase', code: 'reconciliation-required' },
    });
  });
});
