import { readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { agentId } from '@kontourai/station-contracts/agent-identity';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import { afterEach, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { createOrchestrationRoutes } from '../../../routes/orchestration/orchestration.js';
import type { ForegroundMessageHandle } from '../../execution-target/execution-target-execution.js';
import { FileDelegationAttemptClaimStore } from '../delegation-attempt-claim-store.js';
import { EventBus } from '../event-bus.js';

const temp = trackTempDirs();
const DAY = 86_400_000;
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture() {
  const home = temp('create-claim-route-');
  const effect = vi.fn(
    async (input: {
      conversationId?: string;
    }): Promise<ForegroundMessageHandle> => ({
      conversationId: input.conversationId!,
      sessionId: input.conversationId!,
      providerTurnId: 'turn-1',
      target: { kind: 'agent', id: agentId('agent') },
      resolution: {
        schemaVersion: 'station.execution-resolution/v1',
        resolvedAt: '2026-11-01T00:00:00Z',
        environmentId: environmentId('station'),
        agentId: agentId('agent'),
        engine: { kind: 'station' },
        provider: 'station-agent',
        modelLaunchPlan: {
          kind: 'engine-selected',
          evidence: 'adapter-declared',
        },
      },
    }),
  );
  const mount = () =>
    createOrchestrationRoutes(
      { hasSessionStartRecord: async () => false } as never,
      {
        eventBus: new EventBus(),
        logger: { debug: vi.fn() },
        getUserId: () => 'operator',
        delegationAttemptClaimStore: new FileDelegationAttemptClaimStore(home),
        executeForegroundMessage: effect,
      },
    );
  const send = (message = 'hello') =>
    mount().request('/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        clientTurnId: 'request-1',
        message,
        target: { environment: { kind: 'current' }, agent: 'station' },
      }),
    });
  return { home, effect, send };
}

test('the real chat route immediately reclaims changed input from an abandoned unmarked reservation', async () => {
  const f = fixture();
  expect((await f.send()).status).toBe(200);
  const file = join(f.home, 'create-request-claims.json');
  const ledger = JSON.parse(readFileSync(file, 'utf8'));
  const row = ledger.claims[Object.keys(ledger.claims)[0]];
  delete row.result;
  delete row.completedAt;
  writeFileSync(file, JSON.stringify(ledger));
  const retry = await f.send('changed input');
  expect(retry.status).toBe(200);
  expect(f.effect).toHaveBeenCalledTimes(2);
  expect(f.effect.mock.calls[1][0]).toMatchObject({ message: 'changed input' });
});

test.each(['forward', 'backward'] as const)(
  'the real chat route retains a receipt for seven elapsed days through a %s wall jump and reopen',
  async (direction) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const wall = Date.parse('2026-11-01T00:00:00Z');
    vi.setSystemTime(wall);
    let elapsed = 100 * DAY;
    vi.spyOn(os, 'uptime').mockImplementation(() => elapsed / 1000);
    const f = fixture();
    const first = await (await f.send()).json();
    elapsed += DAY;
    vi.setSystemTime(wall + (direction === 'forward' ? 365 : -365) * DAY);
    expect(await (await f.send()).json()).toEqual(first);
    elapsed += 6 * DAY - 1;
    expect(await (await f.send()).json()).toEqual(first);
    expect(f.effect).toHaveBeenCalledOnce();
    elapsed += 1;
    const expired = await f.send();
    expect(expired.status).toBe(200);
    expect(await expired.json()).not.toEqual(first);
    expect(f.effect).toHaveBeenCalledTimes(2);
  },
);

test.each(['marked', 'unknown-owner'] as const)(
  'changed input still conflicts with a %s reservation through the real route',
  async (state) => {
    const f = fixture();
    expect((await f.send()).status).toBe(200);
    const file = join(f.home, 'create-request-claims.json');
    const ledger = JSON.parse(readFileSync(file, 'utf8'));
    const key = Object.keys(ledger.claims)[0];
    const row = ledger.claims[key];
    delete row.result;
    delete row.completedAt;
    if (state === 'marked') row.starting = true;
    else writeFileSync(`${file}.${key}.owner`, '{}');
    writeFileSync(file, JSON.stringify(ledger));
    const retry = await f.send('changed input');
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({
      code: 'client_turn_input_conflict',
    });
    expect(f.effect).toHaveBeenCalledOnce();
  },
);

test.each(['legacy', 'uptime-reset'] as const)(
  'retention conservatively reanchors a %s observation and still expires',
  async (state) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-01T00:00:00Z'));
    let elapsed = 100 * DAY;
    vi.spyOn(os, 'uptime').mockImplementation(() => elapsed / 1000);
    const f = fixture();
    const first = await (await f.send()).json();
    if (state === 'legacy') {
      const file = join(f.home, 'create-request-claims.json');
      const ledger = JSON.parse(readFileSync(file, 'utf8'));
      delete ledger.claims[Object.keys(ledger.claims)[0]].retention;
      writeFileSync(file, JSON.stringify(ledger));
    } else elapsed = DAY;
    vi.setSystemTime(new Date('2027-11-01T00:00:00Z'));
    expect(await (await f.send()).json()).toEqual(first);
    elapsed += 7 * DAY;
    expect(await (await f.send()).json()).not.toEqual(first);
    expect(f.effect).toHaveBeenCalledTimes(2);
  },
);
