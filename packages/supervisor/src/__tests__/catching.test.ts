/**
 * Connection catching (protocol 1.1) with real processes and sockets, and
 * every pairing of a supervisor and core that does or does not speak it.
 * Catching is Windows-only in production;
 * STATION_SUPERVISOR_TEST_FORCE_CATCHING runs the same code on any host
 * (1) or turns it off as a 1.0 supervisor has it (0).
 */
import { realpathSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { trackTempDirs } from '../../../../src-server/__test-utils__/temp-dirs.ts';
import {
  getBoot,
  type RunningSupervisor,
  startLoad,
  startSupervisor,
  writeCoreVariant,
} from './harness.ts';

const makeTempDir = trackTempDirs();

const CATCH_ON = { STATION_SUPERVISOR_TEST_FORCE_CATCHING: '1' };
const CATCH_OFF = { STATION_SUPERVISOR_TEST_FORCE_CATCHING: '0' };
const PROTOCOL_1_0 = { FAKE_CORE_PROTOCOL_1_0: '1' };

const PASSED = /passed (\d+) connection\(s\) held during the handoff/g;
const SPARES_TIMED_OUT = /listener spares; draining anyway/;

function passedCounts(supervisor: RunningSupervisor): number[] {
  return [...supervisor.output().matchAll(PASSED)].map((match) =>
    Number(match[1]),
  );
}

async function handOffUnderLoad(
  supervisor: RunningSupervisor,
  entries: Array<{ entry: string; generation: number }>,
): Promise<void> {
  const load = startLoad(supervisor.port);
  try {
    await vi.waitFor(() => expect(load.stats.ok).toBeGreaterThan(20));
    for (const { entry, generation } of entries) {
      const result = await supervisor.handoff({ entry });
      expect(result, supervisor.output()).toMatchObject({
        outcome: 'committed',
        generation,
      });
      const servedBefore = load.stats.ok;
      await vi.waitFor(() =>
        expect(load.stats.ok).toBeGreaterThan(servedBefore + 20),
      );
    }
  } finally {
    const stats = await load.stop();
    expect(stats.errors, supervisor.output()).toEqual({});
  }
}

describe('connection catching during a handoff (real processes)', () => {
  it('holds connections made while the listener moves and serves each one on the next generation, through a handoff and two rollbacks', async () => {
    const home = makeTempDir('sup-catch-');
    const buildRoot = makeTempDir('sup-catch-build-');
    const entry = realpathSync(writeCoreVariant(buildRoot, 'core', {}));
    const badEntry = writeCoreVariant(buildRoot, 'bad-core', {
      FAKE_CORE_NEVER_READY: '1',
    });
    const servesThenFails = writeCoreVariant(buildRoot, 'serving-core', {
      FAKE_CORE_SERVE_WITHOUT_READY: '1',
    });
    const supervisor = await startSupervisor({ home, entry, env: CATCH_ON });
    const load = startLoad(supervisor.port);
    try {
      await vi.waitFor(() => expect(load.stats.ok).toBeGreaterThan(20));
      expect(
        await supervisor.handoff({ entry }),
        supervisor.output(),
      ).toMatchObject({ outcome: 'committed', generation: 2 });
      // Generation 2 adopted connections the supervisor caught and served
      // them: the load client saw no error and kept being answered.
      const [passed] = passedCounts(supervisor);
      expect(passed, supervisor.output()).toBeGreaterThan(0);
      const boot = await getBoot(supervisor.port);
      expect(boot.adoptedConnections).toBe(passed);
      // The test switch is the supervisor's alone.
      expect(boot.inheritedForceCatching).toBeNull();
      let servedBefore = load.stats.ok;
      await vi.waitFor(() =>
        expect(load.stats.ok).toBeGreaterThan(servedBefore + 20),
      );

      // A trial that never becomes ready: what was caught goes to the
      // generation the rollback starts.
      expect(
        await supervisor.handoff({
          entry: badEntry,
          readinessTimeoutMs: 1_500,
        }),
        supervisor.output(),
      ).toMatchObject({ outcome: 'rolled-back', generation: 4 });
      expect(supervisor.output()).toMatch(
        /passed \d+ connection\(s\) held during the handoff to generation 4/,
      );
      servedBefore = load.stats.ok;
      await vi.waitFor(() =>
        expect(load.stats.ok).toBeGreaterThan(servedBefore + 20),
      );

      // A trial that listens and serves, then misses readiness: it gets what
      // was held from generation 4's drain, and its own drain is caught for
      // the generation the rollback starts.
      expect(
        await supervisor.handoff({
          entry: servesThenFails,
          readinessTimeoutMs: 1_500,
        }),
        supervisor.output(),
      ).toMatchObject({ outcome: 'rolled-back', generation: 6 });
      expect(supervisor.output()).toContain(
        'catching connections on 8 spare listener(s) while generation 5 drains',
      );
      expect(supervisor.output()).toMatch(
        /passed \d+ connection\(s\) held during the handoff to generation 6/,
      );
      servedBefore = load.stats.ok;
      await vi.waitFor(() =>
        expect(load.stats.ok).toBeGreaterThan(servedBefore + 20),
      );
    } finally {
      const stats = await load.stop();
      expect(stats.errors, supervisor.output()).toEqual({});
    }
    expect(supervisor.output()).not.toMatch(SPARES_TIMED_OUT);
  }, 120_000);

  it('a 1.1 supervisor catches nothing for a 1.0 core, upgrading from one or downgrading to one, and does not wait for spares', async () => {
    const home = makeTempDir('sup-catch-old-core-');
    const buildRoot = makeTempDir('sup-catch-old-core-build-');
    const oldCore = realpathSync(
      writeCoreVariant(buildRoot, 'old-core', PROTOCOL_1_0),
    );
    const newCore = realpathSync(writeCoreVariant(buildRoot, 'new-core', {}));
    const supervisor = await startSupervisor({
      home,
      entry: oldCore,
      env: CATCH_ON,
    });
    await handOffUnderLoad(supervisor, [
      { entry: newCore, generation: 2 },
      { entry: oldCore, generation: 3 },
    ]);
    expect(passedCounts(supervisor)).toEqual([]);
    expect(supervisor.output()).not.toMatch(SPARES_TIMED_OUT);
    expect((await getBoot(supervisor.port)).generation).toBe(3);
  }, 120_000);

  it('a 1.0 supervisor, which never asks for spares, hands off between 1.1 cores as before', async () => {
    const home = makeTempDir('sup-catch-old-supervisor-');
    const buildRoot = makeTempDir('sup-catch-old-supervisor-build-');
    const entry = realpathSync(writeCoreVariant(buildRoot, 'core', {}));
    const supervisor = await startSupervisor({ home, entry, env: CATCH_OFF });
    await handOffUnderLoad(supervisor, [
      { entry, generation: 2 },
      { entry, generation: 3 },
    ]);
    expect(passedCounts(supervisor)).toEqual([]);
    expect((await getBoot(supervisor.port)).adoptedConnections).toBe(0);
  }, 120_000);

  it('closes every held connection sent to a generation that dies before taking them', async () => {
    const home = makeTempDir('sup-catch-unacked-');
    const buildRoot = makeTempDir('sup-catch-unacked-build-');
    const entry = realpathSync(writeCoreVariant(buildRoot, 'core', {}));
    // Listens, then blocks past the supervisor's release (so the handles it
    // is sent queue unacknowledged) and dies.
    const dying = writeCoreVariant(buildRoot, 'dying-core', {
      FAKE_CORE_SERVE_WITHOUT_READY: '1',
      FAKE_CORE_BLOCK_THEN_DIE_MS: '2500',
    });
    const supervisor = await startSupervisor({ home, entry, env: CATCH_ON });
    const load = startLoad(supervisor.port);
    let stats: Awaited<ReturnType<typeof load.stop>> | undefined;
    try {
      await vi.waitFor(() => expect(load.stats.ok).toBeGreaterThan(20));
      expect(
        await supervisor.handoff({ entry: dying, readinessTimeoutMs: 10_000 }),
        supervisor.output(),
      ).toMatchObject({ outcome: 'rolled-back', generation: 3 });
      // Several were sent to it, so all but the first queued in Node.
      const sent = supervisor
        .output()
        .match(
          /passed (\d+) connection\(s\) held during the handoff to generation 2/,
        );
      expect(Number(sent?.[1] ?? 0), supervisor.output()).toBeGreaterThan(1);
      const servedBefore = load.stats.ok;
      await vi.waitFor(() =>
        expect(load.stats.ok).toBeGreaterThan(servedBefore + 20),
      );
    } finally {
      stats = await load.stop();
    }
    // Each was closed when the generation died; none was left open for its
    // client to wait out.
    expect(stats.errors.TIMEOUT, supervisor.output()).toBeUndefined();
  }, 120_000);
});
