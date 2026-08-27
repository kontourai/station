import { describe, expect, test } from 'vitest';
import {
  type ActionOperationLedger,
  ActionOperationService,
  type ActionOperationStore,
} from '../../../services/operations/action-operation-service.js';
import { createActionOperationRoutes } from '../action-operations.js';

function service() {
  let ledger: ActionOperationLedger = {
    version: 1,
    creationSequence: 0,
    changeSequence: 0,
    records: [],
  };
  const store: ActionOperationStore = {
    read: async () => structuredClone(ledger),
    transact: async (update) => {
      const outcome = update(structuredClone(ledger));
      if (outcome.next) ledger = structuredClone(outcome.next);
      return outcome.result;
    },
  };
  return new ActionOperationService(store, {
    now: () => new Date('2026-08-23T00:00:00.000Z'),
    cancellationAdapters: [
      {
        domainKind: 'session-handoff',
        cancel: async () => ({ kind: 'cancelled' }),
      },
    ],
  });
}
const actor = { accountId: 'account-a', canReadSession: () => true };

async function seeded() {
  const operations = service();
  await operations.create(actor, {
    id: 'handoff-1',
    scope: { accountId: 'account-a', sessionId: 'session-a' },
    title: 'Continue attached session',
    cancellation: 'supported',
    domain: { kind: 'session-handoff', sourceSessionId: 'session-a' },
    reentry: { kind: 'session', sessionId: 'session-a' },
  });
  return {
    operations,
    app: createActionOperationRoutes({
      operations,
      actorForRequest: () => actor,
    }),
  };
}

describe('action operation routes', () => {
  test('serves an authenticated bounded page and reconnect snapshot', async () => {
    const { app } = await seeded();
    const page = await app.request('/?limit=1');
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      success: true,
      data: { items: [{ id: 'handoff-1' }] },
    });
    const snapshot = await app.request('/watch');
    expect(await snapshot.json()).toMatchObject({
      success: true,
      data: { mode: 'snapshot', cursor: expect.any(String) },
    });
  });

  test('does not distinguish an unauthorized operation from a missing one', async () => {
    const { operations } = await seeded();
    const privateApp = createActionOperationRoutes({
      operations,
      actorForRequest: () => ({ accountId: 'other' }),
    });
    expect((await privateApp.request('/handoff-1')).status).toBe(404);
    expect((await privateApp.request('/missing')).status).toBe(404);
  });

  test('only exposes cancellation where the owner declared it supported', async () => {
    const { app } = await seeded();
    const cancelled = await app.request('/handoff-1/cancel', {
      method: 'POST',
    });
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toMatchObject({
      success: true,
      data: { status: 'cancelled' },
    });
    const repeat = await app.request('/handoff-1/cancel', { method: 'POST' });
    expect(await repeat.json()).toMatchObject({
      success: true,
      idempotent: true,
    });
  });

  test('refuses malformed paging rather than treating it as the first page', async () => {
    const { app } = await seeded();
    expect((await app.request('/?limit=0')).status).toBe(400);
    expect((await app.request(`/?cursor=${'x'.repeat(65)}`)).status).toBe(400);
    expect((await app.request('/?cursor=bounded-but-invalid')).status).toBe(
      400,
    );
    expect(
      (await app.request('/watch?cursor=bounded-but-invalid')).status,
    ).toBe(400);
  });
});
