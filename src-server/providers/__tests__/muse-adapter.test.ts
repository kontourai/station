import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import {
  ENGINE_CAPABILITY_MATRICES,
  resolveEngineCapabilityMatrix,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '@kontourai/station-contracts/engine-capability-matrix';
import { engineDisplayLabel } from '@kontourai/station-contracts/engine-display';
import {
  FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY,
  MUSE_HELD_TURN_UNFINISHED_CODE,
  MUSE_LINGERING_CHILD_REAPED_CODE,
  MUSE_TURN_SLOT_RELEASING_CODE,
  resolveModelLaunchPlan,
  unsupportedModelOptionKeys,
} from '@kontourai/station-contracts/provider';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { projectRuntimeEventsToMessages } from '@kontourai/station-shared/runtime-event-projection';
import { assembleTurnProvenanceEnvelopes } from '@kontourai/station-shared/turn-provenance-fold';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { EventStore } from '../../services/orchestration/event-store.js';
import type { ProviderAdapterShape } from '../adapter-shape.js';
import { SendTurnRefusedError } from '../adapter-shape.js';
import type { MuseAdapterOptions } from '../adapters/muse-adapter.js';
import {
  formatMuseDuration,
  MUSE_BACKGROUND_TASK_COMPLETED_OUTPUT,
  MUSE_BACKGROUND_TASK_STOP_UNCONFIRMED_OUTPUT,
  MUSE_BACKGROUND_TASK_STOPPED_OUTPUT,
  MUSE_BACKGROUND_TASK_UNRESOLVED_OUTPUT,
  MUSE_CANCELLED_TOOL_OUTPUT,
  MUSE_DEFAULT_IDLE_TIMEOUT_MS,
  MUSE_FAILED_NO_RESULT_OUTPUT,
  MUSE_FINISHED_NO_RESULT_OUTPUT,
  MUSE_MAX_SUPERVISION_TIMEOUT_MS,
  MUSE_PENDING_BACKGROUND_TASKS_MAX,
  MUSE_PROVIDER_OVERRIDE_ENV,
  MUSE_REFUSED_VALUE_MAX_CHARS,
  MUSE_STDOUT_BUFFER_MAX_CHARS,
  MUSE_TURN_IDLE_TIMEOUT_CODE,
  MUSE_TURN_TOTAL_TIMEOUT_CODE,
  MuseAdapter,
  MuseTurnSlotReleasingError,
  museCredentialPath,
  resolveMuseProviderOverride,
  resolveMuseSupervisionBound,
  resolveMuseTurnBudget,
} from '../adapters/muse-adapter.js';
import type { MuseProcessLike } from '../adapters/muse-adapter-types.js';
import {
  MUSE_MODEL_LAUNCH,
  MUSE_PROVIDER_MODES,
} from '../adapters/muse-adapter-types.js';
import { UNRESOLVED_TURN_TOOL_OUTPUT } from '../adapters/unresolved-tool-output.js';
import { expectCanonicalSessionLifecycle } from './adapter-contract-test-utils.js';
import {
  MUSE_13_BACKGROUND_FOLLOW_UP_TEXT,
  MUSE_13_BACKGROUND_TASK_ID,
  MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES,
  MUSE_13_BASH_CALL_ID,
  MUSE_13_BASH_TOOL_TURN_LINES,
  MUSE_13_WORKFLOW_CALL_ID,
  MUSE_ECHO_OUTPUT_DELTA,
  MUSE_ECHO_RUN_STARTED,
  MUSE_ECHO_RUN_TERMINAL,
  MUSE_ECHO_TASK_LIFECYCLE,
  MUSE_META_FULL_TEXT,
  MUSE_META_OUTPUT_DELTA_1,
  MUSE_META_OUTPUT_DELTA_2,
  MUSE_META_RUN_TERMINAL,
  MUSE_TOOL_RESULT,
} from './muse-adapter-fixtures.js';

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
}));

/**
 * Structural stand-in for one `muse exec --json` child.
 *
 * Deliberately NOT a real spawn and deliberately not typed against
 * `node:child_process`: a direct import of that module here would require an
 * explicit process-heavy classification in `scripts/vitest-resource-manifest.mjs`,
 * and this suite has no reason to start a process at all.
 */
class FakeMuseProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  killed = false;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly killSignals: Array<NodeJS.Signals | number> = [];

  constructor() {
    super();
    this.stdout.setEncoding('utf8');
    this.stderr.setEncoding('utf8');
  }

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    this.exit(null);
    return true;
  }

  /** Emit the child's exit exactly as the real per-turn process would. */
  exit(code: number | null): void {
    if (this.exitCode !== null) return;
    this.exitCode = code ?? 0;
    this.emit('exit', code);
  }
}

async function flushIo(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

async function writeLines(
  processHandle: FakeMuseProcess,
  ...lines: string[]
): Promise<void> {
  for (const line of lines) {
    processHandle.stdout.write(`${line}\n`);
  }
  await flushIo();
}

async function nextEvent(
  iterator: AsyncIterator<any>,
  label: string,
): Promise<any> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`Timed out waiting for ${label}`)),
        750,
      ),
    ),
  ]);
  return result.value;
}

async function drain(
  iterator: AsyncIterator<any>,
  count: number,
  label: string,
): Promise<any[]> {
  const events: any[] = [];
  for (let index = 0; index < count; index += 1) {
    events.push(await nextEvent(iterator, `${label} #${index + 1}`));
  }
  return events;
}

/**
 * Asserts nothing further is queued after a `drain(iterator, N, label)` call.
 *
 * archive#3450 fault injection found this gap: `drain` with a fixed count
 * proves the first N events, but an EXTRA event published after them (e.g. a
 * stray `turn.completed` appended after the intended `runtime.error`) is
 * simply left unread and never fails anything — the fixed count is a floor
 * assertion in a place a ceiling is required. `AsyncEventQueue` publishes
 * synchronously with every mutation in this suite (no real I/O), so a short
 * race is sufficient to distinguish "genuinely empty" from "something
 * pending" without flaking.
 *
 * MUST be the last thing a test does with `iterator`: the losing
 * `iterator.next()` call is not cancelled when the race resolves via the
 * timeout — it stays registered as a waiter on the queue and will resolve
 * (silently, since nothing awaits it directly) from the NEXT event the queue
 * publishes. Any `drain`/`nextEvent` call made after `expectNoFurtherEvent`
 * in the same test would therefore skip one real event without either call
 * failing. Every current call site is the final thing its test does with the
 * iterator; keep it that way when adding new ones.
 */
async function expectNoFurtherEvent(
  iterator: AsyncIterator<any>,
  label: string,
): Promise<void> {
  const NOTHING_PENDING = Symbol('nothing-pending');
  const result = await Promise.race([
    iterator.next(),
    new Promise<typeof NOTHING_PENDING>((resolve) =>
      setTimeout(() => resolve(NOTHING_PENDING), 30),
    ),
  ]);
  if (result !== NOTHING_PENDING) {
    throw new Error(
      `Unexpected additional event after ${label}: ${JSON.stringify(
        (result as IteratorResult<any>).value,
      )}`,
    );
  }
}

interface Harness {
  adapter: MuseAdapter;
  iterator: AsyncIterator<any>;
  processes: FakeMuseProcess[];
  spawnArgs: string[][];
  spawnCwds: Array<string | undefined>;
  released: number;
  logger: { warn: ReturnType<typeof vi.fn>; info: ReturnType<typeof vi.fn> };
}

function createHarness(overrides: Partial<MuseAdapterOptions> = {}): Harness {
  const processes: FakeMuseProcess[] = [];
  const spawnArgs: string[][] = [];
  const spawnCwds: Array<string | undefined> = [];
  const logger = { warn: vi.fn(), info: vi.fn() };
  const harness = {
    processes,
    spawnArgs,
    spawnCwds,
    released: 0,
    logger,
  } as Harness;
  const adapter = new MuseAdapter({
    newSessionId: () => 'muse-session-fixed',
    processFactory: (args, cwd) => {
      spawnArgs.push(args);
      spawnCwds.push(cwd);
      const processHandle = new FakeMuseProcess();
      processes.push(processHandle);
      return {
        process: processHandle,
        release: () => {
          harness.released += 1;
        },
      };
    },
    // The real path terminates a process TREE with signals; the double just
    // records the signal and settles, so no test here signals a real pid.
    terminateProcess: async (processHandle: MuseProcessLike) => {
      processHandle.kill('SIGTERM');
    },
    logger,
    ...overrides,
  });
  harness.adapter = adapter;
  harness.iterator = adapter.streamEvents()[Symbol.asyncIterator]();
  return harness;
}

describe('MuseAdapter', () => {
  afterEach(() => {
    mockProviderOpsAdd.mockClear();
    mockTurnDurationRecord.mockClear();
    mockSessionStartRecord.mockClear();
  });

  test('declares only capabilities it can demonstrate', () => {
    const adapter: ProviderAdapterShape = new MuseAdapter();
    expect(adapter.provider).toBe('muse');
    expect(adapter.metadata.displayName).toBe('Muse Code');
    expect(adapter.metadata.engineId).toBe('muse');
    expect(adapter.metadata.builtin).toBe(true);
    // `abortSettlement` is consulted ONLY where a discovery call must settle
    // before an abort resolves (`ConnectionInspector` around
    // `listModelCatalog`/`listModels`), and this adapter implements neither —
    // so declaring it was a settlement policy with nothing behind it.
    expect(adapter.metadata).not.toHaveProperty('abortSettlement');
    expect(adapter.listModelCatalog).toBeUndefined();
    expect(adapter.listModels).toBeUndefined();
    expect([...adapter.metadata.capabilities]).toEqual([
      'agent-runtime',
      'session-lifecycle',
      'external-process',
      'image-input',
    ]);
    // Slice 1 proves none of these; declaring one would be a label with
    // nothing deriving it.
    for (const unclaimed of ['resume', 'approvals', 'tool-calls']) {
      expect([...adapter.metadata.capabilities]).not.toContain(unclaimed);
    }
    // Fail-closed chat readiness (`system-status-routes.ts`) skips any adapter
    // that cannot be verified, so this must be a real function.
    expect(typeof adapter.getPrerequisites).toBe('function');
  });

  test('passes validated image bytes to Muse and removes them only after process exit', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'image-turn',
    });
    await harness.adapter.sendTurn({
      threadId: 'image-turn',
      input: 'Inspect image',
      attachments: [
        {
          kind: 'image',
          name: 'test.png',
          mimeType: 'image/png',
          size: 3,
          dataUrl: 'data:image/png;base64,YWJj',
        },
      ],
    });
    const args = harness.spawnArgs[0];
    const path = args[args.indexOf('--image') + 1];
    expect(readFileSync(path, 'utf8')).toBe('abc');
    harness.processes[0].exit(0);
    await flushIo();
    expect(existsSync(path)).toBe(false);
  });

  test('startSession spawns nothing and publishes the canonical lifecycle', async () => {
    const harness = createHarness();
    const session = await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-lifecycle',
      cwd: '/tmp/project',
      modelId: 'muse-spark-1.2-contributor',
    });

    expect(session.status).toBe('ready');
    // The whole point of a per-turn engine: no process exists until a turn.
    expect(harness.processes).toHaveLength(0);

    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-lifecycle',
      input: 'hi',
    });
    expect(harness.processes).toHaveLength(1);

    await writeLines(
      harness.processes[0],
      MUSE_META_OUTPUT_DELTA_1,
      MUSE_META_OUTPUT_DELTA_2,
      MUSE_META_RUN_TERMINAL,
    );
    harness.processes[0].exit(0);
    await flushIo();

    const events = await drain(harness.iterator, 6, 'lifecycle');
    const methods = events.map((event) => event.method);
    expectCanonicalSessionLifecycle(methods);
    expect(methods).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'content.text-delta',
      'content.text-delta',
      'turn.completed',
    ]);

    // One item id per turn, minted at the first delta and reused — and never
    // the turn id, which lives in a different id space muse never equates.
    const [firstDelta, secondDelta] = events.filter(
      (event) => event.method === 'content.text-delta',
    );
    expect(firstDelta.itemId).toBeTruthy();
    expect(secondDelta.itemId).toBe(firstDelta.itemId);
    expect(firstDelta.itemId).not.toBe(turn.turnId);
    expect(firstDelta.turnId).toBe(turn.turnId);

    const completed = events[5];
    expect(completed).toMatchObject({
      method: 'turn.completed',
      turnId: turn.turnId,
      finishReason: 'stop',
    });
    // `run_terminal.text` is the FULL text: appending it after the streamed
    // deltas would double the assistant message.
    expect(completed.outputText).toBe(MUSE_META_FULL_TEXT);
    expect(completed.outputText).not.toContain(
      `${MUSE_META_FULL_TEXT}${MUSE_META_FULL_TEXT}`,
    );
    expect(mockTurnDurationRecord).toHaveBeenCalledWith(expect.any(Number), {
      provider: 'muse',
    });
    expect(mockSessionStartRecord).toHaveBeenCalledWith(expect.any(Number), {
      provider: 'muse',
    });
  });

  test('spawns one process per turn against a stable --session-id', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-multi',
      cwd: '/tmp/project',
      modelId: 'muse-spark-1.2-contributor',
    });

    await harness.adapter.sendTurn({ threadId: 'thread-multi', input: 'one' });
    await writeLines(harness.processes[0], MUSE_META_RUN_TERMINAL);
    harness.processes[0].exit(0);
    await flushIo();

    await harness.adapter.sendTurn({ threadId: 'thread-multi', input: 'two' });
    await writeLines(harness.processes[1], MUSE_META_RUN_TERMINAL);
    harness.processes[1].exit(0);
    await flushIo();

    expect(harness.processes).toHaveLength(2);
    expect(harness.spawnCwds).toEqual(['/tmp/project', '/tmp/project']);
    for (const args of harness.spawnArgs) {
      expect(args.slice(0, 4)).toEqual([
        'exec',
        '--json',
        '--session-id',
        'muse-session-fixed',
      ]);
      expect(args).toContain('--model');
      expect(args).toContain('--workspace');
    }
    expect(harness.spawnArgs[0][harness.spawnArgs[0].length - 1]).toBe('one');
    expect(harness.spawnArgs[1][harness.spawnArgs[1].length - 1]).toBe('two');
    // Each finished turn drops its owned-process registry record; a per-turn
    // spawner that never released would leave one file per turn behind.
    expect(harness.released).toBe(2);
    expect(await harness.adapter.hasSession('thread-multi')).toBe(true);
  });

  test('station#895 wave C (instructionsInFirstTurn): a first-turn-composed prompt reaches the spawned exec argv verbatim', async () => {
    // Muse's matrix cell (`instructionsInFirstTurn`) claims delivery on the
    // strength of this exact property: `sendTurn` forwards `input.input`
    // straight into `buildMuseExecArgs({ prompt: input.input, ... })` with
    // no system-prompt field of its own. Orchestration's ambientContext
    // choke point (orchestration-service.ts) is what prepends the authored
    // prompt into that string before this adapter ever sees it — this test
    // pins the adapter's half: whatever composed first-turn text arrives,
    // the CLI invocation carries it byte-for-byte, and `displayInput`
    // (the typed text alone) is what the adapter persists as the turn's
    // transcript-facing prompt.
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-first-turn-prompt',
      cwd: '/tmp/project',
      modelId: 'muse-spark-1.2-contributor',
    });

    await harness.adapter.sendTurn({
      threadId: 'thread-first-turn-prompt',
      input: 'Be terse.\nHello',
      displayInput: 'Hello',
      metadata: { [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: true },
    });

    expect(harness.spawnArgs[0][harness.spawnArgs[0].length - 1]).toBe(
      'Be terse.\nHello',
    );

    await writeLines(harness.processes[0], MUSE_META_RUN_TERMINAL);
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 4, 'first-turn-prompt');
    const started = events.find((event) => event.method === 'turn.started');
    expect(started.prompt).toBe('Hello');
    // Independent review MEDIUM-1: the marker rides THIS turn's own
    // persisted metadata, so the delegate-seam disclosure can derive
    // 'delivered' from this turn's own record, not merely from having
    // started.
    expect(started.metadata).toMatchObject({
      [FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY]: true,
    });
  });

  test('independent review MEDIUM-1: an ordinary turn (no composed-first-turn metadata) never carries the marker', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-ordinary-turn',
      cwd: '/tmp/project',
      modelId: 'muse-spark-1.2-contributor',
    });

    await harness.adapter.sendTurn({
      threadId: 'thread-ordinary-turn',
      input: 'Hello',
    });

    await writeLines(harness.processes[0], MUSE_META_RUN_TERMINAL);
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 4, 'ordinary-turn');
    const started = events.find((event) => event.method === 'turn.started');
    expect(
      started.metadata?.[FIRST_TURN_INSTRUCTIONS_COMPOSED_METADATA_KEY],
    ).not.toBe(true);
  });

  test('a child exit without run_terminal still closes the turn, and is never a session exit', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-crash',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-crash',
      input: 'hi',
    });
    // Exactly the observed failure shape: `muse exec --model <unknown>` exits
    // 1 having written the error to stderr and NO JSONL at all.
    harness.processes[0].stderr.write(
      'model `station-probe-nonexistent-model` is not in the catalog\n',
    );
    await flushIo();
    harness.processes[0].exit(1);
    await flushIo();

    // archive#3450: a failed turn publishes exactly ONE terminal event —
    // `runtime.error` — never `turn.completed` alongside it. The double
    // publish used to make every non-lifecycle-fold consumer (the "your
    // agent finished" push notification, `closeDelegate`, the
    // `turn.event.projected` receipt) read this failed turn as a success.
    const events = await drain(harness.iterator, 4, 'crash');
    const methods = events.map((event) => event.method);
    expect(methods).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'runtime.error',
    ]);
    expect(methods).not.toContain('turn.completed');
    expect(events[3]).toMatchObject({
      method: 'runtime.error',
      code: 'muse-exit-without-terminal',
      turnId: turn.turnId,
    });
    // The whole point of retaining stderr: an exit code alone names nothing.
    // This message is the ONLY diagnosis a user gets for an unknown model or
    // an expired key.
    expect(events[3].message).toContain(
      'model `station-probe-nonexistent-model` is not in the catalog',
    );
    // A per-turn exit is normal. Publishing session.exited here would end the
    // session after its first turn.
    expect(methods).not.toContain('session.exited');
    // A fixed drain count alone cannot catch a STRAY event published after
    // the ones it asked for (archive#3450 fault injection found this gap).
    await expectNoFurtherEvent(harness.iterator, 'crash');
    expect(await harness.adapter.hasSession('thread-crash')).toBe(true);
    // The session survives, so the next turn still spawns.
    await harness.adapter.sendTurn({
      threadId: 'thread-crash',
      input: 'again',
    });
    expect(harness.processes).toHaveLength(2);
  });

  // archive#3450 review (FIX 3): `muse-exit-without-terminal` and
  // `muse-terminal-not-completed` were the only two `error`-outcome call
  // sites with test coverage; `muse-spawn-failed` and
  // `muse-terminal-not-completed` had none. This covers `muse-spawn-failed`
  // — the child's `error` event (e.g. spawn ENOENT) — which never emits
  // `exit` at all, so it is the one failure path that does not run through
  // the `exit` handler's branch this file already tests.
  test('a spawn failure publishes runtime.error only, never turn.completed', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-spawn-failed',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-spawn-failed',
      input: 'hi',
    });
    // The real shape: a child that never starts emits `error` and never
    // `exit` (Node's ENOENT-on-spawn behavior).
    harness.processes[0].emit('error', new Error('spawn muse ENOENT'));
    await flushIo();

    const events = await drain(harness.iterator, 4, 'spawn failed');
    const methods = events.map((event) => event.method);
    expect(methods).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'runtime.error',
    ]);
    expect(methods).not.toContain('turn.completed');
    expect(events[3]).toMatchObject({
      method: 'runtime.error',
      code: 'muse-spawn-failed',
      turnId: turn.turnId,
    });
    expect(events[3].message).toContain('spawn muse ENOENT');
    await expectNoFurtherEvent(harness.iterator, 'spawn failed');
    // A spawn failure frees the slot itself (no `exit` event will ever
    // arrive to do it), so the session survives and the next turn spawns.
    expect(await harness.adapter.hasSession('thread-spawn-failed')).toBe(true);
    await harness.adapter.sendTurn({
      threadId: 'thread-spawn-failed',
      input: 'again',
    });
    expect(harness.processes).toHaveLength(2);
  });

  // archive#3450 review (FIX 3 + the FIX 1 sub-case): `run_terminal` with a
  // non-`completed` terminal and NO deltas streamed is the narrow case where
  // `effect.text` is the ONLY carrier of muse's reported text anywhere in
  // the event stream — `settleTurn`'s `outputTextDetail` folds it into
  // `runtime.error.message` rather than dropping it silently.
  test('a non-completed run_terminal with no deltas folds its text into runtime.error, publishing no turn.completed', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-terminal-failed',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-terminal-failed',
      input: 'hi',
    });
    // No content.text-delta at all — straight to a non-`completed` terminal
    // carrying explanatory text, the shape `mapMuseFinishReason` classifies
    // as 'other' (nothing in the captured corpus uses this terminal value,
    // so it exercises the "unknown outcome" branch honestly).
    harness.processes[0].stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'event',
        payload: {
          kind: 'run_terminal',
          terminal: 'failed',
          reason: 'model_error',
          text: 'the model refused to respond: content policy violation',
        },
      })}\n`,
    );
    await flushIo();

    const events = await drain(harness.iterator, 4, 'terminal not completed');
    const methods = events.map((event) => event.method);
    expect(methods).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'runtime.error',
    ]);
    expect(methods).not.toContain('turn.completed');
    const error = events[3];
    expect(error).toMatchObject({
      method: 'runtime.error',
      code: 'muse-terminal-not-completed',
      turnId: turn.turnId,
    });
    expect(error.message).toContain(
      'Muse turn ended without completing (terminal: failed, reason: model_error).',
    );
    // The FIX 1 sub-case: `run_terminal.text` was the only carrier of this
    // text (no deltas streamed) and it must not vanish.
    expect(error.message).toContain(
      'the model refused to respond: content policy violation',
    );
    await expectNoFurtherEvent(harness.iterator, 'terminal not completed');
  });

  // muse writes `muse: workspace root: <path>` to stderr on EVERY invocation
  // (live-verified). A per-turn `runtime.warning` therefore put a
  // content-free toast in front of the user on every single turn — a noise
  // class Station does not otherwise have (Codex's equivalent is
  // per-SESSION). Routine stderr goes to the server log; it reaches the user
  // only attached to a failure.
  test('a normal turn publishes no stderr event for muse’s routine banner', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-stderr',
    });
    await harness.adapter.sendTurn({ threadId: 'thread-stderr', input: 'hi' });
    harness.processes[0].stderr.write(
      'muse: workspace root: /tmp/project (cwd default)\n',
    );
    await flushIo();
    await writeLines(harness.processes[0], MUSE_META_RUN_TERMINAL);
    harness.processes[0].exit(0);
    await flushIo();

    const events = await drain(harness.iterator, 4, 'stderr');
    const methods = events.map((event) => event.method);
    expect(methods).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'turn.completed',
    ]);
    expect(methods).not.toContain('runtime.warning');
    // Not silently dropped either — it is recorded through Station's logging
    // seam, where a routine banner belongs.
    expect(harness.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('stderr'),
    );
    // archive#3450 review round 2 (FIX C): the `completed` arm needs the
    // same ceiling as the `error` arm — a stray `runtime.error` appended
    // after `turn.completed` (the exact mirror of archive#3450's original defect)
    // would otherwise be invisible here.
    await expectNoFurtherEvent(harness.iterator, 'stderr');
  });

  test('bounds the stderr tail it carries into a failed turn’s error', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-stderr-flood',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-stderr-flood',
      input: 'hi',
    });
    for (let index = 0; index < 200; index += 1) {
      harness.processes[0].stderr.write(
        `warning ${index}: ${'x'.repeat(80)}\n`,
      );
    }
    await flushIo();
    harness.processes[0].exit(1);
    await flushIo();

    const events = await drain(harness.iterator, 4, 'stderr flood');
    const methods = events.map((event) => event.method);
    // No per-chunk relay at all: `AsyncEventQueue` clears itself on overflow,
    // so an unbounded stderr relay could discard the turn's real events.
    expect(methods.filter((m) => m === 'runtime.warning')).toHaveLength(0);
    // archive#3450: no `turn.completed` alongside the failure.
    expect(methods).not.toContain('turn.completed');
    const error = events[3];
    expect(error.method).toBe('runtime.error');
    // The TAIL survives, not the head. muse prints a routine banner on every
    // invocation, so retaining the head spends the whole budget on the banner
    // and drops the failure reason this error exists to carry.
    expect(error.message).toContain('warning 199:');
    expect(error.message).not.toContain('warning 0:');
    expect(error.message.length).toBeLessThan(700);
    await expectNoFurtherEvent(harness.iterator, 'stderr flood');
  });

  // archive#3450 review round 2 (FIX D): MUSE_OUTPUT_TEXT_DETAIL_MAX_CHARS
  // had no test proving its rejection path runs — the sibling stderr-tail
  // bound above does. Mirrors that test's shape exactly, against
  // `outputTextDetail` instead of `stderrDetail`.
  test('bounds the output-text detail it folds into a failed turn’s error', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-outputtext-flood',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-outputtext-flood',
      input: 'hi',
    });
    // No deltas streamed, so `run_terminal.text` is the only carrier — 604
    // chars, over `MUSE_OUTPUT_TEXT_DETAIL_MAX_CHARS` (500).
    const longText = `head-marker ${'y'.repeat(580)} tail-marker`;
    harness.processes[0].stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'event',
        payload: {
          kind: 'run_terminal',
          terminal: 'failed',
          reason: null,
          text: longText,
        },
      })}\n`,
    );
    await flushIo();

    const events = await drain(harness.iterator, 4, 'output text flood');
    const methods = events.map((event) => event.method);
    expect(methods).not.toContain('turn.completed');
    const error = events[3];
    expect(error.method).toBe('runtime.error');
    // The TAIL survives, not the head — same bound shape as stderrDetail's.
    expect(error.message).toContain('tail-marker');
    expect(error.message).not.toContain('head-marker');
    await expectNoFurtherEvent(harness.iterator, 'output text flood');
  });

  // archive#3450 review round 2, post-merge follow-up (commit b3ff4eb4c):
  // outputTextDetail now redacts BEFORE truncating. The scrub test above uses
  // a 64-char secret, well under MUSE_OUTPUT_TEXT_DETAIL_MAX_CHARS (500) — for
  // a short string, redact-then-slice and slice-then-redact are IDENTICAL, so
  // it cannot tell the two orders apart. This fixture is the discriminating
  // case: a 600-char string (over the bound) with a `sk-…` token straddling
  // the truncation cut. Under the OLD (slice-then-redact) order, `slice(-500)`
  // lands 10 characters into the token, stripping its `sk-` prefix — the part
  // `redactSecrets`'s `\bsk-…` pattern requires to match — so the token's
  // TAIL ("OULDNOTAPPEAR-0123456789") survives as an unredacted fragment.
  // Only redact-first removes the whole token before any slicing runs.
  test('scrubs a secret that straddles the output-text truncation cut', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-outputtext-straddle',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-outputtext-straddle',
      input: 'hi',
    });
    // 90 (89 'a' + a boundary space) + 34 (token) + 476 (a boundary space +
    // 475 'b') = 600 chars. `redactSecrets`'s `\bsk-…\b` pattern needs a
    // non-word character flanking the token to match at all — 'a'/'b'
    // directly abutting it would never match in EITHER order, which would
    // make this fixture accidentally non-discriminating rather than proving
    // anything. slice(-500) on the RAW 600-char string would keep indices
    // [100, 600) — 10 chars into the 34-char token (which occupies indices
    // [90, 124)).
    const prefix = `${'a'.repeat(89)} `;
    const token = 'sk-live-SHOULDNOTAPPEAR-0123456789';
    const suffix = ` ${'b'.repeat(475)}`;
    const straddling = `${prefix}${token}${suffix}`;
    expect(straddling.length).toBe(600);
    // Sanity: the token is genuinely redactable in isolation (proves the
    // fixture's boundaries are correct before trusting the straddle result).
    expect(redactSecrets(token)).toBe('[REDACTED]');

    harness.processes[0].stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'event',
        payload: {
          kind: 'run_terminal',
          terminal: 'failed',
          reason: null,
          text: straddling,
        },
      })}\n`,
    );
    await flushIo();

    const events = await drain(harness.iterator, 4, 'output text straddle');
    const error = events[3];
    expect(error.method).toBe('runtime.error');
    expect(error.message).not.toContain('sk-live-SHOULDNOTAPPEAR-0123456789');
    // The discriminating assertion: even the FRAGMENT a slice-then-redact
    // order would leave behind (the token's tail, stripped of its `sk-`
    // prefix) must not appear.
    expect(error.message).not.toContain('OULDNOTAPPEAR-0123456789');
    await expectNoFurtherEvent(harness.iterator, 'output text straddle');
  });

  // archive#3450 review round 2 (FIX A): `effect.terminal`/`effect.reason`
  // come from `extractString` — a bare `typeof` check with no length cap of
  // its own — and interpolate into `muse-terminal-not-completed`'s
  // `runtime.error.message` PREFIX, which neither `outputTextDetail`'s nor
  // `stderrDetail`'s bounds cover. An oversized `reason` must not reach the
  // published message unbounded (the exact route to the
  // `malformedRelevant`/`RuntimeAuthHealthEventDiagnostic` throw archive#3450
  // removed the OTHER route to).
  test('clamps an oversized terminal/reason before it reaches runtime.error.message', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-terminal-flood',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-terminal-flood',
      input: 'hi',
    });
    // Child-controlled JSONL, bounded only by MUSE_STDOUT_BUFFER_MAX_CHARS
    // (1MB) — 5001 chars here, far over MUSE_TERMINAL_FIELD_MAX_CHARS (200).
    const oversizedReason = `r${'z'.repeat(5000)}`;
    harness.processes[0].stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'event',
        payload: {
          kind: 'run_terminal',
          terminal: 'failed',
          reason: oversizedReason,
          text: null,
        },
      })}\n`,
    );
    await flushIo();

    const events = await drain(harness.iterator, 4, 'terminal flood');
    const error = events[3];
    expect(error.method).toBe('runtime.error');
    // Well under 4096 (MAX_RUNTIME_MESSAGE_LENGTH) — bounded to roughly
    // 2 * MUSE_TERMINAL_FIELD_MAX_CHARS plus the fixed wording, not 5000+.
    expect(error.message.length).toBeLessThan(1000);
    expect(error.message).not.toContain(oversizedReason);
    await expectNoFurtherEvent(harness.iterator, 'terminal flood');
  });

  test('carries the failure reason when a routine banner precedes it', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-stderr-banner',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-stderr-banner',
      input: 'hi',
    });
    // The real shape: ~300 chars of banner, then the one line that matters.
    harness.processes[0].stderr.write(
      `muse: workspace root: /${'w'.repeat(240)} (cwd default)\n`,
    );
    harness.processes[0].stderr.write(
      'muse: warning: rules file produced 67641 bytes, over the limit\n',
    );
    harness.processes[0].stderr.write(
      'model `station-probe-nonexistent-model` is not in the catalog\n',
    );
    await flushIo();
    harness.processes[0].exit(1);
    await flushIo();

    const events = await drain(harness.iterator, 4, 'stderr banner');
    const methods = events.map((event) => event.method);
    expect(methods).not.toContain('turn.completed');
    const error = events[3];
    expect(error.method).toBe('runtime.error');
    expect(error.message).toContain('is not in the catalog');
    await expectNoFurtherEvent(harness.iterator, 'stderr banner');
  });

  test('scrubs secret-shaped stderr before it reaches the event payload', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-stderr-secret',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-stderr-secret',
      input: 'hi',
    });
    harness.processes[0].stderr.write(
      'auth failed for api_key="sk-live-SHOULDNOTAPPEAR-0123456789"\n',
    );
    await flushIo();
    harness.processes[0].exit(1);
    await flushIo();

    const events = await drain(harness.iterator, 4, 'stderr secret');
    expect(events.map((event) => event.method)).not.toContain('turn.completed');
    const error = events[3];
    // Canonical events are persisted and rendered verbatim; redactDeep guards
    // the logging seam, not this one.
    expect(error.message).not.toContain('sk-live-SHOULDNOTAPPEAR-0123456789');
    await expectNoFurtherEvent(harness.iterator, 'stderr secret');
  });

  // archive#3450 review round 2 (FIX B): outputTextDetail folds
  // run_terminal.text into the SAME runtime.error.message string
  // stderrDetail's redacted tail lands in — it must be scrubbed too, or an
  // unredacted secret would sit right next to a redacted one in one string.
  test('scrubs secret-shaped run_terminal text before it reaches runtime.error.message', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-outputtext-secret',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-outputtext-secret',
      input: 'hi',
    });
    // No deltas streamed — run_terminal.text is the only carrier.
    harness.processes[0].stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'event',
        payload: {
          kind: 'run_terminal',
          terminal: 'failed',
          reason: null,
          text: 'auth error: api_key="sk-live-SHOULDNOTAPPEAR-0123456789" rejected',
        },
      })}\n`,
    );
    await flushIo();

    const events = await drain(harness.iterator, 4, 'output text secret');
    const error = events[3];
    expect(error.method).toBe('runtime.error');
    expect(error.message).not.toContain('sk-live-SHOULDNOTAPPEAR-0123456789');
    await expectNoFurtherEvent(harness.iterator, 'output text secret');
  });

  // archive#3450 review round 2, post-merge follow-up (commit b3ff4eb4c):
  // boundedTerminalField now scrubs too — `reason` is the field an engine is
  // most likely to fill with an auth error. Kept well under
  // MUSE_TERMINAL_FIELD_MAX_CHARS (200, ~66 chars here) so the clamp's own
  // head-truncation is not what removes the secret — this proves the SCRUB,
  // not the bound (which `clamps an oversized terminal/reason...` above
  // already proves separately).
  test('scrubs secret-shaped run_terminal.reason before it reaches runtime.error.message', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-terminal-reason-secret',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-terminal-reason-secret',
      input: 'hi',
    });
    const secretReason =
      'auth error: api_key="sk-live-SHOULDNOTAPPEAR-0123456789" rejected';
    expect(secretReason.length).toBeLessThan(200);
    harness.processes[0].stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'event',
        payload: {
          kind: 'run_terminal',
          terminal: 'failed',
          reason: secretReason,
          text: null,
        },
      })}\n`,
    );
    await flushIo();

    const events = await drain(harness.iterator, 4, 'terminal reason secret');
    const error = events[3];
    expect(error.method).toBe('runtime.error');
    expect(error.message).not.toContain('sk-live-SHOULDNOTAPPEAR-0123456789');
    await expectNoFurtherEvent(harness.iterator, 'terminal reason secret');
  });

  test('interrupt reclaims a session whose child wedged after run_terminal', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-wedged',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-wedged',
      input: 'hi',
    });
    // Terminal record arrives, but the child never exits.
    harness.processes[0].stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'event',
        payload: { kind: 'run_terminal', terminal: 'completed', text: 'ok' },
      })}\n`,
    );
    await flushIo();

    // The slot is deliberately still held (the child is alive), so stop must
    // be able to reclaim it — otherwise the session is blocked until the
    // turn deadline.
    await harness.adapter.interruptTurn('thread-wedged');
    await flushIo();
    await expect(
      harness.adapter.sendTurn({ threadId: 'thread-wedged', input: 'again' }),
    ).resolves.toBeDefined();
  });

  test('tolerates a malformed JSONL line and drops muse bookkeeping rows', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-malformed',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-malformed',
      input: 'hi',
    });
    await writeLines(
      harness.processes[0],
      '{"schema_version":1,"payload":{"kind":"run_out',
      'not json at all',
      MUSE_ECHO_RUN_STARTED,
      MUSE_ECHO_TASK_LIFECYCLE,
      MUSE_ECHO_OUTPUT_DELTA,
      MUSE_META_RUN_TERMINAL,
    );
    harness.processes[0].exit(0);
    await flushIo();

    const events = await drain(harness.iterator, 5, 'malformed');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'content.text-delta',
      'turn.completed',
    ]);
    expect(events[3].delta).toBe('echo: say hello');
  });

  test('interruptTurn kills the turn child and closes the turn exactly once', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-interrupt',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-interrupt',
      input: 'hi',
    });
    await writeLines(harness.processes[0], MUSE_META_OUTPUT_DELTA_1);
    await harness.adapter.interruptTurn('thread-interrupt', turn.turnId);
    await flushIo();

    expect(harness.processes[0].killed).toBe(true);
    expect(harness.processes[0].killSignals).toEqual(['SIGTERM']);

    const events = await drain(harness.iterator, 5, 'interrupt');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'content.text-delta',
      'turn.aborted',
    ]);
    expect(events[4]).toMatchObject({
      method: 'turn.aborted',
      turnId: turn.turnId,
      reason: 'interrupted',
    });
    // Still one session, still no session.exited from a killed turn child.
    expect(await harness.adapter.hasSession('thread-interrupt')).toBe(true);
    // archive#3450 review round 2 (FIX C): the `aborted` arm needs the same
    // ceiling as the `error` arm — this test's own name claims "exactly
    // once", which the fixed-count drain above does not compute on its own.
    await expectNoFurtherEvent(harness.iterator, 'interrupt');
  });

  test('stopSession publishes exactly one session.exited', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-stop',
    });
    await harness.adapter.sendTurn({ threadId: 'thread-stop', input: 'hi' });
    await harness.adapter.stopSession('thread-stop');
    // A second stop of the same thread must not publish a second exit.
    await harness.adapter.stopSession('thread-stop');
    await flushIo();

    const events = await drain(harness.iterator, 5, 'stop');
    const methods = events.map((event) => event.method);
    expect(methods).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'turn.aborted',
      'session.exited',
    ]);
    expect(
      methods.filter((method) => method === 'session.exited'),
    ).toHaveLength(1);
    expect(await harness.adapter.hasSession('thread-stop')).toBe(false);
    expect(await harness.adapter.listSessions()).toEqual([]);
  });

  test('rejects a duplicate session and an overlapping turn', async () => {
    const harness = createHarness();
    const input = { provider: 'muse' as const, threadId: 'thread-guard' };
    await harness.adapter.startSession(input);
    await expect(harness.adapter.startSession(input)).rejects.toThrow(
      'already exists',
    );
    await harness.adapter.sendTurn({ threadId: 'thread-guard', input: 'one' });
    await expect(
      harness.adapter.sendTurn({ threadId: 'thread-guard', input: 'two' }),
    ).rejects.toThrow('active turn');
    expect(harness.processes).toHaveLength(1);
    await expect(
      harness.adapter.sendTurn({ threadId: 'unknown-thread', input: 'x' }),
    ).rejects.toThrow('not found');
  });

  // Settling the TURN and freeing the SLOT are two different moments.
  // `run_terminal` settles the turn while the child is still running, so
  // freeing the slot there let a second `muse exec` start concurrently
  // against the same `--session-id` — and released the first child's
  // owned-process record while it could still wedge, defeating the point of
  // `spawnOwnedChild`.
  test('holds the turn slot until the child exits, not merely until run_terminal parses', async () => {
    const harness = createHarness({ settledChildExitWaitMs: 20 });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-slot',
    });
    await harness.adapter.sendTurn({ threadId: 'thread-slot', input: 'one' });
    await writeLines(harness.processes[0], MUSE_META_RUN_TERMINAL);

    // The turn has settled — `turn.completed` is already published — but the
    // child is still alive past the short wait: refused, retryably (#2300).
    await expect(
      harness.adapter.sendTurn({ threadId: 'thread-slot', input: 'two' }),
    ).rejects.toMatchObject({
      code: MUSE_TURN_SLOT_RELEASING_CODE,
      retryable: true,
    });
    expect(harness.processes).toHaveLength(1);
    expect(harness.released).toBe(0);

    harness.processes[0].exit(0);
    await flushIo();
    expect(harness.released).toBe(1);

    await harness.adapter.sendTurn({ threadId: 'thread-slot', input: 'two' });
    expect(harness.processes).toHaveLength(2);

    // Still exactly one terminal event for the first turn.
    const events = await drain(harness.iterator, 5, 'slot');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'turn.completed',
      'turn.started',
    ]);
  });

  test('refuses a turn once stopSession has begun, even after the child exits mid-stop', async () => {
    let releaseTermination = () => {};
    const terminationGate = new Promise<void>((resolve) => {
      releaseTermination = resolve;
    });
    const harness = createHarness({
      // The real ordering: the child dies (which frees the turn slot) while
      // `stopSession` is still awaiting termination.
      terminateProcess: async (processHandle: MuseProcessLike) => {
        processHandle.kill('SIGTERM');
        await terminationGate;
      },
    });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-stop-race',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-stop-race',
      input: 'one',
    });

    const stopping = harness.adapter.stopSession('thread-stop-race');
    await flushIo();
    // Without a `stopped` guard the exit handler has already re-opened the
    // turn slot, so this spawns a second `muse exec` that bills tokens and
    // publishes `content.text-delta`/`turn.completed` AFTER `session.exited`.
    // #2300 round 4: a pre-effect refusal, so the orchestration layer
    // retires the dispatch cleanly instead of recording it indeterminate.
    const refusal = await harness.adapter
      .sendTurn({ threadId: 'thread-stop-race', input: 'two' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(SendTurnRefusedError);
    expect((refusal as Error).message).toContain('stopped');
    expect((refusal as Error).message).not.toContain('thread-stop-race');
    expect(harness.processes).toHaveLength(1);

    releaseTermination();
    await stopping;
  });

  test('drops an over-long unterminated stdout line instead of buffering it without limit', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-stdout-flood',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-stdout-flood',
      input: 'hi',
    });

    // A child writing without newlines. stderr was already bounded; stdout
    // was not, so this grew for the life of the turn.
    //
    // The bound as shipped, as a literal: every other assertion here is
    // `MAX + 1`, which stays green at any value, so raising the ceiling on
    // how much child-controlled memory one unterminated line may hold should
    // be a visible decision in a diff.
    expect(MUSE_STDOUT_BUFFER_MAX_CHARS).toBe(1_048_576);
    harness.processes[0].stdout.write(
      'x'.repeat(MUSE_STDOUT_BUFFER_MAX_CHARS + 1),
    );
    await flushIo();
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('unterminated stdout line'),
    );

    // Dropping the partial line must not break the rest of the stream.
    await writeLines(harness.processes[0], MUSE_META_RUN_TERMINAL);
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 4, 'stdout flood');
    expect(events[3]).toMatchObject({
      method: 'turn.completed',
      finishReason: 'stop',
    });
  });

  test('terminates and settles a turn that outlives its deadline', async () => {
    const harness = createHarness({ turnTimeoutMs: 10 });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-deadline',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-deadline',
      input: 'hi',
    });

    // Nothing is written and the child never exits: without a deadline this
    // turn stays open forever — the last remaining `hasOpenTurn` hang path.
    // archive#3450: exactly one terminal event — `runtime.error` — never
    // `turn.completed` alongside it.
    const events = await drain(harness.iterator, 4, 'turn deadline');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'runtime.error',
    ]);
    expect(events[3]).toMatchObject({
      method: 'runtime.error',
      code: 'muse-turn-timeout',
      turnId: turn.turnId,
    });
    expect(harness.processes[0].killed).toBe(true);
    await expectNoFurtherEvent(harness.iterator, 'turn deadline');

    // The wedged child is reaped and the slot freed, so the session survives.
    await harness.adapter.sendTurn({
      threadId: 'thread-deadline',
      input: 'again',
    });
    expect(harness.processes).toHaveLength(2);
  });

  test('respondToRequest resolves publish-only — muse has no approval channel', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-approve',
    });
    await harness.adapter.respondToRequest(
      'thread-approve',
      'request-1',
      'decline',
    );
    const events = await drain(harness.iterator, 3, 'approval');
    expect(events[2]).toMatchObject({
      method: 'request.resolved',
      requestId: 'request-1',
      status: 'denied',
    });
  });

  test('stopAll closes the event stream', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-stop-all',
    });
    await harness.adapter.stopAll();
    await drain(harness.iterator, 3, 'stopAll');
    const done = await harness.iterator.next();
    expect(done.done).toBe(true);
  });
});

/**
 * #550 — the `STATION_E2E_MUSE_PROVIDER` knob, driven through the adapter's
 * OWN env seam and its `processFactory`, so the real argv the adapter would
 * spawn is what is asserted (not `buildMuseExecArgs` in isolation) and this
 * suite stays spawn-free.
 *
 * Before this, Station never passed `--provider`, so every muse turn ran
 * muse's default (`meta`) and cost a real key plus a network round trip —
 * which is why no journey ever ran one. The whole point of the knob is that
 * `echo` is reachable; the whole point of these tests is that nothing else is.
 */
describe('Muse startup-provider override', () => {
  /**
   * The two markers the CLI attests at spawn for a disposable E2E runtime,
   * spelled exactly as `run-e2e-suite.mjs` mints them for smoke-live
   * (`e2e-${suite}-${Date.now()}-${base36}`) and as
   * `packages/cli/src/commands/lifecycle.ts` writes `STATION_HOME_SOURCE`.
   * Without BOTH, the override is inert whatever it names.
   */
  const CONTAINED_MARKERS = {
    STATION_HOME_SOURCE: '--temp-home',
    STATION_INSTANCE_ID: 'e2e-smoke-live-1788039214298-qpssuh',
  } as const;

  /** A contained runtime naming `value` (or naming nothing). */
  function contained(value?: string): NodeJS.ProcessEnv {
    return {
      ...CONTAINED_MARKERS,
      ...(value === undefined ? {} : { [MUSE_PROVIDER_OVERRIDE_ENV]: value }),
    };
  }

  /** Every turn's argv, from an adapter constructed with `env`. */
  async function argvForEnv(env: NodeJS.ProcessEnv): Promise<string[]> {
    const harness = createHarness({ env });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-provider',
      cwd: '/tmp/project',
      modelId: 'muse-spark-1.2-contributor',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-provider',
      input: 'ping',
    });
    await writeLines(harness.processes[0], MUSE_META_RUN_TERMINAL);
    harness.processes[0].exit(0);
    await flushIo();
    return harness.spawnArgs[0];
  }

  test('unset: the argv is Station\'s default build, with no --provider', async () => {
    // The literal, not a subset — the claim is that the default path did not
    // move, so a `--provider` appearing anywhere fails here.
    expect(await argvForEnv({})).toEqual([
      'exec',
      '--json',
      '--session-id',
      'muse-session-fixed',
      '--model',
      'muse-spark-1.2-contributor',
      '--workspace',
      '/tmp/project',
      '--approval-mode',
      'never',
      '--',
      'ping',
    ]);
  });

  test('echo: the spawned argv carries --provider echo, and drops the model muse would refuse it with', async () => {
    const args = await argvForEnv(contained('echo'));
    expect(args).toEqual([
      'exec',
      '--json',
      '--session-id',
      'muse-session-fixed',
      '--provider',
      'echo',
      '--workspace',
      '/tmp/project',
      '--approval-mode',
      'never',
      '--',
      'ping',
    ]);
    // Adjacency, not mere presence: `--provider` and its value must be one
    // pair, or the flag would consume whatever argument follows it instead.
    expect(args[args.indexOf('--provider') + 1]).toBe('echo');
  });

  test('meta: named explicitly, and the model selection still rides along', async () => {
    const args = await argvForEnv(contained('meta'));
    expect(args).toEqual([
      'exec',
      '--json',
      '--session-id',
      'muse-session-fixed',
      '--provider',
      'meta',
      '--model',
      'muse-spark-1.2-contributor',
      '--workspace',
      '/tmp/project',
      '--approval-mode',
      'never',
      '--',
      'ping',
    ]);
  });

  /**
   * The value is spliced straight into the engine's option surface, so the
   * constraint is what stands between a misconfigured environment and an argv
   * injection into muse's own flags — `-w /etc` and `--workspace=/etc` are
   * state-mutating, and `--yolo` disables approval and the sandbox outright.
   */
  test.each([
    ['--workspace=/etc'],
    ['-w /etc'],
    ['--yolo'],
    ['echo --yolo'],
    ['Echo'],
    ['ECHO'],
    ['eco'],
    ['echo; rm -rf /'],
    ['  '],
    [''],
  ])('refuses %j: it never reaches argv', async (value) => {
    const args = await argvForEnv(contained(value));
    expect(args).not.toContain('--provider');
    expect(args).not.toContain(value);
    // Refused to the PRE-EXISTING default, not to some other provider: the
    // whole invocation is the unset one.
    expect(args).toEqual([
      'exec',
      '--json',
      '--session-id',
      'muse-session-fixed',
      '--model',
      'muse-spark-1.2-contributor',
      '--workspace',
      '/tmp/project',
      '--approval-mode',
      'never',
      '--',
      'ping',
    ]);
  });

  /**
   * Runs `count` turns and returns everything the adapter said while doing it.
   *
   * Turns, not construction: `station-runtime.ts` builds this adapter in a
   * field initializer whose logger closure reads a `this.logger` that is still
   * `undefined` at that moment, so a notice emitted from the constructor
   * reaches nothing in production. These tests therefore assert what a real
   * TURN emits — the only place the report can actually land.
   */
  async function noticesOverTurns(
    env: NodeJS.ProcessEnv,
    count = 1,
    // The terminal a turn in THIS mode really ends with, so the fixture says
    // what the test means: a run under `echo` settles on muse's echo
    // terminal, not on a meta one.
    terminal: string = MUSE_META_RUN_TERMINAL,
  ): Promise<Harness['logger']> {
    const harness = createHarness({ env });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-notice',
    });
    for (let index = 0; index < count; index += 1) {
      await harness.adapter.sendTurn({
        threadId: 'thread-notice',
        input: `turn ${index}`,
      });
      await writeLines(harness.processes[index], terminal);
      harness.processes[index].exit(0);
      await flushIo();
    }
    return harness.logger;
  }

  test('nothing is reported at construction, because nothing there would be heard', () => {
    const logger = { warn: vi.fn(), info: vi.fn() };
    new MuseAdapter({ logger, env: contained('--yolo') });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });

  test('a refused value is reported on the first turn, naming the vocabulary', async () => {
    const logger = await noticesOverTurns(contained('--yolo'));
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain(MUSE_PROVIDER_OVERRIDE_ENV);
    expect(logger.warn.mock.calls[0][0]).toContain('echo, meta');
    expect(logger.warn.mock.calls[0][1]).toEqual({
      reason: 'not-a-provider-mode',
      value: '--yolo',
    });
  });

  test('the report is once per process, not once per turn', async () => {
    const logger = await noticesOverTurns(contained('--yolo'), 3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  test('echo says so rather than letting a prompt echo pass for a model answer', async () => {
    const logger = await noticesOverTurns(
      contained('echo'),
      2,
      MUSE_ECHO_RUN_TERMINAL,
    );
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledTimes(1);
    expect(logger.info.mock.calls[0][0]).toContain(MUSE_PROVIDER_OVERRIDE_ENV);
    expect(logger.info.mock.calls[0][0]).toContain('echo');
  });

  test('the untouched default paths say nothing at all', async () => {
    for (const env of [{}, contained(), contained('meta')]) {
      const logger = await noticesOverTurns(env);
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    }
  });

  test('the refused value is scrubbed and bounded before it is logged', async () => {
    const logger = await noticesOverTurns(
      contained(`Bearer sk-not-a-provider ${'x'.repeat(400)}`),
    );
    const context = logger.warn.mock.calls[0][1] as { value: string };
    expect(context.value).not.toContain('sk-not-a-provider');
    expect(context.value.length).toBeLessThanOrEqual(
      MUSE_REFUSED_VALUE_MAX_CHARS,
    );
  });

  describe('resolveMuseProviderOverride', () => {
    test('accepts exactly muse’s own vocabulary and nothing else', () => {
      expect(MUSE_PROVIDER_MODES).toEqual(['echo', 'meta']);
      for (const mode of MUSE_PROVIDER_MODES) {
        expect(resolveMuseProviderOverride(contained(mode))).toBe(mode);
      }
      expect(resolveMuseProviderOverride({})).toBeUndefined();
    });

    test('trims surrounding whitespace rather than refusing a padded value', () => {
      expect(resolveMuseProviderOverride(contained(' echo\n'))).toBe('echo');
    });

    test('reports the refusal with the raw value it refused', () => {
      const onRefused = vi.fn();
      expect(
        resolveMuseProviderOverride(contained('openai'), onRefused),
      ).toBeUndefined();
      expect(onRefused).toHaveBeenCalledWith({
        reason: 'not-a-provider-mode',
        value: 'openai',
      });
    });

    test('an absent variable is not a refusal', () => {
      const onRefused = vi.fn();
      expect(resolveMuseProviderOverride({}, onRefused)).toBeUndefined();
      expect(onRefused).not.toHaveBeenCalled();
    });
  });

  /**
   * Containment. `src-server/index.ts` imports `dotenv/config`, so a `.env`
   * file in the server's cwd can put this variable into `process.env` on a
   * PERSISTENT home. The name must therefore not be sufficient — only the
   * conjunction with markers the CLI attests at spawn is.
   */
  describe('containment: the variable alone does nothing', () => {
    const UNCONTAINED: Array<[string, NodeJS.ProcessEnv]> = [
      ['no markers at all', {}],
      [
        'a persistent home under a runner-shaped instance id',
        { STATION_INSTANCE_ID: CONTAINED_MARKERS.STATION_INSTANCE_ID },
      ],
      [
        'a temp home with no instance id',
        { STATION_HOME_SOURCE: CONTAINED_MARKERS.STATION_HOME_SOURCE },
      ],
      [
        'a temp home under a NON-runner instance id',
        {
          STATION_HOME_SOURCE: '--temp-home',
          STATION_INSTANCE_ID: 'dogfood-desktop',
        },
      ],
      [
        'a runner-shaped instance id but a --home, not a temp home',
        {
          STATION_HOME_SOURCE: '--home',
          STATION_INSTANCE_ID: CONTAINED_MARKERS.STATION_INSTANCE_ID,
        },
      ],
      [
        'another suite’s instance namespace',
        {
          STATION_HOME_SOURCE: '--temp-home',
          STATION_INSTANCE_ID: 'e2e-product-1788039214298-qpssuh',
        },
      ],
    ];

    test.each(UNCONTAINED)(
      'a perfectly spelled `echo` is inert with %s',
      async (_label, markers) => {
        const args = await argvForEnv({
          ...markers,
          [MUSE_PROVIDER_OVERRIDE_ENV]: 'echo',
        });
        // Byte-identical to the unset invocation, model and all.
        expect(args).toEqual([
          'exec',
          '--json',
          '--session-id',
          'muse-session-fixed',
          '--model',
          'muse-spark-1.2-contributor',
          '--workspace',
          '/tmp/project',
          '--approval-mode',
          'never',
          '--',
          'ping',
        ]);
        expect(args).not.toContain('--provider');
      },
    );

    test('the full conjunction is what lets it through', async () => {
      expect(await argvForEnv(contained('echo'))).toContain('--provider');
    });

    test('an inert override says which state refused it, not that the value was wrong', async () => {
      const logger = await noticesOverTurns({
        ...CONTAINED_MARKERS,
        STATION_HOME_SOURCE: 'default',
        [MUSE_PROVIDER_OVERRIDE_ENV]: 'echo',
      });
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [message, context] = logger.warn.mock.calls[0] as [
        string,
        { reason: string; value: string },
      ];
      expect(context.reason).toBe('uncontained-environment');
      expect(context.value).toBe('echo');
      // The two refusals must not read alike: this one is about the RUNTIME,
      // and pointing an operator at muse's vocabulary would misdiagnose it.
      expect(message).toContain('disposable end-to-end runtime');
      expect(message).not.toContain(MUSE_PROVIDER_MODES.join(', '));
    });

    test('a bad value on a CONTAINED runtime still names the vocabulary', async () => {
      const logger = await noticesOverTurns(contained('--yolo'));
      const [message, context] = logger.warn.mock.calls[0] as [
        string,
        { reason: string },
      ];
      expect(context.reason).toBe('not-a-provider-mode');
      expect(message).toContain(MUSE_PROVIDER_MODES.join(', '));
      expect(message).not.toContain('disposable end-to-end runtime');
    });

    test('containment is checked before the vocabulary, so an uncontained typo names the runtime', () => {
      const onRefused = vi.fn();
      expect(
        resolveMuseProviderOverride(
          { [MUSE_PROVIDER_OVERRIDE_ENV]: '--yolo' },
          onRefused,
        ),
      ).toBeUndefined();
      expect(onRefused).toHaveBeenCalledWith({
        reason: 'uncontained-environment',
        value: '--yolo',
      });
    });

    test('an uncontained runtime with the variable UNSET is still silent', async () => {
      const logger = await noticesOverTurns({ STATION_HOME_SOURCE: 'default' });
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  /**
   * MEDIUM-1: under `echo` no `--model` is ever passed, so a session that
   * reports a model would be asserting something nothing applied.
   */
  describe('the session reports the model that actually ran', () => {
    async function sessionAfterTurn(
      env: NodeJS.ProcessEnv,
    ): Promise<{ started: any; afterTurn: any; listed: any }> {
      const harness = createHarness({ env });
      const started = await harness.adapter.startSession({
        provider: 'muse',
        threadId: 'thread-model-claim',
        cwd: '/tmp/project',
        modelId: 'muse-spark-1.2-contributor',
      });
      await harness.adapter.sendTurn({
        threadId: 'thread-model-claim',
        input: 'ping',
      });
      await writeLines(harness.processes[0], MUSE_ECHO_RUN_TERMINAL);
      harness.processes[0].exit(0);
      await flushIo();
      const listed = (await harness.adapter.listSessions())[0];
      return { started, afterTurn: listed, listed };
    }

    test('echo: no model is claimed, because none was applied', async () => {
      const { started, afterTurn } = await sessionAfterTurn(contained('echo'));
      expect(started.model).toBeUndefined();
      expect(afterTurn.model).toBeUndefined();
    });

    test('unset: the selection is reported exactly as before', async () => {
      const { started, afterTurn } = await sessionAfterTurn({});
      expect(started.model).toBe('muse-spark-1.2-contributor');
      expect(afterTurn.model).toBe('muse-spark-1.2-contributor');
    });

    test('meta: naming the provider explicitly changes nothing about the claim', async () => {
      const { afterTurn } = await sessionAfterTurn(contained('meta'));
      expect(afterTurn.model).toBe('muse-spark-1.2-contributor');
    });

    test('echo: an INERT override still reports the model, because the model really did apply', async () => {
      const { afterTurn } = await sessionAfterTurn({
        [MUSE_PROVIDER_OVERRIDE_ENV]: 'echo',
      });
      expect(afterTurn.model).toBe('muse-spark-1.2-contributor');
    });

    test('echo: a per-turn model request is remembered but never claimed as applied', async () => {
      const harness = createHarness({ env: contained('echo') });
      await harness.adapter.startSession({
        provider: 'muse',
        threadId: 'thread-model-turn',
      });
      await harness.adapter.sendTurn({
        threadId: 'thread-model-turn',
        input: 'ping',
        modelId: 'muse-spark-1.2-contributor',
      });
      // The request never reached argv…
      expect(harness.spawnArgs[0]).not.toContain('--model');
      // …so the session does not report it as the model that ran.
      expect((await harness.adapter.listSessions())[0].model).toBeUndefined();
    });
  });
});

// Nothing about adapter registration is compiler-enforced: the runtime wires
// the adapter set through an array literal and the capability matrix through a
// plain record key, so an omission is silent everywhere except here.
describe('Muse registration', () => {
  test('the built adapter set registered by the runtime includes museAdapter', () => {
    const source = readFileSync(
      new URL('../../runtime/bootstrap/runtime-initialize.ts', import.meta.url),
      'utf8',
    );
    const registration = source.match(
      /registerProviderAdapters\(\s*\[([\s\S]*?)\]/,
    );
    expect(registration).not.toBeNull();
    const registered = registration![1]
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
    expect(registered).toContain('museAdapter');
    expect(registered).toContain('codexAdapter');
    expect(registered).toContain('stationAgentAdapter');
    expect(registered).not.toContain('bedrockAdapter');
    expect(registered).not.toContain('ollamaAdapter');
  });

  test('resolveEngineCapabilityMatrix does not fall back to UNKNOWN for muse', () => {
    expect(ENGINE_CAPABILITY_MATRICES.muse).toBeDefined();
    const matrix = resolveEngineCapabilityMatrix('muse', {
      type: 'muse',
    });
    expect(matrix).toBe(ENGINE_CAPABILITY_MATRICES.muse);
    expect(matrix).not.toBe(UNKNOWN_EXTERNAL_ENGINE_MATRIX);
    expect(matrix.engineId).toBe('muse');
    expect(engineDisplayLabel(matrix.engineId)).toBe('Muse Code');
  });

  test('muse counts as chat-capable while claiming no unproven delivery surface', () => {
    const matrix = ENGINE_CAPABILITY_MATRICES.muse;
    // `engineCanDeliverChat` (system-status-routes.ts) keys off exactly this
    // cell, so an "everything unsupported" matrix would silently make muse
    // permanently un-chat-ready.
    expect(matrix.modelSelection).toEqual({
      state: 'session',
      channel: 'flag',
    });
    expect(matrix.systemPrompt.state).toBe('unsupported');
    expect(matrix.toolServers.state).toBe('unsupported');
    expect(matrix.skills.state).toBe('unsupported');
    expect(matrix.commands.state).toBe('unsupported');
  });

  // The matrix cell above is a CLAIM. This is the gate that decides whether a
  // model request ever reaches `buildMuseExecArgs`:
  // `ModelLaunchPlanning.assertAcceptedModelLaunchPlan` calls exactly this
  // function with exactly this declaration, and an `unavailable` plan throws
  // before the adapter is invoked at all. Passing a `modelId` straight to
  // `sendTurn` (as the rest of this suite does) bypasses it entirely, which
  // is why the matrix could claim `session`/`flag` while every model request
  // was refused.
  test('the model-launch gate admits a muse model request at start and per turn', () => {
    const adapter = new MuseAdapter();
    expect(adapter.metadata.modelLaunch).toEqual(MUSE_MODEL_LAUNCH);
    expect(
      resolveModelLaunchPlan(adapter.metadata.modelLaunch, {
        lifecycle: 'start',
        requestedModelId: 'muse-spark-1.2-contributor',
      }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-declared' });
    expect(
      resolveModelLaunchPlan(adapter.metadata.modelLaunch, {
        lifecycle: 'turn',
        requestedModelId: 'muse-spark-1.2-contributor',
      }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-declared' });
    // Omission retains the session's accepted selector, which is exactly what
    // `sendTurn` does (`input.modelId ?? record.modelId`).
    expect(
      resolveModelLaunchPlan(adapter.metadata.modelLaunch, {
        lifecycle: 'turn',
        retainedModelId: 'muse-spark-1.2-contributor',
      }),
    ).toEqual({ kind: 'engine-selected', evidence: 'adapter-retained' });
    // Resume is claimed nowhere for muse (no `resume` capability, no
    // `adoptSession`), so the declaration must not grant it either.
    expect(
      resolveModelLaunchPlan(adapter.metadata.modelLaunch, {
        lifecycle: 'resume',
        requestedModelId: 'muse-spark-1.2-contributor',
      }),
    ).toEqual({ kind: 'unavailable', reason: 'resume-override-unsupported' });
  });

  // Absent from `PROVIDER_MODEL_OPTION_SUPPORT` means "no known restriction",
  // so a caller's options were accepted and then silently ignored — the
  // adapter reads `modelOptions` nowhere at all.
  test('rejects modelOptions muse cannot apply instead of accepting them silently', () => {
    expect(
      unsupportedModelOptionKeys('muse', {
        approvalMode: 'ask',
        effort: 'high',
      }),
    ).toEqual(['approvalMode', 'effort']);
    expect(unsupportedModelOptionKeys('muse', {})).toEqual([]);
  });
});

/**
 * These derive readiness from the credential STORE, so they must hold on a
 * host that has no `muse` at all — the CI case.
 *
 * That is not free: `buildCliRuntimePrerequisites` early-returns
 * `muse-auth: 'missing'` when the binary cannot be found, BEFORE consulting
 * any derivation. An earlier revision of these tests relied on the ambient
 * host, so on CI two of them failed outright and the "discriminating case"
 * passed through that early return — asserting `missing` while proving
 * nothing about the derivation. Both the binary lookup and the version probe
 * are therefore injected: every case below exercises the installed branch,
 * with no PATH lookup and no spawn (this suite is deliberately spawn-free).
 */
describe('MuseAdapter credential detection', () => {
  const noFile = () => false;
  const yesFile = () => true;
  const installedBinary = () => '/fake/prefix/bin/muse';
  const versionProbe = async () => ({
    stdout: 'Muse Code 0.1.0 (0.1.0-R708.1)',
    stderr: '',
    code: 0,
  });

  function credentialAdapter(options: Partial<MuseAdapterOptions>) {
    return new MuseAdapter({
      findBinary: installedBinary,
      runCommand: versionProbe,
      ...options,
    });
  }

  it('reports authenticated from META_API_KEY without touching the filesystem', async () => {
    const adapter = credentialAdapter({
      env: { META_API_KEY: 'sk-test' },
      credentialFileExists: () => {
        throw new Error('must not stat when the env key is present');
      },
    });
    const prerequisites = await adapter.getPrerequisites();
    const auth = prerequisites.find((p) => p.id === 'muse-auth');
    expect(auth?.status).toBe('installed');
    // Whatever else this reports, the key itself never rides a prerequisite.
    expect(JSON.stringify(prerequisites)).not.toContain('sk-test');
  });

  it('reports unauthenticated when no key and no credential file exist', async () => {
    const adapter = credentialAdapter({
      env: {},
      credentialFileExists: noFile,
    });
    const prerequisites = await adapter.getPrerequisites();
    // The discriminating case, and it only discriminates because the binary
    // is present here: the CLI runs cleanly (`code: 0`), so a
    // version-probe-derived auth state would report `installed`.
    expect(prerequisites.find((p) => p.id === 'muse-cli')?.status).toBe(
      'installed',
    );
    expect(prerequisites.find((p) => p.id === 'muse-auth')?.status).toBe(
      'missing',
    );
  });

  it('reports authenticated when the credential file is present', async () => {
    const adapter = credentialAdapter({
      env: {},
      credentialFileExists: yesFile,
    });
    const prerequisites = await adapter.getPrerequisites();
    expect(prerequisites.find((p) => p.id === 'muse-auth')?.status).toBe(
      'installed',
    );
  });

  it('never spawns and never consults PATH while deriving readiness', async () => {
    const findBinary = vi.fn(installedBinary);
    const runCommand = vi.fn(versionProbe);
    const credentialFileExists = vi.fn(noFile);
    const adapter = new MuseAdapter({
      findBinary,
      runCommand,
      env: { XDG_CONFIG_HOME: '/xdg' },
      credentialFileExists,
    });
    await adapter.getPrerequisites();
    expect(findBinary).toHaveBeenCalledWith('muse');
    // The injected probe stands in for every process this would otherwise
    // start; nothing else may reach `execFile`.
    expect(runCommand).toHaveBeenCalledWith(
      '/fake/prefix/bin/muse',
      ['--version'],
      undefined,
    );
    // Presence only — the credential file is stat'd, never opened.
    expect(credentialFileExists).toHaveBeenCalledWith('/xdg/muse/auth.json');
  });

  it('reports missing when muse itself is absent', async () => {
    const adapter = new MuseAdapter({
      findBinary: () => null,
      runCommand: async () => {
        throw new Error('must not probe a binary that does not exist');
      },
      env: { META_API_KEY: 'sk-test' },
      credentialFileExists: yesFile,
    });
    const prerequisites = await adapter.getPrerequisites();
    expect(prerequisites.find((p) => p.id === 'muse-cli')?.status).toBe(
      'missing',
    );
    expect(prerequisites.find((p) => p.id === 'muse-auth')?.status).toBe(
      'missing',
    );
  });

  it('honors XDG_CONFIG_HOME when locating the credential store', () => {
    expect(museCredentialPath({ XDG_CONFIG_HOME: '/xdg' })).toBe(
      '/xdg/muse/auth.json',
    );
    expect(museCredentialPath({})).toContain('/.config/muse/auth.json');
  });
});

describe('MuseAdapter owned-child registration', () => {
  test('retries the original survivor during forced stop and retains session ownership when termination remains unconfirmed', async () => {
    let terminationAttempts = 0;
    const harness = createHarness({
      // Long on purpose: a refusal for an unconfirmed-stopped child must not
      // wait for an exit nothing will produce (asserted below).
      settledChildExitWaitMs: 60_000,
      // Termination that never confirms: the child is still alive afterwards.
      terminateProcess: async () => {
        terminationAttempts += 1;
        throw new Error('child still alive');
      },
    });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-survivor',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-survivor',
      input: 'hi',
    });
    await expect(
      harness.adapter.interruptTurn('thread-survivor'),
    ).resolves.toEqual({
      outcome: 'termination-unconfirmed',
      turnId: expect.any(String),
    });
    await flushIo();

    // The original handle remains in the slot. A replacement cannot steal the
    // forced-stop target while the old child is still alive.
    // #2300 round 3: Station already failed to confirm this child stopped,
    // so nothing frees the slot on its own — a definitive pre-effect
    // refusal, never the retryable slot-releasing one.
    const refusal = await Promise.race([
      harness.adapter
        .sendTurn({ threadId: 'thread-survivor', input: 'again' })
        .then(
          () => undefined,
          (error: unknown) => error,
        ),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 500)),
    ]);
    expect(refusal).not.toBe('still waiting');
    expect(refusal).toBeInstanceOf(SendTurnRefusedError);
    expect(refusal).not.toBeInstanceOf(MuseTurnSlotReleasingError);
    expect((refusal as Error).message).toContain('could not confirm');

    await expect(
      harness.adapter.stopSession('thread-survivor'),
    ).rejects.toThrow('could not confirm termination');
    expect(terminationAttempts).toBe(2);
    expect(await harness.adapter.hasSession('thread-survivor')).toBe(true);
    expect(harness.processes).toHaveLength(1);
    // The un-exited child stays registered, or Station's crash cleanup could
    // never reap it.
    expect(harness.released).toBe(0);
  });

  test('releases the owned-process record once the child actually exits', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-exits',
    });
    await harness.adapter.sendTurn({ threadId: 'thread-exits', input: 'hi' });
    harness.processes[0].exit(0);
    await flushIo();
    expect(harness.released).toBe(1);
  });
});

describe('MuseAdapter tool events', () => {
  test('publishes tool.completed from a real tool_result, keyed by muse call_id', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-tools',
    });
    await harness.adapter.sendTurn({ threadId: 'thread-tools', input: 'go' });
    await writeLines(harness.processes[0], MUSE_TOOL_RESULT);

    const events = await drain(harness.iterator, 4, 'tool events');
    const tool = events[3];
    expect(tool.method).toBe('tool.completed');
    expect(tool.toolCallId).toBe('call_019feab717fd75639b5a008d7b2c3e09');
    expect(tool.toolName).toBe('read_file');
    expect(tool.status).toBe('success');
    // A distinct itemId keeps the tool row from merging into the assistant
    // text item, whose id is minted per turn.
    expect(tool.itemId).not.toBe(events[2]?.itemId);
  });

  test('oversized escaped Muse tool output persists with a receipt and preserves completion', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'bounded-tool',
    });
    await harness.adapter.sendTurn({ threadId: 'bounded-tool', input: 'go' });
    const record = JSON.parse(MUSE_TOOL_RESULT);
    record.payload.text = `${'\u0000😀'.repeat(30000)}END-OF-RESULT`;
    await writeLines(
      harness.processes[0],
      JSON.stringify(record),
      MUSE_ECHO_RUN_TERMINAL,
    );
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(
      harness.iterator,
      5,
      'bounded output and terminal',
    );
    const tool = events.find((event) => event.method === 'tool.completed');
    expect(tool.output).toContain('END-OF-RESULT');
    expect(tool.outputReceipt).toMatchObject({
      truncated: true,
      fullOutput: 'unavailable',
    });
    expect(events.at(-1)?.method).toBe('turn.completed');
    const dir = mkdtempSync(join(tmpdir(), 'muse-tool-ingress-'));
    const store = new EventStore(join(dir, 'orchestration.sqlite'));
    try {
      for (const event of events)
        expect(() => store.appendEvent(event)).not.toThrow();
      expect(store.listEvents('bounded-tool').at(-1)?.payload.method).toBe(
        'turn.completed',
      );
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
      await harness.adapter.stopAll();
    }
  });

  test('#2308: a real muse 1.3 bash turn publishes tool.started, then its tool.completed under the same id', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-tools-start',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-tools-start',
      input: 'go',
    });
    await writeLines(harness.processes[0], ...MUSE_13_BASH_TOOL_TURN_LINES);

    const events = await drain(harness.iterator, 7, 'muse 1.3 tool turn');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'tool.started',
      'tool.completed',
      'content.text-delta',
      'turn.completed',
    ]);
    const started = events[3];
    expect(started).toEqual({
      eventId: expect.any(String),
      provider: 'muse',
      threadId: 'thread-tools-start',
      createdAt: expect.any(String),
      method: 'tool.started',
      turnId: turn.turnId,
      itemId: `tool:${MUSE_13_BASH_CALL_ID}`,
      toolCallId: MUSE_13_BASH_CALL_ID,
      toolName: 'bash',
    });
    // Nothing in the live stream carries arguments at start.
    expect(started).not.toHaveProperty('arguments');
    expect(events[4]).toMatchObject({
      method: 'tool.completed',
      turnId: turn.turnId,
      itemId: started.itemId,
      toolCallId: MUSE_13_BASH_CALL_ID,
      toolName: 'bash',
      status: 'success',
    });
    await expectNoFurtherEvent(harness.iterator, 'muse 1.3 tool turn');
    await harness.adapter.stopAll();
  });

  test('#2308: a stream without task_kind/idempotency_key (older muse) publishes no tool.started', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-tools-old',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-tools-old',
      input: 'go',
    });
    const stripped = MUSE_13_BASH_TOOL_TURN_LINES.map((line) => {
      const decoded = JSON.parse(line);
      const event = decoded.payload?.event;
      if (event && typeof event === 'object') {
        delete event.task_kind;
        delete event.idempotency_key;
      }
      return JSON.stringify(decoded);
    });
    await writeLines(harness.processes[0], ...stripped);

    const events = await drain(harness.iterator, 6, 'old-shape tool turn');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'tool.completed',
      'content.text-delta',
      'turn.completed',
    ]);
    await expectNoFurtherEvent(harness.iterator, 'old-shape tool turn');
    await harness.adapter.stopAll();
  });

  test('#2308: a started tool with no result is closed as unresolved before the turn terminal', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-tools-open',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-tools-open',
      input: 'go',
    });
    // Everything through the bash task's `started` (line 26), then straight
    // to the run's terminal: the tool never reports a result.
    await writeLines(
      harness.processes[0],
      ...MUSE_13_BASH_TOOL_TURN_LINES.slice(0, 26),
      MUSE_13_BASH_TOOL_TURN_LINES[54]!,
    );

    const events = await drain(harness.iterator, 6, 'open tool at terminal');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'tool.started',
      'tool.completed',
      'turn.completed',
    ]);
    expect(events[4]).toMatchObject({
      method: 'tool.completed',
      turnId: turn.turnId,
      itemId: `tool:${MUSE_13_BASH_CALL_ID}`,
      toolCallId: MUSE_13_BASH_CALL_ID,
      toolName: 'bash',
      status: 'unresolved',
      output: UNRESOLVED_TURN_TOOL_OUTPUT,
    });
    await expectNoFurtherEvent(harness.iterator, 'open tool at terminal');
    await harness.adapter.stopAll();
  });

  test('#2269: a tool in flight is never idle-killed, however long it runs; its result re-arms idle', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ turnIdleTimeoutMs: 1_000 });
      await harness.adapter.startSession({
        provider: 'muse',
        threadId: 'thread-tools-idle',
      });
      await harness.adapter.sendTurn({
        threadId: 'thread-tools-idle',
        input: 'go',
      });
      const emit = async (...lines: string[]) => {
        for (const line of lines)
          harness.processes[0].stdout.write(`${line}\n`);
        await vi.advanceTimersByTimeAsync(0);
      };
      // Lines 1-26: through the bash task's `started` -> tool in flight.
      await emit(...MUSE_13_BASH_TOOL_TURN_LINES.slice(0, 26));
      // Fifty idle windows of silence with the tool still running: nothing
      // may end the turn (the old policy would have killed it at t=1000).
      await vi.advanceTimersByTimeAsync(50_000);
      expect(harness.released).toBe(0);
      expect(harness.processes[0].killed).toBe(false);
      // The result (line 29) closes the tool and re-arms idle from now...
      await emit(...MUSE_13_BASH_TOOL_TURN_LINES.slice(26, 29));
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.released).toBe(0);
      // ...so a full window of silence AFTER it ends the turn as idle.
      await vi.advanceTimersByTimeAsync(200);
      expect(harness.released).toBe(1);
      const events = await drain(harness.iterator, 6, 'tool in flight idle');
      expect(events.map((event) => event.method)).toEqual([
        'session.started',
        'session.configured',
        'turn.started',
        'tool.started',
        'tool.completed',
        'runtime.error',
      ]);
      expect(events[4]).toMatchObject({ status: 'success' });
      expect(events[5]).toMatchObject({ code: MUSE_TURN_IDLE_TIMEOUT_CODE });
    } finally {
      vi.useRealTimers();
    }
  });

  describe('#2308 review round: tool lifecycle edges through the adapter', () => {
    const LINES = MUSE_13_BASH_TOOL_TURN_LINES;
    const BASH_TASK_ID = '01a0cab2-5d4f-7600-886e-a77b38b198a3';
    /** The capture's bash tool, re-keyed to another task and call id. */
    const bashTool = (taskId: string, callId: string) => {
      const sub = (line: string) =>
        line
          .split(BASH_TASK_ID)
          .join(taskId)
          .split(MUSE_13_BASH_CALL_ID)
          .join(callId);
      const finalPhase = (phase: string) =>
        sub(LINES[27]!).replace(
          '"event":{"kind":"completed"',
          `"event":{"kind":"${phase}"`,
        );
      return {
        start: LINES.slice(21, 26).map(sub),
        completed: finalPhase('completed'),
        failed: finalPhase('failed'),
        cancelled: finalPhase('cancelled'),
        result: sub(LINES[28]!),
      };
    };

    async function startTurn(threadId: string, idleMs = 1_000) {
      const harness = createHarness({ turnIdleTimeoutMs: idleMs });
      await harness.adapter.startSession({ provider: 'muse', threadId });
      const turn = await harness.adapter.sendTurn({ threadId, input: 'go' });
      const emit = async (...lines: string[]) => {
        for (const line of lines)
          harness.processes[0].stdout.write(`${line}\n`);
        if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
        else await flushIo();
      };
      return { harness, turn, emit };
    }

    afterEach(() => {
      vi.useRealTimers();
    });

    test('baseline: a child lingering after run_terminal is reaped one idle window after its last activity', async () => {
      // Pins origin/main's behaviour (verified there before this branch's
      // change): settle does not clear the idle timer, so it reaps the child.
      vi.useFakeTimers();
      const { harness, emit } = await startTurn('thread-linger-base');
      await emit(LINES[54]!); // run_terminal; the child never exits
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.processes[0].killed).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(harness.processes[0].killed).toBe(true);
      expect(harness.released).toBe(1);
    });

    test('a child lingering after run_terminal with a tool in flight is still reaped one idle window after settle', async () => {
      vi.useFakeTimers();
      const { harness, emit } = await startTurn('thread-linger-tool');
      await emit(...LINES.slice(0, 26)); // bash tool started, never resolves
      await vi.advanceTimersByTimeAsync(5_000);
      await emit(LINES[54]!); // run_terminal; the child never exits
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.processes[0].killed).toBe(false);
      await vi.advanceTimersByTimeAsync(200);
      expect(harness.processes[0].killed).toBe(true);
      expect(harness.released).toBe(1);
      const events = await drain(harness.iterator, 6, 'linger with tool');
      expect(events.slice(3).map((e) => [e.method, e.status])).toEqual([
        ['tool.started', undefined],
        ['tool.completed', 'unresolved'],
        ['turn.completed', undefined],
      ]);
    });

    test('parallel tools: idle stays disarmed until the LAST open call resolves', async () => {
      vi.useFakeTimers();
      const { harness, emit } = await startTurn('thread-parallel');
      const a = bashTool('task-a', 'call_a');
      const b = bashTool('task-b', 'call_b');
      await emit(...a.start, ...b.start);
      // First result while the second call is still open: still no idle.
      await emit(a.completed, a.result);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.released).toBe(0);
      // Second result: idle re-arms from now and fires one window later.
      await emit(b.completed, b.result);
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.released).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(harness.released).toBe(1);
      const events = await drain(harness.iterator, 8, 'parallel tools');
      expect(
        events.slice(3).map((e) => [e.method, e.toolCallId ?? e.code]),
      ).toEqual([
        ['tool.started', 'call_a'],
        ['tool.started', 'call_b'],
        ['tool.completed', 'call_a'],
        ['tool.completed', 'call_b'],
        ['runtime.error', MUSE_TURN_IDLE_TIMEOUT_CODE],
      ]);
    });

    test('a cancelled task closes its open tool as cancelled and re-arms idle', async () => {
      vi.useFakeTimers();
      const { harness, turn, emit } = await startTurn('thread-cancel');
      const tool = bashTool('task-c', 'call_c');
      await emit(...tool.start);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.released).toBe(0);
      await emit(tool.cancelled);
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.released).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(harness.released).toBe(1);
      const events = await drain(harness.iterator, 6, 'cancelled tool');
      expect(events.slice(3).map((e) => e.method)).toEqual([
        'tool.started',
        'tool.completed',
        'runtime.error',
      ]);
      expect(events[4]).toMatchObject({
        toolCallId: 'call_c',
        toolName: 'bash',
        turnId: turn.turnId,
        itemId: 'tool:call_c',
        status: 'cancelled',
        output: MUSE_CANCELLED_TOOL_OUTPUT,
      });
      expect(events[5]).toMatchObject({ code: MUSE_TURN_IDLE_TIMEOUT_CODE });
    });

    test('a failed task keeps its call open and pairable for the result that follows', async () => {
      vi.useFakeTimers();
      const { harness, emit } = await startTurn('thread-failed-result', 60_000);
      const tool = bashTool('task-f', 'call_f');
      const nameless = tool.result.replace('"tool_name":"bash",', '');
      await emit(...tool.start, tool.failed, nameless);
      await emit(LINES[54]!);
      const events = await drain(harness.iterator, 6, 'failed then result');
      expect(events.slice(3).map((e) => [e.method, e.status])).toEqual([
        ['tool.started', undefined],
        // Paired by call id (the result has no name), not closed at `failed`.
        ['tool.completed', 'success'],
        ['turn.completed', undefined],
      ]);
      expect(events[4]).toMatchObject({
        toolCallId: 'call_f',
        toolName: 'bash',
      });
    });

    test("a failed task with no result stops holding idle disarmed; settle reports muse's failure", async () => {
      vi.useFakeTimers();
      const { harness, emit } = await startTurn('thread-failed-no-result');
      const tool = bashTool('task-f', 'call_f');
      await emit(...tool.start);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.released).toBe(0);
      // `failed`, and muse never emits the tool_result.
      await emit(tool.failed);
      await vi.advanceTimersByTimeAsync(900);
      expect(harness.released).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(harness.released).toBe(1);
      const events = await drain(harness.iterator, 6, 'failed no result');
      expect(
        events.slice(3).map((e) => [e.method, e.status ?? e.code]),
      ).toEqual([
        ['tool.started', undefined],
        // muse said `failed`; only the missing result is new information.
        ['tool.completed', 'error'],
        ['runtime.error', MUSE_TURN_IDLE_TIMEOUT_CODE],
      ]);
      expect(events[4].output).toBe(MUSE_FAILED_NO_RESULT_OUTPUT);
    });

    test('at settle, a completed task with no result reports success; a still-running one stays unresolved', async () => {
      const { harness, emit } = await startTurn(
        'thread-finished-no-result',
        60_000,
      );
      const done = bashTool('task-d', 'call_d');
      const running = bashTool('task-r', 'call_r');
      await emit(...done.start, ...running.start, done.completed);
      await emit(LINES[54]!); // run_terminal; no tool_result for either
      const events = await drain(harness.iterator, 8, 'finished no result');
      const closes = events.filter((e) => e.method === 'tool.completed');
      expect(closes.map((e) => [e.toolCallId, e.status, e.output])).toEqual([
        ['call_d', 'success', MUSE_FINISHED_NO_RESULT_OUTPUT],
        ['call_r', 'unresolved', UNRESOLVED_TURN_TOOL_OUTPUT],
      ]);
      expect(events.at(-1)?.method).toBe('turn.completed');
      await expectNoFurtherEvent(harness.iterator, 'finished no result');
    });

    test('a late named result after a cancel does not publish a second completion', async () => {
      const { harness, emit } = await startTurn('thread-cancel-late', 60_000);
      const tool = bashTool('task-c', 'call_c');
      await emit(...tool.start, tool.cancelled, tool.result);
      await emit(LINES[54]!);
      const events = await drain(harness.iterator, 6, 'cancel then result');
      expect(events.slice(3).map((e) => [e.method, e.status])).toEqual([
        ['tool.started', undefined],
        ['tool.completed', 'cancelled'],
        ['turn.completed', undefined],
      ]);
      await expectNoFurtherEvent(harness.iterator, 'cancel then result');
    });

    test("a still-running tool keeps idle disarmed even after another tool's task failed", async () => {
      vi.useFakeTimers();
      const { harness, emit } = await startTurn('thread-failed-and-running');
      const failed = bashTool('task-f', 'call_f');
      const running = bashTool('task-r', 'call_r');
      await emit(...failed.start, ...running.start, failed.failed);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(harness.released).toBe(0);
      await emit(running.completed, running.result);
      await vi.advanceTimersByTimeAsync(1_100);
      expect(harness.released).toBe(1);
    });

    // Verifier probes P1-P4 (AC3): every settle path closes an open tool
    // BEFORE the turn's terminal, not only run_terminal.
    test('P1: child exit without a terminal closes the open tool as unresolved first', async () => {
      const h = createHarness();
      await h.adapter.startSession({ provider: 'muse', threadId: 'p1' });
      await h.adapter.sendTurn({ threadId: 'p1', input: 'go' });
      await writeLines(h.processes[0], ...LINES.slice(0, 26));
      h.processes[0].exit(0);
      await flushIo();
      const events = await drain(h.iterator, 6, 'p1');
      expect(events.map((e) => e.method)).toEqual([
        'session.started',
        'session.configured',
        'turn.started',
        'tool.started',
        'tool.completed',
        'runtime.error',
      ]);
      expect(events[4]).toMatchObject({
        status: 'unresolved',
        toolCallId: MUSE_13_BASH_CALL_ID,
        output: UNRESOLVED_TURN_TOOL_OUTPUT,
      });
      expect(events[5]).toMatchObject({ code: 'muse-exit-without-terminal' });
      await expectNoFurtherEvent(h.iterator, 'p1');
    });

    test('P2: interrupt closes the open tool as unresolved before turn.aborted', async () => {
      const h = createHarness();
      await h.adapter.startSession({ provider: 'muse', threadId: 'p2' });
      const turn = await h.adapter.sendTurn({ threadId: 'p2', input: 'go' });
      await writeLines(h.processes[0], ...LINES.slice(0, 26));
      const result = await h.adapter.interruptTurn('p2', turn.turnId);
      expect(result.outcome).toBe('cancelled');
      const events = await drain(h.iterator, 6, 'p2');
      expect(events.map((e) => e.method)).toEqual([
        'session.started',
        'session.configured',
        'turn.started',
        'tool.started',
        'tool.completed',
        'turn.aborted',
      ]);
      expect(events[4]).toMatchObject({
        status: 'unresolved',
        toolCallId: MUSE_13_BASH_CALL_ID,
      });
      await expectNoFurtherEvent(h.iterator, 'p2');
    });

    test('P3: a declared budget ends a turn with a tool in flight; the tool is closed first', async () => {
      vi.useFakeTimers();
      const h = createHarness({
        turnTimeoutMs: 5_000,
        turnIdleTimeoutMs: 1_000,
      });
      await h.adapter.startSession({ provider: 'muse', threadId: 'p3' });
      await h.adapter.sendTurn({ threadId: 'p3', input: 'go' });
      for (const line of LINES.slice(0, 26))
        h.processes[0].stdout.write(`${line}\n`);
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(4_900);
      expect(h.released).toBe(0);
      await vi.advanceTimersByTimeAsync(200);
      expect(h.released).toBe(1);
      const events = await drain(h.iterator, 6, 'p3');
      expect(events.map((e) => e.method)).toEqual([
        'session.started',
        'session.configured',
        'turn.started',
        'tool.started',
        'tool.completed',
        'runtime.error',
      ]);
      expect(events[4]).toMatchObject({ status: 'unresolved' });
      expect(events[5]).toMatchObject({ code: MUSE_TURN_TOTAL_TIMEOUT_CODE });
    });

    test('P4: stopSession closes the open tool as unresolved before turn.aborted', async () => {
      const h = createHarness();
      await h.adapter.startSession({ provider: 'muse', threadId: 'p4' });
      await h.adapter.sendTurn({ threadId: 'p4', input: 'go' });
      await writeLines(h.processes[0], ...LINES.slice(0, 26));
      await h.adapter.stopSession('p4');
      const events = await drain(h.iterator, 6, 'p4');
      expect(events.map((e) => e.method)).toEqual([
        'session.started',
        'session.configured',
        'turn.started',
        'tool.started',
        'tool.completed',
        'turn.aborted',
      ]);
      expect(events[4]).toMatchObject({ status: 'unresolved' });
    });

    test('a result without correlation_facts.tool_name pairs with its start; without a start it is dropped', async () => {
      // Real timers: this test awaits `expectNoFurtherEvent`.
      const { harness, emit } = await startTurn('thread-nameless', 60_000);
      const tool = bashTool('task-n', 'call_n');
      const nameless = (line: string) =>
        line.replace('"tool_name":"bash",', '');
      expect(nameless(tool.result)).not.toContain('tool_name');
      await emit(...tool.start, nameless(tool.result));
      // No start for call_orphan: nothing to name it by, so no event.
      await emit(nameless(bashTool('task-o', 'call_orphan').result));
      await emit(LINES[54]!);
      const events = await drain(harness.iterator, 6, 'nameless result');
      expect(events.map((e) => e.method)).toEqual([
        'session.started',
        'session.configured',
        'turn.started',
        'tool.started',
        'tool.completed',
        'turn.completed',
      ]);
      expect(events[4]).toMatchObject({
        toolCallId: 'call_n',
        toolName: 'bash',
        status: 'success',
      });
      await expectNoFurtherEvent(harness.iterator, 'nameless result');
    });

    test('two tasks naming the same call id open one start; a start after its result opens none', async () => {
      // Real timers: this test awaits `expectNoFurtherEvent`.
      const { harness, emit } = await startTurn('thread-dup', 60_000);
      const first = bashTool('task-1', 'call_dup');
      const second = bashTool('task-2', 'call_dup');
      await emit(...first.start, ...second.start);
      const late = bashTool('task-3', 'call_late');
      // Result first, then a start for the same call: the row stays closed.
      await emit(late.result, ...late.start);
      await emit(LINES[54]!);
      const events = await drain(harness.iterator, 7, 'dup starts');
      expect(
        events.slice(3).map((e) => [e.method, e.toolCallId, e.status]),
      ).toEqual([
        ['tool.started', 'call_dup', undefined],
        ['tool.completed', 'call_late', 'success'],
        // call_dup never resolved: closed as unresolved at the turn's end.
        ['tool.completed', 'call_dup', 'unresolved'],
        ['turn.completed', undefined, undefined],
      ]);
      expect(events[5].output).toBe(UNRESOLVED_TURN_TOOL_OUTPUT);
      await expectNoFurtherEvent(harness.iterator, 'dup starts');
    });
  });
});

/**
 * #2269: idle (default 30 min since last verified protocol activity) plus
 * a total budget ONLY when `turnTimeoutMs` is declared (no default — owner
 * direction 2026-09-22). Spawn-free like the rest of this
 * suite: short real-timer budgets for the behavior edges, fake-clock for
 * the headline "active work survives past the old 30-minute wall cutoff".
 */
describe('Muse turn supervision (#2269)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('the idle bound fails closed to its default; the total bound has no default', () => {
    expect(MUSE_DEFAULT_IDLE_TIMEOUT_MS).toBe(30 * 60_000);
    expect(MUSE_MAX_SUPERVISION_TIMEOUT_MS).toBe(24 * 60 * 60_000);
    for (const invalid of [
      undefined,
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MUSE_MAX_SUPERVISION_TIMEOUT_MS + 1,
    ]) {
      expect(resolveMuseSupervisionBound(invalid, 1234)).toBe(1234);
    }
    expect(resolveMuseSupervisionBound(500, 1234)).toBe(500);
    expect(
      resolveMuseSupervisionBound(MUSE_MAX_SUPERVISION_TIMEOUT_MS, 1234),
    ).toBe(MUSE_MAX_SUPERVISION_TIMEOUT_MS);

    // Total: absent means none, not a substitute budget.
    expect(resolveMuseTurnBudget(undefined)).toEqual({
      budgetMs: undefined,
      invalid: false,
    });
    for (const invalid of [
      0,
      -1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      MUSE_MAX_SUPERVISION_TIMEOUT_MS + 1,
    ]) {
      expect(resolveMuseTurnBudget(invalid)).toEqual({
        budgetMs: undefined,
        invalid: true,
      });
    }
    expect(resolveMuseTurnBudget(500)).toEqual({
      budgetMs: 500,
      invalid: false,
    });
  });

  test('with no declared budget, turn.started declares idle only — no deadline, no total', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-no-budget',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-no-budget',
      input: 'hi',
    });
    const events = await drain(harness.iterator, 3, 'no budget');
    const supervision = events[2].metadata.supervision;
    expect(supervision).toEqual({
      provider: 'muse',
      turnId: events[2].turnId,
      startedAt: expect.any(String),
      idleLimitMs: MUSE_DEFAULT_IDLE_TIMEOUT_MS,
    });
    await harness.adapter.stopAll();
  });

  test('an invalid turnTimeoutMs applies no total budget and is reported once; invalid idle falls back', async () => {
    const harness = createHarness({
      turnTimeoutMs: 0,
      turnIdleTimeoutMs: Number.NaN,
    });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-invalid-bounds',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-invalid-bounds',
      input: 'hi',
    });
    const events = await drain(harness.iterator, 3, 'invalid bounds');
    expect(events[2]).toMatchObject({ method: 'turn.started' });
    const supervision = events[2].metadata.supervision;
    expect(supervision.idleLimitMs).toBe(MUSE_DEFAULT_IDLE_TIMEOUT_MS);
    expect(supervision).not.toHaveProperty('totalLimitMs');
    expect(supervision).not.toHaveProperty('deadlineAt');
    const budgetWarnings = () =>
      harness.logger.warn.mock.calls.filter(([message]) =>
        String(message).includes('turnTimeoutMs=0'),
      );
    expect(budgetWarnings()).toHaveLength(1);
    harness.processes[0].exit(0);
    await flushIo();
    await harness.adapter.sendTurn({
      threadId: 'thread-invalid-bounds',
      input: 'again',
    });
    expect(budgetWarnings()).toHaveLength(1);
    await harness.adapter.stopAll();
  });

  test('a genuinely silent turn settles with the distinct idle code and frees the slot', async () => {
    const harness = createHarness({
      turnIdleTimeoutMs: 40,
      turnTimeoutMs: 30_000,
    });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-idle',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-idle',
      input: 'hi',
    });
    // Nothing written, child never exits: the idle window — not the 30 s
    // absolute budget — ends this turn.
    const events = await drain(harness.iterator, 4, 'idle deadline');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'runtime.error',
    ]);
    expect(events[3]).toMatchObject({
      method: 'runtime.error',
      code: MUSE_TURN_IDLE_TIMEOUT_CODE,
      turnId: turn.turnId,
    });
    expect(String(events[3].message)).toContain('40ms');
    expect(harness.processes[0].killed).toBe(true);

    // Terminated and reaped: exactly one terminal (the recovery turn.started
    // arrives next, proving no duplicate terminal was queued), slot freed.
    expect(harness.released).toBe(1);
    await harness.adapter.sendTurn({
      threadId: 'thread-idle',
      input: 'again',
    });
    expect(harness.processes).toHaveLength(2);
    const next = await nextEvent(harness.iterator, 'idle recovery');
    expect(next.method).toBe('turn.started');
    // Last iterator use in this test: the losing waiter must not swallow a
    // later real event (see `expectNoFurtherEvent`'s contract above).
    await expectNoFurtherEvent(harness.iterator, 'idle deadline');
  });

  test('verified activity survives past the old 30-minute cutoff; duplicates and noise do not extend idle', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.adapter.startSession({
        provider: 'muse',
        threadId: 'thread-policy',
      });
      await harness.adapter.sendTurn({
        threadId: 'thread-policy',
        input: 'hi',
      });
      const emitLine = async (line: string) => {
        harness.processes[0].stdout.write(`${line}\n`);
        await vi.advanceTimersByTimeAsync(0);
      };
      const minute = 60_000;

      // Verified activity at t=0 and t=29min.
      await emitLine(MUSE_META_OUTPUT_DELTA_1);
      await vi.advanceTimersByTimeAsync(29 * minute);
      await emitLine(MUSE_META_OUTPUT_DELTA_2);

      // t=58min: past the old 30-minute wall-clock cutoff from turn start.
      // Under the old single-deadline code this turn would already be dead;
      // under the declared idle policy it is alive on verified activity.
      await vi.advanceTimersByTimeAsync(29 * minute);
      await expect(
        harness.adapter.sendTurn({
          threadId: 'thread-policy',
          input: 'intruder',
        }),
      ).rejects.toThrow('active turn');

      // A newly identified tool result at t=58 IS verified activity, so the
      // idle window moves to t=88min. Twenty minutes later the SAME receipt
      // replays, beside a malformed line, an unknown heartbeat-shaped frame,
      // and stderr noise: none of those reschedules anything, so the turn
      // still ends at t=88min. (If the replay refreshed idle, the slot would
      // still be held at t=95min and the recovery sendTurn below would
      // reject instead of resolving — no hanging wait needed.)
      await emitLine(MUSE_TOOL_RESULT);
      await vi.advanceTimersByTimeAsync(20 * minute);
      await emitLine(MUSE_TOOL_RESULT);
      await emitLine('this is not json');
      await emitLine(MUSE_ECHO_TASK_LIFECYCLE);
      harness.processes[0].stderr.write('muse: workspace root: /work\n');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(17 * minute);

      // t=95min: the idle deadline fired at t=88min, so the slot is free.
      expect(harness.released).toBe(1);
      await harness.adapter.sendTurn({
        threadId: 'thread-policy',
        input: 'again',
      });
      expect(harness.processes).toHaveLength(2);

      const events = await drain(harness.iterator, 8, 'idle policy');
      const error = events.find((event) => event.method === 'runtime.error');
      expect(error).toMatchObject({
        code: MUSE_TURN_IDLE_TIMEOUT_CODE,
      });
      // #2308 review: one completion per call id per turn — the replayed
      // receipt is dropped rather than published as a second outcome row,
      // and (as before) never buys idle time.
      expect(
        events.filter((event) => event.method === 'tool.completed'),
      ).toHaveLength(1);
      // Exactly one terminal: the last event is the recovery turn's start.
      expect(events[7]).toMatchObject({ method: 'turn.started' });
    } finally {
      vi.useRealTimers();
    }
  });

  test('with no declared budget, a turn with sustained activity is never ended by Station', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.adapter.startSession({
        provider: 'muse',
        threadId: 'thread-no-total',
      });
      await harness.adapter.sendTurn({
        threadId: 'thread-no-total',
        input: 'hi',
      });
      const minute = 60_000;
      // Verified activity every 29 minutes for ~24.7 hours — past the 24 h
      // cap on ANY budget value — so no hidden default total (2 h, or even
      // MUSE_MAX_SUPERVISION_TIMEOUT_MS) can survive this test.
      const rounds = 51;
      expect(rounds * 29 * minute).toBeGreaterThan(
        MUSE_MAX_SUPERVISION_TIMEOUT_MS,
      );
      for (let round = 0; round < rounds; round += 1) {
        await vi.advanceTimersByTimeAsync(29 * minute);
        harness.processes[0].stdout.write(`${MUSE_META_OUTPUT_DELTA_1}\n`);
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(harness.processes[0].killed).toBe(false);
      expect(harness.released).toBe(0);
      const events = await drain(harness.iterator, 3 + rounds, 'no total');
      expect(
        events.filter((event) => event.method === 'runtime.error'),
      ).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a declared turnTimeoutMs still ends an active turn and is attributed to that budget, without stderr', async () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness({ turnTimeoutMs: 60 * 60_000 });
      await harness.adapter.startSession({
        provider: 'muse',
        threadId: 'thread-total',
      });
      const turn = await harness.adapter.sendTurn({
        threadId: 'thread-total',
        input: 'hi',
      });
      // muse's routine stderr, present on every real run.
      harness.processes[0].stderr.write(
        'muse: workspace root: /work\nwarning: rules file AGENTS.md truncated\n',
      );
      const minute = 60_000;
      for (let round = 0; round < 2; round += 1) {
        await vi.advanceTimersByTimeAsync(29 * minute);
        harness.processes[0].stdout.write(`${MUSE_META_OUTPUT_DELTA_1}\n`);
        await vi.advanceTimersByTimeAsync(0);
      }
      // t=58min of genuine activity; the declared 60 min budget still ends it.
      await vi.advanceTimersByTimeAsync(3 * minute);
      const events = await drain(harness.iterator, 6, 'declared total');
      const error = events.find((event) => event.method === 'runtime.error');
      expect(error).toMatchObject({
        code: MUSE_TURN_TOTAL_TIMEOUT_CODE,
        turnId: turn.turnId,
      });
      expect(error.message).toContain('3600000ms turn budget declared for it');
      expect(error.message).not.toContain('workspace root');
      expect(error.message).not.toContain('truncated');
      expect(error.message).not.toContain('muse stderr');
      expect(harness.processes[0].killed).toBe(true);
      expect(harness.released).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  test('an idle expiry message does not carry muse’s routine stderr', async () => {
    const harness = createHarness({ turnIdleTimeoutMs: 40 });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-idle-stderr',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-idle-stderr',
      input: 'hi',
    });
    harness.processes[0].stderr.write(
      'muse: workspace root: /work\nwarning: rules file AGENTS.md truncated\n',
    );
    const events = await drain(harness.iterator, 4, 'idle stderr');
    expect(events[3]).toMatchObject({
      method: 'runtime.error',
      code: MUSE_TURN_IDLE_TIMEOUT_CODE,
    });
    expect(events[3].message).toContain('no tool reported running');
    expect(events[3].message).not.toContain('workspace root');
    expect(events[3].message).not.toContain('muse stderr');
  });

  test('an unconfirmed deadline kill holds the slot until the late exit', async () => {
    // `terminateProcessTree` can fail to confirm exit after SIGKILL. The
    // deadline path must then behave like `interruptTurn`'s
    // `termination-unconfirmed`: settle exactly once, keep the single slot
    // closed so no overlapping `muse exec` runs against the same
    // `--session-id`, and let the late `exit` release and free exactly once.
    const harness = createHarness({
      turnTimeoutMs: 10,
      settledChildExitWaitMs: 20,
      terminateProcess: async () => {
        throw new Error('kill ESRCH: termination unconfirmed');
      },
    });
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-unconfirmed',
    });
    const turn = await harness.adapter.sendTurn({
      threadId: 'thread-unconfirmed',
      input: 'hi',
    });
    const events = await drain(harness.iterator, 4, 'unconfirmed deadline');
    expect(events.map((event) => event.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'runtime.error',
    ]);
    expect(events[3]).toMatchObject({
      method: 'runtime.error',
      code: MUSE_TURN_TOTAL_TIMEOUT_CODE,
      turnId: turn.turnId,
    });
    await flushIo();

    // The slot is still held: a replacement turn must not start while the
    // old child may still be alive.
    await expect(
      harness.adapter.sendTurn({
        threadId: 'thread-unconfirmed',
        input: 'intruder',
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof SendTurnRefusedError &&
        !(error instanceof MuseTurnSlotReleasingError),
    );
    expect(harness.processes).toHaveLength(1);
    expect(harness.released).toBe(0);

    // The late exit frees the slot exactly once and publishes no second
    // terminal for the old turn; the session recovers with the next turn
    // (which carries the same short budget, so its own terminal closes the
    // sequence and bounds the assertion below).
    harness.processes[0].exit(1);
    await flushIo();
    expect(harness.released).toBe(1);
    const retry = await harness.adapter.sendTurn({
      threadId: 'thread-unconfirmed',
      input: 'again',
    });
    expect(harness.processes).toHaveLength(2);
    const rest = await drain(harness.iterator, 2, 'unconfirmed recovery');
    expect(rest.map((event) => event.method)).toEqual([
      'turn.started',
      'runtime.error',
    ]);
    expect(rest[0]).toMatchObject({
      method: 'turn.started',
      turnId: retry.turnId,
    });
    // Ceiling over the whole test: exactly two terminals — one per turn,
    // no duplicate for the unconfirmed kill or the late exit.
    const terminals = [...events, ...rest].filter(
      (event) => event.method === 'runtime.error',
    );
    expect(terminals.map((event) => [event.turnId, event.code])).toEqual([
      [turn.turnId, MUSE_TURN_TOTAL_TIMEOUT_CODE],
      [retry.turnId, MUSE_TURN_TOTAL_TIMEOUT_CODE],
    ]);
  });

  test('tool-receipt replay past the bounded retention reads as new idle activity', async () => {
    // The per-turn replay dedup is bounded (oldest-first past the cap): an
    // evicted id replaying reads as new idle activity, because it is still
    // a protocol frame the child actually emitted. This pins that honest
    // bound rather than claiming every duplicate never reschedules.
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      await harness.adapter.startSession({
        provider: 'muse',
        threadId: 'thread-replay-cap',
      });
      await harness.adapter.sendTurn({
        threadId: 'thread-replay-cap',
        input: 'hi',
      });
      const minute = 60_000;
      const variant = (index: number): string =>
        MUSE_TOOL_RESULT.replace(
          'call_019feab717fd75639b5a008d7b2c3e09',
          `call_capacity_${index}`,
        );
      const emitLine = async (line: string) => {
        harness.processes[0].stdout.write(`${line}\n`);
        await vi.advanceTimersByTimeAsync(0);
      };
      // 501 distinct receipts at t≈0: the ring holds 500, so the first id
      // is evicted and its replay below reads as new verified activity.
      for (let index = 0; index < 501; index += 1) {
        await emitLine(variant(index));
      }
      // t=29min: replay the EVICTED first receipt. It reschedules idle to
      // t=59min (a retained duplicate would not — see the sibling test).
      await vi.advanceTimersByTimeAsync(29 * minute);
      await emitLine(variant(0));
      // t=58min: still inside the rescheduled idle window — the slot holds.
      await vi.advanceTimersByTimeAsync(29 * minute);
      await expect(
        harness.adapter.sendTurn({
          threadId: 'thread-replay-cap',
          input: 'intruder',
        }),
      ).rejects.toThrow('active turn');
      // t=60min: the rescheduled idle window elapsed — one idle terminal.
      await vi.advanceTimersByTimeAsync(2 * minute);
      const events = await drain(harness.iterator, 506, 'replay capacity');
      const errors = events.filter((event) => event.method === 'runtime.error');
      expect(errors).toHaveLength(1);
      expect(errors[0]).toMatchObject({
        code: MUSE_TURN_IDLE_TIMEOUT_CODE,
      });
      expect(
        events.filter((event) => event.method === 'tool.completed'),
      ).toHaveLength(502);
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * #2300 owner decisions (2026-09-22): a completed `run_terminal` while the
 * turn is owed a background report HOLDS the turn; muse's automatic
 * follow-up run is delivered on the same turn; `turn.completed` fires once,
 * at the real end; a held turn has no post-terminal budget and never ends
 * in `runtime.error`.
 *
 * Driven by the scrubbed live capture (see
 * `MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES`). 0-based indexes used below:
 * [28] the launch `tool_result`, [30] run 1's `run_terminal`, [31] the
 * background task's `completed`, [32] the follow-up's `command_accepted`,
 * [50]/[51] its deltas, [62] its `run_terminal`.
 */
describe('Muse background work holds the turn (#2300)', () => {
  const LINES = MUSE_13_BACKGROUND_WORKFLOW_TURN_LINES;
  const ROW_ID = `muse-task:${MUSE_13_BACKGROUND_TASK_ID}`;
  const ROW_TOOL = 'workflow_background';
  /** Through run 1's `run_terminal`: the task is launched and pending. */
  const THROUGH_RUN_1 = LINES.slice(0, 31);
  const LAUNCH = LINES[28]!;
  const RUN_1_TERMINAL = LINES[30]!;
  const TASK_COMPLETED = LINES[31]!;
  /** The follow-up run, `command_accepted` through its `run_terminal`. */
  const FOLLOW_UP = LINES.slice(32);
  const withTerminal = (line: string, terminal: string) =>
    line.replace('"terminal":"completed"', `"terminal":"${terminal}"`);
  /** A run_output_delta record carrying `text`, from the capture's own. */
  const deltaLine = (text: string) =>
    FOLLOW_UP[18]!.replace(
      '"text":"Workflow completed: sleep"',
      `"text":${JSON.stringify(text)}`,
    );
  /** The launch result re-keyed to another call id and task id. */
  const launchOf = (callId: string, taskId: string) =>
    LAUNCH.split(MUSE_13_WORKFLOW_CALL_ID)
      .join(callId)
      .split(MUSE_13_BACKGROUND_TASK_ID)
      .join(taskId);
  const textOf = (message: { parts: Array<{ type: string; text?: string }> }) =>
    message.parts
      .filter((p) => p.type === 'text')
      .map((p) => p.text)
      .join('');

  afterEach(() => {
    vi.useRealTimers();
  });

  async function startTurn(
    threadId: string,
    overrides: Partial<MuseAdapterOptions> = {},
  ) {
    const harness = createHarness(overrides);
    await harness.adapter.startSession({ provider: 'muse', threadId });
    const turn = await harness.adapter.sendTurn({ threadId, input: 'go' });
    const emit = async (...lines: string[]) => {
      for (const line of lines) harness.processes[0].stdout.write(`${line}\n`);
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
      else await flushIo();
    };
    return { harness, turn, emit };
  }

  test('the fixture is scrubbed of machine paths', () => {
    const joined = LINES.join('\n');
    for (const token of ['/Users/', '/private/', 'brian', 'claude-501']) {
      expect(joined).not.toContain(token);
    }
    expect(LINES).toHaveLength(63);
  });

  test('full replay: one turn, the background row settles late, the follow-up run lands on it, one turn.completed', async () => {
    const { harness, turn, emit } = await startTurn('bg-replay');
    await emit(...THROUGH_RUN_1);
    const run1 = await drain(harness.iterator, 6, 'run 1');
    expect(run1.map((e) => [e.method, e.toolCallId])).toEqual([
      ['session.started', undefined],
      ['session.configured', undefined],
      ['turn.started', undefined],
      ['tool.started', MUSE_13_WORKFLOW_CALL_ID],
      ['tool.completed', MUSE_13_WORKFLOW_CALL_ID],
      ['tool.started', ROW_ID],
    ]);
    expect(run1[5]).toEqual({
      eventId: expect.any(String),
      provider: 'muse',
      threadId: 'bg-replay',
      createdAt: expect.any(String),
      method: 'tool.started',
      turnId: turn.turnId,
      itemId: `tool:${ROW_ID}`,
      toolCallId: ROW_ID,
      toolName: ROW_TOOL,
    });
    // Run 1's terminal published nothing: the NEXT event is the task's
    // late settle, not a turn.completed.
    await emit(TASK_COMPLETED);
    expect(await nextEvent(harness.iterator, 'late settle')).toMatchObject({
      method: 'tool.completed',
      turnId: turn.turnId,
      itemId: `tool:${ROW_ID}`,
      toolCallId: ROW_ID,
      toolName: ROW_TOOL,
      status: 'success',
      output: MUSE_BACKGROUND_TASK_COMPLETED_OUTPUT,
    });
    await emit(...FOLLOW_UP);
    const run2 = await drain(harness.iterator, 3, 'follow-up run');
    expect(run2.map((e) => e.method)).toEqual([
      'content.text-delta',
      'content.text-delta',
      'turn.completed',
    ]);
    expect(run2.every((e) => e.turnId === turn.turnId)).toBe(true);
    expect(run2[0].itemId).toBe(run2[1].itemId);
    // Run 1 produced no text, so no paragraph break is inserted.
    expect(run2[0].delta + run2[1].delta).toBe(
      MUSE_13_BACKGROUND_FOLLOW_UP_TEXT,
    );
    expect(run2[2]).toMatchObject({
      finishReason: 'stop',
      outputText: MUSE_13_BACKGROUND_FOLLOW_UP_TEXT,
    });
    // muse exits after the follow-up's terminal: nothing further, and
    // certainly no second turn.started.
    harness.processes[0].exit(0);
    await flushIo();
    expect(harness.released).toBe(1);
    await expectNoFurtherEvent(harness.iterator, 'full replay');
  });

  test('a task that settles BEFORE run 1 ends still holds the turn for the follow-up that reports it', async () => {
    const { harness, turn, emit } = await startTurn('bg-early-settle');
    // Launch, the task's completion, THEN run 1's terminal.
    await emit(...LINES.slice(0, 30), TASK_COMPLETED, RUN_1_TERMINAL);
    const early = await drain(harness.iterator, 7, 'early settle');
    expect(early.slice(5).map((e) => [e.method, e.status])).toEqual([
      ['tool.started', undefined],
      ['tool.completed', 'success'],
    ]);
    await emit(...FOLLOW_UP);
    const run2 = await drain(harness.iterator, 3, 'reported follow-up');
    expect(run2.map((e) => e.method)).toEqual([
      'content.text-delta',
      'content.text-delta',
      'turn.completed',
    ]);
    expect(run2[2]).toMatchObject({
      turnId: turn.turnId,
      finishReason: 'stop',
      outputText: MUSE_13_BACKGROUND_FOLLOW_UP_TEXT,
    });
    harness.processes[0].exit(0);
    await flushIo();
    await expectNoFurtherEvent(harness.iterator, 'early settle');
  });

  test('the projection renders the held turn as one finished message with the background row settled', async () => {
    const { harness, emit } = await startTurn('bg-projection');
    await emit(...LINES);
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 10, 'projection replay');
    expect(events.at(-1)?.method).toBe('turn.completed');
    const messages = projectRuntimeEventsToMessages(events);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    const assistant = messages[1]!;
    const tools = assistant.parts.filter((p) => p.type === 'tool-invocation');
    expect(
      tools.map((p) => [p.toolCallId, p.toolName, p.state, p.result]),
    ).toEqual([
      [MUSE_13_WORKFLOW_CALL_ID, 'workflow', 'result', expect.any(String)],
      [ROW_ID, ROW_TOOL, 'result', MUSE_BACKGROUND_TASK_COMPLETED_OUTPUT],
    ]);
    expect(
      assistant.parts.filter((p) => p.type === 'text').map((p) => p.text),
    ).toEqual([MUSE_13_BACKGROUND_FOLLOW_UP_TEXT]);
  });

  test('projection: text before the workflow call is not duplicated by the composed outputText', async () => {
    const { harness, emit } = await startTurn('bg-text-before');
    // Run 1 writes text before the workflow tool's task (line 21 on).
    await emit(
      ...LINES.slice(0, 20),
      deltaLine("I'll launch the workflow now."),
      ...LINES.slice(20),
    );
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 11, 'text before');
    const completed = events.at(-1);
    expect(completed).toMatchObject({
      method: 'turn.completed',
      outputText: `I'll launch the workflow now.\n\n${MUSE_13_BACKGROUND_FOLLOW_UP_TEXT}`,
    });
    const assistant = projectRuntimeEventsToMessages(events).at(-1)!;
    expect(textOf(assistant)).toBe(completed.outputText);
    expect(assistant.parts.map((p) => p.type)).toEqual([
      'text',
      'tool-invocation',
      'tool-invocation',
      'text',
    ]);
  });

  test('projection: follow-up text reported only in its terminal is rendered after the rows', async () => {
    const { harness, emit } = await startTurn('bg-terminal-only');
    await emit(
      ...LINES.slice(0, 20),
      deltaLine('Launching.'),
      ...LINES.slice(20, 50),
      // No follow-up deltas: its text arrives only in its terminal.
      ...LINES.slice(52),
    );
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 9, 'terminal only');
    const composed = `Launching.\n\n${MUSE_13_BACKGROUND_FOLLOW_UP_TEXT}`;
    expect(events.at(-1)).toMatchObject({
      method: 'turn.completed',
      outputText: composed,
    });
    const assistant = projectRuntimeEventsToMessages(events).at(-1)!;
    expect(textOf(assistant)).toBe(composed);
    expect(assistant.parts.at(-1)).toMatchObject({
      type: 'text',
      text: `\n\n${MUSE_13_BACKGROUND_FOLLOW_UP_TEXT}`,
    });
  });

  test('projection: a turn that launches nothing, with text before its bash tool, renders its text once', async () => {
    const { harness, emit } = await startTurn('bash-text-before');
    await emit(
      ...MUSE_13_BASH_TOOL_TURN_LINES.slice(0, 5),
      deltaLine('Before.'),
      ...MUSE_13_BASH_TOOL_TURN_LINES.slice(5),
    );
    const events = await drain(harness.iterator, 8, 'bash text before');
    const completed = events.at(-1);
    expect(completed.method).toBe('turn.completed');
    const assistant = projectRuntimeEventsToMessages(events).at(-1)!;
    expect(textOf(assistant)).toBe(completed.outputText);
    expect(
      assistant.parts.filter((p) => p.type === 'text').map((p) => p.text),
    ).toEqual(['Before.', completed.outputText.slice('Before.'.length)]);
  });

  test('provenance counts the workflow call once and the background task under its own name', async () => {
    const { harness, emit } = await startTurn('bg-provenance');
    await emit(...LINES);
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 10, 'provenance');
    const [envelope] = assembleTurnProvenanceEnvelopes(events);
    expect(envelope?.tools).toMatchObject({
      state: 'observed',
      value: {
        uses: [
          expect.objectContaining({
            name: 'workflow',
            started: 1,
            succeeded: 1,
          }),
          expect.objectContaining({
            name: ROW_TOOL,
            started: 1,
            succeeded: 1,
          }),
        ],
      },
    });
  });

  test('a held turn outlives any number of idle windows, before and after its task settles', async () => {
    vi.useFakeTimers();
    const { harness, emit } = await startTurn('bg-no-budget', {
      turnIdleTimeoutMs: 1_000,
    });
    await emit(...THROUGH_RUN_1);
    // A day of silence with the task pending...
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    await emit(TASK_COMPLETED);
    // ...and another with it settled while the follow-up stays silent.
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(harness.processes[0].killed).toBe(false);
    expect(harness.released).toBe(0);
    await emit(...FOLLOW_UP);
    // Everything is queued; real timers let `drain`'s own timeout work.
    vi.useRealTimers();
    const events = await drain(harness.iterator, 10, 'held two days');
    expect(events.map((e) => e.method)).toEqual([
      'session.started',
      'session.configured',
      'turn.started',
      'tool.started',
      'tool.completed',
      'tool.started',
      'tool.completed',
      'content.text-delta',
      'content.text-delta',
      'turn.completed',
    ]);
    expect(events[9]).toMatchObject({
      outputText: MUSE_13_BACKGROUND_FOLLOW_UP_TEXT,
    });
  });

  test('a turn held only for an already-settled task also has no idle bound', async () => {
    vi.useFakeTimers();
    const { harness, emit } = await startTurn('bg-early-no-budget', {
      turnIdleTimeoutMs: 1_000,
    });
    // The task settles (arming idle, with nothing pending) before run 1
    // ends; the hold must disarm that timer.
    await emit(...LINES.slice(0, 30), TASK_COMPLETED, RUN_1_TERMINAL);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(harness.processes[0].killed).toBe(false);
    await emit(...FOLLOW_UP);
    vi.useRealTimers();
    const events = await drain(harness.iterator, 10, 'early, held a day');
    expect(events.map((e) => e.method)).not.toContain('runtime.error');
    expect(events.at(-1)).toMatchObject({
      method: 'turn.completed',
      outputText: MUSE_13_BACKGROUND_FOLLOW_UP_TEXT,
    });
  });

  test('a declared turn budget closes a held turn with a warning, never runtime.error', async () => {
    vi.useFakeTimers();
    const { harness, emit } = await startTurn('bg-budget', {
      turnTimeoutMs: 5 * 60_000,
    });
    await emit(...THROUGH_RUN_1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(harness.processes[0].killed).toBe(true);
    vi.useRealTimers();
    const events = await drain(harness.iterator, 9, 'held budget');
    expect(events.slice(5).map((e) => [e.method, e.status ?? e.code])).toEqual([
      ['tool.started', undefined],
      ['runtime.warning', MUSE_HELD_TURN_UNFINISHED_CODE],
      ['tool.completed', 'unresolved'],
      ['turn.completed', undefined],
    ]);
    expect(events[6].message).toContain('turn budget of 5 minutes');
    expect(events[8]).toMatchObject({ finishReason: 'other' });
  });

  test('Stop while held signals the process group, cancels the background row, and aborts the turn', async () => {
    const { harness, turn, emit } = await startTurn('bg-stop');
    await emit(...THROUGH_RUN_1);
    const result = await harness.adapter.interruptTurn('bg-stop', turn.turnId);
    expect(result).toEqual({ outcome: 'cancelled', turnId: turn.turnId });
    expect(harness.processes[0].killSignals).toEqual(['SIGTERM']);
    const events = await drain(harness.iterator, 8, 'stop while held');
    expect(events.slice(5).map((e) => [e.method, e.status])).toEqual([
      ['tool.started', undefined],
      ['tool.completed', 'cancelled'],
      ['turn.aborted', undefined],
    ]);
    expect(events[6]).toMatchObject({
      toolCallId: ROW_ID,
      output: MUSE_BACKGROUND_TASK_STOPPED_OUTPUT,
    });
    // The slot is free: the next send is accepted.
    await harness.adapter.sendTurn({ threadId: 'bg-stop', input: 'again' });
    expect(harness.processes).toHaveLength(2);
    await harness.adapter.stopAll();
  });

  test('Stop while held with termination unconfirmed says the task may still be running', async () => {
    const { harness, turn, emit } = await startTurn('bg-stop-unconfirmed', {
      terminateProcess: async () => {
        throw new Error('still alive');
      },
    });
    await emit(...THROUGH_RUN_1);
    const result = await harness.adapter.interruptTurn(
      'bg-stop-unconfirmed',
      turn.turnId,
    );
    expect(result.outcome).toBe('termination-unconfirmed');
    const events = await drain(harness.iterator, 8, 'stop unconfirmed');
    expect(events[6]).toMatchObject({
      toolCallId: ROW_ID,
      status: 'cancelled',
      output: MUSE_BACKGROUND_TASK_STOP_UNCONFIRMED_OUTPUT,
    });
    expect(events[7].method).toBe('turn.aborted');
  });

  test('a Stop-aborted held turn is not reaped or announced later', async () => {
    vi.useFakeTimers();
    const { harness, turn, emit } = await startTurn('bg-stop-no-reap', {
      turnIdleTimeoutMs: 1_000,
      terminateProcess: async () => {
        throw new Error('still alive');
      },
    });
    await emit(...THROUGH_RUN_1);
    await harness.adapter.interruptTurn('bg-stop-no-reap', turn.turnId);
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    vi.useRealTimers();
    const events = await drain(harness.iterator, 8, 'aborted');
    expect(events.at(-1)?.method).toBe('turn.aborted');
    await expectNoFurtherEvent(harness.iterator, 'aborted, then a day');
  });

  test.each([
    [0, null, 'code 0'],
    [137, null, 'code 137'],
    [null, 'SIGKILL', 'signal SIGKILL'],
  ] as const)(
    'a child that exits while held (code %s, signal %s) closes the turn as completed with a warning naming %s',
    async (code, signal, named) => {
      const { harness, emit } = await startTurn(`bg-exit-${named}`);
      await emit(...THROUGH_RUN_1);
      if (signal) harness.processes[0].signalCode = signal;
      harness.processes[0].exit(code);
      await flushIo();
      const events = await drain(harness.iterator, 9, 'exit while held');
      expect(
        events.slice(5).map((e) => [e.method, e.status ?? e.code]),
      ).toEqual([
        ['tool.started', undefined],
        ['runtime.warning', MUSE_HELD_TURN_UNFINISHED_CODE],
        ['tool.completed', 'unresolved'],
        ['turn.completed', undefined],
      ]);
      expect(events[6].message).toContain(`(${named})`);
      expect(events[7]).toMatchObject({
        toolCallId: ROW_ID,
        output: MUSE_BACKGROUND_TASK_UNRESOLVED_OUTPUT,
      });
      expect(events[8]).toMatchObject({ finishReason: 'other' });
      expect(harness.released).toBe(1);
      await expectNoFurtherEvent(harness.iterator, 'exit while held');
    },
  );

  test('a follow-up terminal that did not complete closes the turn honestly with the composed text', async () => {
    const { harness, emit } = await startTurn('bg-run2-cancelled');
    const run1Text = RUN_1_TERMINAL.replace(
      '"text":""',
      '"text":"Launched it."',
    );
    // The task is still pending (its completion never arrives) when the
    // follow-up run ends `cancelled`.
    await emit(
      ...THROUGH_RUN_1.slice(0, 30),
      run1Text,
      ...FOLLOW_UP.slice(0, -1),
      withTerminal(FOLLOW_UP.at(-1)!, 'cancelled'),
    );
    const events = await drain(harness.iterator, 11, 'run 2 cancelled');
    expect(events.slice(5).map((e) => [e.method, e.status ?? e.code])).toEqual([
      ['tool.started', undefined],
      ['content.text-delta', undefined],
      ['content.text-delta', undefined],
      ['runtime.warning', MUSE_HELD_TURN_UNFINISHED_CODE],
      ['tool.completed', 'unresolved'],
      ['turn.completed', undefined],
    ]);
    // Run 1's text reached nothing but its terminal, so the follow-up's
    // first delta carries the paragraph break that joins them.
    expect(events[6].delta).toBe('\n\nWorkflow completed: sleep');
    expect(events[10]).toMatchObject({
      finishReason: 'cancelled',
      outputText: `Launched it.\n\n${MUSE_13_BACKGROUND_FOLLOW_UP_TEXT}`,
    });
    expect(events.some((e) => e.method === 'runtime.error')).toBe(false);
    await expectNoFurtherEvent(harness.iterator, 'run 2 cancelled');
  });

  test("a failed follow-up records muse's terminal and reason in the warning", async () => {
    const { harness, emit } = await startTurn('bg-run2-failed');
    await emit(
      ...THROUGH_RUN_1,
      TASK_COMPLETED,
      ...FOLLOW_UP.slice(0, -1),
      withTerminal(FOLLOW_UP.at(-1)!, 'failed').replace(
        '"reason":null',
        '"reason":"provider quota exceeded"',
      ),
    );
    const events = await drain(harness.iterator, 11, 'run 2 failed');
    const warning = events.find((e) => e.method === 'runtime.warning');
    expect(warning).toMatchObject({
      code: MUSE_HELD_TURN_UNFINISHED_CODE,
      severity: 'warning',
    });
    expect(warning.message).toContain(
      'terminal: failed, reason: provider quota exceeded',
    );
    expect(events.at(-1)).toMatchObject({
      method: 'turn.completed',
      finishReason: 'other',
      outputText: MUSE_13_BACKGROUND_FOLLOW_UP_TEXT,
    });
    expect(events.some((e) => e.method === 'runtime.error')).toBe(false);
    await expectNoFurtherEvent(harness.iterator, 'run 2 failed');
  });

  test('run 1 text and the follow-up are separate items joined by a paragraph break, and project as one text', async () => {
    const { harness, turn, emit } = await startTurn('bg-two-texts');
    await emit(
      ...THROUGH_RUN_1.slice(0, 30),
      deltaLine('Launched it.'),
      RUN_1_TERMINAL,
      TASK_COMPLETED,
      ...FOLLOW_UP,
    );
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 11, 'two texts');
    const deltas = events.filter((e) => e.method === 'content.text-delta');
    expect(deltas.map((e) => e.delta)).toEqual([
      'Launched it.',
      '\n\nWorkflow completed: sleep',
      ' 60 && echo done > workflow-finished.txt finished with exit 0.',
    ]);
    expect(deltas[0].itemId).not.toBe(deltas[1].itemId);
    expect(deltas[1].itemId).toBe(deltas[2].itemId);
    const composed = `Launched it.\n\n${MUSE_13_BACKGROUND_FOLLOW_UP_TEXT}`;
    expect(events.at(-1)).toMatchObject({
      method: 'turn.completed',
      turnId: turn.turnId,
      finishReason: 'stop',
      outputText: composed,
    });
    const assistant = projectRuntimeEventsToMessages(events).at(-1)!;
    expect(
      assistant.parts.filter((p) => p.type === 'text').map((p) => p.text),
    ).toEqual([composed]);
    await expectNoFurtherEvent(harness.iterator, 'two texts');
  });

  test('a launch result that is not a well-formed launch announces nothing; the turn settles at its terminal', async () => {
    const launch = JSON.parse(LAUNCH);
    const variants: Record<string, string> = {
      malformed: '{"status":"launched","taskId":',
      notLaunched: JSON.stringify({
        status: 'queued',
        taskId: MUSE_13_BACKGROUND_TASK_ID,
      }),
      badTaskId: JSON.stringify({ status: 'launched', taskId: 'a b/c' }),
      oversized: JSON.stringify({
        status: 'launched',
        taskId: MUSE_13_BACKGROUND_TASK_ID,
        padding: 'x'.repeat(70_000),
      }),
    };
    for (const [name, text] of Object.entries(variants)) {
      const { harness, emit } = await startTurn(`bg-${name}`);
      launch.payload.text = text;
      await emit(
        ...LINES.slice(0, 28),
        JSON.stringify(launch),
        ...LINES.slice(29, 31),
      );
      const events = await drain(harness.iterator, 6, name);
      expect(
        events.slice(3).map((e) => [e.method, e.toolCallId]),
        name,
      ).toEqual([
        ['tool.started', MUSE_13_WORKFLOW_CALL_ID],
        ['tool.completed', MUSE_13_WORKFLOW_CALL_ID],
        ['turn.completed', undefined],
      ]);
      await harness.adapter.stopAll();
    }
  });

  test('a settled task re-announced under another call id opens no second row', async () => {
    const { harness, emit } = await startTurn('bg-reannounce');
    await emit(
      ...LINES.slice(0, 29),
      TASK_COMPLETED,
      launchOf('call_second', MUSE_13_BACKGROUND_TASK_ID),
      RUN_1_TERMINAL,
      ...FOLLOW_UP,
    );
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 11, 'reannounce');
    expect(
      events
        .filter((e) => e.toolCallId === ROW_ID)
        .map((e) => [e.method, e.status]),
    ).toEqual([
      ['tool.started', undefined],
      ['tool.completed', 'success'],
    ]);
    expect(events.at(-1)?.method).toBe('turn.completed');
    await expectNoFurtherEvent(harness.iterator, 'reannounce');
  });

  test(`tracks at most ${MUSE_PENDING_BACKGROUND_TASKS_MAX} background tasks per turn`, async () => {
    const { harness, emit } = await startTurn('bg-cap');
    const launches = Array.from(
      { length: MUSE_PENDING_BACKGROUND_TASKS_MAX + 1 },
      (_, index) => launchOf(`call_${index}`, `task-${index}`),
    );
    await emit(...LINES.slice(0, 28), ...launches);
    const total = 3 + 2 * (MUSE_PENDING_BACKGROUND_TASKS_MAX + 1) + 1;
    const events = await drain(harness.iterator, total - 1, 'cap');
    const rows = events.filter(
      (e) => e.method === 'tool.started' && e.toolName === ROW_TOOL,
    );
    expect(rows).toHaveLength(MUSE_PENDING_BACKGROUND_TASKS_MAX);
    expect(rows.at(-1)?.toolCallId).toBe(
      `muse-task:task-${MUSE_PENDING_BACKGROUND_TASKS_MAX - 1}`,
    );
    // The drain count above is exact: no row for the task past the cap.
    await expectNoFurtherEvent(harness.iterator, 'cap');
    expect(harness.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `more than ${MUSE_PENDING_BACKGROUND_TASKS_MAX} background tasks`,
      ),
    );
  });

  test('a queued send waits out the previous child exiting instead of being refused', async () => {
    const { harness, emit } = await startTurn('bg-queued-send');
    await emit(...LINES);
    // The turn is complete (the server frees it here); muse takes a moment
    // longer to exit.
    const send = harness.adapter.sendTurn({
      threadId: 'bg-queued-send',
      input: 'next',
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(harness.processes).toHaveLength(1);
    harness.processes[0].exit(0);
    await expect(send).resolves.toMatchObject({ threadId: 'bg-queued-send' });
    expect(harness.processes).toHaveLength(2);
    await harness.adapter.stopAll();
  });

  test('a lingering child reaped after a turn that closed background rows is announced, not silent', async () => {
    vi.useFakeTimers();
    const { harness, emit } = await startTurn('bg-reap-warning', {
      turnIdleTimeoutMs: 1_000,
    });
    // Run 1 fails AFTER launching the workflow: the turn ends (runtime.error,
    // as any failed run 1 does) with the task pending, and the child lingers.
    await emit(
      ...THROUGH_RUN_1.slice(0, 30),
      withTerminal(RUN_1_TERMINAL, 'failed'),
    );
    await vi.advanceTimersByTimeAsync(900);
    expect(harness.processes[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(harness.processes[0].killed).toBe(true);
    vi.useRealTimers();
    const events = await drain(harness.iterator, 9, 'reap warning');
    expect(events.slice(5).map((e) => [e.method, e.status ?? e.code])).toEqual([
      ['tool.started', undefined],
      ['tool.completed', 'unresolved'],
      ['runtime.error', 'muse-terminal-not-completed'],
      ['runtime.warning', MUSE_LINGERING_CHILD_REAPED_CODE],
    ]);
    expect(events[8]).toMatchObject({ severity: 'warning' });
    expect(events[8].message).toContain('still running 1 second after');
  });

  test("a child lingering after a held turn's final terminal is reaped one idle window on, and the next send spawns", async () => {
    vi.useFakeTimers();
    const { harness, emit } = await startTurn('bg-final-linger', {
      turnIdleTimeoutMs: 1_000,
    });
    // The whole capture, then the child never exits.
    await emit(...LINES);
    await vi.advanceTimersByTimeAsync(900);
    expect(harness.processes[0].killed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(harness.processes[0].killed).toBe(true);
    expect(harness.released).toBe(1);
    await expect(
      harness.adapter.sendTurn({ threadId: 'bg-final-linger', input: 'next' }),
    ).resolves.toMatchObject({ threadId: 'bg-final-linger' });
    expect(harness.processes).toHaveLength(2);
    vi.useRealTimers();
    const events = await drain(harness.iterator, 11, 'final linger');
    // One turn.completed, then the next turn — the reap itself is silent:
    // nothing the finished turn knew of was still running.
    expect(events.slice(9).map((e) => e.method)).toEqual([
      'turn.completed',
      'turn.started',
    ]);
    await harness.adapter.stopAll();
  });

  test('a clean exit of a turn held only for an unreported, already-settled task closes as before: stop, no warning', async () => {
    const { harness, emit } = await startTurn('bg-early-exit0');
    await emit(...LINES.slice(0, 30), TASK_COMPLETED, RUN_1_TERMINAL);
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 8, 'early exit 0');
    expect(events.slice(5).map((e) => [e.method, e.status])).toEqual([
      ['tool.started', undefined],
      ['tool.completed', 'success'],
      ['turn.completed', undefined],
    ]);
    expect(events[7]).toMatchObject({ finishReason: 'stop', outputText: '' });
    await expectNoFurtherEvent(harness.iterator, 'early exit 0');
  });

  test("a clean exit after a task that was pending at run 1's terminal settled gets the warning", async () => {
    // The verified shape (muse follows up such a task), going wrong.
    const { harness, emit } = await startTurn('bg-verified-exit0');
    await emit(...THROUGH_RUN_1, TASK_COMPLETED);
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 9, 'verified exit 0');
    expect(
      events.slice(7).map((e) => [e.method, e.code ?? e.finishReason]),
    ).toEqual([
      ['runtime.warning', MUSE_HELD_TURN_UNFINISHED_CODE],
      ['turn.completed', 'other'],
    ]);
    await expectNoFurtherEvent(harness.iterator, 'verified exit 0');
  });

  test('a clean exit that cuts off a started follow-up gets the warning, even if another task settled during it', async () => {
    const { harness, emit } = await startTurn('bg-cut-follow-up');
    const settleOf = (taskId: string) =>
      TASK_COMPLETED.split(MUSE_13_BACKGROUND_TASK_ID).join(taskId);
    // Two tasks launched; the capture's settles before run 1 ends, the
    // second is still pending at run 1's terminal.
    await emit(
      ...LINES.slice(0, 29),
      launchOf('call_b', 'task-b'),
      LINES[29]!,
      TASK_COMPLETED,
      RUN_1_TERMINAL,
      // The follow-up for the first starts and streams...
      ...FOLLOW_UP.slice(0, 20),
      // ...the second settles during it, and muse exits cleanly.
      settleOf('task-b'),
    );
    harness.processes[0].exit(0);
    await flushIo();
    const events = await drain(harness.iterator, 14, 'cut-off follow-up');
    expect(
      events.slice(-2).map((e) => [e.method, e.code ?? e.finishReason]),
    ).toEqual([
      ['runtime.warning', MUSE_HELD_TURN_UNFINISHED_CODE],
      ['turn.completed', 'other'],
    ]);
    await expectNoFurtherEvent(harness.iterator, 'cut-off follow-up');
  });

  test('a non-zero exit of that same held turn still gets the warning', async () => {
    const { harness, emit } = await startTurn('bg-early-exit1');
    await emit(...LINES.slice(0, 30), TASK_COMPLETED, RUN_1_TERMINAL);
    harness.processes[0].exit(1);
    await flushIo();
    const events = await drain(harness.iterator, 9, 'early exit 1');
    expect(
      events.slice(7).map((e) => [e.method, e.code ?? e.finishReason]),
    ).toEqual([
      ['runtime.warning', MUSE_HELD_TURN_UNFINISHED_CODE],
      ['turn.completed', 'other'],
    ]);
    await expectNoFurtherEvent(harness.iterator, 'early exit 1');
  });

  test('stopSession during the settled-slot wait refuses the send cleanly, as a pre-effect refusal', async () => {
    const { harness, emit } = await startTurn('bg-stop-during-wait');
    await emit(...LINES);
    const send = harness.adapter
      .sendTurn({ threadId: 'bg-stop-during-wait', input: 'next' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    await flushIo();
    await harness.adapter.stopSession('bg-stop-during-wait');
    const refusal = await send;
    expect(refusal).toBeInstanceOf(SendTurnRefusedError);
    expect((refusal as Error).message).toContain('stopped');
    expect(harness.processes).toHaveLength(1);
  });

  test('formats Station durations exactly', () => {
    expect(formatMuseDuration(1_000)).toBe('1 second');
    expect(formatMuseDuration(1_500)).toBe('1.5 seconds');
    expect(formatMuseDuration(90_000)).toBe('90 seconds');
    expect(formatMuseDuration(60_000)).toBe('1 minute');
    expect(formatMuseDuration(5 * 60_000)).toBe('5 minutes');
    expect(formatMuseDuration(30 * 60_000)).toBe('30 minutes');
    expect(formatMuseDuration(60 * 60_000)).toBe('1 hour');
    expect(formatMuseDuration(90 * 60_000)).toBe('90 minutes');
  });

  test('turns that launch nothing still settle at their first run_terminal and are reaped silently if they linger', async () => {
    vi.useFakeTimers();
    const { harness, emit } = await startTurn('bg-none', {
      turnIdleTimeoutMs: 1_000,
    });
    await emit(...MUSE_13_BASH_TOOL_TURN_LINES);
    const events = await drain(harness.iterator, 7, 'bash turn');
    expect(events.at(-1)?.method).toBe('turn.completed');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(harness.processes[0].killed).toBe(true);
    // No warning for a child with nothing the turn knew of still running.
    const next = await Promise.race([
      harness.iterator.next(),
      vi.advanceTimersByTimeAsync(50).then(() => 'none' as const),
    ]);
    expect(next).toBe('none');
  });
});
