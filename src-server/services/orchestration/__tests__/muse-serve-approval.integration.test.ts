/**
 * #2452: a Muse workflow subagent's approval, end to end through Station's
 * own seams. The REAL `MuseAdapter` (serve path) runs under the real
 * `OrchestrationService` and event store; only the `muse serve` host is a
 * stream double, fed the live Muse Code 1.3.0 capture
 * (`muse-serve-1.3.0-workflow-child-approve.jsonl`). The approval is answered
 * with the same `respondToRequest` command the inline approval card posts,
 * using the request id Station persisted — not an id the test knows from the
 * capture.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  FakeMuseServeHost,
  loadMuseServeCapture,
  replayMuseServeCapture,
} from '../../../providers/__tests__/muse-serve-replay.js';
import {
  buildMuseServeArgs,
  MuseAdapter,
} from '../../../providers/adapters/muse-adapter.js';
import { EventBus } from '../event-bus.js';
import { EventStore } from '../event-store.js';
import { OrchestrationService } from '../orchestration-service.js';

const THREAD = 'muse-serve-approval';

async function eventually<T>(
  read: () => T | undefined,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('#2452 a Muse workflow subagent approval through OrchestrationService', () => {
  let tmp: string;
  let eventStore: EventStore;
  let service: OrchestrationService;
  let adapter: MuseAdapter;
  const hosts: FakeMuseServeHost[] = [];

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'muse-serve-approval-'));
    eventStore = new EventStore(join(tmp, 'orchestration.sqlite'));
    hosts.length = 0;
    adapter = new MuseAdapter({
      serve: {
        spawnHost: (posture) => {
          const host = new FakeMuseServeHost(buildMuseServeArgs(posture));
          hosts.push(host);
          return { process: host, release: () => {} };
        },
        terminateHost: async (spawned) => {
          (spawned.process as FakeMuseServeHost).exit(0);
        },
      },
      processFactory: () => {
        throw new Error('exec must not spawn on the serve path');
      },
      logger: { warn: () => {}, info: () => {} },
    });
    service = new OrchestrationService({
      adapterRegistry: {
        register() {},
        get: (provider) => (provider === 'muse' ? adapter : undefined),
        list: () => [adapter],
      },
      eventBus: new EventBus(),
      eventStore,
      logger: { debug: vi.fn(), warn: vi.fn() },
    });
  });

  afterEach(async () => {
    await adapter.stopAll().catch(() => undefined);
    eventStore.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  function persisted(): CanonicalRuntimeEvent[] {
    return eventStore.listEvents(THREAD).map((row) => row.payload);
  }

  test('ask asks: the request is persisted, answered by respondToRequest, walked on the wire, and resolved approved', async () => {
    const started = service.dispatch(
      {
        type: 'startSession',
        input: {
          threadId: THREAD,
          provider: 'muse',
          modelOptions: { approvalMode: 'ask' },
        },
      },
      { userId: 'owner-user' },
    );
    started.catch(() => undefined);
    const host = await eventually(() => hosts[0]);
    const driven = await replayMuseServeCapture(
      host,
      loadMuseServeCapture('workflow-child-approve'),
      {
        onDrivenRequest: (method, occurrence) => {
          if (method === 'turn/start') {
            return service.dispatch({
              type: 'sendTurn',
              input: { threadId: THREAD, input: 'launch one subagent' },
            });
          }
          if (method === 'approval/decide' && occurrence === 0) {
            return (async () => {
              const opened = await eventually(() =>
                persisted().find((event) => event.method === 'request.opened'),
              );
              if (opened.method !== 'request.opened') throw new Error();
              await service.dispatch({
                type: 'respondToRequest',
                threadId: opened.threadId,
                requestId: opened.requestId,
                expectedRequestEventId: opened.eventId,
                decision: 'accept',
              });
            })();
          }
          return undefined;
        },
      },
    );
    await started;

    // Station's posture reached the host as muse's ask mode.
    expect(
      driven.find((frame) => frame.method === 'session/start')?.params,
    ).toMatchObject({ approvalMode: 'promptUnmatched' });
    const opened = persisted().find(
      (event) => event.method === 'request.opened',
    );
    expect(opened).toMatchObject({
      requestType: 'approval',
      payload: {
        toolName: 'bash',
        childWork: { childId: '00000000-0000-7000-8000-000000000023' },
      },
    });
    expect(
      driven
        .filter((frame) => frame.method === 'approval/decide')
        .map((frame) => frame.params?.choiceId),
    ).toEqual(['allow_once', 'allow_once']);
    await expect(
      eventually(() =>
        persisted().find((event) => event.method === 'request.resolved'),
      ),
    ).resolves.toMatchObject({ status: 'approved' });
    // The turn continued: the subagent settled and muse replied on its own.
    await eventually(() =>
      persisted().find(
        (event) =>
          event.method === 'child-work.updated' &&
          event.delta.kind === 'settle' &&
          event.delta.status === 'completed',
      ),
    );
    await eventually(() =>
      persisted().find(
        (event) =>
          event.method === 'turn.started' &&
          event.metadata?.trigger === 'provider',
      ),
    );
  });
});
