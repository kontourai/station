/**
 * Live OOM-kill reports, near-cap memory pressure and engine OOM-score
 * protection in workload scopes (#5081), against the real launcher with a
 * fake systemd manager, a fake cgroup tree and a fake /proc.
 */
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ChildWorkloadNotice,
  closeChildWorkload,
  prepareChildWorkload,
  trackChildWorkload,
} from '@kontourai/station-shared/child-workload';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

const log = vi.hoisted(() => ({
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
}));
vi.mock('../../../utils/logger.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/logger.js')>()),
  createLogger: () => log,
}));
vi.mock('../../../telemetry/metrics.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../telemetry/metrics.js')>()),
  workloadScopeCleanupAttempts: { add: vi.fn() },
  workloadScopeCleanupBacklog: { addCallback: vi.fn() },
  workloadScopeOomKills: { add: vi.fn() },
  workloadScopeMemoryPressure: { add: vi.fn() },
}));

import {
  workloadScopeMemoryPressure,
  workloadScopeOomKills,
} from '../../../telemetry/metrics.js';
import { WORKLOAD_SESSION_ENV } from '../workload-budget.js';
import {
  __workloadTestHooks,
  inspectSessionWorkload,
  workloadBudgetStatus,
} from '../workload-resources.js';

const MIB = 1024 * 1024;
const makeTempDir = trackTempDirs();
const KILL_WARNING = 'A process in a workload scope was killed for memory';
const PRESSURE_WARNING = 'A workload scope is near its memory limit';
const PRESSURE_EXIT = 'A workload scope is no longer near its memory limit';
/** The engine is this test process: the monitor sees it alive. */
const LEADER = process.pid;
const HOLDER_CMDLINE = '/usr/bin/sleep\u00002147483647\u0000';

interface FakeProcess {
  pid: number;
  name: string;
  rssMiB: number;
  oomScoreAdj?: number;
  cmdline?: string;
}

const messages = (mock: typeof log.warn, message: string) =>
  mock.mock.calls.filter(([text]) => text === message);

describe('workload scope memory visibility (fake cgroup and /proc)', () => {
  const env = process.env;
  let cgroupRoot = '';
  let procRoot = '';
  const controlGroups = new Map<string, string>();

  beforeEach(() => {
    process.env = { ...env };
    delete process.env.STATION_WORKLOAD_PRESSURE_PERCENT;
    controlGroups.clear();
    for (const fn of Object.values(log)) fn.mockClear();
    vi.mocked(workloadScopeOomKills.add).mockClear();
    vi.mocked(workloadScopeMemoryPressure.add).mockClear();
  });
  afterEach(() => {
    process.env = env;
    __workloadTestHooks.reset();
  });

  async function start(options: { holder?: boolean } = {}) {
    const home = makeTempDir('workload-pressure-');
    cgroupRoot = join(home, 'sys-fs-cgroup');
    procRoot = join(home, 'proc');
    await __workloadTestHooks.start({
      homeDir: home,
      cgroupRoot,
      procRoot,
      manualMonitor: true,
      holderBinaries: options.holder
        ? { setsid: '/usr/bin/setsid', sleep: '/usr/bin/sleep' }
        : null,
      run: async (args) => {
        if (args[0] === 'show' && args.includes('--property=ControlGroup'))
          return `${controlGroups.get(args[1]) ?? ''}\n`;
        if (args[0] === 'show' && args[2]?.startsWith('--property=LoadState'))
          return controlGroups.has(args[1])
            ? `LoadState=loaded\nActiveState=active\nResult=success\nMemoryPeak=1\nCPUUsageNSec=1\nControlGroup=${controlGroups.get(args[1])}\n`
            : 'LoadState=not-found\nActiveState=inactive\n';
        return '';
      },
    });
  }

  /** Launches a scope (an engine's when sessionId is given) and tracks it. */
  async function launchScope(sessionId?: string, pid = LEADER) {
    const launch = prepareChildWorkload('/usr/bin/claude', [], {
      PATH: '/usr/bin',
      ...(sessionId ? { [WORKLOAD_SESSION_ENV]: sessionId } : {}),
    });
    if (!launch) throw new Error('no launcher installed');
    const unit = launch.args
      .find((arg) => arg.startsWith('--unit='))
      ?.slice('--unit='.length) as string;
    const group = `/app.slice/${unit}`;
    controlGroups.set(unit, group);
    const scope = `${cgroupRoot}${group}`;
    await mkdir(scope, { recursive: true });
    trackChildWorkload(launch, pid);
    return { launch, unit, scope, pid };
  }

  /** The scope's memory files, in the kernel's own format. */
  async function memory(
    scope: string,
    value: {
      currentMiB: number;
      maxMiB?: number;
      inactiveFileMiB?: number;
      oomKills?: number;
      limitEvents?: number;
    },
  ) {
    const kills = value.oomKills ?? 0;
    await writeFile(
      join(scope, 'memory.current'),
      `${value.currentMiB * MIB}\n`,
    );
    await writeFile(
      join(scope, 'memory.max'),
      `${(value.maxMiB ?? 1000) * MIB}\n`,
    );
    await writeFile(
      join(scope, 'memory.events'),
      `low 0\nhigh 0\nmax ${value.limitEvents ?? 0}\noom ${kills}\noom_kill ${kills}\noom_group_kill 0\n`,
    );
    await writeFile(
      join(scope, 'memory.stat'),
      `anon ${value.currentMiB * MIB}\ninactive_file ${(value.inactiveFileMiB ?? 0) * MIB}\n`,
    );
  }

  /** The scope's processes, each with its /proc status and oom_score_adj. */
  async function processes(scope: string, list: FakeProcess[]) {
    await writeFile(
      join(scope, 'cgroup.procs'),
      list.map(({ pid }) => `${pid}\n`).join(''),
    );
    for (const item of list) {
      const dir = join(procRoot, String(item.pid));
      await mkdir(dir, { recursive: true });
      await writeFile(
        join(dir, 'status'),
        `Name:\t${item.name}\nUmask:\t0022\nState:\tS (sleeping)\nVmRSS:\t${item.rssMiB * 1024} kB\n`,
      );
      await writeFile(join(dir, 'cmdline'), item.cmdline ?? `${item.name}\0`);
      await writeFile(
        join(dir, 'stat'),
        `${item.pid} (${item.name}) S ${Array.from({ length: 18 }, () => '0').join(' ')} 4242 0 0\n`,
      );
      await writeFile(
        join(dir, 'oom_score_adj'),
        `${item.oomScoreAdj ?? 200}\n`,
      );
    }
  }

  const oomScore = async (pid: number) =>
    Number(
      await readFile(join(procRoot, String(pid), 'oom_score_adj'), 'utf8'),
    );

  test('a kill in a running engine scope is reported within one poll, naming the largest processes', async () => {
    await start();
    // No engine listener: the Claude adapter registers none, and the kill
    // must be reported all the same.
    const { scope, unit } = await launchScope('thread-claude');
    const before: FakeProcess[] = [
      { pid: LEADER, name: 'claude', rssMiB: 240 },
      { pid: 2001, name: 'fallow', rssMiB: 5100 },
      { pid: 2002, name: 'node', rssMiB: 620 },
      { pid: 2003, name: 'sh', rssMiB: 4 },
      { pid: 2004, name: 'tsc', rssMiB: 100 },
    ];
    await processes(scope, before);
    // Near the cap first: the snapshot then names the culprit.
    await memory(scope, { currentMiB: 6200, maxMiB: 7000 });
    await __workloadTestHooks.pollOomKills();
    expect(messages(log.warn, KILL_WARNING)).toEqual([]);
    expect(messages(log.warn, PRESSURE_WARNING)).toHaveLength(1);

    // The kernel kills fallow; the next poll sees the count rise.
    await processes(
      scope,
      before.filter(({ pid }) => pid !== 2001),
    );
    await memory(scope, { currentMiB: 1000, maxMiB: 7000, oomKills: 1 });
    await __workloadTestHooks.pollOomKills();
    const kills = messages(log.warn, KILL_WARNING);
    expect(kills).toHaveLength(1);
    expect(kills[0]?.[1]).toMatchObject({
      unit,
      sessionId: 'thread-claude',
      oomKills: 1,
      newKills: 1,
      largestRemaining: [
        { pid: 2002, name: 'node', rssBytes: 620 * MIB },
        { pid: LEADER, name: 'claude', rssBytes: 240 * MIB },
        { pid: 2004, name: 'tsc', rssBytes: 100 * MIB },
      ],
      largestAtPressure: [
        { pid: 2001, name: 'fallow', rssBytes: 5100 * MIB },
        { pid: 2002, name: 'node', rssBytes: 620 * MIB },
        { pid: LEADER, name: 'claude', rssBytes: 240 * MIB },
      ],
    });
    expect(workloadScopeOomKills.add).toHaveBeenCalledTimes(1);
    expect(workloadScopeOomKills.add).toHaveBeenCalledWith(1, {
      source: 'live',
      scope_kind: 'engine',
    });
    expect(workloadBudgetStatus().scopes?.[0]).toMatchObject({
      oomKills: 1,
      lastOomKillAt: expect.any(String),
      lastOomKillProcesses: [
        expect.objectContaining({ name: 'node' }),
        expect.objectContaining({ name: 'claude' }),
        expect.objectContaining({ name: 'tsc' }),
      ],
    });

    // The same count again: nothing new to report.
    await __workloadTestHooks.pollOomKills();
    expect(messages(log.warn, KILL_WARNING)).toHaveLength(1);

    // A kill seen first at close is counted as such, once.
    await memory(scope, { currentMiB: 1000, maxMiB: 7000, oomKills: 2 });
    await closeChildWorkload(LEADER);
    expect(workloadScopeOomKills.add).toHaveBeenLastCalledWith(1, {
      source: 'close',
      scope_kind: 'engine',
    });
    expect(messages(log.warn, KILL_WARNING)).toHaveLength(1);
  });

  test('a cascade that ends the engine within one poll is still reported', async () => {
    await start();
    const { scope } = await launchScope('thread-cascade');
    await processes(scope, [{ pid: LEADER, name: 'claude', rssMiB: 240 }]);
    await memory(scope, { currentMiB: 300 });
    await __workloadTestHooks.pollOomKills();
    // fallow, fallow, node and the engine: four kills between two polls.
    await processes(scope, []);
    await memory(scope, { currentMiB: 0, oomKills: 4 });
    await __workloadTestHooks.pollOomKills();
    const kills = messages(log.warn, KILL_WARNING);
    expect(kills).toHaveLength(1);
    expect(kills[0]?.[1]).toMatchObject({ oomKills: 4, newKills: 4 });
    expect(workloadScopeOomKills.add).toHaveBeenCalledWith(4, {
      source: 'live',
      scope_kind: 'engine',
    });
    await closeChildWorkload(LEADER);
    // Close found nothing the poll had not already counted.
    expect(workloadScopeOomKills.add).toHaveBeenCalledTimes(1);
  });

  test('near-cap pressure is reported once on entering and once on leaving', async () => {
    await start();
    const { scope, unit } = await launchScope('thread-pressure');
    await processes(scope, [
      { pid: LEADER, name: 'claude', rssMiB: 240 },
      { pid: 2101, name: 'vitest', rssMiB: 600 },
    ]);
    // 80% of the 1000 MiB limit: below the default 85%.
    await memory(scope, { currentMiB: 800 });
    await __workloadTestHooks.pollOomKills();
    // Mostly inactive page cache: the working set is far from the limit.
    await memory(scope, { currentMiB: 990, inactiveFileMiB: 400 });
    await __workloadTestHooks.pollOomKills();
    expect(messages(log.warn, PRESSURE_WARNING)).toEqual([]);
    expect(workloadScopeMemoryPressure.add).not.toHaveBeenCalled();

    await memory(scope, { currentMiB: 900, limitEvents: 37 });
    await __workloadTestHooks.pollOomKills();
    await __workloadTestHooks.pollOomKills();
    // Still above 80%, the exit line: no transition.
    await memory(scope, { currentMiB: 820, limitEvents: 40 });
    await __workloadTestHooks.pollOomKills();
    const entered = messages(log.warn, PRESSURE_WARNING);
    expect(entered).toHaveLength(1);
    expect(entered[0]?.[1]).toMatchObject({
      unit,
      sessionId: 'thread-pressure',
      workingSetBytes: 900 * MIB,
      memoryMaxBytes: 1000 * MIB,
      thresholdPercent: 85,
      limitEvents: 37,
      largestProcesses: [
        { pid: 2101, name: 'vitest', rssBytes: 600 * MIB },
        { pid: LEADER, name: 'claude', rssBytes: 240 * MIB },
      ],
    });
    expect(workloadBudgetStatus().scopes?.[0]?.pressure).toMatchObject({
      thresholdPercent: 85,
      workingSetBytes: 900 * MIB,
    });
    // The engine reads the same state through workload_status.
    expect(
      (await inspectSessionWorkload('thread-pressure')).scope,
    ).toMatchObject({
      state: 'measured',
      pressure: {
        largestProcesses: [
          expect.objectContaining({ name: 'vitest' }),
          expect.objectContaining({ name: 'claude' }),
        ],
      },
    });

    await memory(scope, { currentMiB: 700, limitEvents: 40 });
    await __workloadTestHooks.pollOomKills();
    await __workloadTestHooks.pollOomKills();
    expect(messages(log.info, PRESSURE_EXIT)).toHaveLength(1);
    expect(messages(log.warn, PRESSURE_WARNING)).toHaveLength(1);
    expect(workloadBudgetStatus().scopes?.[0]?.pressure).toBeUndefined();
    expect(vi.mocked(workloadScopeMemoryPressure.add).mock.calls).toEqual([
      [1, { transition: 'enter', scope_kind: 'engine' }],
      [1, { transition: 'exit', scope_kind: 'engine' }],
    ]);
    await closeChildWorkload(LEADER);
  });

  test("an engine scope's notice subscribers hear each transition once, never once per poll (#5113)", async () => {
    await start();
    const { launch, scope } = await launchScope('thread-notices');
    const notices: ChildWorkloadNotice[] = [];
    const stop = launch.watchNotices?.((notice) => notices.push(notice));
    expect(stop).toBeDefined();
    const engine = { pid: LEADER, name: 'claude', rssMiB: 240 };
    const fallow = { pid: 2301, name: 'fallow', rssMiB: 600 };
    await processes(scope, [engine, fallow]);
    await memory(scope, { currentMiB: 900 });
    // Three polls above the threshold: one entering.
    for (let poll = 0; poll < 3; poll += 1)
      await __workloadTestHooks.pollOomKills();
    expect(notices).toEqual([
      {
        kind: 'pressure-enter',
        workingSetBytes: 900 * MIB,
        memoryMaxBytes: 1000 * MIB,
        thresholdPercent: 85,
        largestProcesses: [
          { pid: 2301, name: 'fallow', rssBytes: 600 * MIB },
          { pid: LEADER, name: 'claude', rssBytes: 240 * MIB },
        ],
      },
    ]);

    // The kernel kills fallow: announced once the engine is seen alive
    // after it, with what survived, and never again for the same count.
    await processes(scope, [engine]);
    await memory(scope, { currentMiB: 300, oomKills: 1 });
    for (let poll = 0; poll < 3; poll += 1)
      await __workloadTestHooks.pollOomKills();
    expect(notices.slice(1)).toEqual([
      {
        kind: 'pressure-exit',
        workingSetBytes: 300 * MIB,
        memoryMaxBytes: 1000 * MIB,
        thresholdPercent: 85,
      },
      {
        kind: 'oom-kill',
        // The limit the scope was launched with.
        kill: { oomKills: 1, newKills: 1, memoryMaxBytes: expect.any(Number) },
        largestProcesses: [
          { pid: LEADER, name: 'claude', rssBytes: 240 * MIB },
        ],
      },
    ]);

    // Unsubscribed: a later transition reaches nobody.
    stop?.();
    await memory(scope, { currentMiB: 950, oomKills: 1 });
    await __workloadTestHooks.pollOomKills();
    expect(notices).toHaveLength(3);
    expect(messages(log.warn, PRESSURE_WARNING)).toHaveLength(2);
    await closeChildWorkload(LEADER);
  });

  test('the pressure threshold follows STATION_WORKLOAD_PRESSURE_PERCENT', async () => {
    process.env.STATION_WORKLOAD_PRESSURE_PERCENT = '95';
    await start();
    const { scope } = await launchScope();
    await processes(scope, [{ pid: LEADER, name: 'node', rssMiB: 900 }]);
    await memory(scope, { currentMiB: 900 });
    await __workloadTestHooks.pollOomKills();
    expect(messages(log.warn, PRESSURE_WARNING)).toEqual([]);
    await memory(scope, { currentMiB: 960 });
    await __workloadTestHooks.pollOomKills();
    expect(messages(log.warn, PRESSURE_WARNING)).toHaveLength(1);
    expect(workloadScopeMemoryPressure.add).toHaveBeenCalledWith(1, {
      transition: 'enter',
      scope_kind: 'command',
    });
    await closeChildWorkload(LEADER);
  });

  test("an engine scope's commands get a higher OOM score than the engine", async () => {
    await start({ holder: true });
    const { scope } = await launchScope('thread-oom-score');
    await memory(scope, { currentMiB: 100 });
    await processes(scope, [
      { pid: LEADER, name: 'claude', rssMiB: 240, oomScoreAdj: 200 },
      { pid: 2201, name: 'sleep', rssMiB: 1, cmdline: HOLDER_CMDLINE },
      { pid: 2202, name: 'fallow', rssMiB: 50, oomScoreAdj: 200 },
      { pid: 2203, name: 'chrome', rssMiB: 50, oomScoreAdj: 900 },
    ]);
    await __workloadTestHooks.pollOomKills();
    expect(await oomScore(LEADER)).toBe(200);
    expect(await oomScore(2201)).toBe(200);
    expect(await oomScore(2202)).toBe(500);
    // Never lowered: a command that chose a higher score keeps it.
    expect(await oomScore(2203)).toBe(900);

    // A command the engine starts later is raised on the next poll.
    await processes(scope, [
      { pid: LEADER, name: 'claude', rssMiB: 240, oomScoreAdj: 200 },
      { pid: 2201, name: 'sleep', rssMiB: 1, cmdline: HOLDER_CMDLINE },
      { pid: 2204, name: 'node', rssMiB: 50, oomScoreAdj: 200 },
    ]);
    await __workloadTestHooks.pollOomKills();
    expect(await oomScore(2204)).toBe(500);
    expect(await oomScore(LEADER)).toBe(200);
    expect(await oomScore(2201)).toBe(200);
    await closeChildWorkload(LEADER);
  });

  test("a command scope's processes keep their OOM scores", async () => {
    await start();
    const { scope } = await launchScope();
    await memory(scope, { currentMiB: 100 });
    await processes(scope, [
      { pid: LEADER, name: 'node', rssMiB: 240, oomScoreAdj: 200 },
      { pid: 2301, name: 'node', rssMiB: 50, oomScoreAdj: 200 },
    ]);
    await __workloadTestHooks.pollOomKills();
    expect(await oomScore(2301)).toBe(200);
    await closeChildWorkload(LEADER);
  });

  test.skipIf(process.getuid?.() === 0)(
    'a failed OOM score raise is reported once and not retried',
    async () => {
      await start();
      const { scope, unit } = await launchScope('thread-oom-score-denied');
      await memory(scope, { currentMiB: 100 });
      await processes(scope, [
        { pid: LEADER, name: 'claude', rssMiB: 240, oomScoreAdj: 200 },
        { pid: 2401, name: 'node', rssMiB: 50, oomScoreAdj: 200 },
      ]);
      // Readable but not writable: the raise is refused, as the kernel refuses
      // a process another user owns.
      await chmod(join(procRoot, '2401', 'oom_score_adj'), 0o444);
      await __workloadTestHooks.pollOomKills();
      await __workloadTestHooks.pollOomKills();
      const failures = log.warn.mock.calls.filter(([text]) =>
        String(text).startsWith("Could not raise a command's OOM score"),
      );
      expect(failures).toHaveLength(1);
      expect(failures[0]?.[1]).toMatchObject({ unit });
      await closeChildWorkload(LEADER);
    },
  );
});
