import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import {
  ENGINE_CAPABILITY_MATRICES,
  resolveEngineCapabilityMatrix,
  UNKNOWN_EXTERNAL_ENGINE_MATRIX,
} from '@kontourai/station-contracts/engine-capability-matrix';
import {
  resolveModelLaunchPlan,
  unsupportedModelOptionKeys,
} from '@kontourai/station-contracts/provider';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { ProviderAdapterShape } from '../adapter-shape.js';
import type { MuseAdapterOptions } from '../adapters/muse-adapter.js';
import {
  MUSE_STDOUT_BUFFER_MAX_CHARS,
  MuseAdapter,
  museCredentialPath,
} from '../adapters/muse-adapter.js';
import type { MuseProcessLike } from '../adapters/muse-adapter-types.js';
import { MUSE_MODEL_LAUNCH } from '../adapters/muse-adapter-types.js';
import { expectCanonicalSessionLifecycle } from './adapter-contract-test-utils.js';
import {
  MUSE_ECHO_OUTPUT_DELTA,
  MUSE_ECHO_RUN_STARTED,
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
    expect(adapter.metadata.runtimeId).toBe('muse-runtime');
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
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-slot',
    });
    await harness.adapter.sendTurn({ threadId: 'thread-slot', input: 'one' });
    await writeLines(harness.processes[0], MUSE_META_RUN_TERMINAL);

    // The turn has settled — `turn.completed` is already published — but the
    // child is still alive.
    await expect(
      harness.adapter.sendTurn({ threadId: 'thread-slot', input: 'two' }),
    ).rejects.toThrow('active turn');
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
    await expect(
      harness.adapter.sendTurn({ threadId: 'thread-stop-race', input: 'two' }),
    ).rejects.toThrow('stopped');
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
  });

  test('resolveEngineCapabilityMatrix does not fall back to UNKNOWN for muse', () => {
    expect(ENGINE_CAPABILITY_MATRICES.muse).toBeDefined();
    const matrix = resolveEngineCapabilityMatrix('muse-runtime', {
      type: 'muse',
    });
    expect(matrix).toBe(ENGINE_CAPABILITY_MATRICES.muse);
    expect(matrix).not.toBe(UNKNOWN_EXTERNAL_ENGINE_MATRIX);
    expect(matrix.engineId).toBe('muse');
    expect(matrix.displayName).toBe('Muse Code');
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
    await expect(
      harness.adapter.sendTurn({ threadId: 'thread-survivor', input: 'again' }),
    ).rejects.toThrow('active turn');

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

  test('does not publish tool.started — the live stream has no id to open one with', async () => {
    const harness = createHarness();
    await harness.adapter.startSession({
      provider: 'muse',
      threadId: 'thread-tools-start',
    });
    await harness.adapter.sendTurn({
      threadId: 'thread-tools-start',
      input: 'go',
    });
    await writeLines(harness.processes[0], MUSE_TOOL_RESULT);
    harness.processes[0].stdout.write(
      `${JSON.stringify({
        schema_version: 1,
        record_type: 'event',
        payload: { kind: 'run_terminal', terminal: 'completed', text: 'done' },
      })}\n`,
    );
    await flushIo();

    const methods: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      methods.push((await nextEvent(harness.iterator, `m${i}`)).method);
    }
    expect(methods).toContain('tool.completed');
    // `call_id` appears only on the result; a started event would have to
    // borrow task_lifecycle's task_id and would never pair.
    expect(methods).not.toContain('tool.started');
  });
});
