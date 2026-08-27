/**
 * Console bridge service tests (S4 item 1).
 *
 * The hub-sink tests run against the REAL Console hub from the published
 * @kontourai/console tarball (`createConsoleHubServer`), in-process on an
 * ephemeral port — POST /records and GET /state are the genuine contract,
 * including hub-side id deduplication (the idempotent re-emission proof).
 */

import * as fs from 'node:fs';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import * as bridgeMetrics from '../../../telemetry/metrics.js';
import { EventBus } from '../../orchestration/event-bus.js';
import { EventStore } from '../../orchestration/event-store.js';
import {
  ConsoleBridgeService,
  resolveConsoleBridgeConfig,
} from '../console-bridge-service.js';

vi.mock('../../../telemetry/metrics.js', () => ({
  consoleEmissions: { add: vi.fn() },
  orchestrationEventsPersisted: { add: vi.fn() },
  orchestrationEventPersistDuration: { record: vi.fn() },
  orchestrationCoalesceRatio: { record: vi.fn() },
}));

const require = createRequire(import.meta.url);
const { createConsoleHubServer } =
  require('@kontourai/console/console-server/dist/src/console-foundation/console-hub-server.js') as {
    createConsoleHubServer: (options?: Record<string, unknown>) => {
      server: import('node:http').Server;
      listen(
        options?: { host?: string; port?: number },
        callback?: () => void,
      ): import('node:http').Server;
      close(callback?: (error?: Error) => void): import('node:http').Server;
    };
  };

const THREAD = 'thread-bridge-1';

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function emitThroughStore(
  store: EventStore,
  bus: EventBus,
  event: CanonicalRuntimeEvent,
): void {
  store.appendEvent(event);
  bus.emit('orchestration:event', { event });
}

/**
 * `threadId` defaults to `THREAD` so every pre-existing call site (which
 * passes only `workspace`) is byte-identical to before, aside from the
 * `evt-N` -> `evt-N-<threadId>` eventId suffix (unasserted anywhere) needed
 * so two threads' events can coexist in the same store for the multi-thread
 * coalescing tests below (`id` is a globally unique key in `EventStore`).
 */
function gatedSessionEvents(
  workspace: string,
  threadId: string = THREAD,
): CanonicalRuntimeEvent[] {
  const base = { provider: 'claude' as const, threadId };
  const runId = `session-${threadId}`;
  return [
    {
      ...base,
      eventId: `evt-1-${threadId}`,
      createdAt: '2026-06-12T10:00:00.000Z',
      method: 'session.started',
      sessionId: threadId,
    },
    {
      ...base,
      eventId: `evt-2-${threadId}`,
      createdAt: '2026-06-12T10:00:01.000Z',
      method: 'flow.run-attached',
      runId,
      definitionId: 'station-delivery',
      cwd: workspace,
      resumed: false,
    },
    {
      ...base,
      eventId: `evt-3-${threadId}`,
      createdAt: '2026-06-12T10:10:00.000Z',
      method: 'flow.gate-verdict',
      runId,
      verdict: 'pass',
      gateId: 'implement-gate',
    },
    {
      ...base,
      eventId: `evt-4-${threadId}`,
      createdAt: '2026-06-12T10:20:00.000Z',
      method: 'session.state-changed',
      sessionId: threadId,
      from: 'review_pending',
      to: 'completed',
    },
  ];
}

describe('ConsoleBridgeService', () => {
  let dir: string;
  let store: EventStore;
  let bus: EventBus;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'console-bridge-'));
    store = new EventStore(join(dir, 'orchestration.sqlite'));
    bus = new EventBus();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('disabled by default: empty env -> no subscription, no delivery, no files', async () => {
    const fetchSpy = vi.fn();
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger: makeLogger(),
      config: resolveConsoleBridgeConfig({}),
      fetchImpl: fetchSpy as unknown as typeof fetch,
      flushDelayMs: 0,
    });
    expect(service.enabled).toBe(false);
    service.start();
    for (const event of gatedSessionEvents(dir)) {
      emitThroughStore(store, bus, event);
    }
    await service.flushNow();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '.kontourai', 'console'))).toBe(false);
    await service.stop();
  });

  test('delivers a gated session to a REAL hub; GET /state shows process and gate; re-emission is idempotent', async () => {
    const kontourRoot = join(dir, 'hub-root');
    const app = createConsoleHubServer({ serveUi: false, kontourRoot });
    await new Promise<void>((resolve) => {
      app.listen({ host: '127.0.0.1', port: 0 }, resolve);
    });
    const hubUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    try {
      const service = new ConsoleBridgeService({
        eventBus: bus,
        eventStore: store,
        logger: makeLogger(),
        config: resolveConsoleBridgeConfig({
          STATION_CONSOLE_HUB_URL: hubUrl,
        }),
        flushDelayMs: 0,
      });
      expect(service.enabled).toBe(true);
      service.start();
      for (const event of gatedSessionEvents(dir)) {
        emitThroughStore(store, bus, event);
      }
      await service.flushNow();

      const state = (await (await fetch(`${hubUrl}/state`)).json()) as {
        processes: Array<Record<string, unknown>>;
        gates: Array<Record<string, unknown>>;
        source: { acceptedEventCount: number; duplicateEventCount: number };
      };
      expect(state.processes).toEqual([
        expect.objectContaining({
          id: 'station-session-thread-bridge-1',
          status: 'completed',
        }),
      ]);
      expect(state.gates).toEqual([
        expect.objectContaining({
          id: 'gate-session-thread-bridge-1-implement-gate',
          status: 'passed',
        }),
      ]);
      const accepted = state.source.acceptedEventCount;
      expect(accepted).toBe(4);

      // Idempotent re-emission: a FRESH service instance (no sent-id memory)
      // re-derives and re-posts the same deterministic records; the hub
      // deduplicates by id, so projection state does not change.
      const replay = new ConsoleBridgeService({
        eventBus: bus,
        eventStore: store,
        logger: makeLogger(),
        config: resolveConsoleBridgeConfig({
          STATION_CONSOLE_HUB_URL: hubUrl,
        }),
        flushDelayMs: 0,
      });
      replay.start();
      replay.enqueueThread(THREAD);
      await replay.flushNow();

      const replayed = (await (await fetch(`${hubUrl}/state`)).json()) as {
        processes: Array<Record<string, unknown>>;
        source: { acceptedEventCount: number; duplicateEventCount: number };
      };
      expect(replayed.source.acceptedEventCount).toBe(accepted);
      // Delivery progress is durable, so a fresh bridge does not POST an
      // already accepted page solely to rely on downstream deduplication.
      expect(replayed.source.duplicateEventCount).toBe(0);
      expect(replayed.processes).toEqual(state.processes);

      await service.stop();
      await replay.stop();
    } finally {
      await new Promise<void>((resolve) => {
        app.close(() => resolve());
      });
    }
  });

  test('fail-soft: unreachable hub warns once, never throws, and keeps the bus subscription alive', async () => {
    const logger = makeLogger();
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger,
      config: resolveConsoleBridgeConfig({
        // Closed port: connection refused.
        STATION_CONSOLE_HUB_URL: 'http://127.0.0.1:1',
      }),
      flushDelayMs: 0,
    });
    service.start();
    const events = gatedSessionEvents(dir);
    emitThroughStore(store, bus, events[0]);
    await service.flushNow();
    emitThroughStore(store, bus, events[1]);
    await service.flushNow();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    // Listener was not dropped by the bus (a throwing listener would be).
    const listener = vi.fn();
    bus.subscribe(listener);
    emitThroughStore(store, bus, events[2]);
    expect(listener).toHaveBeenCalled();
    await service.flushNow();
    await service.stop();
  });

  test('file sink writes workspace .kontourai/console JSONL plus a resource-shaped export manifest, idempotently', async () => {
    const workspace = join(dir, 'workspace');
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger: makeLogger(),
      config: resolveConsoleBridgeConfig({
        STATION_CONSOLE_FILE_SINK: '1',
      }),
      flushDelayMs: 0,
    });
    service.start();
    for (const event of gatedSessionEvents(workspace)) {
      emitThroughStore(store, bus, event);
    }
    await service.flushNow();

    const streamPath = join(
      workspace,
      '.kontourai',
      'console',
      'events',
      'station-bridge',
      'project',
      'station-local',
      THREAD,
      '1-4.jsonl',
    );
    const lines = readFileSync(streamPath, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(4);
    for (const line of lines) {
      const record = JSON.parse(line) as Record<string, unknown>;
      expect(record.schema).toBe('kontour.console.event');
    }

    // Re-flush does not duplicate lines (idempotent re-emission).
    service.enqueueThread(THREAD);
    await service.flushNow();
    expect(readFileSync(streamPath, 'utf8').trim().split('\n')).toHaveLength(4);

    // Kontour resource envelope (S4 item 3).
    const manifest = JSON.parse(
      readFileSync(
        join(
          workspace,
          '.kontourai',
          'console',
          'resources',
          'station',
          'session-export-thread-bridge-1.json',
        ),
        'utf8',
      ),
    ) as Record<string, any>;
    expect(manifest.apiVersion).toBe('station.kontourai.io/v1alpha1');
    expect(manifest.kind).toBe('SessionEventExport');
    expect(manifest.metadata.name).toBe('session-export-thread-bridge-1');
    expect(manifest.spec.segments).toEqual([
      expect.objectContaining({
        path: posix.join(
          'events',
          'station-bridge',
          'project',
          'station-local',
          THREAD,
          '1-4.jsonl',
        ),
        recordCount: 4,
      }),
    ]);
    expect(manifest.spec.segments[0].path).toBe(
      posix.join(
        'events',
        'station-bridge',
        'project',
        'station-local',
        THREAD,
        '1-4.jsonl',
      ),
    );
    expect(manifest.status.recordCount).toBe(4);
    expect(manifest.status.sessionStatus).toBe('completed');
    await service.stop();
  });

  test('keeps progress at zero after a manifest write failure and retries the same atomic segment without duplicate records', async () => {
    const workspace = join(dir, 'workspace-manifest-retry');
    let interruptManifestRename = true;
    const logger = makeLogger();
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger,
      config: resolveConsoleBridgeConfig({ STATION_CONSOLE_FILE_SINK: '1' }),
      flushDelayMs: 0,
      fileSystem: {
        existsSync: fs.existsSync,
        mkdirSync: fs.mkdirSync,
        readFileSync: fs.readFileSync,
        renameSync: (source, destination) => {
          if (
            interruptManifestRename &&
            dirname(String(destination)).endsWith(join('resources', 'station'))
          ) {
            throw new Error('injected manifest rename interruption');
          }
          fs.renameSync(source, destination);
        },
        unlinkSync: fs.unlinkSync,
        writeFileSync: fs.writeFileSync,
      },
    });
    service.start();
    for (const event of gatedSessionEvents(workspace)) {
      emitThroughStore(store, bus, event);
    }
    await service.flushNow();

    expect(logger.warn).toHaveBeenCalledWith(
      'Console bridge file sink failed',
      expect.objectContaining({
        error: expect.stringContaining('injected manifest rename interruption'),
      }),
    );

    const scopeId = 'project:station-local';
    const segmentPath = join(
      workspace,
      '.kontourai',
      'console',
      'events',
      'station-bridge',
      'project',
      'station-local',
      THREAD,
      '1-4.jsonl',
    );
    expect(store.readConsoleDeliveryProgress(THREAD, scopeId)).toBe(0);
    expect(readFileSync(segmentPath, 'utf8').trim().split('\n')).toHaveLength(
      4,
    );

    interruptManifestRename = false;
    service.enqueueThread(THREAD);
    await service.flushNow();

    expect(store.readConsoleDeliveryProgress(THREAD, scopeId)).toBe(4);
    expect(readFileSync(segmentPath, 'utf8').trim().split('\n')).toHaveLength(
      4,
    );
    const manifest = JSON.parse(
      readFileSync(
        join(
          workspace,
          '.kontourai',
          'console',
          'resources',
          'station',
          'session-export-thread-bridge-1.json',
        ),
        'utf8',
      ),
    ) as { status: { recordCount: number } };
    expect(manifest.status.recordCount).toBe(4);
    await service.stop();
  });

  test('fails loudly on structurally corrupt segment metadata rather than writing a plausible manifest', () => {
    const workspace = join(dir, 'workspace-corrupt-manifest');
    const root = join(workspace, '.kontourai', 'console');
    const manifestPath = join(
      root,
      'resources',
      'station',
      'session-export-thread-bridge-1.json',
    );
    fs.mkdirSync(join(root, 'resources', 'station'), { recursive: true });
    writeFileSync(
      manifestPath,
      JSON.stringify({
        spec: {
          segments: [
            {
              path: '../outside.jsonl',
              firstSequence: 1,
              lastSequence: 1,
              sourceEventCount: 1,
              recordCount: 1,
              lastRecordId: 'record-1',
            },
          ],
        },
        status: { lastRecordId: 'record-1', lastSequence: 1 },
      }),
      'utf8',
    );
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger: makeLogger(),
      config: resolveConsoleBridgeConfig({ STATION_CONSOLE_FILE_SINK: '1' }),
      flushDelayMs: 0,
    });
    expect(() =>
      (service as any).writeExportManifest(THREAD, root, [], {
        path: 'events/station-bridge/project/station-local/thread-bridge-1/2-2.jsonl',
        firstSequence: 2,
        lastSequence: 2,
        sourceEventCount: 1,
        recordCount: 1,
        lastRecordId: 'record-2',
      }),
    ).toThrow('Console export manifest is unreadable');
  });

  test('rejects every malformed manifest segment and status invariant', () => {
    const workspace = join(dir, 'workspace-manifest-invariants');
    const root = join(workspace, '.kontourai', 'console');
    const manifestPath = join(
      root,
      'resources',
      'station',
      'session-export-thread-bridge-1.json',
    );
    fs.mkdirSync(join(root, 'resources', 'station'), { recursive: true });
    const valid = {
      spec: {
        segments: [
          {
            path: 'events/station-bridge/project/station-local/thread-bridge-1/1-1.jsonl',
            firstSequence: 1,
            lastSequence: 1,
            sourceEventCount: 1,
            recordCount: 1,
            lastRecordId: 'record-1',
          },
        ],
      },
      status: {
        recordCount: 1,
        sessionStatus: 'completed',
        lastRecordId: 'record-1',
        lastSequence: 1,
      },
    };
    const mutate = [
      (value: any) => (value.spec.segments = []),
      (value: any) => (value.spec.segments[0].path = ''),
      (value: any) => (value.spec.segments[0].path = '/absolute.jsonl'),
      (value: any) => (value.spec.segments[0].path = '../traversal.jsonl'),
      (value: any) => (value.spec.segments[0].path = 'segment\\windows.jsonl'),
      (value: any) =>
        (value.spec.segments[0].path = 'C:/drive-qualified.jsonl'),
      (value: any) => (value.spec.segments[0].recordCount = -1),
      (value: any) => {
        value.spec.segments[0].firstSequence = 2;
        value.spec.segments[0].lastSequence = 1;
      },
      (value: any) => (value.spec.segments[0].sourceEventCount = 2),
      (value: any) =>
        value.spec.segments.push({
          ...value.spec.segments[0],
          path: 'events/station-bridge/project/station-local/thread-bridge-1/1-2.jsonl',
          lastSequence: 2,
          lastRecordId: 'record-2',
        }),
      (value: any) => value.spec.segments.push({ ...value.spec.segments[0] }),
      (value: any) => (value.status.recordCount = 2),
      (value: any) => (value.status.sessionStatus = 'invented'),
      (value: any) => (value.status.lastRecordId = 'wrong-final-record'),
      (value: any) => (value.status.lastSequence = 2),
      (value: any) => delete value.status.sessionStatus,
      (value: any) => delete value.status.lastRecordId,
    ];
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger: makeLogger(),
      config: resolveConsoleBridgeConfig({ STATION_CONSOLE_FILE_SINK: '1' }),
      flushDelayMs: 0,
    });

    for (const apply of mutate) {
      const corrupted = structuredClone(valid);
      apply(corrupted);
      writeFileSync(manifestPath, JSON.stringify(corrupted), 'utf8');
      expect(() =>
        (service as any).writeExportManifest(THREAD, root, [], {
          path: 'events/station-bridge/project/station-local/thread-bridge-1/2-2.jsonl',
          firstSequence: 2,
          lastSequence: 2,
          sourceEventCount: 1,
          recordCount: 1,
          lastRecordId: 'record-2',
        }),
      ).toThrow('Console export manifest is unreadable');
    }
  });

  // ── station#1093 Part B: KeyedCoalescingWorker integration ──

  test('AC1: a burst of N raw events for one thread coalesces into exactly one downstream read-model refetch', async () => {
    const fetchSpy = vi.fn(
      async () => new Response(null, { status: 200 }),
    ) as unknown as typeof fetch;
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger: makeLogger(),
      config: resolveConsoleBridgeConfig({
        STATION_CONSOLE_HUB_URL: 'http://hub.invalid',
      }),
      fetchImpl: fetchSpy,
      flushDelayMs: 0,
    });
    service.start();

    const listEventsSpy = vi.spyOn(store, 'listEventsByMethodsAfterSequence');
    const base = gatedSessionEvents(dir);
    // 4 canonical events plus 6 more bursty state-change events — 10 raw
    // events total for the one thread, emitted synchronously (no `await`
    // between them, matching a real streaming-turn burst through the same
    // EventBus the SSE route's own subscriber uses).
    const burst: CanonicalRuntimeEvent[] = [
      ...base,
      ...Array.from({ length: 6 }, (_, i) => ({
        ...base[3],
        eventId: `evt-burst-${i}`,
        createdAt: `2026-06-12T10:30:0${i}.000Z`,
      })),
    ];
    // A transcript delta is persisted but irrelevant to Console records.
    // The bridge must not materialize it merely because it shares a thread.
    store.appendEvent({
      provider: 'claude',
      threadId: THREAD,
      eventId: 'evt-transcript-only',
      createdAt: '2026-06-12T10:15:00.000Z',
      method: 'content.text-delta',
      itemId: 'item-transcript-only',
      delta: 'not-a-console-record',
    });
    for (const event of burst) {
      emitThroughStore(store, bus, event);
    }
    // Nothing dispatches synchronously — coalescing defers to a microtask.
    expect(listEventsSpy).not.toHaveBeenCalled();

    await service.flushNow();

    // 10 raw events -> exactly one thread-scoped method-targeted query (the
    // "downstream expensive operation" R2/AC1 name), not 10.
    expect(listEventsSpy).toHaveBeenCalledTimes(1);
    expect(listEventsSpy).toHaveBeenCalledWith(
      THREAD,
      expect.arrayContaining(['session.started', 'flow.run-attached']),
      0,
    );
    expect(listEventsSpy.mock.results[0]?.value).toHaveLength(burst.length);

    // Observability: the coalesce-ratio instrument recorded the full burst
    // size against this one dispatch.
    expect(
      bridgeMetrics.orchestrationCoalesceRatio.record,
    ).toHaveBeenCalledWith(burst.length, { consumer: 'console_bridge' });

    await service.stop();
  });

  test('AC3: a flush already in flight cannot be overtaken by, and never loses, an event that lands while it runs', async () => {
    const releases: Array<() => void> = [];
    const fetchSpy = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          releases.push(() => resolve(new Response(null, { status: 200 })));
        }),
    ) as unknown as typeof fetch;
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger: makeLogger(),
      config: resolveConsoleBridgeConfig({
        STATION_CONSOLE_HUB_URL: 'http://hub.invalid',
      }),
      fetchImpl: fetchSpy,
      flushDelayMs: 0,
    });
    service.start();

    const listEventsSpy = vi.spyOn(store, 'listEventsByMethodsAfterSequence');
    const events = gatedSessionEvents(dir);

    emitThroughStore(store, bus, events[0]); // session.started
    const firstFlush = service.flushNow();

    // Let the first dispatch start and reach its in-flight fetch — it has
    // already read the thread's history by this point.
    await Promise.resolve();
    await Promise.resolve();
    expect(listEventsSpy).toHaveBeenCalledTimes(1);
    expect(listEventsSpy.mock.results[0]?.value).toHaveLength(1);

    // A second canonical event lands for the SAME thread while the first
    // flush is still in flight (mirrors a burst continuing while the
    // downstream op it triggered hasn't settled yet).
    emitThroughStore(store, bus, events[1]); // flow.run-attached

    let firstResolved = false;
    void firstFlush.then(() => {
      firstResolved = true;
    });
    await Promise.resolve();
    expect(firstResolved).toBe(false);

    releases[0]();
    await firstFlush;
    expect(firstResolved).toBe(true);
    // The dispatch already in flight when the second event landed never saw
    // it — proven above, its incremental result had length 1 while the
    // second event didn't exist in the store yet. It could not overtake.

    // The second event is never lost: the worker auto-drains the pending
    // key into its own follow-up dispatch as soon as the first completes,
    // and that dispatch reads only the next record — no caller action
    // required, and ordering (dispatch 1 strictly before dispatch 2) holds.
    expect(listEventsSpy).toHaveBeenCalledTimes(2);
    expect(listEventsSpy.mock.results[1]?.value).toHaveLength(1);

    releases[1]?.();
    await service.flushNow();
    expect(listEventsSpy).toHaveBeenCalledTimes(2);

    await service.stop();
  });

  test('uses the latest cwd-bearing session.configured event as bounded Codex file-sink context', async () => {
    const workspace = join(dir, 'codex-workspace');
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger: makeLogger(),
      config: resolveConsoleBridgeConfig({ STATION_CONSOLE_FILE_SINK: '1' }),
      flushDelayMs: 0,
    });
    service.start();

    // Codex supplies the workspace on a non-bridged configuration event.
    // The bridge must fetch just this newest dependency, rather than replaying
    // the thread's complete history to discover a path for every flush.
    store.appendEvent({
      eventId: 'codex-configured',
      provider: 'codex',
      threadId: THREAD,
      createdAt: '2026-06-12T09:59:00.000Z',
      method: 'session.configured',
      sessionId: THREAD,
      cwd: workspace,
    } as never);
    emitThroughStore(store, bus, {
      eventId: 'codex-started',
      provider: 'codex',
      threadId: THREAD,
      createdAt: '2026-06-12T10:00:00.000Z',
      method: 'session.started',
      sessionId: THREAD,
    });

    const cwdSpy = vi.spyOn(store, 'latestCwdConfiguredEvent');
    await service.flushNow();

    expect(cwdSpy).toHaveBeenCalledWith(THREAD);
    expect(
      existsSync(
        join(
          workspace,
          '.kontourai',
          'console',
          'events',
          'station-bridge',
          'project',
          'station-local',
          THREAD,
          '1-2.jsonl',
        ),
      ),
    ).toBe(true);
    await service.stop();
  });

  test('AC4: interleaved events across two threads coalesce independently, with no cross-thread contamination', async () => {
    const THREAD_A = 'thread-bridge-ac4-a';
    const THREAD_B = 'thread-bridge-ac4-b';
    const workspaceA = join(dir, 'workspace-a');
    const workspaceB = join(dir, 'workspace-b');
    const service = new ConsoleBridgeService({
      eventBus: bus,
      eventStore: store,
      logger: makeLogger(),
      config: resolveConsoleBridgeConfig({
        STATION_CONSOLE_FILE_SINK: '1',
      }),
      flushDelayMs: 0,
    });
    service.start();

    const listEventsSpy = vi.spyOn(store, 'listEventsByMethodsAfterSequence');
    const a = gatedSessionEvents(workspaceA, THREAD_A);
    const b = gatedSessionEvents(workspaceB, THREAD_B);

    // Fully interleaved raw event order: A0,B0,A1,B1,... — proves
    // cross-thread ordering on the shared EventBus has no bearing on either
    // thread's own coalesced flush or derived state.
    for (let i = 0; i < a.length; i++) {
      emitThroughStore(store, bus, a[i]);
      emitThroughStore(store, bus, b[i]);
    }

    await service.flushNow();

    // Exactly one thread-scoped refetch per thread — never merged across
    // threads, never repeated per raw event.
    const callsForA = listEventsSpy.mock.calls.filter(
      ([id]) => id === THREAD_A,
    );
    const callsForB = listEventsSpy.mock.calls.filter(
      ([id]) => id === THREAD_B,
    );
    expect(callsForA).toHaveLength(1);
    expect(callsForB).toHaveLength(1);

    const manifestFor = (workspace: string, threadId: string) =>
      JSON.parse(
        readFileSync(
          join(
            workspace,
            '.kontourai',
            'console',
            'resources',
            'station',
            `session-export-${threadId}.json`,
          ),
          'utf8',
        ),
      ) as Record<string, any>;

    const manifestA = manifestFor(workspaceA, THREAD_A);
    const manifestB = manifestFor(workspaceB, THREAD_B);
    expect(manifestA.metadata.labels['station.kontourai.io/thread']).toBe(
      THREAD_A,
    );
    expect(manifestB.metadata.labels['station.kontourai.io/thread']).toBe(
      THREAD_B,
    );
    expect(manifestA.status.recordCount).toBe(4);
    expect(manifestB.status.recordCount).toBe(4);
    expect(manifestA.status.sessionStatus).toBe('completed');
    expect(manifestB.status.sessionStatus).toBe('completed');

    // Each thread has a deterministic page segment. Concurrent workers never
    // append to a shared stream, and every segment remains independently
    // parseable for retry/reconciliation.
    const streamPathFor = (workspace: string) =>
      join(
        workspace,
        '.kontourai',
        'console',
        'events',
        'station-bridge',
        'project',
        'station-local',
      );
    const linesA = readFileSync(
      join(streamPathFor(workspaceA), THREAD_A, '1-4.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n');
    const linesB = readFileSync(
      join(streamPathFor(workspaceB), THREAD_B, '1-4.jsonl'),
      'utf8',
    )
      .trim()
      .split('\n');
    expect(linesA).toHaveLength(4);
    expect(linesB).toHaveLength(4);
    for (const line of [...linesA, ...linesB]) {
      expect(() => JSON.parse(line)).not.toThrow();
    }

    await service.stop();
  });

  // ── Fix round (review CRITICAL/HIGH/MEDIUM findings on the above) ──

  test('MEDIUM: with the production windowMs=200 real-timer branch, a burst still coalesces into exactly one dispatch after the window elapses', async () => {
    vi.useFakeTimers();
    try {
      const service = new ConsoleBridgeService({
        eventBus: bus,
        eventStore: store,
        logger: makeLogger(),
        config: resolveConsoleBridgeConfig({
          STATION_CONSOLE_FILE_SINK: '1',
        }),
        flushDelayMs: 200,
      });
      service.start();

      const listEventsSpy = vi.spyOn(store, 'listEventsByMethodsAfterSequence');
      const workspace = join(dir, 'workspace-windowms');
      for (const event of gatedSessionEvents(workspace)) {
        emitThroughStore(store, bus, event);
      }

      // Nothing dispatches before the window elapses — every other test in
      // this file uses `flushDelayMs: 0` (the microtask branch); this is
      // the real `setTimeout` branch production actually runs.
      await vi.advanceTimersByTimeAsync(199);
      expect(listEventsSpy).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(listEventsSpy).toHaveBeenCalledTimes(1);
      expect(listEventsSpy).toHaveBeenCalledWith(THREAD, expect.any(Array), 0);

      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('CRITICAL regression: a failed hub delivery does not self-arm a retry loop — dispatch count stays flat with no further real traffic', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(
        async () => new Response(null, { status: 503 }),
      ) as unknown as typeof fetch;
      const service = new ConsoleBridgeService({
        eventBus: bus,
        eventStore: store,
        logger: makeLogger(),
        config: resolveConsoleBridgeConfig({
          STATION_CONSOLE_HUB_URL: 'http://hub.invalid',
        }),
        fetchImpl: fetchSpy,
        flushDelayMs: 200, // the real-timer branch the bug lived in
      });
      service.start();

      const listEventsSpy = vi.spyOn(store, 'listEventsByMethodsAfterSequence');
      emitThroughStore(store, bus, gatedSessionEvents(dir)[0]);

      // Let the batch window elapse and the (failing) dispatch complete.
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(listEventsSpy).toHaveBeenCalledTimes(1);

      // No new traffic for a long stretch — with the CRITICAL bug (the
      // handler self-re-enqueuing on failure), this would have kept
      // re-arming a 200ms timer and re-dispatching indefinitely. It must
      // not: the count stays flat.
      await vi.advanceTimersByTimeAsync(200 * 20);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(listEventsSpy).toHaveBeenCalledTimes(1);

      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  test('CRITICAL regression: stop() terminates the loop — no dispatch fires again afterward even as time passes', async () => {
    vi.useFakeTimers();
    try {
      const fetchSpy = vi.fn(
        async () => new Response(null, { status: 503 }),
      ) as unknown as typeof fetch;
      const service = new ConsoleBridgeService({
        eventBus: bus,
        eventStore: store,
        logger: makeLogger(),
        config: resolveConsoleBridgeConfig({
          STATION_CONSOLE_HUB_URL: 'http://hub.invalid',
        }),
        fetchImpl: fetchSpy,
        flushDelayMs: 200,
      });
      service.start();

      const listEventsSpy = vi.spyOn(store, 'listEventsByMethodsAfterSequence');
      emitThroughStore(store, bus, gatedSessionEvents(dir)[0]);
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // stop() must resolve promptly (it is not waiting out a runaway
      // retry loop) and dispose the worker so nothing outlives it.
      await service.stop();

      await vi.advanceTimersByTimeAsync(200 * 20);
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(listEventsSpy).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('CRITICAL regression: the next real canonical event after a failure redelivers the previously failed record (fail-soft recovery preserved)', async () => {
    vi.useFakeTimers();
    try {
      let hubUp = false;
      const fetchMock = vi.fn(async () =>
        hubUp
          ? new Response(null, { status: 200 })
          : new Response(null, { status: 503 }),
      );
      const service = new ConsoleBridgeService({
        eventBus: bus,
        eventStore: store,
        logger: makeLogger(),
        config: resolveConsoleBridgeConfig({
          STATION_CONSOLE_HUB_URL: 'http://hub.invalid',
        }),
        fetchImpl: fetchMock as unknown as typeof fetch,
        flushDelayMs: 200,
      });
      service.start();

      const events = gatedSessionEvents(dir);
      emitThroughStore(store, bus, events[0]); // session.started
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchMock).toHaveBeenCalledTimes(1); // failed attempt

      // Self-throttled: no new traffic, no further attempts for a while.
      await vi.advanceTimersByTimeAsync(200 * 5);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The hub recovers and a NEW real canonical event lands for the same
      // thread — this is the only thing allowed to trigger a retry.
      hubUp = true;
      emitThroughStore(store, bus, events[1]); // flow.run-attached
      await vi.advanceTimersByTimeAsync(200);

      // Redelivery happened: the previously-failed record (never added to
      // `hubSent`) is retried alongside anything new, proving fail-soft
      // recovery still works once real traffic resumes.
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);

      await service.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});
