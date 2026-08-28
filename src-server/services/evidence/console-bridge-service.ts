/**
 * Console bridge service (roadmap S4 item 1).
 *
 * Subscribes where canonical runtime events already flow — the
 * `orchestration:event` EventBus channel fed by OrchestrationService and the
 * platform-mutation gate — re-derives a thread's Console records from the
 * event store (the event-sourced state is the source of truth), and delivers
 * the not-yet-sent ones to up to two sinks:
 *
 * - a local file sink:
 *   `.kontourai/console/events/station-bridge/<scope>.jsonl` in the session's
 *   project workspace (byte-layout-compatible with the Console emitter's
 *   `LocalFileSink`), plus a Kontour resource-shaped export manifest under
 *   `.kontourai/console/resources/station/` (S4 item 3);
 * - the Console hub: `POST /records` against `kontour serve`.
 *
 * Both sinks are OFF by default (zero-config-change behavior) and enabled by
 * env, following the OTel house pattern (`OTEL_EXPORTER_OTLP_ENDPOINT`):
 *
 * - `STATION_CONSOLE_HUB_URL`   — e.g. `http://127.0.0.1:3737` (hub sink)
 * - `STATION_CONSOLE_FILE_SINK` — `1`/`true` (workspace file sink)
 * - `STATION_CONSOLE_SCOPE`    — optional scope id (default `station-local`)
 *
 * Fail-soft: a Console hub being down must never affect sessions. Delivery
 * errors are recorded on the `station.console.emissions` counter and warned
 * about once per outage (latched until a delivery succeeds again); the
 * subscriber never throws into the EventBus (which drops throwing listeners).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { SERVER_EVENTS } from '@kontourai/station-contracts/runtime-events';
import {
  consoleEmissions,
  orchestrationCoalesceRatio,
} from '../../telemetry/metrics.js';
import { KeyedCoalescingWorker } from '../infra/keyed-coalescing-worker.js';
import type { EventBus, ServerEvent } from '../orchestration/event-bus.js';
import type { EventStore } from '../orchestration/event-store.js';
import {
  CONSOLE_BRIDGE_PRODUCER,
  CONSOLE_BRIDGED_METHODS,
  type ConsoleBridgeScope,
  type ConsoleEventRecord,
  DEFAULT_CONSOLE_SCOPE,
  deriveConsoleEventRecords,
  resolveThreadWorkspace,
  sanitizeConsoleToken,
} from './console-bridge.js';
import { consoleArtifactRoot } from './local-artifact-paths.js';

/** OTel `consumer` attribute recorded on the coalesce-ratio/burst-size instruments (archive#1093 Part B). */
const COALESCE_CONSUMER = 'console_bridge';

/**
 * Max concurrent per-thread flushes (archive#1093 Part B / issue's "bounded
 * refetch concurrency (~8)"). Each flush does its own thread-scoped
 * targeted EventStore refetch plus (optionally) a sequence
 * of hub POSTs, so bounding concurrency caps how many of those can run at
 * once across a burst that dirties many threads simultaneously. Different
 * threads' flushes touch disjoint state (per-thread event history, per-scope
 * append-only file writes that are synchronous and therefore never
 * interleave mid-write — see `deliverToFileSink`), so concurrent dispatch
 * across threads is safe; a single thread's own flushes are still always
 * serialized by `KeyedCoalescingWorker`'s per-key guarantee.
 */
const DEFAULT_FLUSH_CONCURRENCY = 8;

export interface ConsoleBridgeConfig {
  /** Console hub base URL; enables the `POST /records` sink. */
  hubUrl?: string;
  /** Enables the workspace `.kontourai/console/events/**` JSONL sink. */
  fileSink: boolean;
  scope: ConsoleBridgeScope;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function resolveConsoleBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): ConsoleBridgeConfig {
  const hubUrl = env.STATION_CONSOLE_HUB_URL?.trim();
  const fileSink = TRUTHY.has(
    (env.STATION_CONSOLE_FILE_SINK ?? '').trim().toLowerCase(),
  );
  const scopeId = env.STATION_CONSOLE_SCOPE?.trim();
  return {
    hubUrl: hubUrl ? hubUrl.replace(/\/+$/, '') : undefined,
    fileSink,
    scope: scopeId
      ? { kind: 'project', id: scopeId, label: `Station sessions (${scopeId})` }
      : DEFAULT_CONSOLE_SCOPE,
  };
}

interface ConsoleBridgeLogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ConsoleBridgeServiceOptions {
  eventBus: EventBus;
  eventStore: EventStore;
  logger: ConsoleBridgeLogger;
  /** Defaults to `resolveConsoleBridgeConfig(process.env)`. */
  config?: ConsoleBridgeConfig;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Flush debounce in ms (batches bursts of canonical events). */
  flushDelayMs?: number;
  /** Max concurrent per-thread flushes; defaults to {@link DEFAULT_FLUSH_CONCURRENCY}. Injectable for tests. */
  flushConcurrency?: number;
  /** Injectable only for deterministic durability-failure tests. */
  fileSystem?: ConsoleBridgeFileSystem;
}

const STATION_RESOURCE_API_VERSION = 'station.kontourai.io/v1alpha1';
const CONSOLE_SESSION_STATUSES = new Set([
  'unknown',
  'running',
  'completed',
  'blocked',
]);

export interface ConsoleBridgeFileSystem {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): void;
  readFileSync(path: string, encoding: 'utf8'): string;
  renameSync(source: string, destination: string): void;
  unlinkSync(path: string): void;
  writeFileSync(path: string, data: string, encoding: 'utf8'): void;
}

const NODE_FILE_SYSTEM: ConsoleBridgeFileSystem = {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
};

interface ConsoleExportSegment {
  path: string;
  firstSequence: number;
  lastSequence: number;
  /** Number of source events in this bounded page, not the numeric range. */
  sourceEventCount: number;
  recordCount: number;
  lastRecordId: string;
}

function validateExportSegment(segment: unknown): ConsoleExportSegment {
  if (!segment || typeof segment !== 'object') {
    throw new Error('Console export manifest has invalid segment metadata');
  }
  const value = segment as Partial<ConsoleExportSegment>;
  const firstSequence = value.firstSequence;
  const lastSequence = value.lastSequence;
  const sourceEventCount = value.sourceEventCount;
  const recordCount = value.recordCount;
  if (
    typeof value.path !== 'string' ||
    value.path.length === 0 ||
    posix.isAbsolute(value.path) ||
    win32.isAbsolute(value.path) ||
    value.path.includes('\\') ||
    value.path
      .split('/')
      .some((part) => part.length === 0 || part === '.' || part === '..') ||
    typeof firstSequence !== 'number' ||
    !Number.isInteger(firstSequence) ||
    typeof lastSequence !== 'number' ||
    !Number.isInteger(lastSequence) ||
    typeof sourceEventCount !== 'number' ||
    !Number.isInteger(sourceEventCount) ||
    typeof recordCount !== 'number' ||
    !Number.isInteger(recordCount) ||
    firstSequence < 1 ||
    lastSequence < firstSequence ||
    sourceEventCount < 1 ||
    sourceEventCount > lastSequence - firstSequence + 1 ||
    recordCount < 1 ||
    typeof value.lastRecordId !== 'string' ||
    value.lastRecordId.length === 0
  ) {
    throw new Error('Console export manifest has invalid segment metadata');
  }
  return value as ConsoleExportSegment;
}

function validateExportSegments(segments: unknown): ConsoleExportSegment[] {
  if (!Array.isArray(segments)) {
    throw new Error('Console export manifest has invalid segments');
  }
  if (segments.length === 0) {
    throw new Error('Console export manifest has no segments');
  }
  const parsed = segments.map(validateExportSegment);
  if (new Set(parsed.map((segment) => segment.path)).size !== parsed.length) {
    throw new Error('Console export manifest has duplicate segment paths');
  }
  for (let index = 1; index < parsed.length; index += 1) {
    if (parsed[index - 1]!.lastSequence >= parsed[index]!.firstSequence) {
      throw new Error(
        'Console export manifest has overlapping or unsorted segments',
      );
    }
  }
  return parsed;
}

function validateSessionStatus(value: unknown): string {
  if (typeof value !== 'string' || !CONSOLE_SESSION_STATUSES.has(value)) {
    throw new Error('Console export manifest has invalid session status');
  }
  return value;
}

export class ConsoleBridgeService {
  private readonly config: ConsoleBridgeConfig;
  private readonly fetchImpl: typeof fetch;
  private readonly fileSystem: ConsoleBridgeFileSystem;
  private readonly flushDelayMs: number;
  private readonly hubSent = new Set<string>();
  private readonly fileSent = new Set<string>();
  /** Highest successfully delivered Console-method sequence per thread. */
  private readonly deliveredThrough = new Map<string, number>();
  private hubOutageWarned = false;
  private unsubscribe: (() => void) | null = null;
  /**
   * archive#1093 Part B: replaces the hand-rolled `dirtyThreads` Set +
   * single `setTimeout` debounce this service used before Part A's shared
   * primitives existed. That old debounce already coalesced a synchronous
   * burst of N canonical events for one thread into exactly one
   * `flushThread()` call — this is not a new capability. What changes:
   * different threads now flush with bounded concurrency
   * (`DEFAULT_FLUSH_CONCURRENCY`) instead of one strictly serial chain
   * across all dirty threads; `flushNow()`/tests get the primitive's
   * deterministic `drain()` idle signal instead of a hand-derived one; the
   * merge function sums the raw event count per key so `dispatchFlush` can
   * record an accurate coalesce-ratio metric; and the whole thing is now
   * built on Part A's tested, reusable primitive instead of a bespoke
   * one-off. See `deliverToHub`'s failure branch for why a delivery
   * failure must NOT self-`enqueue()` back into this worker.
   */
  private readonly worker: KeyedCoalescingWorker<string, number>;

  constructor(private readonly options: ConsoleBridgeServiceOptions) {
    this.config = options.config ?? resolveConsoleBridgeConfig();
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.fileSystem = options.fileSystem ?? NODE_FILE_SYSTEM;
    this.flushDelayMs = options.flushDelayMs ?? 200;
    this.worker = new KeyedCoalescingWorker<string, number>(
      (threadId, eventsCoalesced) =>
        this.dispatchFlush(threadId, eventsCoalesced),
      {
        merge: (current, next) => current + next,
        windowMs: this.flushDelayMs,
        concurrency: options.flushConcurrency ?? DEFAULT_FLUSH_CONCURRENCY,
        onError: (error, threadId) => {
          // Defense in depth: dispatchFlush() already catches everything
          // flushThread() can throw (fail-soft — Console problems are never
          // session problems). Never let anything escape into an unhandled
          // rejection.
          this.warnOnce('Console bridge flush failed', {
            threadId,
            error: String(error),
          });
        },
      },
    );
  }

  get enabled(): boolean {
    return Boolean(this.config.hubUrl) || this.config.fileSink;
  }

  /** No-op unless a sink is configured (additive, off by default). */
  start(): void {
    if (!this.enabled || this.unsubscribe) return;
    this.unsubscribe = this.options.eventBus.subscribe((event) =>
      this.onServerEvent(event),
    );
    this.options.logger.info('Console bridge enabled', {
      hub: this.config.hubUrl ?? false,
      fileSink: this.config.fileSink,
      scope: this.config.scope.id,
    });
  }

  /**
   * Unsubscribes from the EventBus (no new thread gets marked dirty), then
   * disposes the worker: lets anything already coalesced or in flight
   * finish (fail-soft, idempotent re-emission — never dropped mid-flush)
   * and stops it from accepting further `enqueue()` calls, so no batch
   * timer can be armed after this resolves. Review fix (CRITICAL, this
   * round): `stop()` previously never touched the worker at all, so a
   * timer armed by a still-in-flight dispatch could outlive `stop()` and
   * hold the process open.
   */
  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.worker.dispose();
  }

  /** Drains every coalesced thread flush immediately (tests, proof scripts, shutdown). */
  async flushNow(): Promise<void> {
    await this.worker.drain();
  }

  /** Queue a thread for (re-)emission, e.g. backfill of an existing session. */
  enqueueThread(threadId: string): void {
    this.worker.enqueue(threadId, 1);
  }

  private onServerEvent(serverEvent: ServerEvent): void {
    try {
      if (serverEvent.event !== SERVER_EVENTS.ORCHESTRATION_EVENT) return;
      const event = serverEvent.data?.event as
        | { method?: string; threadId?: string }
        | undefined;
      if (!event?.method || !event.threadId) return;
      if (!CONSOLE_BRIDGED_METHODS.has(event.method)) return;
      this.worker.enqueue(event.threadId, 1);
    } catch (error) {
      // Never throw into the EventBus — it drops throwing listeners.
      this.options.logger.debug('Console bridge event handling failed', {
        error: String(error),
      });
    }
  }

  private async dispatchFlush(
    threadId: string,
    eventsCoalesced: number,
  ): Promise<void> {
    // Review fix (LOW, this round): dropped the parallel
    // `orchestrationCoalesceBurstSize` counter — a histogram's Sum/Count
    // aggregations already give any backend the same running total and
    // dispatch count this consumer's burst size would have provided.
    orchestrationCoalesceRatio.record(eventsCoalesced, {
      consumer: COALESCE_CONSUMER,
    });
    try {
      await this.flushThread(threadId);
    } catch (error) {
      // Fail-soft: Console problems are never session problems.
      this.warnOnce('Console bridge flush failed', {
        threadId,
        error: String(error),
      });
    }
  }

  private async flushThread(threadId: string): Promise<void> {
    const scopeId = `${this.config.scope.kind}:${this.config.scope.id}`;
    let afterSequence =
      this.deliveredThrough.get(threadId) ??
      this.options.eventStore.readConsoleDeliveryProgress(threadId, scopeId);
    while (true) {
      const events = this.options.eventStore.listEventsByMethodsAfterSequence(
        threadId,
        [...CONSOLE_BRIDGED_METHODS],
        afterSequence,
      );
      if (events.length === 0) return;
      // Codex reports cwd on session.configured, which deliberately is not a
      // Console record. Supply that one latest dependency as context without
      // reopening the full event history on every flush.
      const cwdEvent =
        this.options.eventStore.latestCwdConfiguredEvent(threadId);
      const contextEvents = cwdEvent
        ? [cwdEvent, ...events]
            .filter(
              (event, index, all) =>
                all.findIndex((candidate) => candidate.id === event.id) ===
                index,
            )
            .sort((left, right) => left.sequence - right.sequence)
        : events;
      const records = deriveConsoleEventRecords(contextEvents, {
        scope: this.config.scope,
      });
      let delivered = records.length === 0;
      if (records.length > 0) {
        delivered = true;
        if (this.config.fileSink) {
          delivered = this.deliverToFileSink(threadId, contextEvents, records);
        }
        if (this.config.hubUrl) {
          delivered = (await this.deliverToHub(threadId, records)) && delivered;
        }
      }
      if (!delivered) return;

      afterSequence = events.at(-1)!.sequence;
      this.options.eventStore.writeConsoleDeliveryProgress(
        threadId,
        scopeId,
        afterSequence,
      );
      this.deliveredThrough.set(threadId, afterSequence);
      if (events.length < 250) return;
    }
  }

  private deliverToFileSink(
    threadId: string,
    events: ReturnType<EventStore['listEvents']>,
    records: ConsoleEventRecord[],
  ): boolean {
    const workspace = resolveThreadWorkspace(events);
    const pending = records.filter((record) => !this.fileSent.has(record.id));
    if (!workspace) {
      if (pending.length > 0) {
        consoleEmissions.add(pending.length, {
          sink: 'file',
          outcome: 'skipped',
        });
        this.options.logger.debug(
          'Console bridge file sink skipped (no workspace known for thread)',
          { threadId },
        );
      }
      return false;
    }
    if (pending.length === 0) return true;
    if (events.length > 250) {
      throw new Error('Console file export page exceeds 250 source events');
    }
    try {
      const root = consoleArtifactRoot(workspace);
      const segmentDirectory = join(
        root,
        'events',
        CONSOLE_BRIDGE_PRODUCER.id,
        sanitizeConsoleToken(this.config.scope.kind),
        sanitizeConsoleToken(this.config.scope.id),
        sanitizeConsoleToken(threadId),
      );
      const firstSequence = events[0]?.sequence;
      const lastSequence = events.at(-1)?.sequence;
      if (!firstSequence || !lastSequence) {
        throw new Error('Console file export requires a non-empty source page');
      }
      const segmentName = `${firstSequence}-${lastSequence}.jsonl`;
      const segmentPath = join(segmentDirectory, segmentName);
      const segmentContent = `${pending.map((record) => JSON.stringify(record)).join('\n')}\n`;
      this.fileSystem.mkdirSync(segmentDirectory, { recursive: true });
      if (this.fileSystem.existsSync(segmentPath)) {
        let existing: ConsoleEventRecord[];
        try {
          existing = this.fileSystem
            .readFileSync(segmentPath, 'utf8')
            .split('\n')
            .filter(Boolean)
            .map((line) => JSON.parse(line) as ConsoleEventRecord);
        } catch (error) {
          throw new Error('Console export segment is unreadable', {
            cause: error,
          });
        }
        if (JSON.stringify(existing) !== JSON.stringify(pending)) {
          throw new Error(
            'Console export segment conflicts with its source page',
          );
        }
      } else {
        const tempPath = `${segmentPath}.${process.pid}.${Date.now()}.tmp`;
        this.fileSystem.writeFileSync(tempPath, segmentContent, 'utf8');
        this.fileSystem.renameSync(tempPath, segmentPath);
      }
      consoleEmissions.add(pending.length, {
        sink: 'file',
        outcome: 'accepted',
      });
      this.writeExportManifest(threadId, root, records, {
        path: posix.join(
          'events',
          CONSOLE_BRIDGE_PRODUCER.id,
          sanitizeConsoleToken(this.config.scope.kind),
          sanitizeConsoleToken(this.config.scope.id),
          sanitizeConsoleToken(threadId),
          segmentName,
        ),
        firstSequence,
        lastSequence,
        sourceEventCount: events.length,
        recordCount: pending.length,
        lastRecordId: pending.at(-1)?.id ?? '',
      });
      // The manifest is the durable reader contract. Do not advance the
      // in-memory dedup marker until both stream and manifest are durable.
      for (const record of pending) this.fileSent.add(record.id);
      return true;
    } catch (error) {
      consoleEmissions.add(pending.length, { sink: 'file', outcome: 'failed' });
      this.warnOnce('Console bridge file sink failed', {
        threadId,
        error: String(error),
      });
      return false;
    }
  }

  /**
   * Kontour resource-shaped export manifest (S4 item 3): the cross-product
   * file Station writes alongside the event stream so other Kontour tools can
   * discover the export. Envelope follows the suite Resource Contract
   * convention (`apiVersion`/`kind`/`metadata`/`spec`/`status`), verified
   * against `flow/examples/flow-definition-resource-contract.json` and the
   * Veritas resource-contract audit.
   */
  private writeExportManifest(
    threadId: string,
    kontourRoot: string,
    records: ConsoleEventRecord[],
    segment: ConsoleExportSegment,
  ): void {
    const name = `session-export-${sanitizeConsoleToken(threadId)}`;
    const manifestPath = join(
      kontourRoot,
      'resources',
      'station',
      `${name}.json`,
    );
    const now = new Date().toISOString();
    let createdAt = now;
    let priorStatus = 'unknown';
    let priorSegments: ConsoleExportSegment[] = [];
    try {
      const existing = JSON.parse(
        this.fileSystem.readFileSync(manifestPath, 'utf8'),
      ) as {
        metadata?: { createdAt?: string };
        spec?: { segments?: unknown };
        status?: {
          recordCount?: unknown;
          sessionStatus?: string;
          lastRecordId?: unknown;
          lastSequence?: unknown;
        };
      };
      if (existing.metadata?.createdAt) createdAt = existing.metadata.createdAt;
      if (existing.spec?.segments === undefined) {
        throw new Error('Console export manifest lacks segment metadata');
      }
      priorSegments = validateExportSegments(existing.spec.segments);
      const priorLast = priorSegments.at(-1);
      if (existing.status?.sessionStatus === undefined) {
        throw new Error('Console export manifest lacks status metadata');
      }
      priorStatus = validateSessionStatus(existing.status.sessionStatus);
      if (
        !priorLast ||
        existing.status?.lastRecordId !== priorLast.lastRecordId ||
        existing.status?.lastSequence !== priorLast.lastSequence ||
        typeof existing.status?.recordCount !== 'number' ||
        existing.status.recordCount !==
          priorSegments.reduce(
            (total, candidate) => total + candidate.recordCount,
            0,
          )
      ) {
        throw new Error(
          'Console export manifest has inconsistent final record metadata',
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error('Console export manifest is unreadable', {
          cause: error,
        });
      }
    }
    const segments = validateExportSegments(
      [
        ...priorSegments.filter((candidate) => candidate.path !== segment.path),
        segment,
      ].sort((left, right) => left.firstSequence - right.firstSequence),
    );
    const streamRecordCount = segments.reduce(
      (total, candidate) => total + candidate.recordCount,
      0,
    );
    const lastSegment = segments.at(-1)!;
    const lastProcess = [...records]
      .reverse()
      .find((record) => record.type.startsWith('process.'));
    const sessionStatus = validateSessionStatus(
      (lastProcess?.payload.after as { status?: unknown } | undefined)
        ?.status ?? priorStatus,
    );
    const manifest = {
      apiVersion: STATION_RESOURCE_API_VERSION,
      kind: 'SessionEventExport',
      metadata: {
        name,
        labels: { 'station.kontourai.io/thread': threadId },
        annotations: {
          'station.kontourai.io/producer': CONSOLE_BRIDGE_PRODUCER.id,
        },
        createdAt,
        updatedAt: now,
      },
      spec: {
        producer: { ...CONSOLE_BRIDGE_PRODUCER },
        scope: { ...this.config.scope },
        segments,
        source: { store: 'orchestration-events', threadId },
      },
      status: {
        recordCount: streamRecordCount,
        lastRecordId: lastSegment.lastRecordId,
        lastSequence: lastSegment.lastSequence,
        sessionStatus,
        conditions: [
          {
            type: 'Exported',
            status: 'True',
            reason: 'RecordsWritten',
            message: `${streamRecordCount} Console event records derived from event-sourced session state.`,
            lastTransitionTime: now,
          },
        ],
      },
    };
    this.fileSystem.mkdirSync(dirname(manifestPath), { recursive: true });
    const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      this.fileSystem.writeFileSync(
        tempPath,
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      this.fileSystem.renameSync(tempPath, manifestPath);
    } catch (error) {
      try {
        this.fileSystem.unlinkSync(tempPath);
      } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(
            'Console export manifest temporary file is unreadable',
            {
              cause: cleanupError,
            },
          );
        }
      }
      throw error;
    }
  }

  private async deliverToHub(
    threadId: string,
    records: ConsoleEventRecord[],
  ): Promise<boolean> {
    const hubUrl = this.config.hubUrl;
    if (!hubUrl) return true;
    const pending = records.filter((record) => !this.hubSent.has(record.id));
    for (const record of pending) {
      let delivered = false;
      try {
        const response = await this.fetchImpl(`${hubUrl}/records`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(record),
        });
        delivered = response.ok;
        if (!delivered) {
          this.warnOnce('Console hub rejected a record', {
            threadId,
            recordId: record.id,
            status: response.status,
          });
        }
      } catch (error) {
        this.warnOnce('Console hub unreachable (will retry on next event)', {
          threadId,
          hubUrl,
          error: String(error),
        });
      }
      if (delivered) {
        this.hubSent.add(record.id);
        this.hubOutageWarned = false;
        consoleEmissions.add(1, { sink: 'hub', outcome: 'accepted' });
      } else {
        consoleEmissions.add(1, { sink: 'hub', outcome: 'failed' });
        // Self-throttling retry (review fix, CRITICAL this round): do NOT
        // re-enqueue this thread here. A failed record is simply never
        // added to `hubSent`, so it stays "pending" from `deliverToHub`'s
        // own perspective (the `pending = records.filter(...)` line above)
        // — the next REAL canonical event for this thread (or an explicit
        // `enqueueThread`/`flushNow`) naturally retries it. Self-enqueuing
        // from inside the handler that just failed would arm a fresh
        // `windowMs` timer every cycle with no cap and no backoff — a
        // single hub hiccup becomes a permanent retry loop (real SQL reads
        // + real POSTs) with no new traffic required, which breaks the
        // exact "Console problems are never session problems" contract
        // this fail-soft handling exists for. Matches the pre-Part-B
        // behavior, where a failed thread only re-flushed when new traffic
        // marked it dirty again.
        return false;
      }
    }
    return true;
  }

  private warnOnce(message: string, meta: Record<string, unknown>): void {
    if (this.hubOutageWarned) {
      this.options.logger.debug(message, meta);
      return;
    }
    this.hubOutageWarned = true;
    this.options.logger.warn(message, meta);
  }
}
