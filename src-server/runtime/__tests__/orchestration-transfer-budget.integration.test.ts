import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inspect } from 'node:util';
import { serve } from '@hono/node-server';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { Hono } from 'hono';
import { afterEach, describe, expect, test, vi } from 'vitest';
import * as sdk from '../../../packages/sdk/src/client/index.js';
import { assertDeterministicBaseline } from '../../../scripts/orchestration-transfer-budget.mjs';
import { runTransferCapture } from '../../../scripts/orchestration-transfer-gate.mjs';
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
  ORCHESTRATION_TRANSFER_LIVE_ACTIVITY_FRAMES,
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

async function startMeasurement({
  refusal,
  holdLiveOpenMs,
  hideActivityFrames = false,
  stallAttempts = false,
  nativeBarrierTimeoutMs,
  nativeHeavyLiveFrameCount = 44,
}: {
  refusal: boolean;
  holdLiveOpenMs: number;
  /** Simulates a route that never flushes its trailing activity frame. */
  hideActivityFrames?: boolean;
  /** The recorder never reports a completed response, so a barrier times out. */
  stallAttempts?: boolean;
  nativeBarrierTimeoutMs?: number;
  nativeHeavyLiveFrameCount?: number;
}) {
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
  const nativeMeasurementPromise = measureOrchestrationTransfer({
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
      heavyLiveFrameCount: nativeHeavyLiveFrameCount,
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
        if (holdLiveOpenMs)
          await new Promise((resolve) => setTimeout(resolve, holdLiveOpenMs));
      },
    },
    baseUrl,
    store,
    service,
    recorder:
      hideActivityFrames || stallAttempts
        ? {
            attempts: stallAttempts ? [] : nativeRecorder.attempts,
            checkpoint: () => nativeRecorder.checkpoint(),
            activityFramesSinceCheckpoint: () => 0,
          }
        : nativeRecorder,
    sdk,
    barrierTimeoutMs: nativeBarrierTimeoutMs,
    budget: refusal
      ? {
          ...transferBudget.policy,
          live: { ...transferBudget.policy.live, frames: 43 },
        }
      : transferBudget.policy,
  });
  return {
    externalMeasurement,
    nativeMeasurementPromise,
    nativeRecorder,
    externalRecorder,
    nativeBoundary,
    externalFinalPair,
  };
}

describe('orchestration transfer byte budgets', () => {
  // `holdLiveOpenMs` forces the slow-host path: the harness keeps the live
  // stream open past the route's 100ms activity debounce after the heavy turn.
  test.each([
    { refusal: false, holdLiveOpenMs: 0 },
    { refusal: true, holdLiveOpenMs: 0 },
    { refusal: false, holdLiveOpenMs: 400 },
  ])(
    'measures five bounded phases and retains refusal diagnostics (%o)',
    async ({ refusal, holdLiveOpenMs }) => {
      const {
        externalMeasurement,
        nativeMeasurementPromise,
        nativeRecorder,
        externalRecorder,
        nativeBoundary,
        externalFinalPair,
      } = await startMeasurement({ refusal, holdLiveOpenMs });

      if (refusal) {
        await expect(nativeMeasurementPromise).rejects.toMatchObject({
          diagnostic: {
            kind: 'station-transfer-failure',
            phase: { scenario: 'station-native', name: 'live', frames: 44 },
            limit: { frames: 43 },
            eventIdentities: expect.arrayContaining([
              expect.objectContaining({ event: 'orchestration:event' }),
            ]),
            truncated: false,
          },
        });
        const failure = await nativeMeasurementPromise.catch((error) => error);
        expect(JSON.stringify(failure.diagnostic)).not.toContain(
          finalToolOutputOf(externalFinalPair),
        );
        return;
      }
      const nativeMeasurement = await nativeMeasurementPromise;

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
      // The trailing session.state-changed leaves the thread dirty, so the
      // route's debounced activity frame always follows it; the scenario waits
      // for that frame instead of racing the 100ms timer.
      const nativeLive = nativeRecorder.attempts[2]!;
      expect(nativeLive.frames).toBe(44);
      expect(nativeLive.activityFrames).toBe(1);
      expect(externalRecorder.attempts[2]!.activityFrames).toBe(0);
      expect(nativeLive.eventIdentities.at(-1)).toMatchObject({
        event: 'orchestration:activity',
      });
      expect(nativeBoundary.calls).toHaveLength(11);
      expect(
        nativeBoundary.calls.every(([url]) =>
          String(url).endsWith('/api/agents/transfer-native-agent/chat'),
        ),
      ).toBe(true);
      expect(transferFixtureDigest()).toMatch(/^[0-9a-f]{64}$/);
    },
  );

  test('the activity frame is part of the measured live phase, so captures that differ in timing compare equal', async () => {
    const capture = async (holdLiveOpenMs: number) => {
      const run = await startMeasurement({ refusal: false, holdLiveOpenMs });
      const native = await run.nativeMeasurementPromise;
      return { external: run.externalMeasurement, native };
    };
    const fast = await capture(0);
    sdk.setClientCredentialResolver();
    await Promise.all(closers.splice(0).map((close) => close()));
    const slow = await capture(400);
    const report = (run: Awaited<ReturnType<typeof capture>>) => ({
      schemaVersion: 1,
      subjectSha: 'a'.repeat(40),
      baseSha: 'b'.repeat(40),
      dirty: false,
      fixtureDigest: 'c'.repeat(64),
      toolDigest: 'd'.repeat(64),
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      phases: [...run.external.phases, ...run.native.phases],
    });
    // The gate's own A/B comparator, over the real measured phases.
    expect(() =>
      assertDeterministicBaseline(report(fast), report(slow)),
    ).not.toThrow();
    const live = (run: Awaited<ReturnType<typeof capture>>) =>
      run.native.phases.find((phase) => phase.name === 'live')!;
    expect(live(fast).wireBytes).toBe(live(slow).wireBytes);
  }, 60_000);

  test('pins the expected activity frames per source', () => {
    expect(ORCHESTRATION_TRANSFER_LIVE_ACTIVITY_FRAMES).toEqual({
      'external-engine': 0,
      'station-native': 1,
    });
  });

  // The real scenario failure text through the real gate FAIL-line path.
  const gateFailLine = (stderr: string) => {
    try {
      runTransferCapture({
        candidateRoot: resolve(import.meta.dirname, '../../..'),
        targetRoot: '/fixture-target',
        output: '/fixture-output.json',
        baseSha: 'a'.repeat(40),
        timeout: 4_000,
        spawn: (() => ({ status: 1, stdout: '', stderr })) as never,
      } as never);
    } catch (error) {
      return String((error as Error).message);
    }
    return '';
  };

  /**
   * The shape Node prints for an uncaught error: the source line that threw
   * (which contains the message template) comes before the error line, and an
   * Error subclass is named `ClassName [Error]` there.
   */
  const uncaughtStderr = (message: string, errorName = 'Error') =>
    [
      'file:///repo/src-server/__test-utils__/orchestration-transfer-scenario.ts:133',
      '    throw new Error(`orchestration transfer scenario: ${message}`);',
      '          ^',
      '',
      `${errorName}: ${message}`,
      '    at fail (file:///repo/src-server/__test-utils__/orchestration-transfer-scenario.ts:133:11)',
    ].join('\n');

  test('a slow scenario barrier is reported through the gate with the remedy', async () => {
    const run = await startMeasurement({
      refusal: false,
      holdLiveOpenMs: 0,
      stallAttempts: true,
      nativeBarrierTimeoutMs: 1,
    });
    const failure = await run.nativeMeasurementPromise.catch((error) => error);
    expect(String(failure.message)).toMatch(/barrier timed out after 1ms/);
    const line = gateFailLine(uncaughtStderr(failure.message));
    expect(line).toContain(
      'STATION_TRANSFER_CAPTURE_TIMEOUT_MS=<milliseconds>',
    );
    expect(line).toMatch(/barrier timed out after 1ms/);
  }, 60_000);

  test('a trailing activity frame that never arrives is reported as a possible regression, not load', async () => {
    const run = await startMeasurement({
      refusal: false,
      holdLiveOpenMs: 0,
      hideActivityFrames: true,
      nativeBarrierTimeoutMs: 600,
    });
    const failure = await run.nativeMeasurementPromise.catch((error) => error);
    expect(String(failure.message)).toContain(
      'saw 0 activity frames, expected 1',
    );
    const line = gateFailLine(uncaughtStderr(failure.message));
    expect(line).toContain('may be a regression in the route');
    expect(line).not.toContain('raise it for this run');
  }, 60_000);

  test('a live phase that is not one heavy turn fails with frames, activity frames and identities', async () => {
    const run = await startMeasurement({
      refusal: false,
      holdLiveOpenMs: 0,
      nativeHeavyLiveFrameCount: 43,
    });
    const failure = await run.nativeMeasurementPromise.catch((error) => error);
    expect(String(failure.message)).toContain(
      'live phase did not contain one heavy turn: frames 44 != 43, activityFrames 1',
    );
    expect(failure.diagnostic).toMatchObject({
      kind: 'station-transfer-failure',
      activityFrames: 1,
      expectedFrames: 43,
      truncated: false,
      eventIdentities: expect.arrayContaining([
        expect.objectContaining({ event: 'orchestration:activity' }),
      ]),
    });
    // Node names an Error subclass in its uncaught output; take the line from
    // Node's own formatting rather than restating it.
    const printed = inspect(failure).split('\n')[0]!;
    expect(printed).toMatch(/^TransferMeasurementFailure \[Error\]: /);
    const line = gateFailLine(
      uncaughtStderr(
        printed.replace(/^[^:]+: /, ''),
        printed.slice(0, printed.indexOf(': ')),
      ),
    );
    expect(line).toContain('frames 44 != 43, activityFrames 1');
  }, 60_000);
});
