import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  parseHostedTenantRegistry,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MUSE_TURN_IDLE_TIMEOUT_CODE,
  MUSE_TURN_TOTAL_TIMEOUT_CODE,
  MuseAdapter,
} from '../../providers/adapters/muse-adapter.js';
import type { MuseProcessLike } from '../../providers/adapters/muse-adapter-types.js';
import { projectSessionLifecycle } from '../../services/orchestration/session-lifecycle-service.js';
import { TurnProgressTracker } from '../../services/orchestration/turn-progress-tracker.js';
import {
  observeDelegatedTask,
  snapshotFor,
} from '../station-control-delegation.js';

const { mockProviderOpsAdd, mockTurnDurationRecord, mockSessionStartRecord } =
  vi.hoisted(() => ({
    mockProviderOpsAdd: vi.fn(),
    mockTurnDurationRecord: vi.fn(),
    mockSessionStartRecord: vi.fn(),
  }));

vi.mock('../../telemetry/metrics.js', () => ({
  adapterSessionStartDuration: { record: mockSessionStartRecord },
  adapterTurnDuration: { record: mockTurnDurationRecord },
  providerOps: { add: mockProviderOpsAdd },
  orchestrationTurnStallDetections: { add: vi.fn() },
}));

process.env.STATION_API_BASE = 'http://control-delegation-pipeline.test';
process.env.STATION_INTERNAL_API_TOKEN = 'internal-test-token';

const CURRENT_API = 'http://control-delegation-pipeline.test';
const fetchMock = vi.fn<typeof fetch>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const hostedRegistry = parseHostedTenantRegistry({
  schemaVersion: 1,
  tenants: [{ id: 'alpha', authority: 'alpha.station.test' }],
});

function hostedAuthority(tenant: 'alpha') {
  return sessionReadAuthorityFromRequest(
    'shared-user',
    {
      tenantId: hostedRegistry.tenants.find((entry) => entry.id === tenant)!
        .id,
    },
    hostedRegistry,
  );
}

function installCurrentStationFetch() {
  fetchMock.mockImplementation(async (input) => {
    const url = String(input);
    if (url === `${CURRENT_API}/.well-known/station/v1`) {
      return json({ environmentId: 'environment-current' });
    }
    if (url === `${CURRENT_API}/api/agents/reviewer`) {
      return json({
        success: true,
        data: { slug: 'reviewer', name: 'Reviewer', available: true },
      });
    }
    throw new Error(`Unexpected request: ${url}`);
  });
}

/**
 * #2269 producer→caller composition proof (spawn-free, ordinary group).
 *
 * The focused `station-control-delegation.supervision` suite proves
 * `snapshotFor` against hand-built sessions; this file proves the stages
 * those fixtures stand in for are real:
 *
 *   real MuseAdapter events (host-authored turn.started declaration,
 *     verified-activity facts, terminal runtime.error)
 *     → real TurnProgressTracker observation (the watchdog's own turnId)
 *     → real projectSessionLifecycle fold (message-first runtime_error
 *     attribution, exactly as production computes it)
 *     → real snapshotFor / observeDelegatedTask projection.
 *
 * Nothing here hand-creates a terminalAttribution, supervision declaration,
 * or reason: the only hand-built event is the delegation BINDING record
 * (identity metadata the orchestration service stamps at dispatch, same as
 * the existing observe harness), and the only stubbed seam is the
 * readCurrentConversationSession transport plus the agent-catalog fetch.
 * The HTTP route is a thin pass-through over observeDelegatedTask
 * (orchestration.ts takes it as an injectable dep), and `station delegate
 * status` rendering of this exact snapshot shape is proven by the CLI's own
 * `delegate.test.ts` status test — both links cited, not re-proven, here.
 */

const TARGET = {
  apiBase: 'http://current.invalid',
  environmentId: 'environment-current',
  environmentName: 'Current environment',
  kind: 'current' as const,
};

const BINDING_METADATA = {
  taskId: 'task-pipeline',
  conversationId: 'task-pipeline',
  targetKind: 'agent',
  targetId: 'reviewer',
};

function bindingConfiguredEvent(): Record<string, unknown> {
  return {
    method: 'session.configured',
    createdAt: '2026-09-20T21:59:00.000Z',
    metadata: {
      taskId: 'task-pipeline',
      environmentId: 'environment-current',
      environmentName: 'Current environment',
      targetKind: 'agent',
      targetId: 'reviewer',
      userId: 'shared-user',
    },
  };
}

class FakeMuseProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  exit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit('exit', code);
  }
}

function deltaLine(text: string): string {
  return JSON.stringify({ payload: { kind: 'run_output_delta', text } });
}

function terminalLine(
  terminal: string,
  reason: string | null,
  text: string,
): string {
  return JSON.stringify({
    payload: { kind: 'run_terminal', terminal, reason, text },
  });
}

async function flushIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function waitForTurnTerminal(
  seen: CanonicalRuntimeEvent[],
  turnId: string,
  timeoutMs = 15_000,
): Promise<CanonicalRuntimeEvent> {
  const startedAt = Date.now();
  for (;;) {
    const terminal = seen.find(
      (event) =>
        event.turnId === turnId &&
        (event.method === 'runtime.error' ||
          event.method === 'turn.completed' ||
          event.method === 'turn.aborted'),
    );
    if (terminal) return terminal;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for terminal of turn ${turnId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

interface DrivenTurn {
  adapter: MuseAdapter;
  tracker: TurnProgressTracker;
  seen: CanonicalRuntimeEvent[];
  collector: Promise<void>;
  processes: FakeMuseProcess[];
  seed: Record<string, unknown>;
  fold: ReturnType<typeof projectSessionLifecycle>;
  /**
   * The watchdog observation captured right after the activity script ran
   * (BEFORE the terminal event). The real tracker clears the watch when the
   * terminal `runtime.error` lands, so a post-terminal `read()` is honestly
   * undefined — this field is the live read-model value a delegation read
   * racing the terminal would join against.
   */
  liveProgress: Record<string, unknown> | undefined;
}

async function driveTurn(options: {
  threadId: string;
  turnIdleTimeoutMs: number;
  turnTimeoutMs: number;
  metadata?: Record<string, unknown>;
  script: (proc: FakeMuseProcess) => Promise<void>;
}): Promise<{ driven: DrivenTurn; turnId: string }> {
  const processes: FakeMuseProcess[] = [];
  const adapter = new MuseAdapter({
    turnIdleTimeoutMs: options.turnIdleTimeoutMs,
    turnTimeoutMs: options.turnTimeoutMs,
    processFactory: () => {
      const proc = new FakeMuseProcess();
      processes.push(proc);
      return { process: proc as unknown as MuseProcessLike };
    },
    terminateProcess: async () => {},
  });
  const tracker = new TurnProgressTracker({
    providerForThread: () => 'muse' as never,
    publishProjectionChange: () => {},
    logger: { warn: () => {} },
  });
  await adapter.startSession({ provider: 'muse', threadId: options.threadId });
  const seen: CanonicalRuntimeEvent[] = [];
  const collector = (async () => {
    for await (const event of adapter.streamEvents()) {
      seen.push(event);
      tracker.observe(event);
    }
  })();
  const { turnId } = await adapter.sendTurn({
    threadId: options.threadId,
    input: 'probe',
    ...(options.metadata ? { metadata: options.metadata } : {}),
  });
  await options.script(processes[0]);
  const liveProgress = tracker.read(options.threadId) as
    | Record<string, unknown>
    | undefined;
  await waitForTurnTerminal(seen, turnId);
  const sessions = await adapter.listSessions();
  const seed = { ...(sessions.find((s) => s.threadId === options.threadId) as unknown as Record<string, unknown>) };
  const fold = projectSessionLifecycle({ session: seed as never, events: seen });
  const driven: DrivenTurn = {
    adapter,
    tracker,
    seen,
    collector,
    processes,
    seed,
    fold,
    liveProgress: liveProgress ? { ...liveProgress } : undefined,
  };
  return { driven, turnId };
}

async function stopDriven(driven: DrivenTurn): Promise<void> {
  await driven.adapter.stopAll().catch(() => {});
  await driven.collector;
}

/** Session as the delegation route would read it: fold facts, never hand-made. */
function sessionFromPipeline(
  driven: DrivenTurn,
  _threadId: string,
): Record<string, unknown> {
  return {
    ...driven.seed,
    lifecycleState: driven.fold.lifecycleState,
    ...(driven.fold.transitionReason
      ? { transitionReason: driven.fold.transitionReason }
      : {}),
    ...(driven.fold.terminalAttribution
      ? { terminalAttribution: driven.fold.terminalAttribution }
      : {}),
    provider: 'muse',
    ...(driven.liveProgress ? { turnProgress: driven.liveProgress } : {}),
  };
}

function eventsFromPipeline(driven: DrivenTurn): Array<Record<string, unknown>> {
  return driven.seen as unknown as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock);
  fetchMock.mockReset();
  installCurrentStationFetch();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('delegation supervision producer pipeline (#2269)', () => {
  test('idle expiry flows adapter → tracker → fold → snapshot with a synthesized reason', async () => {
    const { driven, turnId } = await driveTurn({
      threadId: 'pipe-idle',
      turnIdleTimeoutMs: 500,
      turnTimeoutMs: 20_000,
      script: async (proc) => {
        proc.stdout.write(`${deltaLine('working')}\n`);
        await flushIo();
      },
    });
    try {
      const terminal = driven.seen.find(
        (event) =>
          event.turnId === turnId && event.method === 'runtime.error',
      );
      expect(terminal).toMatchObject({ code: MUSE_TURN_IDLE_TIMEOUT_CODE });
      // The real fold classifies message-first: a budget kill reads as
      // runtime_error carrying the raw adapter message — the projection
      // below must re-derive the budget from the event code, never forward
      // this detail.
      expect(driven.fold.terminalAttribution?.kind).toBe('runtime_error');
      expect(
        String(
          (driven.fold.terminalAttribution as { detail?: unknown })?.detail ??
            '',
        ),
      ).toContain('was terminated');

      const session = sessionFromPipeline(driven, 'pipe-idle');
      expect(session.turnProgress).toMatchObject({ turnId });
      // The terminal itself clears the live watch: a post-terminal read is
      // honestly empty, so the supervision above provably came from the
      // live-captured observation, not from anything reconstructed after.
      expect(driven.tracker.read('pipe-idle')).toBeUndefined();
      const snapshot = snapshotFor({
        target: TARGET,
        detail: { session, events: eventsFromPipeline(driven) },
        metadata: BINDING_METADATA,
      });
      expect(snapshot.supervision).toMatchObject({
        provider: 'muse',
        turnId,
        idleLimitMs: 500,
        totalLimitMs: 20_000,
      });
      expect(snapshot.supervision?.lastProgressEventAt).toBeDefined();
      expect(snapshot.reason).toEqual({
        code: MUSE_TURN_IDLE_TIMEOUT_CODE,
        detail:
          'The turn ended after a full window with no verified protocol activity.',
      });
      expect(JSON.stringify(snapshot)).not.toContain('was terminated');
    } finally {
      await stopDriven(driven);
    }
  });

  test('absolute expiry stays distinct from idle through the real fold', async () => {
    const { driven, turnId } = await driveTurn({
      threadId: 'pipe-total',
      turnIdleTimeoutMs: 5_000,
      turnTimeoutMs: 2_500,
      script: async (proc) => {
        for (let n = 0; n < 8; n += 1) {
          proc.stdout.write(`${deltaLine(`tick ${n}`)}\n`);
          await new Promise((resolve) => setTimeout(resolve, 150));
        }
        await flushIo();
      },
    });
    try {
      const terminal = driven.seen.find(
        (event) =>
          event.turnId === turnId && event.method === 'runtime.error',
      );
      expect(terminal).toMatchObject({ code: MUSE_TURN_TOTAL_TIMEOUT_CODE });
      // Same typed attribution as idle (the fold collapses both by
      // design) — the reason must still name the absolute budget.
      expect(driven.fold.terminalAttribution?.kind).toBe('runtime_error');
      const snapshot = snapshotFor({
        target: TARGET,
        detail: {
          session: sessionFromPipeline(driven, 'pipe-total'),
          events: eventsFromPipeline(driven),
        },
        metadata: BINDING_METADATA,
      });
      expect(snapshot.reason).toEqual({
        code: MUSE_TURN_TOTAL_TIMEOUT_CODE,
        detail: 'The turn ended at its absolute turn budget.',
      });
      expect(snapshot.supervision).toMatchObject({ turnId });
    } finally {
      await stopDriven(driven);
    }
  });

  test('an unknown child failure keeps its raw text out of the snapshot', async () => {
    const sentinel = 'SENTINEL_MARKER_UNREDACTED_9f8e';
    const privatePath = '/private/var/station-proof-plan/notes.md';
    const { driven, turnId } = await driveTurn({
      threadId: 'pipe-unknown',
      turnIdleTimeoutMs: 10_000,
      turnTimeoutMs: 20_000,
      script: async (proc) => {
        proc.stdout.write(
          `${terminalLine('error', `boom ${sentinel} at ${privatePath}`, 'partial')}\n`,
        );
        await flushIo();
        proc.exit(1);
        await flushIo();
      },
    });
    try {
      const session = sessionFromPipeline(driven, 'pipe-unknown');
      // The real fold really saw the raw text — otherwise this test would
      // prove nothing about redaction at the seam.
      expect(
        String(
          (session.terminalAttribution as { detail?: unknown })?.detail ?? '',
        ),
      ).toContain(sentinel);
      const snapshot = snapshotFor({
        target: TARGET,
        detail: { session, events: eventsFromPipeline(driven) },
        metadata: BINDING_METADATA,
      });
      expect(snapshot.reason).toEqual({ code: 'runtime_error' });
      const serialized = JSON.stringify(snapshot);
      expect(serialized).not.toContain(sentinel);
      expect(serialized).not.toContain(privatePath);
      expect(turnId).toBeTruthy();
    } finally {
      await stopDriven(driven);
    }
  });

  test('caller metadata cannot mint a budget through the real turn.started', async () => {
    const { driven, turnId } = await driveTurn({
      threadId: 'pipe-forged',
      turnIdleTimeoutMs: 5_000,
      turnTimeoutMs: 20_000,
      metadata: {
        turnTimeoutMs: 1,
        turnIdleTimeoutMs: 1,
        supervision: {
          provider: 'muse',
          turnId: 'forged-turn',
          startedAt: new Date().toISOString(),
          deadlineAt: new Date(Date.now() + 1).toISOString(),
          idleLimitMs: 1,
          totalLimitMs: 1,
        },
      },
      script: async (proc) => {
        proc.stdout.write(`${deltaLine('done')}\n`);
        await flushIo();
        proc.stdout.write(
          `${terminalLine('completed', null, 'done')}\n`,
        );
        await flushIo();
        proc.exit(0);
        await flushIo();
      },
    });
    try {
      const started = driven.seen.find(
        (event) =>
          event.method === 'turn.started' && event.turnId === turnId,
      ) as unknown as Record<string, unknown>;
      const declaration = (
        started.metadata as Record<string, unknown>
      ).supervision as Record<string, unknown>;
      // Host-authored only: the real turn id, the server budgets, and no
      // caller-shaped keys leaking onto the declaration.
      expect(declaration.turnId).toBe(turnId);
      expect(declaration.idleLimitMs).toBe(5_000);
      expect(declaration.totalLimitMs).toBe(20_000);
      const snapshot = snapshotFor({
        target: TARGET,
        detail: {
          session: sessionFromPipeline(driven, 'pipe-forged'),
          events: eventsFromPipeline(driven),
        },
        metadata: {
          ...BINDING_METADATA,
          turnTimeoutMs: 1,
          supervision: { provider: 'muse', turnId, totalLimitMs: 1 },
        },
      });
      // A completed turn clears the watch, so there is honestly no current
      // supervision — and certainly not the forged 1 ms budget.
      expect(snapshot.supervision).toBeUndefined();
      expect(JSON.stringify(snapshot)).not.toContain('forged-turn');
    } finally {
      await stopDriven(driven);
    }
  });

  test('supervision follows the live turn; a newer start never shadows by recency', async () => {
    const processes: FakeMuseProcess[] = [];
    const adapter = new MuseAdapter({
      turnIdleTimeoutMs: 500,
      turnTimeoutMs: 20_000,
      processFactory: () => {
        const proc = new FakeMuseProcess();
        processes.push(proc);
        return { process: proc as unknown as MuseProcessLike };
      },
      terminateProcess: async () => {},
    });
    const tracker = new TurnProgressTracker({
      providerForThread: () => 'muse' as never,
      publishProjectionChange: () => {},
      logger: { warn: () => {} },
    });
    await adapter.startSession({ provider: 'muse', threadId: 'pipe-turns' });
    const seen: CanonicalRuntimeEvent[] = [];
    const collector = (async () => {
      for await (const event of adapter.streamEvents()) {
        seen.push(event);
        tracker.observe(event);
      }
    })();
    try {
      const first = await adapter.sendTurn({
        threadId: 'pipe-turns',
        input: 'one',
      });
      processes[0].stdout.write(`${deltaLine('one')}\n`);
      await flushIo();
      const staleProgress = tracker.read('pipe-turns');
      expect(staleProgress?.turnId).toBe(first.turnId);
      processes[0].stdout.write(
        `${terminalLine('completed', null, 'one')}\n`,
      );
      await flushIo();
      processes[0].exit(0);
      await waitForTurnTerminal(seen, first.turnId);

      const second = await adapter.sendTurn({
        threadId: 'pipe-turns',
        input: 'two',
      });
      processes[1].stdout.write(`${deltaLine('two')}\n`);
      await flushIo();
      const live = tracker.read('pipe-turns');
      await waitForTurnTerminal(seen, second.turnId);

      const seed = (await adapter.listSessions()).find(
        (s) => s.threadId === 'pipe-turns',
      ) as unknown as Record<string, unknown>;
      const fold = projectSessionLifecycle({ session: seed as never, events: seen });
      expect(live?.turnId).toBe(second.turnId);
      const snapshot = snapshotFor({
        target: TARGET,
        detail: {
          session: {
            ...seed,
            lifecycleState: fold.lifecycleState,
            ...(fold.terminalAttribution
              ? { terminalAttribution: fold.terminalAttribution }
              : {}),
            provider: 'muse',
            turnProgress: { ...live },
          },
          events: seen as unknown as Array<Record<string, unknown>>,
        },
        metadata: BINDING_METADATA,
      });
      expect(snapshot.supervision?.turnId).toBe(second.turnId);
      expect(snapshot.reason?.code).toBe(MUSE_TURN_IDLE_TIMEOUT_CODE);

      // The stale first-turn observation still joins to its OWN
      // declaration by identity — the newer start does not shadow it.
      const staleSnapshot = snapshotFor({
        target: TARGET,
        detail: {
          session: {
            ...seed,
            lifecycleState: 'running',
            provider: 'muse',
            turnProgress: { ...staleProgress },
          },
          events: seen as unknown as Array<Record<string, unknown>>,
        },
        metadata: BINDING_METADATA,
      });
      expect(staleSnapshot.supervision?.turnId).toBe(first.turnId);
    } finally {
      await adapter.stopAll().catch(() => {});
      await collector;
    }
  });

  test('a stale budget never labels later turns through the real arc', async () => {
    // Root review 00:40 regression over the real producer/caller path:
    // failed budget turn → fresh running turn → fresh success carries NO
    // old reason, and a later different failure must not reuse the old
    // budget code. The legit current timeout is preserved first.
    const processes: FakeMuseProcess[] = [];
    const adapter = new MuseAdapter({
      turnIdleTimeoutMs: 500,
      turnTimeoutMs: 20_000,
      processFactory: () => {
        const proc = new FakeMuseProcess();
        processes.push(proc);
        return { process: proc as unknown as MuseProcessLike };
      },
      terminateProcess: async () => {},
    });
    const tracker = new TurnProgressTracker({
      providerForThread: () => 'muse' as never,
      publishProjectionChange: () => {},
      logger: { warn: () => {} },
    });
    await adapter.startSession({ provider: 'muse', threadId: 'pipe-stale' });
    const seen: CanonicalRuntimeEvent[] = [];
    const collector = (async () => {
      for await (const event of adapter.streamEvents()) {
        seen.push(event);
        tracker.observe(event);
      }
    })();
    const pipeSnapshot = async () => {
      const seed = (await adapter.listSessions()).find(
        (s) => s.threadId === 'pipe-stale',
      ) as unknown as Record<string, unknown>;
      const fold = projectSessionLifecycle({
        session: seed as never,
        events: seen,
      });
      const progress = tracker.read('pipe-stale') as
        | Record<string, unknown>
        | undefined;
      return snapshotFor({
        target: TARGET,
        detail: {
          session: {
            ...seed,
            lifecycleState: fold.lifecycleState,
            ...(fold.transitionReason
              ? { transitionReason: fold.transitionReason }
              : {}),
            ...(fold.terminalAttribution
              ? { terminalAttribution: fold.terminalAttribution }
              : {}),
            provider: 'muse',
            ...(progress ? { turnProgress: { ...progress } } : {}),
          },
          events: seen as unknown as Array<Record<string, unknown>>,
        },
        metadata: BINDING_METADATA,
      });
    };
    try {
      // Turn 1 dies on the idle budget: the current timeout is legit.
      const first = await adapter.sendTurn({
        threadId: 'pipe-stale',
        input: 'one',
      });
      processes[0].stdout.write(`${deltaLine('one')}\n`);
      await flushIo();
      await waitForTurnTerminal(seen, first.turnId);
      const failedSnap = await pipeSnapshot();
      expect(failedSnap.reason).toEqual({
        code: MUSE_TURN_IDLE_TIMEOUT_CODE,
        detail:
          'The turn ended after a full window with no verified protocol activity.',
      });

      // Turn 2 runs fresh: the old budget code must not label it, while its
      // own live supervision is current.
      const second = await adapter.sendTurn({
        threadId: 'pipe-stale',
        input: 'two',
      });
      processes[1].stdout.write(`${deltaLine('two')}\n`);
      await flushIo();
      const runningSnap = await pipeSnapshot();
      expect(runningSnap.reason).toBeUndefined();
      expect(runningSnap.supervision).toMatchObject({
        turnId: second.turnId,
      });

      // Turn 2 succeeds: no old reason on a clean outcome.
      processes[1].stdout.write(`${terminalLine('completed', null, 'two')}\n`);
      await flushIo();
      processes[1].exit(0);
      await waitForTurnTerminal(seen, second.turnId);
      const doneSnap = await pipeSnapshot();
      expect(doneSnap.reason).toBeUndefined();
      expect(doneSnap.status).toBe('completed');

      // Turn 3 fails differently: bare generic, never the old budget code.
      const third = await adapter.sendTurn({
        threadId: 'pipe-stale',
        input: 'three',
      });
      processes[2].stdout.write(
        `${terminalLine('error', 'new failure mode', 'partial')}\n`,
      );
      await flushIo();
      processes[2].exit(1);
      await waitForTurnTerminal(seen, third.turnId);
      const failedDifferentlySnap = await pipeSnapshot();
      expect(failedDifferentlySnap.reason).toEqual({
        code: 'runtime_error',
      });
      expect(JSON.stringify(failedDifferentlySnap)).not.toContain(
        MUSE_TURN_IDLE_TIMEOUT_CODE,
      );
    } finally {
      await adapter.stopAll().catch(() => {});
      await collector;
    }
  });

  test('observeDelegatedTask serves the pipeline snapshot over the read seam', async () => {
    const { driven, turnId } = await driveTurn({
      threadId: 'task-pipeline',
      turnIdleTimeoutMs: 500,
      turnTimeoutMs: 20_000,
      script: async (proc) => {
        proc.stdout.write(`${deltaLine('working')}\n`);
        await flushIo();
      },
    });
    try {
      const session = {
        ...driven.seed,
        threadId: 'task-pipeline',
        lifecycleState: driven.fold.lifecycleState,
        ...(driven.fold.transitionReason
          ? { transitionReason: driven.fold.transitionReason }
          : {}),
        ...(driven.fold.terminalAttribution
          ? { terminalAttribution: driven.fold.terminalAttribution }
          : {}),
        provider: 'muse',
        ...(driven.liveProgress ? { turnProgress: driven.liveProgress } : {}),
        delegation: {
          taskId: 'task-pipeline',
          environmentId: 'environment-current',
          environmentName: 'Current environment',
          targetKind: 'agent',
          targetId: 'reviewer',
        },
      };
      const events = [
        bindingConfiguredEvent(),
        ...eventsFromPipeline(driven),
      ];
      const detail = { session, events };
      const canRead = (authority: {
        tenantExecutionContext?: { tenantId: string };
      }) => authority.tenantExecutionContext?.tenantId === 'alpha';
      const service = {
        listSessionReadModel: vi.fn(async (authority) =>
          canRead(authority) ? [session] : [],
        ),
        readSession: vi.fn(async (_taskId, authority) =>
          canRead(authority) ? detail : null,
        ),
        readCurrentConversationSession: vi.fn(
          async (_conversationId, authority) =>
            canRead(authority) ? detail : null,
        ),
        currentConversationSessionId: vi.fn(() => 'task-pipeline'),
        reservedConversationHandoff: vi.fn(() => undefined),
        resolveConversationContinuation: vi.fn(async () => ({
          sessionId: 'task-pipeline',
          startRequired: false,
        })),
        getProviderAdapter: vi.fn(() => undefined),
        readSessionEventPage: vi.fn(async (_taskId, { authority }) =>
          canRead(authority)
            ? {
                session,
                events: events.map((event, index) => ({
                  sequence: index + 1,
                  event,
                })),
                nextSequence: events.length,
                hasMore: false,
              }
            : null,
        ),
      };
      const snapshot = await observeDelegatedTask(
        { taskId: 'task-pipeline', readAuthority: hostedAuthority('alpha') },
        service as never,
      );
      expect(snapshot.supervision).toMatchObject({
        provider: 'muse',
        turnId,
        idleLimitMs: 500,
        totalLimitMs: 20_000,
      });
      expect(snapshot.reason).toEqual({
        code: MUSE_TURN_IDLE_TIMEOUT_CODE,
        detail:
          'The turn ended after a full window with no verified protocol activity.',
      });
      expect(JSON.stringify(snapshot)).not.toContain('was terminated');
      expect(service.readCurrentConversationSession).toHaveBeenCalledWith(
        'task-pipeline',
        expect.anything(),
      );
    } finally {
      await stopDriven(driven);
    }
  });
});
