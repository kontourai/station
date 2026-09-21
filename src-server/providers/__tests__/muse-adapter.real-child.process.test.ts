import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CanonicalRuntimeEvent } from '@kontourai/station-contracts/runtime-events';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
  MUSE_TURN_IDLE_TIMEOUT_CODE,
  MUSE_TURN_TOTAL_TIMEOUT_CODE,
  MuseAdapter,
} from '../adapters/muse-adapter.js';
import type { MuseProcessLike } from '../adapters/muse-adapter-types.js';
import { spawnOwnedChild } from '../../services/infra/process-utils.js';

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
 * #2269 real-child supervision proof (process-heavy).
 *
 * The spawn-free `muse-adapter.test.ts` suite proves deadline semantics with
 * injected doubles; this file proves the same deadlines against REAL owned
 * children: a tiny Node fixture stands in for `muse exec --json` (no model,
 * no billing, no 30-minute waits — all bounds are short injected values),
 * spawned through the production `spawnOwnedChild` path (`windowsHide`,
 * detached group, owned registry record) and torn down by the production
 * `terminateProcessTree` path (no injected `terminateProcess` anywhere).
 *
 * Every wall-clock value here is a bound the run observes, not a constant
 * the test asserts: cases wait for stream facts (terminal events, pid files,
 * process death) with generous caps, and never assert exact firing times.
 * Startup headroom is explicit — the idle/total values leave seconds of
 * slack above fixture spawn cost on a loaded host.
 */

const SILENT_FIXTURE = `setInterval(() => {}, 1000);\n`;

const NOISY_FIXTURE = `let n = 0;
setInterval(() => {
  n += 1;
  process.stdout.write('not-json just noise ' + n + '\\n');
  process.stderr.write('muse: workspace root: /tmp\\n');
}, 100);\n`;

const ACTIVE_FIXTURE = `let n = 0;
setInterval(() => {
  n += 1;
  process.stdout.write(JSON.stringify({ payload: { kind: 'run_output_delta', text: 'tick ' + n } }) + '\\n');
}, 100);\n`;

const COMPLETING_FIXTURE = `process.stdout.write(JSON.stringify({ payload: { kind: 'run_output_delta', text: 'done' } }) + '\\n');
process.stdout.write(JSON.stringify({ payload: { kind: 'run_terminal', terminal: 'completed', reason: null, text: 'done' } }) + '\\n');
setTimeout(() => process.exit(0), 200);\n`;

const TREE_FIXTURE = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const grandchild = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
writeFileSync(process.argv[2], String(grandchild.pid ?? -1));
setInterval(() => {}, 1000);\n`;

const TERMINAL_METHODS = new Set(['runtime.error', 'turn.completed', 'turn.aborted']);

function isDead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

async function waitFor(
  label: string,
  predicate: () => boolean,
  timeoutMs = 25_000,
): Promise<void> {
  const startedAt = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

interface OwnedRealChild {
  adapter: MuseAdapter;
  seen: CanonicalRuntimeEvent[];
  collector: Promise<void>;
  childPids: number[];
  releaseCalls: number;
  registryDir: string;
  fixturePath: (name: string, source: string) => string;
}

const tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function startOwnedTurn(options: {
  threadId: string;
  fixture: string;
  turnIdleTimeoutMs: number;
  turnTimeoutMs: number;
  extraArgs?: string[];
}): Promise<{ harness: OwnedRealChild; turnId: string }> {
  const root = mkdtempSync(join(tmpdir(), 'station-muse-real-child-'));
  tempRoots.push(root);
  const registryDir = join(root, 'registry');
  const seen: CanonicalRuntimeEvent[] = [];
  const childPids: number[] = [];
  const harness: OwnedRealChild = {
    adapter: undefined as never,
    seen,
    collector: Promise.resolve(),
    childPids,
    releaseCalls: 0,
    registryDir,
    fixturePath: (name, source) => {
      const path = join(root, name);
      writeFileSync(path, source, { mode: 0o600 });
      return path;
    },
  };
  const script = harness.fixturePath('fixture.mjs', options.fixture);
  const argv = [script, ...(options.extraArgs ?? [])];
  const adapter = new MuseAdapter({
    turnIdleTimeoutMs: options.turnIdleTimeoutMs,
    turnTimeoutMs: options.turnTimeoutMs,
    processFactory: () => {
      const { proc, release } = spawnOwnedChild(process.execPath, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        registryDir,
      });
      if (typeof proc.pid === 'number') childPids.push(proc.pid);
      const wrappedRelease = () => {
        harness.releaseCalls += 1;
        release();
      };
      return {
        process: proc as unknown as MuseProcessLike,
        release: wrappedRelease,
      };
    },
  });
  harness.adapter = adapter;
  await adapter.startSession({ provider: 'muse', threadId: options.threadId });
  harness.collector = (async () => {
    for await (const event of adapter.streamEvents()) {
      seen.push(event);
    }
  })();
  const { turnId } = await adapter.sendTurn({
    threadId: options.threadId,
    input: 'probe',
  });
  return { harness, turnId };
}

async function stopHarness(harness: OwnedRealChild): Promise<void> {
  await harness.adapter.stopAll().catch(() => {});
  await harness.collector;
  for (const pid of harness.childPids) {
    await waitFor(`child ${pid} to exit`, () => isDead(pid), 15_000);
  }
}

function terminalsFor(
  seen: CanonicalRuntimeEvent[],
  turnId: string,
): CanonicalRuntimeEvent[] {
  return seen.filter(
    (event) =>
      event.turnId === turnId && TERMINAL_METHODS.has(event.method),
  );
}

describe('muse adapter real owned-child supervision (#2269)', () => {
  let harness: OwnedRealChild | undefined;

  beforeEach(() => {
    harness = undefined;
  });

  afterEach(async () => {
    if (harness) await stopHarness(harness);
  });

  test('a silent real child is idle-killed, reaped, and released exactly once', async () => {
    const started = await startOwnedTurn({
      threadId: 'real-idle-silent',
      fixture: SILENT_FIXTURE,
      turnIdleTimeoutMs: 1_500,
      turnTimeoutMs: 20_000,
    });
    harness = started.harness;
    const { seen, childPids, registryDir } = started.harness;
    const { turnId } = started;

    expect(childPids).toHaveLength(1);
    const pid = childPids[0];
    // The owned-process record exists while the child lives.
    expect(
      readdirSync(registryDir).filter((name) => name === `engine-${pid}.json`),
    ).toHaveLength(1);

    await waitFor('idle terminal for the silent child', () =>
      terminalsFor(seen, turnId).some(
        (event) =>
          event.method === 'runtime.error' &&
          event.code === MUSE_TURN_IDLE_TIMEOUT_CODE,
      ),
    );
    // The real child is actually gone — not just a mock kill — and the slot
    // is freed only then: a replacement turn starts against the same session.
    await waitFor(`real child ${pid} to exit`, () => isDead(pid));
    const terminals = terminalsFor(seen, turnId);
    expect(terminals).toHaveLength(1);
    expect(started.harness.releaseCalls).toBe(1);
    expect(
      readdirSync(registryDir).filter((name) => name === `engine-${pid}.json`),
    ).toHaveLength(0);

    const followUp = await started.harness.adapter.sendTurn({
      threadId: 'real-idle-silent',
      input: 'follow-up',
    });
    expect(followUp.turnId).not.toBe(turnId);
  }, 60_000);

  test('stderr and malformed output never reschedule the idle deadline', async () => {
    const started = await startOwnedTurn({
      threadId: 'real-idle-noisy',
      fixture: NOISY_FIXTURE,
      turnIdleTimeoutMs: 1_500,
      turnTimeoutMs: 20_000,
    });
    harness = started.harness;
    const { seen, childPids } = started.harness;
    const { turnId } = started;

    await waitFor('idle terminal for the noisy child', () =>
      terminalsFor(seen, turnId).some(
        (event) =>
          event.method === 'runtime.error' &&
          event.code === MUSE_TURN_IDLE_TIMEOUT_CODE,
      ),
    );
    // Noise produced no verified activity at all.
    expect(
      seen.filter(
        (event) =>
          event.turnId === turnId &&
          (event.method === 'content.text-delta' ||
            event.method === 'tool.completed'),
      ),
    ).toHaveLength(0);
    expect(terminalsFor(seen, turnId)).toHaveLength(1);
    await waitFor(`real child ${childPids[0]} to exit`, () =>
      isDead(childPids[0]),
    );
    expect(started.harness.releaseCalls).toBe(1);
  }, 60_000);

  test('verified activity outlasts idle, then the fixed total ends the real child', async () => {
    const started = await startOwnedTurn({
      threadId: 'real-total-beats-idle',
      fixture: ACTIVE_FIXTURE,
      turnIdleTimeoutMs: 2_500,
      turnTimeoutMs: 6_000,
    });
    harness = started.harness;
    const { seen, childPids } = started.harness;
    const { turnId } = started;

    await waitFor('total terminal for the active child', () =>
      terminalsFor(seen, turnId).some(
        (event) =>
          event.method === 'runtime.error' &&
          event.code === MUSE_TURN_TOTAL_TIMEOUT_CODE,
      ),
    );
    // Deltas streamed across a span wider than one idle window, so the turn
    // demonstrably survived idle expiry by activity — and still died at the
    // fixed total, which activity never moves.
    const deltas = seen.filter(
      (event) =>
        event.turnId === turnId && event.method === 'content.text-delta',
    );
    const stamps = deltas
      .map((event) => Date.parse(event.createdAt))
      .filter((value) => Number.isFinite(value));
    expect(deltas.length).toBeGreaterThan(3);
    expect(Math.max(...stamps) - Math.min(...stamps)).toBeGreaterThan(2_500);
    expect(terminalsFor(seen, turnId)).toHaveLength(1);
    await waitFor(`real child ${childPids[0]} to exit`, () =>
      isDead(childPids[0]),
    );
    expect(started.harness.releaseCalls).toBe(1);
  }, 60_000);

  test('a completing real child exits cleanly with one terminal and one release', async () => {
    const started = await startOwnedTurn({
      threadId: 'real-clean-exit',
      fixture: COMPLETING_FIXTURE,
      turnIdleTimeoutMs: 10_000,
      turnTimeoutMs: 20_000,
    });
    harness = started.harness;
    const { seen, childPids } = started.harness;
    const { turnId } = started;

    await waitFor('completed terminal for the exiting child', () =>
      terminalsFor(seen, turnId).some(
        (event) => event.method === 'turn.completed',
      ),
    );
    await waitFor(`real child ${childPids[0]} to exit`, () =>
      isDead(childPids[0]),
    );
    // The exit handler settles nothing new: exactly one terminal, one release.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(terminalsFor(seen, turnId)).toHaveLength(1);
    expect(started.harness.releaseCalls).toBe(1);

    const followUp = await started.harness.adapter.sendTurn({
      threadId: 'real-clean-exit',
      input: 'follow-up',
    });
    expect(followUp.turnId).not.toBe(turnId);
  }, 60_000);

  test('an idle kill reaps the owned descendant tree, not just the child', async () => {
    const root = mkdtempSync(join(tmpdir(), 'station-muse-real-tree-'));
    tempRoots.push(root);
    const pidFile = join(root, 'grandchild.pid');
    const script = join(root, 'tree.mjs');
    writeFileSync(script, TREE_FIXTURE, { mode: 0o600 });
    const registryDir = join(root, 'registry');
    const seen: CanonicalRuntimeEvent[] = [];
    const childPids: number[] = [];
    let releaseCalls = 0;
    const adapter = new MuseAdapter({
      turnIdleTimeoutMs: 1_500,
      turnTimeoutMs: 20_000,
      processFactory: () => {
        const { proc, release } = spawnOwnedChild(
          process.execPath,
          [script, pidFile],
          { stdio: ['ignore', 'pipe', 'pipe'], registryDir },
        );
        if (typeof proc.pid === 'number') childPids.push(proc.pid);
        return {
          process: proc as unknown as MuseProcessLike,
          release: () => {
            releaseCalls += 1;
            release();
          },
        };
      },
    });
    harness = {
      adapter,
      seen,
      collector: Promise.resolve(),
      childPids,
      releaseCalls: 0,
      registryDir,
      fixturePath: (name, source) => {
        const path = join(root, name);
        writeFileSync(path, source, { mode: 0o600 });
        return path;
      },
    };
    await adapter.startSession({ provider: 'muse', threadId: 'real-idle-tree' });
    harness.collector = (async () => {
      for await (const event of adapter.streamEvents()) {
        seen.push(event);
      }
    })();
    const { turnId } = await adapter.sendTurn({
      threadId: 'real-idle-tree',
      input: 'probe',
    });

    // Ready barrier: the fixture reports its real grandchild pid to a file —
    // no blind sleep before asserting the tree exists.
    await waitFor('grandchild pid file', () => {
      try {
        return readdirSync(root).includes('grandchild.pid');
      } catch {
        return false;
      }
    });
    const grandchildPid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(Number.isSafeInteger(grandchildPid)).toBe(true);
    expect(isDead(grandchildPid)).toBe(false);

    await waitFor('idle terminal for the tree child', () =>
      terminalsFor(seen, turnId).some(
        (event) =>
          event.method === 'runtime.error' &&
          event.code === MUSE_TURN_IDLE_TIMEOUT_CODE,
      ),
    );
    // Both the child and its owned descendant are really gone.
    await waitFor(`real child ${childPids[0]} to exit`, () =>
      isDead(childPids[0]),
    );
    await waitFor(`grandchild ${grandchildPid} to be reaped`, () =>
      isDead(grandchildPid),
    );
    expect(terminalsFor(seen, turnId)).toHaveLength(1);
    expect(releaseCalls).toBe(1);
  }, 60_000);
});
