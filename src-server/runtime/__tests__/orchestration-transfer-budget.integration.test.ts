import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as sdk from '../../../packages/sdk/src/client/index.js';
import { HttpTransferRecorder } from '../../__test-utils__/http-transfer-recorder.js';
import { GateTestAdapter } from '../../__test-utils__/orchestration-gate-test-harness.js';
import {
  heavyTransferFinalPair,
  heavyTransferPrefix,
  ORCHESTRATION_TRANSFER_OWNER,
  ORCHESTRATION_TRANSFER_THREAD_ID,
  retainedTransferEvents,
  transferFixtureDigest,
} from '../../__test-utils__/orchestration-transfer-fixture.js';
import {
  createStationTransferBoundary,
  groupTransferEventsByTurn,
  measureOrchestrationTransfer,
  ORCHESTRATION_TRANSFER_PHASE_NAMES,
} from '../../__test-utils__/orchestration-transfer-scenario.js';
import { StationAgentAdapter } from '../../providers/adapters/station-agent-adapter.js';
import { createOrchestrationRoutes } from '../../routes/orchestration/orchestration.js';
import { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import { EventBus } from '../../services/orchestration/event-bus.js';
import { EventStore } from '../../services/orchestration/event-store.js';
import { OrchestrationService } from '../../services/orchestration/orchestration-service.js';
import type { Logger } from '../../utils/logger.js';
import { configureRuntimeHttp } from '../bootstrap/runtime-http.js';

const roots: string[] = [];
const closers: Array<() => Promise<void>> = [];
const transferBudget = JSON.parse(
  readFileSync(
    new URL(
      '../../../scripts/fixtures/orchestration-transfer/budget.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  policy: Record<
    string,
    { wireBytes: number; decodedBytes: number; frames: number }
  >;
};

afterEach(async () => {
  sdk.setClientCredentialResolver();
  await Promise.all(closers.splice(0).map((close) => close()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function until(predicate: () => boolean, description: string) {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error(`barrier timed out: ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function createLogger(): Logger {
  // The six level methods alone do not satisfy `Logger` — the seam also
  // declares child/setLevel/getLevel, and the routes this harness composes
  // take a real `Logger`. Annotated so a future member addition is one
  // compile error here rather than one at every call site.
  const logger: Logger = {
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    trace: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
    setLevel: vi.fn(),
    getLevel: vi.fn(() => 'info' as const),
  };
  return logger;
}

/**
 * `heavyTransferEvents()` ends `tool.started -> tool.completed ->
 * turn.completed`, so `heavyTransferFinalPair()` (its last three) always has
 * the tool completion at index 1 — that is the event carrying `output`.
 * `CanonicalRuntimeEvent` is a union discriminated on `method`, so read it
 * through a narrowing that FAILS LOUDLY if the fixture is ever reordered,
 * rather than a cast that would keep compiling against the wrong event.
 */
function finalToolOutputOf(pair: CanonicalRuntimeEvent[]): string {
  const completion = pair[1];
  if (completion?.method !== 'tool.completed')
    throw new Error(
      `heavyTransferFinalPair()[1] must be tool.completed, got ${completion?.method ?? 'nothing'}`,
    );
  const { output } = completion;
  if (typeof output !== 'string')
    throw new Error('the fixture tool completion carries no string output');
  return output;
}

async function runtime() {
  const root = mkdtempSync(join(tmpdir(), 'station-transfer-budget-'));
  roots.push(root);
  const store = new EventStore(join(root, 'orchestration.sqlite'));
  const eventBus = new EventBus();
  const logger = createLogger();
  const externalAdapter = new GateTestAdapter();
  const nativeBoundary = createStationTransferBoundary();
  let nativeTimestamp = 0;
  const nativeAdapter = new StationAgentAdapter({
    apiBase: 'http://station-native.test',
    hasAgent: (agentId) => agentId === 'transfer-native-agent',
    approvalRegistry: new ApprovalRegistry(logger, { eventBus }),
    eventBus,
    fetch: nativeBoundary.fetch,
    now: () => new Date(Date.UTC(2026, 7, 25, 0, 0, nativeTimestamp++)),
  });
  const service = new OrchestrationService({
    adapterRegistry: {
      register() {},
      get(provider) {
        if (provider === externalAdapter.provider) return externalAdapter;
        if (provider === nativeAdapter.provider) return nativeAdapter;
        return undefined;
      },
      list() {
        return [externalAdapter, nativeAdapter];
      },
    },
    eventBus,
    eventStore: store,
    logger,
    ownerlessSessionAccess: 'single-user-compat',
  });
  service.initialize();
  const app = new Hono();
  configureRuntimeHttp({ app: app as never, logger, eventBus });
  app.route(
    '/api/orchestration',
    createOrchestrationRoutes(service, {
      eventBus,
      logger,
      getUserId: () => ORCHESTRATION_TRANSFER_OWNER,
    }),
  );
  const listener = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
  await once(listener, 'listening');
  const address = listener.address();
  if (!address || typeof address === 'string')
    throw new Error('loopback listener did not bind a TCP port');
  closers.push(async () => {
    // `ServerType` is a union and only its http.Server arm declares
    // closeAllConnections, so `?.` is not enough: the property is absent
    // from the type, not merely optional.
    if ('closeAllConnections' in listener) listener.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      listener.close((error) => (error ? reject(error) : resolve())),
    );
    await service.shutdown();
    store.close();
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    externalAdapter,
    nativeAdapter,
    nativeBoundary,
    service,
    store,
  };
}

describe('orchestration transfer byte budgets', () => {
  test('measures the same five bounded phases through external and native engines', async () => {
    const {
      baseUrl,
      externalAdapter,
      nativeAdapter,
      nativeBoundary,
      service,
      store,
    } = await runtime();
    const externalRecorder = new HttpTransferRecorder(baseUrl);
    sdk.setClientCredentialResolver(() => ({
      origin: baseUrl,
      transport: externalRecorder.transport,
    }));
    const externalFinalPair = heavyTransferFinalPair();
    const externalMeasurement = await measureOrchestrationTransfer({
      source: {
        scenario: 'external-engine',
        provider: 'claude',
        threadId: ORCHESTRATION_TRANSFER_THREAD_ID,
        heavyTurnId: () => 'transfer-heavy-turn',
        finalToolOutput: () => finalToolOutputOf(externalFinalPair),
        finalReplayEventCount: 3,
        heavyLiveFrameCount: 42,
        async seedRetained() {
          for (const event of retainedTransferEvents())
            externalAdapter.events.push(event);
          await until(
            () =>
              store.listEvents(ORCHESTRATION_TRANSFER_THREAD_ID).length ===
              retainedTransferEvents().length,
            'external retained history persisted through adapter ingestion',
          );
        },
        async startHeavyPrefix() {
          for (const event of heavyTransferPrefix())
            externalAdapter.events.push(event);
          await until(
            () =>
              store.listEvents(ORCHESTRATION_TRANSFER_THREAD_ID).length ===
              retainedTransferEvents().length + heavyTransferPrefix().length,
            'external heavy prefix persisted through adapter ingestion',
          );
        },
        async finishHeavyTurn() {
          for (const event of externalFinalPair)
            externalAdapter.events.push(event);
          await until(
            () =>
              store
                .listEvents(ORCHESTRATION_TRANSFER_THREAD_ID)
                .some(
                  (stored) =>
                    (stored.payload as { eventId?: unknown }).eventId ===
                    externalFinalPair[2]!.eventId,
                ),
            'external heavy terminal persisted through adapter ingestion',
          );
        },
      },
      baseUrl,
      store,
      service,
      recorder: externalRecorder,
      sdk,
      budget: transferBudget.policy,
    });

    const nativeThreadId = 'transfer-budget-station-agent-thread';
    let nativeHeavyTurnId: string | undefined;
    const nativeRecorder = new HttpTransferRecorder(baseUrl);
    sdk.setClientCredentialResolver(() => ({
      origin: baseUrl,
      transport: nativeRecorder.transport,
    }));
    const nativeMeasurement = await measureOrchestrationTransfer({
      source: {
        scenario: 'station-native',
        provider: 'station-agent',
        threadId: nativeThreadId,
        heavyTurnId: () => {
          if (!nativeHeavyTurnId) throw new Error('native heavy turn missing');
          return nativeHeavyTurnId;
        },
        finalToolOutput: () => finalToolOutputOf(heavyTransferFinalPair()),
        finalReplayEventCount: 4,
        heavyLiveFrameCount: 44,
        async seedRetained() {
          await nativeAdapter.startSession({
            threadId: nativeThreadId,
            provider: 'station-agent',
            metadata: {
              agentId: 'transfer-native-agent',
              userId: ORCHESTRATION_TRANSFER_OWNER,
            },
          });
          for (const [index, turn] of groupTransferEventsByTurn(
            retainedTransferEvents(),
          ).entries()) {
            nativeBoundary.queueComplete(turn);
            await nativeAdapter.sendTurn({
              threadId: nativeThreadId,
              input: `Run retained transfer turn ${index}.`,
              modelId: 'fixture-model',
            });
            await until(
              () =>
                store
                  .listEvents(nativeThreadId)
                  .filter(
                    (stored) =>
                      (stored.payload as { method?: unknown }).method ===
                      'turn.completed',
                  ).length ===
                index + 1,
              `native retained turn ${index} persisted through adapter ingestion`,
            );
          }
        },
        async startHeavyPrefix() {
          nativeBoundary.queuePaused(heavyTransferPrefix(), externalFinalPair);
          const nativeTurn = await nativeAdapter.sendTurn({
            threadId: nativeThreadId,
            input: 'Run the bounded native transfer fixture.',
            modelId: 'fixture-model',
          });
          nativeHeavyTurnId = nativeTurn.turnId;
          await until(
            () =>
              store
                .listEvents(nativeThreadId)
                .filter(
                  (stored) =>
                    (stored.payload as { turnId?: unknown }).turnId ===
                      nativeHeavyTurnId &&
                    (stored.payload as { method?: unknown }).method ===
                      'tool.completed',
                ).length === 19,
            'native heavy prefix persisted through adapter ingestion',
          );
        },
        async finishHeavyTurn() {
          nativeBoundary.releaseFinal();
          await until(
            () =>
              store
                .listEvents(nativeThreadId)
                .filter(
                  (stored) =>
                    (stored.payload as { turnId?: unknown }).turnId ===
                      nativeHeavyTurnId &&
                    (stored.payload as { method?: unknown }).method ===
                      'turn.completed',
                ).length === 1,
            'native heavy terminal persisted through adapter ingestion',
          );
        },
      },
      baseUrl,
      store,
      service,
      recorder: nativeRecorder,
      sdk,
      budget: transferBudget.policy,
    });

    expect(externalMeasurement.phases).toHaveLength(5);
    expect(nativeMeasurement.phases).toHaveLength(5);
    expect(
      [...externalMeasurement.phases, ...nativeMeasurement.phases].map(
        (phase) => `${phase.scenario}/${phase.name}`,
      ),
    ).toEqual([
      ...ORCHESTRATION_TRANSFER_PHASE_NAMES.map(
        (name) => `external-engine/${name}`,
      ),
      ...ORCHESTRATION_TRANSFER_PHASE_NAMES.map(
        (name) => `station-native/${name}`,
      ),
    ]);
    expect(nativeMeasurement.finalCursor).toBeGreaterThan(
      nativeMeasurement.beforeHeavyCursor,
    );
    expect(nativeBoundary.calls).toHaveLength(11);
    expect(
      nativeBoundary.calls.every(([url]) =>
        String(url).endsWith('/api/agents/transfer-native-agent/chat'),
      ),
    ).toBe(true);
    expect(transferFixtureDigest()).toMatch(/^[0-9a-f]{64}$/);
  });
});
