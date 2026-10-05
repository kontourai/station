import { createHash } from 'node:crypto';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import type { TransferAttempt } from './http-transfer-recorder.js';

export const ORCHESTRATION_TRANSFER_PHASE_NAMES = Object.freeze([
  'initialEventWindow',
  'snapshot',
  'live',
  'shortReplay',
  'fallback',
] as const);

type OrchestrationTransferScenario = 'external-engine' | 'station-native';
type OrchestrationTransferPhaseName =
  (typeof ORCHESTRATION_TRANSFER_PHASE_NAMES)[number];

interface MeasuredTransferPhase {
  scenario: OrchestrationTransferScenario;
  name: OrchestrationTransferPhaseName;
  wireBytes: number;
  decodedBytes: number;
  frames: number;
  contentEncoding: 'identity' | 'gzip';
  compressionRatio: number | null;
  complete: boolean;
  abortedByClient?: boolean;
}

type SseMessage = { event: string; id?: string; data: string };

interface SseConnection {
  close(): void;
}

interface ScenarioSource {
  scenario: OrchestrationTransferScenario;
  provider: string;
  threadId: string;
  heavyTurnId(): string;
  finalToolOutput(): string;
  finalReplayEventCount: number;
  heavyLiveFrameCount: number;
  seedRetained(): Promise<void>;
  startHeavyPrefix(): Promise<void>;
  finishHeavyTurn(): Promise<void>;
}

/**
 * Exact `orchestration:activity` frames each source's live phase carries. The
 * route flushes one 100ms after a trailing coalesced event that carried no
 * activity binding. Station-native ends its heavy turn with such an event
 * (`session.state-changed`), the external engine does not. The scenario waits
 * for that frame before closing the stream, so a slow host cannot close the
 * stream first: the frame and its bytes are always in the phase, and two
 * baseline captures compare equal. Capture and tests read this one table.
 */
export const ORCHESTRATION_TRANSFER_LIVE_ACTIVITY_FRAMES = Object.freeze({
  'external-engine': 0,
  'station-native': 1,
} as const);

interface Budget {
  wireBytes: number;
  decodedBytes: number;
  frames: number;
}

export class TransferMeasurementFailure extends Error {
  constructor(
    message: string,
    readonly diagnostic: {
      kind: 'station-transfer-failure';
      phase: MeasuredTransferPhase;
      limit: Budget;
      eventIdentities: TransferAttempt['eventIdentities'];
      truncated: boolean;
      /** Set when the phase's frame count, not a byte ceiling, was refused. */
      activityFrames?: number;
      expectedFrames?: number;
    },
  ) {
    super(`orchestration transfer scenario: ${message}`);
  }
}

interface MeasureOrchestrationTransferOptions {
  source: ScenarioSource;
  baseUrl: string;
  store: {
    listEvents(threadId: string): Array<{ payload: unknown }>;
  };
  service: { readEventStreamHead(): number };
  recorder: {
    attempts: TransferAttempt[];
    checkpoint(): void;
    activityFramesSinceCheckpoint(): number;
  };
  sdk: {
    getOrchestrationSessionEventWindow<T>(
      baseUrl: string,
      threadId: string,
      input: { turnLimit: number },
    ): Promise<T>;
    fetchSSE(
      url: string,
      options: {
        headers?: Record<string, string>;
        reconnect: false;
        onMessage(message: SseMessage): void;
        onError(error: unknown): void;
      },
    ): SseConnection;
  };
  budget: Record<string, Budget>;
  /** Deadline for each internal barrier; the capture derives it from its bound. */
  barrierTimeoutMs?: number;
}

export function groupTransferEventsByTurn(
  events: CanonicalRuntimeEvent[],
): CanonicalRuntimeEvent[][] {
  const groups = new Map<string, CanonicalRuntimeEvent[]>();
  for (const event of events) {
    if (!event.turnId) continue;
    const group = groups.get(event.turnId) ?? [];
    group.push(event);
    groups.set(event.turnId, group);
  }
  return [...groups.values()];
}

function fail(message: string): never {
  throw new Error(`orchestration transfer scenario: ${message}`);
}

async function untilWithin(
  predicate: () => boolean,
  description: string,
  timeoutMs: number,
) {
  const deadline = performance.now() + timeoutMs;
  while (!predicate()) {
    if (performance.now() > deadline)
      fail(`barrier timed out after ${timeoutMs}ms: ${description}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

function eventFromMessage(message: SseMessage): Record<string, unknown> | null {
  if (message.event !== 'orchestration:event') return null;
  try {
    const parsed = JSON.parse(message.data) as { event?: unknown };
    return parsed.event && typeof parsed.event === 'object'
      ? (parsed.event as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function openSse(
  options: MeasureOrchestrationTransferOptions,
  headers: Record<string, string> = {},
) {
  const messages: SseMessage[] = [];
  const errors: string[] = [];
  const connection = options.sdk.fetchSSE(
    `${options.baseUrl}/api/orchestration/events?threadId=${options.source.threadId}`,
    {
      headers,
      reconnect: false,
      onMessage: (message) => messages.push(message),
      onError: (error) =>
        errors.push(error instanceof Error ? error.message : String(error)),
    },
  );
  return { connection, errors, messages };
}

function phase(
  scenario: OrchestrationTransferScenario,
  name: OrchestrationTransferPhaseName,
  attempt: TransferAttempt | undefined,
): MeasuredTransferPhase {
  if (!attempt) fail(`missing ${scenario}/${name} attempt`);
  return {
    scenario,
    name,
    wireBytes: attempt.socketBytesRead,
    decodedBytes: attempt.decodedBodyBytes,
    frames: attempt.frames,
    contentEncoding: attempt.contentEncoding,
    compressionRatio: attempt.compressionRatio,
    complete: attempt.complete,
    ...(attempt.abortedByClient ? { abortedByClient: true } : {}),
  };
}

function assertWithinBudget(
  phases: MeasuredTransferPhase[],
  budget: Record<string, Budget>,
  attempts: TransferAttempt[],
) {
  for (const item of phases) {
    const limit = budget[item.name];
    if (!limit) fail(`budget omits ${item.name}`);
    for (const [metric, value] of Object.entries({
      wireBytes: item.wireBytes,
      decodedBytes: item.decodedBytes,
      frames: item.frames,
    })) {
      if (value > limit[metric as keyof Budget]) {
        const attempt =
          attempts[ORCHESTRATION_TRANSFER_PHASE_NAMES.indexOf(item.name)]!;
        throw new TransferMeasurementFailure(
          `WIRE_BUDGET_EXCEEDED_${item.scenario}_${item.name}: ${metric} ${value} > ${limit[metric as keyof Budget]}`,
          {
            kind: 'station-transfer-failure',
            phase: item,
            limit,
            eventIdentities: attempt.eventIdentities,
            truncated: attempt.frames > attempt.eventIdentities.length,
          },
        );
      }
    }
    if (item.wireBytes <= 0 || item.decodedBytes <= 0)
      fail(`${item.scenario}/${item.name} has no transfer bytes`);
    if (!item.complete && !item.abortedByClient)
      fail(`${item.scenario}/${item.name} did not complete`);
  }
}

/**
 * Runs the canonical five-phase transfer measurement against either an
 * external-engine adapter or Station's native adapter. The source alone owns
 * how events enter the service; every read/replay/fallback request is shared.
 */
export async function measureOrchestrationTransfer(
  options: MeasureOrchestrationTransferOptions,
): Promise<{
  phases: MeasuredTransferPhase[];
  beforeHeavyCursor: number;
  shortReplayCursor: number;
  finalCursor: number;
}> {
  const { source } = options;
  const until = (predicate: () => boolean, description: string) =>
    untilWithin(predicate, description, options.barrierTimeoutMs ?? 5_000);
  await source.seedRetained();
  const retained = options.store
    .listEvents(source.threadId)
    .map((item) => item.payload as Record<string, unknown>);
  if (retained.length === 0)
    fail(`${source.scenario} retained history missing`);
  if (
    retained.some(
      (event) =>
        event.provider !== source.provider ||
        event.threadId !== source.threadId,
    )
  )
    fail(`${source.scenario} retained history crossed provider or thread`);

  const window = await options.sdk.getOrchestrationSessionEventWindow<{
    events?: unknown[];
  }>(options.baseUrl, source.threadId, { turnLimit: 10 });
  if (!window.events?.length)
    fail(`${source.scenario} initial window was empty`);
  await until(
    () => options.recorder.attempts.length === 1,
    `${source.scenario} event-window response completed`,
  );

  const snapshot = openSse(options);
  await until(
    () =>
      snapshot.messages.some(
        (message) => message.event === 'orchestration:caughtUp',
      ) || snapshot.errors.length > 0,
    `${source.scenario} snapshot caught-up marker`,
  );
  if (snapshot.errors.length) fail(`${source.scenario} snapshot failed`);
  snapshot.connection.close();
  await until(
    () => options.recorder.attempts.length === 2,
    `${source.scenario} snapshot socket closed`,
  );

  const live = openSse(options);
  await until(
    () =>
      live.messages.some(
        (message) => message.event === 'orchestration:caughtUp',
      ),
    `${source.scenario} live stream snapshot barrier`,
  );
  options.recorder.checkpoint();
  const beforeHeavyCursor = options.service.readEventStreamHead();
  await source.startHeavyPrefix();
  const shortReplayCursor = options.service.readEventStreamHead();
  if (shortReplayCursor <= beforeHeavyCursor)
    fail(`${source.scenario} heavy prefix did not advance cursor`);
  await source.finishHeavyTurn();
  await until(
    () =>
      live.messages.some((message) => {
        const event = eventFromMessage(message);
        return (
          event?.method === 'turn.completed' &&
          event.provider === source.provider &&
          event.threadId === source.threadId &&
          event.turnId === source.heavyTurnId()
        );
      }),
    `${source.scenario} heavy terminal delivered live`,
  );
  const expectedActivity =
    ORCHESTRATION_TRANSFER_LIVE_ACTIVITY_FRAMES[source.scenario];
  const activityWaitMs = options.barrierTimeoutMs ?? 5_000;
  const activityDeadline = performance.now() + activityWaitMs;
  while (options.recorder.activityFramesSinceCheckpoint() < expectedActivity) {
    // Unlike the other barriers this one waits for an event the route owes,
    // so a miss is reported as a possible regression, not as host load.
    if (performance.now() > activityDeadline)
      fail(
        `${source.scenario} trailing activity frame did not arrive within ${activityWaitMs}ms: the live phase saw ${options.recorder.activityFramesSinceCheckpoint()} activity frames, expected ${expectedActivity}. This may be a regression in the route's trailing activity flush, not only host load; check it before raising the timeout`,
      );
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  live.connection.close();
  await until(
    () => options.recorder.attempts.length === 3,
    `${source.scenario} live stream socket closed`,
  );

  const replay = openSse(options, {
    'Last-Event-ID': String(shortReplayCursor),
  });
  await until(
    () =>
      replay.messages.some(
        (message) => message.event === 'orchestration:caughtUp',
      ),
    `${source.scenario} short replay caught-up marker`,
  );
  const replayed = replay.messages.filter(
    (message) => message.event === 'orchestration:event',
  );
  if (replayed.length !== source.finalReplayEventCount)
    fail(`${source.scenario} short replay lost final pair`);
  if (
    replayed.some(
      (message, index) => message.id !== String(shortReplayCursor + index + 1),
    )
  )
    fail(`${source.scenario} short replay cursor sequence changed`);
  const replayedEvents = replayed.map(eventFromMessage);
  if (
    replayedEvents.some(
      (event) =>
        !event ||
        event.provider !== source.provider ||
        event.threadId !== source.threadId ||
        (event.turnId !== undefined && event.turnId !== source.heavyTurnId()),
    )
  )
    fail(`${source.scenario} short replay crossed provider, thread, or turn`);
  if (!replayedEvents.some((event) => event?.turnId === source.heavyTurnId()))
    fail(`${source.scenario} short replay lost the heavy turn identity`);
  const finalToolEvent = replayedEvents[1];
  if (
    createHash('sha256')
      .update(String(finalToolEvent?.output))
      .digest('hex') !==
    createHash('sha256').update(source.finalToolOutput()).digest('hex')
  )
    fail(`${source.scenario} short replay lost final tool output`);
  if (
    replay.messages.some(
      (message) => message.event === 'orchestration:snapshot',
    )
  )
    fail(`${source.scenario} short replay fell back to snapshot`);
  replay.connection.close();
  await until(
    () => options.recorder.attempts.length === 4,
    `${source.scenario} short replay socket closed`,
  );

  const fallback = openSse(options, {
    'Last-Event-ID': String(beforeHeavyCursor),
  });
  await until(
    () =>
      fallback.messages.some(
        (message) => message.event === 'orchestration:caughtUp',
      ),
    `${source.scenario} fallback caught-up marker`,
  );
  if (
    !fallback.messages.some(
      (message) => message.event === 'orchestration:snapshot',
    ) ||
    fallback.messages.some((message) => message.event === 'orchestration:event')
  )
    fail(`${source.scenario} fallback was not a pure snapshot`);
  fallback.connection.close();
  await until(
    () => options.recorder.attempts.length === 5,
    `${source.scenario} fallback socket closed`,
  );

  const phases = ORCHESTRATION_TRANSFER_PHASE_NAMES.map((name, index) =>
    phase(source.scenario, name, options.recorder.attempts[index]),
  );
  assertWithinBudget(phases, options.budget, options.recorder.attempts);
  options.recorder.attempts.forEach((attempt, index) => {
    const expected =
      index === 2
        ? ORCHESTRATION_TRANSFER_LIVE_ACTIVITY_FRAMES[source.scenario]
        : 0;
    if (attempt.activityFrames !== expected)
      fail(
        `${source.scenario}/${ORCHESTRATION_TRANSFER_PHASE_NAMES[index]} carried ${attempt.activityFrames} activity frames, expected ${expected}`,
      );
  });

  if (phases[2]?.frames !== source.heavyLiveFrameCount) {
    const attempt = options.recorder.attempts[2]!;
    throw new TransferMeasurementFailure(
      `${source.scenario} live phase did not contain one heavy turn: frames ${phases[2]?.frames} != ${source.heavyLiveFrameCount}, activityFrames ${attempt.activityFrames}`,
      {
        kind: 'station-transfer-failure',
        phase: phases[2]!,
        limit: options.budget.live!,
        eventIdentities: attempt.eventIdentities,
        truncated: attempt.frames > attempt.eventIdentities.length,
        activityFrames: attempt.activityFrames,
        expectedFrames: source.heavyLiveFrameCount,
      },
    );
  }
  const finalCursor = options.service.readEventStreamHead();
  return { phases, beforeHeavyCursor, shortReplayCursor, finalCursor };
}

type StationBoundaryFrame = Record<string, unknown>;

function stationFrames(
  events: CanonicalRuntimeEvent[],
): StationBoundaryFrame[] {
  const frames: StationBoundaryFrame[] = [];
  for (const event of events) {
    if (event.method === 'tool.started') {
      frames.push({
        type: 'tool-call',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: event.arguments,
      });
    } else if (event.method === 'tool.completed') {
      frames.push({
        type: 'tool-result',
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        output: event.output,
      });
    } else if (event.method === 'turn.completed') {
      frames.push({ type: 'finish', finishReason: 'stop' });
    }
  }
  return frames;
}

/** Deterministic, pauseable fake model boundary for the native adapter. */
export function createStationTransferBoundary() {
  const encoder = new TextEncoder();
  const plans: Array<{
    initial: StationBoundaryFrame[];
    final: StationBoundaryFrame[];
  }> = [];
  let release: (() => void) | undefined;
  const calls: Array<Parameters<typeof globalThis.fetch>> = [];
  const emit = (
    controller: ReadableStreamDefaultController<Uint8Array>,
    frames: StationBoundaryFrame[],
  ) => {
    for (const frame of frames)
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
  };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push([input, init]);
    const plan = plans.shift();
    if (!plan) fail('native adapter fetched without a queued model boundary');
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          emit(controller, plan.initial);
          const finish = () => {
            emit(controller, plan.final);
            controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            controller.close();
            release = undefined;
          };
          if (plan.final.length) release = finish;
          else finish();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  };
  return {
    calls,
    fetch,
    queueComplete(events: CanonicalRuntimeEvent[]) {
      plans.push({ initial: stationFrames(events), final: [] });
    },
    queuePaused(
      prefix: CanonicalRuntimeEvent[],
      final: CanonicalRuntimeEvent[],
    ) {
      plans.push({
        initial: stationFrames(prefix),
        final: stationFrames(final),
      });
    },
    releaseFinal() {
      if (!release) fail('native model boundary has no paused final pair');
      release();
    },
  };
}
