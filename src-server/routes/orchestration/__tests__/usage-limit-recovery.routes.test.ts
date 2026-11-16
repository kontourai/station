import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  createGateTestRegistry,
  GateTestAdapter,
} from '../../../__test-utils__/orchestration-gate-test-harness';
import { awaitSessionAttachmentSettled } from '../../../__test-utils__/session-runtime-barriers.js';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import type { CredentialProfileRecoveryAdapter } from '../../../services/orchestration/credential-recovery-module';
import { EventBus } from '../../../services/orchestration/event-bus';
import { EventStore } from '../../../services/orchestration/event-store';
import { OrchestrationService } from '../../../services/orchestration/orchestration-service';
import { createOrchestrationRoutes } from '../orchestration';

/**
 * #3157: the chat banner's three routes, through the real router, service,
 * coordinator and ledger. The stop is seeded the way the coordinator records
 * it (`wait-until-reset`, `usageLimit`), because these tests are about who
 * may read it and act on it, and what the response reports back.
 */
const NOW = '2026-09-24T21:00:00.000Z';
const RESET_AT = '2099-01-01T00:00:00.000Z';
const THREAD = 'session-a';

const makeTempDir = trackTempDirs();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  options: {
    autoResume?: boolean;
    credentialProfileRecoveryAdapter?: CredentialProfileRecoveryAdapter;
    hosted?: boolean;
  } = {},
) {
  const directory = makeTempDir('station-usage-limit-');
  const store = new EventStore(join(directory, 'events.sqlite'));
  const adapter = new GateTestAdapter();
  vi.spyOn(adapter, 'hasSession').mockResolvedValue(true);
  const service = new OrchestrationService({
    adapterRegistry: createGateTestRegistry(adapter),
    eventBus: new EventBus(),
    eventStore: store,
    logger: { debug: vi.fn(), warn: vi.fn() },
    resolveUsageLimitAutoResume: async () => options.autoResume === true,
    ...(options.credentialProfileRecoveryAdapter
      ? {
          credentialProfileRecoveryAdapter:
            options.credentialProfileRecoveryAdapter,
        }
      : {}),
    ...(options.hosted ? { requireTenantExecutionContext: () => true } : {}),
  });
  service.initialize();
  await awaitSessionAttachmentSettled(service);
  store.upsertSession({
    provider: 'claude',
    threadId: THREAD,
    status: 'ready',
    createdAt: NOW,
    updatedAt: NOW,
  });
  store.appendEvent({
    eventId: 'configured-a',
    provider: 'claude',
    threadId: THREAD,
    method: 'session.configured',
    sessionId: THREAD,
    createdAt: NOW,
    metadata: { userId: 'owner' },
  });
  store.appendEvent({
    eventId: 'limited-start',
    provider: 'claude',
    threadId: THREAD,
    turnId: 'limited-turn',
    method: 'turn.started',
    createdAt: NOW,
    prompt: 'Finish the migration.',
  });
  const ledger = store.createRecoveryLedger();
  ledger.arm({
    fingerprint: `${THREAD}:limited-turn:rate-limit:account`,
    threadId: THREAD,
    provider: 'claude',
    sourceEventId: 'limited-start',
    sourceTurnId: 'limited-turn',
    failureKind: 'rate-limit',
    scope: 'account',
    decision: 'wait-until-reset',
    dueAt: RESET_AT,
    maxAttempts: 1,
    outcome: 'armed',
    usageLimit: true,
    createdAt: NOW,
    updatedAt: NOW,
  });
  let user = 'owner';
  let principalCurrent = true;
  const app = createOrchestrationRoutes(service, {
    eventBus: new EventBus(),
    logger: { debug: vi.fn() },
    getUserId: () => user,
    isRequestPrincipalCurrent: () => principalCurrent,
  });
  cleanups.push(async () => {
    await service.shutdown();
    store.close();
  });
  return {
    store,
    service,
    ledger,
    app,
    setUser: (value: string) => {
      user = value;
    },
    revoke: () => {
      principalCurrent = false;
    },
  };
}

const PATH = `/sessions/${THREAD}/usage-limit`;
const post = (f: Awaited<ReturnType<typeof fixture>>, action: string) =>
  f.app.request(`${PATH}/${action}`, { method: 'POST' });

describe('usage-limit banner routes (#3157)', () => {
  test('the read answers with the recovery projection and the live auto-resume setting, not the event list', async () => {
    const f = await fixture({ autoResume: true });
    const response = await f.app.request(PATH);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: Record<string, unknown>;
    };
    expect(body.data).toEqual({
      recovery: expect.objectContaining({
        decision: 'wait-until-reset',
        outcome: 'armed',
        dueAt: RESET_AT,
        usageLimit: true,
        autoResume: true,
      }),
    });
  });

  test('a Session without a usage-limit stop reads null', async () => {
    const f = await fixture();
    f.ledger.cancel(`${THREAD}:limited-turn:rate-limit:account`, NOW);
    const settled = (await (await f.app.request(PATH)).json()) as {
      data: { recovery: unknown };
    };
    expect(settled.data.recovery).toMatchObject({ outcome: 'canceled' });
    f.store.upsertSession({
      provider: 'claude',
      threadId: 'session-b',
      status: 'ready',
      createdAt: NOW,
      updatedAt: NOW,
    });
    f.store.appendEvent({
      eventId: 'configured-b',
      provider: 'claude',
      threadId: 'session-b',
      method: 'session.configured',
      sessionId: 'session-b',
      createdAt: NOW,
      metadata: { userId: 'owner' },
    });
    expect(
      await (await f.app.request('/sessions/session-b/usage-limit')).json(),
    ).toEqual({ success: true, data: { recovery: null } });
  });

  test('Cancel auto-resume retires the waiting stop with its reason and reports the projection back', async () => {
    const f = await fixture({ autoResume: true });
    const response = await post(f, 'cancel');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        result: { kind: 'canceled' },
        recovery: {
          outcome: 'canceled',
          outcomeReason: 'user-canceled',
          usageLimit: true,
        },
      },
    });
    // A second click on a banner that has since settled acts on nothing.
    expect(await (await post(f, 'cancel')).json()).toMatchObject({
      data: {
        result: { kind: 'not-waiting' },
        recovery: { outcome: 'canceled', outcomeReason: 'user-canceled' },
      },
    });
    expect(await (await post(f, 'resume')).json()).toMatchObject({
      data: { result: { kind: 'not-waiting' } },
    });
  });

  test('"Resume at reset" and "Don\'t resume" decide this stop in place of the setting, and send nothing now', async () => {
    const f = await fixture({ autoResume: false });
    expect(await (await post(f, 'resume-at-reset')).json()).toMatchObject({
      success: true,
      data: {
        result: { kind: 'chosen', choice: 'resume' },
        recovery: {
          outcome: 'armed',
          autoResume: true,
          autoResumeChoice: 'resume',
        },
      },
    });
    expect(await (await post(f, 'hold')).json()).toMatchObject({
      data: {
        result: { kind: 'chosen', choice: 'hold' },
        recovery: {
          outcome: 'armed',
          autoResume: false,
          autoResumeChoice: 'hold',
        },
      },
    });
    // The read reports the choice too.
    expect(await (await f.app.request(PATH)).json()).toMatchObject({
      data: { recovery: { autoResumeChoice: 'hold', autoResume: false } },
    });
  });

  test('another person cannot make the choice, and none is recorded', async () => {
    const f = await fixture({ autoResume: false });
    f.setUser('someone-else');
    expect((await post(f, 'resume-at-reset')).status).toBe(404);
    expect((await post(f, 'hold')).status).toBe(404);
    f.setUser('owner');
    const read = (await (await f.app.request(PATH)).json()) as {
      data: { recovery: Record<string, unknown> };
    };
    expect(read.data.recovery.autoResumeChoice).toBeUndefined();
    expect(read.data.recovery.autoResume).toBe(false);
  });

  test('Resume now runs the same pre-dispatch checks: a closed Session retires the stop with its reason', async () => {
    const f = await fixture();
    f.store.upsertSession({
      provider: 'claude',
      threadId: THREAD,
      status: 'closed',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await (await post(f, 'resume')).json()).toMatchObject({
      success: true,
      data: {
        result: { kind: 'retired', reason: 'session-ended' },
        recovery: { outcome: 'canceled', outcomeReason: 'session-ended' },
      },
    });
  });

  test('another person cannot read, resume or cancel the stop, and it is left armed', async () => {
    const f = await fixture();
    f.setUser('someone-else');
    expect((await f.app.request(PATH)).status).toBe(404);
    expect((await post(f, 'resume')).status).toBe(404);
    expect((await post(f, 'cancel')).status).toBe(404);
    f.setUser('owner');
    expect(await (await f.app.request(PATH)).json()).toMatchObject({
      data: { recovery: { outcome: 'armed' } },
    });
  });

  test('a request whose principal is no longer current cannot act, and the stop is left armed', async () => {
    const f = await fixture();
    f.revoke();
    expect((await post(f, 'resume')).status).toBe(404);
    expect((await post(f, 'cancel')).status).toBe(404);
    expect(f.ledger.latestProjection(THREAD)).toMatchObject({
      outcome: 'armed',
    });
  });

  test('an unknown Session is not found on every route', async () => {
    const f = await fixture();
    expect((await f.app.request('/sessions/nope/usage-limit')).status).toBe(
      404,
    );
    for (const action of ['resume', 'cancel'])
      expect(
        (
          await f.app.request(`/sessions/nope/usage-limit/${action}`, {
            method: 'POST',
          })
        ).status,
      ).toBe(404);
  });

  test('an ordinary timed retry is not a usage-limit stop: nothing to read, resume or cancel, and it stays armed', async () => {
    const f = await fixture();
    f.store.upsertSession({
      provider: 'claude',
      threadId: 'session-b',
      status: 'ready',
      createdAt: NOW,
      updatedAt: NOW,
    });
    f.store.appendEvent({
      eventId: 'configured-b',
      provider: 'claude',
      threadId: 'session-b',
      method: 'session.configured',
      sessionId: 'session-b',
      createdAt: NOW,
      metadata: { userId: 'owner' },
    });
    f.ledger.arm({
      fingerprint: 'session-b:turn-b:rate-limit:provider',
      threadId: 'session-b',
      provider: 'claude',
      sourceEventId: 'start-b',
      sourceTurnId: 'turn-b',
      failureKind: 'rate-limit',
      scope: 'provider',
      decision: 'retry-later',
      dueAt: RESET_AT,
      maxAttempts: 1,
      outcome: 'armed',
      createdAt: NOW,
      updatedAt: NOW,
    } as never);
    expect(
      await (await f.app.request('/sessions/session-b/usage-limit')).json(),
    ).toEqual({ success: true, data: { recovery: null } });
    for (const action of ['resume', 'cancel'])
      expect(
        await (
          await f.app.request(`/sessions/session-b/usage-limit/${action}`, {
            method: 'POST',
          })
        ).json(),
      ).toEqual({
        success: true,
        data: { result: { kind: 'not-waiting' }, recovery: null },
      });
    expect(f.ledger.latestProjection('session-b')).toMatchObject({
      outcome: 'armed',
    });
  });
});

describe('"Continue on <label>" routes', () => {
  const FINGERPRINT = `${THREAD}:limited-turn:rate-limit:account`;
  function accounts() {
    const stage = vi.fn<CredentialProfileRecoveryAdapter['stage']>(
      async () => ({ kind: 'unavailable' }),
    );
    const listContinueOnProfiles = vi.fn(async (provider: string) =>
      provider === 'claude' ? [{ ref: 'work', label: 'Work' }] : [],
    );
    return { stage, listContinueOnProfiles };
  }
  const continueOn = (
    f: Awaited<ReturnType<typeof fixture>>,
    profileRef: unknown,
    stopId: unknown = FINGERPRINT,
  ) =>
    f.app.request(`${PATH}/continue-on`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profileRef, stopId }),
    });

  test('the read lists the accounts the waiting stop may continue on, for its owner only', async () => {
    const adapter = accounts();
    const f = await fixture({ credentialProfileRecoveryAdapter: adapter });
    const response = await f.app.request(`${PATH}/continue-on`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      success: true,
      data: {
        stopId: FINGERPRINT,
        profiles: [{ ref: 'work', label: 'Work' }],
      },
    });
    expect(adapter.listContinueOnProfiles).toHaveBeenCalledWith('claude');
    // The banner's own read does not carry the accounts.
    const banner = (await (await f.app.request(PATH)).json()) as {
      data: { recovery: Record<string, unknown> };
    };
    expect(JSON.stringify(banner)).not.toContain('work');

    f.setUser('someone-else');
    expect((await f.app.request(`${PATH}/continue-on`)).status).toBe(404);
    expect((await continueOn(f, 'work')).status).toBe(404);
    expect(adapter.stage).not.toHaveBeenCalled();
  });

  test('choosing an offered account stages exactly it, with consent; a refusal leaves the stop waiting', async () => {
    const adapter = accounts();
    const f = await fixture({ credentialProfileRecoveryAdapter: adapter });
    const response = await continueOn(f, 'work');
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { result: unknown; recovery: Record<string, unknown> };
    };
    expect(adapter.stage).toHaveBeenCalledOnce();
    expect(adapter.stage.mock.calls[0]?.[0]).toMatchObject({
      provider: 'claude',
      consentedProfileRef: 'work',
    });
    expect(body.data.result).toEqual({ kind: 'not-switched' });
    expect(body.data.recovery).toMatchObject({ outcome: 'armed' });
    expect(f.ledger.find(FINGERPRINT)?.outcome).toBe('armed');
  });

  test('an account the stop is not offered is refused before anything is staged', async () => {
    const adapter = accounts();
    const f = await fixture({ credentialProfileRecoveryAdapter: adapter });
    const body = (await (await continueOn(f, 'personal')).json()) as {
      data: { result: unknown };
    };
    expect(body.data.result).toEqual({ kind: 'not-switched' });
    expect(adapter.stage).not.toHaveBeenCalled();
    expect((await continueOn(f, '../escape')).status).toBe(400);
    expect(adapter.stage).not.toHaveBeenCalled();
  });

  test('a click bound to another stop, or to none, is refused before anything is staged', async () => {
    const adapter = accounts();
    const f = await fixture({ credentialProfileRecoveryAdapter: adapter });
    const stale = (await (
      await continueOn(f, 'work', `${THREAD}:an-older-turn:rate-limit:account`)
    ).json()) as {
      data: { result: unknown; recovery: Record<string, unknown> };
    };
    expect(stale.data.result).toEqual({ kind: 'not-waiting' });
    expect(stale.data.recovery).toMatchObject({ outcome: 'armed' });
    expect((await continueOn(f, 'work', null)).status).toBe(400);
    expect(adapter.stage).not.toHaveBeenCalled();
    expect(f.ledger.find(FINGERPRINT)?.outcome).toBe('armed');
  });

  test('a hosted Station offers no account and switches none', async () => {
    const adapter = accounts();
    const f = await fixture({
      credentialProfileRecoveryAdapter: adapter,
      hosted: true,
    });
    // A hosted Session's route answers no account (here: not found for a
    // Session with no tenant binding); the service refuses on its own too.
    const read = await f.app.request(`${PATH}/continue-on`);
    const listed =
      read.status === 200
        ? ((await read.json()) as { data: { profiles: unknown[] } }).data
            .profiles
        : [];
    expect(listed).toEqual([]);
    await continueOn(f, 'work');
    await expect(f.service.readUsageLimitContinueOn(THREAD)).resolves.toEqual({
      profiles: [],
    });
    await expect(
      f.service.actOnUsageLimitRecovery(THREAD, 'continue-on', {
        profileRef: 'work',
        stopId: FINGERPRINT,
      }),
    ).resolves.toMatchObject({ result: { kind: 'not-switched' } });
    expect(adapter.listContinueOnProfiles).not.toHaveBeenCalled();
    expect(f.ledger.find(FINGERPRINT)?.outcome).toBe('armed');
    expect(adapter.stage).not.toHaveBeenCalled();
  });

  test('a stop that is no longer waiting offers nothing and answers not-waiting', async () => {
    const adapter = accounts();
    const f = await fixture({ credentialProfileRecoveryAdapter: adapter });
    f.ledger.cancel(FINGERPRINT, NOW);
    const read = (await (
      await f.app.request(`${PATH}/continue-on`)
    ).json()) as { data: { profiles: unknown[] } };
    expect(read.data.profiles).toEqual([]);
    const body = (await (await continueOn(f, 'work')).json()) as {
      data: { result: unknown };
    };
    expect(body.data.result).toEqual({ kind: 'not-waiting' });
    expect(adapter.stage).not.toHaveBeenCalled();
  });
});
