#!/usr/bin/env node
/**
 * Station idle-weight and request-overhead check.
 *
 * Starts one isolated instance through the real launcher, measures how heavy
 * its process tree is at rest, sends "hi" to the Claude engine through a
 * loopback stub endpoint (no model spend), and compares the results with a
 * recorded baseline. See docs/reference/station-weight.md.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { lookupProcessBirthFingerprint } from '../../packages/shared/src/process-identity.mjs';
import { acceptedTurnReply } from '../../tests/live/helpers/accepted-turn-reply.mjs';
import { execFileSyncBounded } from '../lib/bounded-capture.mjs';
import { findFreePortBlock, findFreePortOutside } from '../lib/free-ports.mjs';
import { invokedDirectly } from '../lib/module-entry.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
} from '../lib/owned-process.mjs';
import {
  evaluateBudgets,
  formatVerdicts,
  gateOutcome,
  recordBaseline,
} from './station-weight-budgets.mjs';
import {
  diffAgainstControl,
  findTurnRequest,
  markersReached,
  messagesRequests,
  summarizeRequest,
  summarizeSideCall,
} from './station-weight-request.mjs';
import { STUB_REPLY_TEXT, startStubAnthropic } from './station-weight-stub.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
export const DEFAULT_BASELINE_PATH = join(HERE, 'station-weight-baseline.json');
const PROMPT = 'hi';
const RESERVED_PORTS = [3000, 3141];
/** Ports an instance occupies relative to its server port (see development guide). */
const SERVER_BAND = [0, 2, 3];

const progress = (text) =>
  process.stderr.write(
    `[station-weight] ${new Date().toISOString()} ${text}\n`,
  );

const measured = (value, unit, extra = {}) => ({
  status: 'measured',
  value,
  unit,
  ...extra,
});
const notMeasured = (reason, unit) => ({
  status: 'not_measured',
  unit,
  reason,
});

/**
 * `base` without any `GIT_*` variable. GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE,
 * GIT_CONFIG_* and the rest route or reconfigure every git command that
 * inherits them, so a caller running inside another checkout's hook would
 * otherwise have the check read, or commit into, that checkout.
 */
export function gitEnvironment(base = process.env) {
  return Object.fromEntries(
    Object.entries(base).filter(([key]) => !key.startsWith('GIT_')),
  );
}

const git = (...args) =>
  execFileSyncBounded('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
    env: gitEnvironment(),
  }).trim();

/** The revision under test and whether the tree is dirty. */
export function repositoryState() {
  return { sha: git('rev-parse', 'HEAD'), dirty: git('status', '--porcelain') };
}

// ---------------------------------------------------------------------------
// Process tree: what belongs to the run, by recorded identity and by the
// environment every process the instance starts inherits.

/**
 * One process as this check sees it. `uid`, `startedAtMs` and
 * `contextSwitches` (Linux) come with a table read; `memoryBytes` is attached
 * by withMemory.
 * @typedef {{ pid: number, ppid: number, uid?: number, rssBytes: number, cpuSeconds: number, started: string, startedAtMs?: number, contextSwitches?: number, command: string, memoryBytes?: number }} ProcessRow
 * @typedef {{ pid: number, started: string }} ProcessIdentity
 * @typedef {{ tags: string[], excludeTags?: string[], argumentMarkers?: string[], uid: number, notBeforeMs: number }} Tagging
 * @typedef {(command: string, args: string[], options: object) => string} RunCommand
 * @typedef {{ status: string, value?: number, unit?: string, reason?: string, [detail: string]: any }} Metric
 */

/** Pinned so lstart is a property of the process, not of who asked. */
const PS_ENV = { ...process.env, LC_ALL: 'C', TZ: 'UTC' };

const MONTHS = 'Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec'.split(' ');

/** C-locale lstart, `Www Mmm [ d]d HH:MM:SS YYYY`, as `ps` prints it. */
const lstartToken = ([weekday, month, day, clock, year]) =>
  `${weekday} ${month} ${day.padStart(2, ' ')} ${clock} ${year}`;

/** Epoch ms of a UTC lstart (whole seconds), or NaN. */
const lstartMs = ([, month, day, clock, year]) => {
  const [hours, minutes, seconds] = clock.split(':').map(Number);
  return Date.UTC(
    Number(year),
    MONTHS.indexOf(month),
    Number(day),
    hours,
    minutes,
    seconds,
  );
};

/**
 * The fields of one `/proc/<pid>/stat` line this check uses, or `null` when
 * it does not parse. Field numbers are proc(5)'s: ppid 4, utime 14, stime
 * 15, starttime 22, rss 24 (pages).
 */
export function parseProcStat(text) {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = text
    .slice(close + 1)
    .trim()
    .split(/\s+/);
  const picked = [fields[1], fields[11], fields[12], fields[19], fields[21]];
  if (!picked.every((field) => /^\d+$/.test(field ?? ''))) return null;
  const [ppid, utime, stime, startTicks, rssPages] = picked;
  return {
    command: text.slice(open + 1, close),
    ppid: Number(ppid),
    ticks: Number(utime) + Number(stime),
    startTicks,
    rssPages: Number(rssPages),
  };
}

let linuxContext;
/** Host constants a Linux row is computed with; read once. */
function defaultLinuxContext() {
  const getconf = (name) => {
    const value = Number(
      execFileSyncBounded('getconf', [name], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
    );
    assert(Number.isInteger(value) && value > 0, `getconf ${name}`);
    return value;
  };
  linuxContext ??= {
    bootId: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    hz: getconf('CLK_TCK'),
    pageSize: getconf('PAGESIZE'),
    bootTimeSeconds: Number(
      readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)$/m)?.[1],
    ),
  };
  assert(
    Number.isInteger(linuxContext.bootTimeSeconds),
    '/proc/stat carries no btime',
  );
  return linuxContext;
}

/**
 * The Linux process table, one row per process from a single
 * `/proc/<pid>/stat` read (parent, CPU, birth and RSS together) plus its
 * `status` (effective uid, context switches). `stat` is read again after
 * `status`: a process whose start ticks changed in between exited and its pid
 * was reused, so it is dropped rather than given another process's fields.
 * The birth token is the format `lookupProcessBirthFingerprint` and the
 * instance record use (`linux:<boot id>:<start ticks>`). CPU is utime + stime
 * in ticks: procps prints `time` in whole seconds, which rounds a quiet
 * tree's CPU to zero.
 */
/**
 * @param {{ readFile?: (path: string, encoding: 'utf8') => string, listPids?: () => number[], bootId: string, hz: number, pageSize: number, bootTimeSeconds: number }} [context]
 * @returns {ProcessRow[]}
 */
export function linuxProcessTable(
  {
    readFile = readFileSync,
    listPids = () =>
      readdirSync('/proc')
        .filter((entry) => /^\d+$/.test(entry))
        .map(Number),
    bootId,
    hz,
    pageSize,
    bootTimeSeconds,
  } = defaultLinuxContext(),
) {
  const read = (path) => {
    try {
      return readFile(path, 'utf8');
    } catch {
      return null;
    }
  };
  const rows = [];
  for (const pid of listPids()) {
    const statText = read(`/proc/${pid}/stat`);
    const stat = statText && parseProcStat(statText);
    const status = stat && read(`/proc/${pid}/status`);
    const recheck = status && read(`/proc/${pid}/stat`);
    // Exited, or the pid now names another process.
    if (!recheck || parseProcStat(recheck)?.startTicks !== stat.startTicks)
      continue;
    const uid = status.match(/^Uid:\s+\d+\s+(\d+)/m)?.[1];
    let contextSwitches = 0;
    for (const match of status.matchAll(
      /^(?:non)?voluntary_ctxt_switches:\s+(\d+)$/gm,
    ))
      contextSwitches += Number(match[1]);
    rows.push({
      pid,
      ppid: stat.ppid,
      uid: uid === undefined ? NaN : Number(uid),
      rssBytes: stat.rssPages * pageSize,
      cpuSeconds: stat.ticks / hz,
      started: `linux:${bootId}:${stat.startTicks}`,
      startedAtMs: (bootTimeSeconds + Number(stat.startTicks) / hz) * 1000,
      contextSwitches,
      command: stat.command,
    });
  }
  return rows;
}

/**
 * One snapshot of every process. `started` is the birth token in the format
 * the instance record and `lookupProcessBirthFingerprint` use (pinned lstart
 * on macOS, `/proc` start ticks plus boot id on Linux), so pid plus `started`
 * is the process identity and a reused pid is never mistaken for the same
 * one. `startedAtMs` is the wall-clock birth (whole seconds on macOS). On
 * Linux the table comes from `/proc` alone (see linuxProcessTable); on macOS
 * one `ps` call reads every field of a process at once.
 */
/**
 * @param {RunCommand} [run]
 * @param {{ platform?: string, linux?: Parameters<typeof linuxProcessTable>[0] }} [options]
 * @returns {ProcessRow[]}
 */
export function processTable(
  run = /** @type {RunCommand} */ (execFileSyncBounded),
  { platform: platformName = process.platform, linux } = {},
) {
  if (platformName === 'linux') return linuxProcessTable(linux);
  const text = run(
    'ps',
    ['-A', '-o', 'pid=,ppid=,uid=,rss=,time=,lstart=,comm='],
    { encoding: 'utf8', windowsHide: true, env: PS_ENV },
  );
  const rows = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 11) continue;
    const [pid, ppid, uid, rss, time, ...rest] = parts;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      uid: Number(uid),
      rssBytes: Number(rss) * 1024,
      cpuSeconds: parseCpuTime(time),
      started: lstartToken(rest.slice(0, 5)),
      startedAtMs: lstartMs(rest.slice(0, 5)),
      command: basename(rest.slice(5).join(' ')),
    });
  }
  return rows;
}

/** `ps` cumulative CPU: [[dd-]hh:]mm:ss[.ff]. */
export function parseCpuTime(text) {
  const [days, clock] = text.includes('-') ? text.split('-') : ['0', text];
  const fields = clock.split(':').map(Number);
  while (fields.length < 3) fields.unshift(0);
  const [hours, minutes, seconds] = fields;
  return Number(days) * 86400 + hours * 3600 + minutes * 60 + seconds;
}

const identityKey = (row) => `${row.pid}:${row.started}`;

/**
 * The rows owned by `roots`: each root whose pid AND birth token match a live
 * row, and every descendant of those by parent pid. A root whose pid now
 * belongs to another process contributes nothing.
 */
/**
 * @param {ProcessRow[]} table
 * @param {ProcessIdentity[]} roots
 * @returns {ProcessRow[]}
 */
export function ownedTree(table, roots) {
  const wanted = new Set(roots.map(identityKey));
  const ids = new Set(
    table.filter((row) => wanted.has(identityKey(row))).map((row) => row.pid),
  );
  let size;
  do {
    size = ids.size;
    for (const row of table) if (ids.has(row.ppid)) ids.add(row.pid);
  } while (ids.size !== size);
  return table.filter((row) => ids.has(row.pid));
}

/** Identities of the instance's registered roots, from its record. */
export function recordedRoots(record) {
  const roots = [record.serverFingerprint, record.uiFingerprint].filter(
    Boolean,
  );
  assert(
    roots.length > 0 &&
      roots.every(
        (root) =>
          Number.isInteger(root.pid) && typeof root.startToken === 'string',
      ),
    'instance record carries no process fingerprints to identify its tree',
  );
  return roots.map((root) => ({ pid: root.pid, started: root.startToken }));
}

/**
 * How a process is recognised as the run's by its environment, with no
 * ancestry. Station keeps PATH, HOME and TMPDIR for its children (an engine
 * needs PATH to find `claude`), so a process that detached from the tree
 * still carries the scratch HOME and TMPDIR; the nonce `STATION_WEIGHT_RUN`
 * is set for every process the instance starts. A process qualifies only if
 * it runs as this user (effective uid) and started after the run did, and a
 * process naming the nonce in its arguments is excluded: the nonce is only
 * ever passed through the environment. The slack absorbs whole-second birth
 * times (macOS lstart, Linux btime).
 */
/**
 * @param {{ nonce: string, scratch: string, startedAtMs: number, controlConfigDir?: string, uid?: number }} run
 * @returns {Tagging}
 */
export function runTagging({
  nonce,
  scratch,
  startedAtMs,
  controlConfigDir,
  uid = process.geteuid(),
}) {
  assert(/^[0-9a-f]{32}$/.test(nonce), 'the run tag is a 128-bit hex nonce');
  return {
    tags: [
      `STATION_WEIGHT_RUN=${nonce}`,
      `HOME=${join(scratch, 'user')}`,
      `TMPDIR=${join(scratch, 'tmp')}`,
    ],
    excludeTags: controlConfigDir
      ? [`CLAUDE_CONFIG_DIR=${controlConfigDir}`]
      : [],
    argumentMarkers: [nonce],
    uid,
    notBeforeMs: Math.floor(startedAtMs / 1000) * 1000 - 2_000,
  };
}

const LSTART_LINE =
  /^\s*(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\d\d:\d\d:\d\d)\s+(\d{4})\s+(.*)$/;

/** pid -> { started, command } from `ps -o pid=,lstart=,command=` output. */
function psCommands(text) {
  const lines = new Map();
  for (const line of text.split('\n')) {
    const match = line.match(LSTART_LINE);
    if (match)
      lines.set(Number(match[1]), {
        started: lstartToken(match.slice(2, 7)),
        command: match[7],
      });
  }
  return lines;
}

/**
 * pid -> environment test and argument line for each row. Linux: the exact
 * NUL-separated entries of `/proc/<pid>/environ` (and `cmdline`), accepted
 * only if the pid still has the row's start ticks afterwards. macOS: `ps -E` appends
 * the environment a process was started with to its arguments, so the
 * environment is what follows the process's plain `ps` command line, and a
 * process whose two lines disagree (or whose birth differs from the row's)
 * changed between the reads and is skipped. A process whose environment
 * cannot be read (another user's) gets no entry.
 */
function environments(rows, { run, platformName, readFile }) {
  const tests = new Map();
  if (platformName === 'linux') {
    for (const row of rows) {
      let entries;
      let argv;
      let recheck;
      try {
        entries = readFile(`/proc/${row.pid}/environ`, 'utf8');
        argv = readFile(`/proc/${row.pid}/cmdline`, 'utf8');
        recheck = parseProcStat(readFile(`/proc/${row.pid}/stat`, 'utf8'));
      } catch {
        continue;
      }
      if (
        !recheck ||
        row.started !==
          `${row.started.slice(0, row.started.lastIndexOf(':') + 1)}${recheck.startTicks}`
      )
        continue;
      const set = new Set(entries.split('\0'));
      tests.set(row.pid, {
        carries: (tag) => set.has(tag),
        argv: argv.split('\0').join(' '),
      });
    }
    return tests;
  }
  const ps = (args) =>
    psCommands(
      run('ps', ['-A', ...args, '-ww', '-o', 'pid=,lstart=,command='], {
        encoding: 'utf8',
        windowsHide: true,
        env: PS_ENV,
      }),
    );
  const plain = ps([]);
  const withEnvironment = ps(['-E']);
  for (const row of rows) {
    const argv = plain.get(row.pid);
    const full = withEnvironment.get(row.pid);
    if (!argv || !full) continue;
    if (argv.started !== row.started || full.started !== row.started) continue;
    if (
      full.command !== argv.command &&
      !full.command.startsWith(`${argv.command} `)
    )
      continue;
    // Entries are space-separated and a value may itself contain spaces, so
    // a tag is a whole `KEY=VALUE` entry bounded by spaces: `TMPDIR=/x/tmp`
    // does not match `TMPDIR=/x/tmp2`.
    const environment = ` ${full.command.slice(argv.command.length + 1)} `;
    tests.set(row.pid, {
      carries: (tag) => environment.includes(` ${tag} `),
      argv: argv.command,
    });
  }
  return tests;
}

/**
 * Rows of `table` that are the run's by environment (see runTagging): the
 * same effective uid, started after the run, carrying any of `tags` and none
 * of `excludeTags` (the control engine shares the run's environment but is
 * not Station's), with no argument naming the nonce. These are found
 * whatever their ancestry: a double-forked daemon or a child spawned during
 * shutdown has no path back to the roots.
 */
/**
 * @param {ProcessRow[]} table
 * @param {Tagging} tagging
 * @param {{ run?: RunCommand, platform?: string, readFile?: (path: string, encoding: 'utf8') => string }} [options]
 * @returns {ProcessRow[]}
 */
export function taggedRows(
  table,
  { tags, excludeTags = [], argumentMarkers = [], uid, notBeforeMs },
  {
    run = /** @type {RunCommand} */ (execFileSyncBounded),
    platform: platformName = process.platform,
    readFile = readFileSync,
  } = {},
) {
  assert(
    Number.isInteger(uid) && Number.isFinite(notBeforeMs),
    'tagging needs the run uid and start time',
  );
  const candidates = table.filter(
    (row) =>
      row.pid !== process.pid &&
      row.uid === uid &&
      row.startedAtMs >= notBeforeMs,
  );
  const environment = environments(candidates, {
    run,
    platformName,
    readFile,
  });
  return candidates.filter((row) => {
    const entry = environment.get(row.pid);
    return (
      entry !== undefined &&
      !argumentMarkers.some((marker) => entry.argv.includes(marker)) &&
      tags.some(entry.carries) &&
      !excludeTags.some(entry.carries)
    );
  });
}

/**
 * The instance's processes: owned by the recorded roots or tagged.
 * @param {ProcessRow[]} table
 * @param {ProcessIdentity[]} roots
 * @param {ProcessRow[]} tagged
 */
export function instanceTree(table, roots, tagged) {
  return ownedTree(table, [...roots, ...tagged]);
}

/**
 * Rows from `before` still alive in `after` with the same birth token, plus
 * anything they spawned since.
 * @param {ProcessIdentity[]} before
 * @param {ProcessRow[]} after
 */
export function survivors(before, after) {
  return ownedTree(after, before);
}

/**
 * The instance's tree in `table`: its recorded roots and tagged processes.
 * @param {ProcessRow[]} table
 * @param {ProcessIdentity[]} roots
 * @param {Tagging} tagging
 * @param {Parameters<typeof taggedRows>[2]} [options]
 */
export function instanceSnapshot(table, roots, tagging, options) {
  return instanceTree(table, roots, taggedRows(table, tagging, options));
}

/**
 * What lives on after stop: survivors of the pre-stop tree by identity, and
 * every process still carrying the run's environment, whether it detached or
 * was spawned after the pre-stop snapshot.
 * @param {ProcessIdentity[]} beforeStop
 * @param {ProcessRow[]} after
 * @param {Tagging} tagging
 * @param {Parameters<typeof taggedRows>[2]} [options]
 */
export function leftoverAfterStop(beforeStop, after, tagging, options) {
  return ownedTree(after, [
    ...beforeStop,
    ...taggedRows(after, tagging, options),
  ]);
}

/**
 * Sends `signal` to each row only while its pid still has the recorded birth
 * token: a pid that now belongs to another process is never signalled.
 */
export function signalIfSame(
  rows,
  signal,
  {
    birth = (pid) => lookupProcessBirthFingerprint(pid),
    kill = process.kill,
  } = {},
) {
  const signalled = [];
  const skipped = [];
  for (const row of rows) {
    if (birth(row.pid) !== row.started) {
      skipped.push(row.pid);
      continue;
    }
    try {
      kill(row.pid, signal);
      signalled.push(row.pid);
    } catch {
      // Exited between the check and the signal.
    }
  }
  return { signalled, skipped };
}

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const processRows = (rows) =>
  rows.map(({ pid, ppid, rssBytes, memoryBytes, command }) => ({
    pid,
    ppid,
    rssBytes,
    memoryBytes,
    command,
  }));

/**
 * What a process's memory is measured as. macOS compresses idle pages out of
 * RSS (a busy host showed one process at 4 MiB RSS and 87 MiB footprint), so
 * there the kernel's phys_footprint, compressed pages included, is the
 * measure. Elsewhere it is RSS. Baselines are per host class, so a value is
 * only ever compared with one of the same basis.
 */
export const MEMORY_BASIS =
  process.platform === 'darwin' ? 'phys_footprint' : 'rss';

/** pid -> phys_footprint bytes from `footprint -f bytes --noCategories`. */
export function parseFootprint(text) {
  const footprints = new Map();
  let pid;
  for (const line of text.split('\n')) {
    const header = line.match(/\[(\d+)\]:\s.*Footprint:/);
    if (header) {
      pid = Number(header[1]);
      continue;
    }
    const value = line.match(/^\s*phys_footprint:\s+(\d+) B$/);
    if (value && pid !== undefined) {
      footprints.set(pid, Number(value[1]));
      pid = undefined;
    }
  }
  return footprints;
}

const isAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/**
 * Attaches `memoryBytes` to each row. A process that exited before it could
 * be read is dropped; a live one the reader did not report is an error, not
 * a zero.
 */
/**
 * @param {ProcessRow[]} rows
 * @param {RunCommand} [run]
 * @returns {ProcessRow[]}
 */
export function withMemory(
  rows,
  run = /** @type {RunCommand} */ (execFileSyncBounded),
) {
  if (MEMORY_BASIS === 'rss' || !rows.length)
    return rows.map((row) => ({ ...row, memoryBytes: row.rssBytes }));
  let footprints;
  try {
    footprints = parseFootprint(
      run(
        'footprint',
        [
          '-f',
          'bytes',
          '--noCategories',
          ...rows.map((row) => String(row.pid)),
        ],
        { encoding: 'utf8', windowsHide: true },
      ),
    );
  } catch (error) {
    // `footprint` refuses the whole call when one pid has already exited.
    const live = rows.filter((row) => isAlive(row.pid));
    if (live.length === rows.length) throw error;
    return withMemory(live, run);
  }
  return rows
    .filter((row) => footprints.has(row.pid) || isAlive(row.pid))
    .map((row) => {
      if (!footprints.has(row.pid))
        throw new Error(`footprint did not report live pid ${row.pid}`);
      return { ...row, memoryBytes: footprints.get(row.pid) };
    });
}

/**
 * Linux only: voluntary + involuntary context switches per process, keyed by
 * identity, as read with the row itself (see linuxProcessTable), so a count
 * never belongs to a process that reused the pid.
 */
function contextSwitches(rows) {
  return new Map(
    rows
      .filter((row) => Number.isFinite(row.contextSwitches))
      .map((row) => [identityKey(row), row.contextSwitches]),
  );
}

/** Switches over the window by the processes read at both of its ends. */
export function contextSwitchDelta(start, end) {
  let total = 0;
  for (const [key, count] of end)
    if (start.has(key)) total += count - start.get(key);
  return total;
}

// ---------------------------------------------------------------------------
// The launcher and the HTTP API.

/** Generous: a build's output is large, but a runaway child is still refused. */
const LAUNCHER_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Runs one launcher command as an owned process group and returns its exit
 * status and output. Output that overflowed its capture bound or is not valid
 * UTF-8, and a process that could not run at all, are errors: an incomplete
 * capture is never taken as a complete success.
 */
export async function runLauncher(
  executable,
  args,
  { env, timeoutMs, cwd = ROOT, maxBytes = LAUNCHER_OUTPUT_MAX_BYTES },
) {
  const label = `${basename(executable)} ${args[0] ?? ''}`.trim();
  const owned = executeOwnedProcess(executable, args, undefined, label, {
    cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = captureOwnedProcessOutput(owned, { maxBytes });
  progress(`${label} pid=${owned.child.pid}`);
  const timer = setTimeout(() => void owned.forceTerminate(), timeoutMs);
  try {
    const result = await owned.completion;
    const captured = output.finish();
    progress(`${label} exited status=${result.status} signal=${result.signal}`);
    if (result.error)
      throw new Error(`${label} did not run: ${result.error.message}`, {
        cause: result.error,
      });
    if (captured.truncated)
      throw new Error(
        `${label} wrote ${captured.stdout.sourceBytes + captured.stderr.sourceBytes} bytes, past the ${maxBytes}-byte capture bound: its output is incomplete`,
      );
    if (captured.invalidUtf8)
      throw new Error(`${label} wrote output that is not valid UTF-8`);
    return {
      status: result.status,
      signal: result.signal,
      output: `${captured.stdout.text}\n${captured.stderr.text}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

const station = (args, options) =>
  runLauncher(join(ROOT, 'station'), args, options);

async function stationOk(args, options) {
  const result = await station(args, options);
  assert.equal(
    result.status,
    0,
    `station ${args.join(' ')} exited ${result.status}:\n${result.output.slice(-4000)}`,
  );
  return result;
}

function client(port) {
  let credential;
  const call = async (method, path, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(credential ? { authorization: `Bearer ${credential}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // Status alone is reported for a non-JSON body.
    }
    return { status: response.status, json, text };
  };
  return {
    call,
    async pair(home) {
      const grant = await call(
        'POST',
        '/.well-known/station/v1/pairing/local-grant',
        {
          secret: readFileSync(
            join(home, 'runtime/local-grant.secret'),
            'utf8',
          ).trim(),
          deviceName: 'station-weight',
          clientInstanceId: randomUUID(),
        },
      );
      assert.equal(
        grant.status,
        200,
        `local grant: ${grant.text.slice(0, 300)}`,
      );
      credential = grant.json?.credential;
      assert(credential, 'local grant issued no credential');
    },
  };
}

async function poll(description, timeoutMs, probe, intervalMs = 500) {
  const deadline = performance.now() + timeoutMs;
  let last;
  while (performance.now() < deadline) {
    try {
      const value = await probe();
      if (value) return value;
    } catch (error) {
      if (error?.fatal) throw error;
      last = error;
    }
    await wait(intervalMs);
  }
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for ${description}${last ? `: ${last.message}` : ''}`,
  );
}

async function claudeReadiness(api) {
  let last = 'no answer';
  try {
    return await poll('the Claude engine to report ready', 90_000, async () => {
      const response = await api.call('GET', '/api/connections/agents');
      const row = (response.json?.data ?? []).find(
        (connection) => connection?.id === 'claude',
      );
      last = row
        ? `status=${row.status} setup=${row.setup?.state}`
        : 'no claude connection row';
      return row?.status === 'ready' ? { ready: true } : false;
    });
  } catch (error) {
    return { ready: false, reason: `${error.message} (last: ${last})` };
  }
}

/** One stub-answered turn; resolves when the turn completed with the stub reply. */
async function sendHi(api, cwd) {
  const { json } = await poll(
    'the chat dispatch to be accepted',
    90_000,
    async () => {
      const response = await api.call('POST', '/api/orchestration/chat', {
        target: {
          environment: { kind: 'current' },
          agent: 'claude',
          workspace: { kind: 'directory', cwd },
        },
        message: PROMPT,
        clientTurnId: randomUUID(),
      });
      // Declared-transient refusal while the agent catalog settles.
      if (
        response.status === 400 &&
        /Agent catalog is refreshing/.test(response.json?.error ?? '')
      )
        return false;
      assert(
        response.status < 400 && response.json?.success !== false,
        `chat dispatch: HTTP ${response.status} ${response.text.slice(0, 400)}`,
      );
      return response;
    },
  );
  const { sessionId, providerTurnId } = json.data ?? {};
  assert(sessionId && providerTurnId, 'chat dispatch named no session/turn');
  await poll('the stub-answered turn to complete', 120_000, async () => {
    const detail = await api.call(
      'GET',
      `/api/orchestration/sessions/${encodeURIComponent(sessionId)}`,
    );
    return acceptedTurnReply(
      detail.json?.data?.events ?? [],
      providerTurnId,
      STUB_REPLY_TEXT,
    );
  });
  return sessionId;
}

// ---------------------------------------------------------------------------
// The control request: the same engine through the Agent SDK, no Station.

/**
 * The Claude Code binary the Agent SDK ships for this platform, pinned by the
 * lockfile. `null` when this platform has no bundled binary installed.
 */
export function bundledClaudeExecutable() {
  const sdk = createRequire(import.meta.url).resolve(
    '@anthropic-ai/claude-agent-sdk',
  );
  try {
    const manifest = createRequire(sdk).resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const binary = join(dirname(manifest), 'claude');
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

async function controlRequest({ cwd, env, stub, executable, model }) {
  const { query } = await import('@anthropic-ai/claude-agent-sdk');
  const from = stub.requests.length;
  const children = [];
  const run = query({
    prompt: PROMPT,
    options: {
      cwd,
      env,
      pathToClaudeCodeExecutable: executable,
      // Same model as Station's turn, so model-specific lines cancel out.
      ...(model ? { model } : {}),
      spawnClaudeCodeProcess: (options) => {
        const child = spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        children.push(child);
        return child;
      },
    },
  });
  const deadline = setTimeout(() => void run.interrupt?.(), 120_000);
  try {
    for await (const message of run) if (message.type === 'result') break;
  } finally {
    clearTimeout(deadline);
    run.close?.();
    // The control engine must be gone before the leftover check, which
    // would otherwise have to tell it apart from Station's processes.
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 5_000);
      await exited;
      clearTimeout(timer);
    }
  }
  return stub.requests.slice(from);
}

// ---------------------------------------------------------------------------

function scrubbedEnvironment(scratch, stubUrl, claudeExecutable, runNonce) {
  // Station reports the Claude engine ready only when a `claude` is on PATH.
  // Point that at the SDK's bundled binary, so Station and the control run
  // the same lockfile-pinned executable rather than whatever this host has
  // installed.
  const bin = join(scratch, 'bin');
  mkdirSync(bin, { recursive: true });
  if (claudeExecutable) symlinkSync(claudeExecutable, join(bin, 'claude'));
  // Allowlist, not denylist: the caller's agent/session variables (for
  // example an outer Claude Code's entrypoint or plugins) must not reach
  // either Station or the control engine.
  const env = {
    PATH: [
      bin,
      dirname(process.execPath),
      '/usr/bin',
      '/bin',
      '/usr/sbin',
      '/sbin',
    ].join(':'),
    HOME: join(scratch, 'user'),
    TMPDIR: join(scratch, 'tmp'),
    USER: process.env.USER ?? 'station-weight',
    LOGNAME: process.env.LOGNAME ?? process.env.USER ?? 'station-weight',
    SHELL: '/bin/sh',
    LANG: 'C.UTF-8',
    DOTENV_CONFIG_PATH: join(scratch, 'no-inherited-dotenv'),
    STATION_ROOT: join(scratch, 'station-root'),
    STATION_DISABLE_LOGIN_PATH_RESOLVE: '1',
    STATION_TELEMETRY_ENABLED: 'false',
    STATION_TELEMETRY_ENDPOINT: '',
    STATION_USAGE_TELEMETRY_KEY: '',
    OTEL_EXPORTER_OTLP_ENDPOINT: '',
    CODEX_HOME: join(scratch, 'codex'),
    CLAUDE_CONFIG_DIR: join(scratch, 'claude'),
    STATION_EXTERNAL_CODEX_SOURCE_ROOT: join(scratch, 'codex'),
    STATION_EXTERNAL_CLAUDE_SOURCE_ROOT: join(scratch, 'claude'),
    STATION_EXTERNAL_OPENCODE_SOURCE_ROOT: join(scratch, 'opencode'),
    STATION_EXTERNAL_GROK_SOURCE_ROOT: join(scratch, 'grok'),
    ANTHROPIC_BASE_URL: stubUrl,
    // Not a credential: the stub accepts anything and never forwards it.
    ANTHROPIC_API_KEY: 'station-weight-stub',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
    DISABLE_ERROR_REPORTING: '1',
    // Ties every process the instance starts to this run (see runTagging).
    STATION_WEIGHT_RUN: runNonce,
  };
  for (const key of [
    'HOME',
    'TMPDIR',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'STATION_ROOT',
    'STATION_EXTERNAL_OPENCODE_SOURCE_ROOT',
    'STATION_EXTERNAL_GROK_SOURCE_ROOT',
  ])
    mkdirSync(env[key], { recursive: true });
  return env;
}

/**
 * Writes the fixture repository and commits it with git confined to it: the
 * run's isolated environment without any `GIT_*` routing or config variable,
 * no system config, and an empty global config under the scratch root.
 */
export function fixtureRepository(scratch, markers, env) {
  const repo = join(scratch, 'repo');
  mkdirSync(repo, { recursive: true });
  // CLAUDE.md deliberately does not import AGENTS.md, so each file's
  // marker answers for that file alone.
  writeFileSync(join(repo, 'AGENTS.md'), `# Rules\n\n${markers.agentsMd}\n`);
  writeFileSync(join(repo, 'CLAUDE.md'), `# Rules\n\n${markers.claudeMd}\n`);
  const globalConfig = join(scratch, 'fixture.gitconfig');
  writeFileSync(globalConfig, '');
  const gitEnv = {
    ...gitEnvironment(env),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_AUTHOR_NAME: 'station-weight',
    GIT_AUTHOR_EMAIL: 'station-weight@example.invalid',
    GIT_COMMITTER_NAME: 'station-weight',
    GIT_COMMITTER_EMAIL: 'station-weight@example.invalid',
  };
  const run = (...args) =>
    execFileSyncBounded('git', args, {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      env: gitEnv,
    });
  run('init', '-q');
  run('add', '-A');
  run('commit', '-qm', 'fixture');
  return repo;
}

async function allocatePorts() {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = await findFreePortBlock(4);
    const ui = await findFreePortOutside(server, 4);
    const band = [...SERVER_BAND.map((offset) => server + offset), ui];
    if (!band.some((port) => RESERVED_PORTS.includes(port)))
      return { server, ui };
  }
  throw new Error('could not allocate a port band clear of reserved ports');
}

// ---------------------------------------------------------------------------
// Host identity for host-dependent budgets.

function hardwareModel(platformName) {
  try {
    if (platformName === 'darwin')
      return execFileSyncBounded('sysctl', ['-n', 'hw.model'], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim();
    if (platformName === 'linux')
      return ['sys_vendor', 'product_name']
        .map((name) =>
          readFileSync(`/sys/devices/virtual/dmi/id/${name}`, 'utf8').trim(),
        )
        .join(' ');
  } catch {
    // Unreadable: the fingerprint still separates hosts by CPU and memory.
  }
  return 'unknown';
}

/**
 * What a host-dependent baseline is keyed by. Only the hash and a coarse
 * platform label are ever written to the committed baseline.
 */
export function hostFingerprintInputs({
  platform: platformName = process.platform,
  arch = process.arch,
  model = hardwareModel(platformName),
  cpuList = cpus(),
  memoryBytes = totalmem(),
  osRelease = release(),
} = {}) {
  return {
    platform: platformName,
    arch,
    hardwareModel: model,
    cpuModel: cpuList[0]?.model ?? 'unknown',
    cpuCount: cpuList.length,
    memoryGiB: Math.round(memoryBytes / 2 ** 30),
    osMajor: String(osRelease).split('.')[0],
  };
}

export function hostFingerprint(inputs) {
  const canonical = JSON.stringify(
    Object.fromEntries(
      Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

export function describeHost(inputs = hostFingerprintInputs()) {
  return {
    label: `${inputs.platform}-${inputs.arch}`,
    fingerprint: hostFingerprint(inputs),
    // Local result only; the committed baseline keeps the hash and label.
    fingerprintInputs: inputs,
    node: process.version,
    loadStart: loadavg(),
  };
}

// ---------------------------------------------------------------------------
// Rest and idle measurement.

/** Two consecutive tree memory samples within this fraction count as settled. */
const SETTLE_TOLERANCE = 0.05;

/**
 * Waits `settleMs`, then samples the tree every `settleIntervalMs` until two
 * consecutive memory totals agree within SETTLE_TOLERANCE. A tree still moving
 * at `settleMaxMs` is not at rest, so the caller reports it as not measured.
 */
async function settleTree(snapshot, settings) {
  const begin = performance.now();
  await wait(settings.settleMs);
  let previous = snapshot();
  const samples = [sum(previous, 'memoryBytes')];
  while (performance.now() - begin < settings.settleMaxMs) {
    await wait(settings.settleIntervalMs);
    const current = snapshot();
    const before = sum(previous, 'memoryBytes');
    const now = sum(current, 'memoryBytes');
    samples.push(now);
    if (Math.abs(now - before) <= SETTLE_TOLERANCE * before)
      return {
        rows: current,
        stable: true,
        settledAfterMs: performance.now() - begin,
        samples,
      };
    previous = current;
  }
  return {
    rows: previous,
    stable: false,
    settledAfterMs: performance.now() - begin,
    samples,
  };
}

/** A settled tree's memory; an empty tree measured nothing. */
/** @returns {Metric} */
export function restMetric(settled, extra = {}) {
  const detail = {
    basis: MEMORY_BASIS,
    processCount: settled.rows.length,
    processes: processRows(settled.rows),
    settledAfterMs: settled.settledAfterMs,
    memorySamples: settled.samples,
    ...extra,
  };
  if (!settled.rows.length)
    return {
      ...notMeasured(
        "the instance's process tree was empty: nothing was measured",
        'bytes',
      ),
      ...detail,
    };
  if (settled.stable)
    return measured(sum(settled.rows, 'memoryBytes'), 'bytes', detail);
  return {
    ...notMeasured(
      `tree memory did not settle within ${SETTLE_TOLERANCE * 100}% in ${Math.round(settled.settledAfterMs / 1000)}s`,
      'bytes',
    ),
    ...detail,
  };
}

/**
 * CPU time the tree used over `windowMs`, sampled every `intervalMs`. Each
 * process counts the CPU time it last showed minus what it showed at the
 * window's start (zero if it appeared inside the window), so a worker that
 * exits during the window still counts what it used up to its last sample.
 * `snapshot(final)` returns the tree's rows. A slow snapshot stretches the
 * interval, so the span between two consecutive reads is measured: from the
 * start of one snapshot to the end of the next, the longest a process can
 * run between the last read that saw it and the first that did not.
 */
/**
 * @param {(final: boolean) => ProcessRow[]} snapshot
 * @param {{ windowMs: number, intervalMs: number }} timing
 */
export async function sampleTreeCpu(snapshot, { windowMs, intervalMs }) {
  const startCpu = new Map();
  const lastCpu = new Map();
  let samples = 0;
  let previousStart;
  let maxReadSpanMs = 0;
  const observe = (final, first) => {
    const readStart = performance.now();
    const rows = snapshot(final);
    if (previousStart !== undefined)
      maxReadSpanMs = Math.max(
        maxReadSpanMs,
        performance.now() - previousStart,
      );
    previousStart = readStart;
    samples += 1;
    for (const row of rows) {
      const key = identityKey(row);
      if (!startCpu.has(key)) startCpu.set(key, first ? row.cpuSeconds : 0);
      lastCpu.set(key, row.cpuSeconds);
    }
    return rows;
  };
  const begin = performance.now();
  const firstRows = observe(false, true);
  let next = begin;
  for (;;) {
    next += intervalMs;
    const end = begin + windowMs;
    if (next >= end) {
      await wait(Math.max(0, end - performance.now()));
      break;
    }
    await wait(Math.max(0, next - performance.now()));
    observe(false, false);
  }
  const endRows = observe(true, false);
  const windowSeconds = (performance.now() - begin) / 1000;
  const endKeys = new Set(endRows.map(identityKey));
  let cpuSeconds = 0;
  for (const [key, last] of lastCpu)
    cpuSeconds += Math.max(0, last - startCpu.get(key));
  return {
    cpuSeconds,
    windowSeconds,
    samples,
    maxReadSpanMs,
    firstRows,
    endRows,
    exitedDuringWindow: [...lastCpu.keys()].filter((key) => !endKeys.has(key))
      .length,
  };
}

/**
 * What `sampleTreeCpu` cannot see; reported beside every CPU value. The
 * value is a lower bound: none of this is counted, and it is still compared.
 */
export const IDLE_CPU_GAP = ({ intervalMs, maxReadSpanMs }) =>
  `not counted: CPU a process used after its last read before exiting (up to ${Math.ceil(maxReadSpanMs)} ms per process, the longest span observed between the start of one read and the end of the next; the nominal interval is ${intervalMs} ms), processes that started and exited between two reads, and processes that left the tree by detaching inside the window and exited before its end (the window follows ancestry and rescans the environment only at its end)`;

/** @returns {Metric} */
export function idleCpuMetric(sampled, intervalMs) {
  const detail = {
    windowSeconds: sampled.windowSeconds,
    cpuSeconds: sampled.cpuSeconds,
    processCount: sampled.endRows.length,
    samples: sampled.samples,
    sampleIntervalMs: intervalMs,
    maxReadSpanMs: sampled.maxReadSpanMs,
    exitedDuringWindow: sampled.exitedDuringWindow,
    gap: IDLE_CPU_GAP({ intervalMs, maxReadSpanMs: sampled.maxReadSpanMs }),
  };
  if (!sampled.firstRows.length || !sampled.endRows.length)
    return {
      ...notMeasured(
        "the instance's process tree was empty: nothing was measured",
        'percent of one core',
      ),
      ...detail,
    };
  return measured(
    (sampled.cpuSeconds / sampled.windowSeconds) * 100,
    'percent of one core',
    detail,
  );
}

/**
 * What the leftover check cannot find; reported with the metric. Nothing ties
 * such a process to the run: no subreaper or cgroup follows it on macOS, and
 * a process group or session can be left with setsid and its id reused.
 */
export const LEFTOVER_GAP =
  'not found: a process that both left the instance tree (for example by double-forking, so it is reparented away) and was started with an environment that drops the run tag, HOME and TMPDIR (for example env: {}); neither ancestry nor environment ties it to the run';

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
};

/** Defaults are chosen for a quiet host; flags can lengthen them. */
export const DEFAULT_SETTINGS = Object.freeze({
  settleMs: 30_000,
  settleIntervalMs: 5_000,
  settleMaxMs: 300_000,
  cpuWindowMs: 30_000,
  cpuSampleIntervalMs: 250,
  idleSessions: 3,
  stopGraceMs: 5_000,
  sideCallWindowMs: 5_000,
  readyLaunches: 1,
});

/**
 * Applies the baseline to a result: records it when asked (refusing an
 * incomplete one), evaluates the budgets, and decides the gate.
 */
export function evaluateRun(
  result,
  {
    baselinePath = DEFAULT_BASELINE_PATH,
    record = false,
    reportOnly = false,
  } = {},
) {
  result.reportOnly = reportOnly;
  try {
    // Report-only never reads the baseline: it compares nothing.
    const baseline =
      !reportOnly && existsSync(baselinePath)
        ? JSON.parse(readFileSync(baselinePath, 'utf8'))
        : undefined;
    result.budgets = evaluateBudgets(result, baseline, { reportOnly });
    result.gate = gateOutcome(result, result.budgets, { reportOnly });
    if (!existsSync(baselinePath) && !reportOnly)
      result.gate.reasons.unshift(`no baseline file at ${baselinePath}`);
    if (record) {
      const next = recordBaseline(result, baseline);
      writeFileSync(baselinePath, `${JSON.stringify(next, null, 2)}\n`);
      result.baselineRecorded = baselinePath;
      result.gate = {
        passed: true,
        reasons: [],
        summary: `RECORDED baseline for host ${result.host.fingerprint} (${result.host.label}) in ${baselinePath}`,
      };
    }
  } catch (error) {
    result.budgets ??= [];
    result.gate = {
      passed: false,
      reasons: [error.message],
      summary: record ? 'baseline NOT recorded' : 'budgets NOT evaluated',
    };
  }
  return result;
}

/**
 * @param {{ out?: string, baselinePath?: string, record?: boolean, reportOnly?: boolean, allowDirty?: boolean, settings?: Partial<Record<keyof typeof DEFAULT_SETTINGS, number>>, hooks?: { beforeStop?: (context: { env: NodeJS.ProcessEnv, scratch: string }) => Promise<void> } }} [options]
 * @returns {Promise<Record<string, any>>}
 */
export async function runStationWeight({
  out,
  baselinePath = DEFAULT_BASELINE_PATH,
  record = false,
  reportOnly = false,
  allowDirty = false,
  settings: overrides = {},
  hooks = {},
} = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  for (const [name, value] of Object.entries(settings))
    assert(Number.isSafeInteger(value) && value >= 0, `invalid ${name}`);
  assert(settings.idleSessions >= 1, 'idleSessions must be at least 1');
  assert(settings.readyLaunches >= 1, 'readyLaunches must be at least 1');
  assert(
    settings.cpuSampleIntervalMs >= 1,
    'cpuSampleIntervalMs must be at least 1',
  );
  const { sha, dirty } = repositoryState();
  assert(allowDirty || !dirty, 'commit first: the check measures a clean tree');
  const runStartedAtMs = Date.now();
  const runId = randomUUID();
  // The environment tag is its own nonce, not the run id: the run id also
  // names the output directory and the fixture markers.
  const runNonce = randomBytes(16).toString('hex');
  const outputDir = resolve(
    out ?? join(ROOT, '.kontourai/station-weight', sha, runId),
  );
  mkdirSync(outputDir, { recursive: true });
  const result = {
    schemaVersion: 2,
    kind: 'station-weight',
    sourceRevision: sha,
    dirty: Boolean(dirty),
    runId,
    startedAt: new Date().toISOString(),
    outcome: 'failed',
    host: describeHost(),
    settings,
    units: {
      bytes: 'UTF-8 bytes; no tokenizer is applied, so no token counts',
      chars: 'Unicode code points',
    },
    metrics: {},
  };
  const write = () => {
    result.host.loadEnd = loadavg();
    writeFileSync(
      join(outputDir, 'result.json'),
      `${JSON.stringify(result, null, 2)}\n`,
    );
  };
  if (!['darwin', 'linux'].includes(process.platform)) {
    // The launcher is a bash script and the tree is read through POSIX ps.
    result.outcome = 'not_measured';
    result.reason = `${process.platform} is not supported: requires POSIX ps and the bash launcher`;
    evaluateRun(result, { baselinePath, record, reportOnly });
    write();
    return { ...result, outputDir };
  }

  // Rooted at /tmp, not the caller's TMPDIR: tools under this home listen on
  // Unix sockets, whose paths are limited to ~104 bytes, and a test runner's
  // nested TMPDIR overruns that.
  const scratch = mkdtempSync(join('/tmp', 'station-weight-'));
  const instance = `weight-${runId.slice(0, 8)}`;
  const markers = {
    claudeMd: `station-weight-claude-md-${runId}`,
    agentsMd: `station-weight-agents-md-${runId}`,
  };
  const stub = await startStubAnthropic();
  const claudeExecutable = bundledClaudeExecutable();
  const env = scrubbedEnvironment(
    scratch,
    stub.url,
    claudeExecutable,
    runNonce,
  );
  const repo = fixtureRepository(scratch, markers, env);
  const controlConfigDir = join(scratch, 'claude-control');
  // The control engine shares the run's environment but is not Station's.
  const tagging = runTagging({
    nonce: runNonce,
    scratch,
    startedAtMs: runStartedAtMs,
    controlConfigDir,
  });
  const ports = await allocatePorts();
  const api = client(ports.server);
  let started = false;
  let roots = [];
  const treeNow = (table = processTable()) =>
    instanceSnapshot(table, roots, tagging);
  try {
    // `station start --clean` rebuilds, so a ready time taken from it would
    // mostly measure the build. Build first (reported on its own), then the
    // measured start reuses that build.
    const buildStart = performance.now();
    await stationOk(['build', `--instance=${instance}`], {
      env,
      timeoutMs: 20 * 60_000,
    });
    result.metrics.buildMs = measured(performance.now() - buildStart, 'ms', {
      note: 'reported only; not a budget',
    });

    // Ready time is the median of `readyLaunches` launches (one by default;
    // the metric is report-only); every launch but the last is stopped
    // again, and the last one is the instance measured.
    // A start after a stop rebuilds the UI (measured: 16-20 s against 5.5 s
    // for the first start), so each relaunch is preceded by an unmeasured
    // build and times the same thing as the first.
    const launches = [];
    for (let index = 0; index < settings.readyLaunches; index += 1) {
      if (index > 0) {
        await stationOk(['stop', `--instance=${instance}`], {
          env,
          timeoutMs: 120_000,
        });
        started = false;
        await stationOk(['build', `--instance=${instance}`], {
          env,
          timeoutMs: 20 * 60_000,
        });
      }
      started = true;
      launches.push(await launchInstance(instance, ports, scratch, env));
    }
    result.metrics.serverReadyMs = measured(
      median(launches.map((launch) => launch.readyMs)),
      'ms',
      {
        endpoint: 'UI listener /api/system/readiness status:ready',
        aggregate: `median of ${launches.length} launches`,
        launches,
      },
    );
    const instanceRecord = JSON.parse(
      readFileSync(
        join(ROOT, '.station/instances', `${instance}.json`),
        'utf8',
      ),
    );
    roots = recordedRoots(instanceRecord);
    await api.pair(instanceRecord.baseDir);

    progress('paired; settling');
    const memorySnapshot = () => withMemory(treeNow());
    result.metrics.restMemoryBytes = restMetric(
      await settleTree(memorySnapshot, settings),
    );

    // The window walks the tree by ancestry from the roots and the processes
    // tagged at its start (a full environment scan every 250 ms would be the
    // heaviest thing on the host), and rescans for tagged processes at its end.
    const taggedAtStart = taggedRows(processTable(), tagging);
    const linux = process.platform === 'linux';
    // Context switches are read from /proc when the window opens and when it
    // closes, not from the rows afterwards (both would then read the end).
    let switchesStart;
    let switchesEnd;
    const sampled = await sampleTreeCpu(
      (final) => {
        const table = processTable();
        const rows = final
          ? treeNow(table)
          : instanceTree(table, roots, taggedAtStart);
        if (linux && !switchesStart) switchesStart = contextSwitches(rows);
        if (linux && final) switchesEnd = contextSwitches(rows);
        return rows;
      },
      {
        windowMs: settings.cpuWindowMs,
        intervalMs: settings.cpuSampleIntervalMs,
      },
    );
    result.metrics.idleCpuPercent = idleCpuMetric(
      sampled,
      settings.cpuSampleIntervalMs,
    );
    result.metrics.idleWakeups = notMeasured(
      process.platform === 'darwin'
        ? 'macOS exposes per-process wakeups only through powermetrics (root) or libproc; top IDLEW did not advance between samples'
        : 'Linux has no per-process wakeup counter; see idleContextSwitches',
      'count',
    );
    result.metrics.idleContextSwitches = linux
      ? measured(contextSwitchDelta(switchesStart, switchesEnd), 'count', {
          note: 'voluntary + involuntary context switches of the processes alive at both ends of the window; a proxy, not wakeups',
        })
      : notMeasured('reads /proc; Linux only', 'count');

    const preTurn = stub.requests.length;
    result.endpointCallsAtRest = stub.requests
      .slice(0, preTurn)
      .map((request) => `${request.method} ${request.path}`);
    progress('idle samples taken; waiting for the Claude engine');
    const readiness = claudeExecutable
      ? await claudeReadiness(api)
      : {
          ready: false,
          reason: `no bundled Claude Code binary for ${process.platform}-${process.arch}`,
        };
    progress(`Claude engine ready=${readiness.ready}`);
    const sessionIds = [];
    if (readiness.ready) {
      sessionIds.push(await sendHi(api, repo));
      await wait(settings.sideCallWindowMs);
      const turnWindow = stub.requests.slice(preTurn);
      const turn = findTurnRequest(turnWindow, PROMPT);
      result.request = {
        prompt: PROMPT,
        station: turn ? summarizeRequest(turn.body, turn.bodyBytes) : null,
        sideCalls: messagesRequests(turnWindow)
          .filter((request) => request !== turn)
          .map(summarizeSideCall),
        otherCalls: turnWindow
          .filter((request) => !messagesRequests([request]).length)
          .map((request) => `${request.method} ${request.path}`),
      };
      if (turn) {
        result.repoRules = markersReached(turn.body, markers);
        result.metrics['request.sideCallCount'] = measured(
          result.request.sideCalls.length,
          'requests',
        );
      }
      for (let index = 1; index < settings.idleSessions; index += 1)
        sessionIds.push(await sendHi(api, repo));
      progress('sessions created; settling');
      result.metrics.idleSessionsMemoryBytes = restMetric(
        await settleTree(memorySnapshot, settings),
        {
          sessions: sessionIds.length,
          note: 'each session was created by one stub-answered turn; no real model call',
        },
      );

      mkdirSync(controlConfigDir, { recursive: true });
      progress('idle-session sample taken; running the control request');
      const controlCalls = await controlRequest({
        cwd: repo,
        env: { ...env, CLAUDE_CONFIG_DIR: controlConfigDir },
        stub,
        executable: claudeExecutable,
        model: result.request.station?.model ?? undefined,
      });
      const control = findTurnRequest(controlCalls, PROMPT);
      result.request.control = control
        ? summarizeRequest(control.body, control.bodyBytes)
        : null;
      const versions = [
        result.request.station?.claudeCodeVersion,
        result.request.control?.claudeCodeVersion,
      ];
      if (!turn || !control)
        result.request.diffReason = `no ${turn ? 'control' : 'Station'} turn request reached the stub`;
      else if (!versions[0] || versions[0] !== versions[1])
        result.request.diffReason = `Station and control ran different Claude Code versions (${versions.join(' vs ')})`;
      else {
        const diff = diffAgainstControl(turn.body, control.body);
        result.request.stationAdded = diff;
        result.metrics['request.stationAddedTextBytes'] = measured(
          diff.addedText.bytes,
          'bytes',
          { chars: diff.addedText.chars, lines: diff.addedText.lineCount },
        );
        result.metrics['request.stationAddedToolCount'] = measured(
          diff.addedTools.length + diff.addedNamedTools.length,
          'tools',
          {
            withDefinitions: diff.addedTools.length,
            namedOnly: diff.addedNamedTools.length,
            changedDefinitions: diff.changedTools.length,
          },
        );
        result.metrics['request.stationAddedToolDefinitionBytes'] = measured(
          diff.addedToolDefinitionBytes,
          'bytes',
          {
            note: 'added tools in full, plus the byte growth of tool definitions Station changed',
          },
        );
      }
    }
    const requestGap = readiness.ready
      ? (result.request?.diffReason ??
        'the Station turn request was not identified')
      : `Claude engine not ready: ${readiness.reason}`;
    for (const id of [
      'request.stationAddedTextBytes',
      'request.stationAddedToolCount',
      'request.stationAddedToolDefinitionBytes',
      'request.sideCallCount',
      'idleSessionsMemoryBytes',
    ])
      result.metrics[id] ??= notMeasured(requestGap);
    result.repoRules ??= { status: 'not_measured', reason: requestGap };

    // Leftover after stop: the tree as it stood, then whatever of it lives
    // on, plus anything still carrying the run's environment however it got
    // there (a double-forked daemon, a child spawned during shutdown).
    progress('stopping');
    const tableBeforeStop = processTable();
    const beforeStop = instanceSnapshot(tableBeforeStop, roots, tagging);
    // Evidence that the environment alone ties every instance process to
    // the run: what ancestry found that tagging did not.
    const taggedBeforeStop = new Set(
      taggedRows(tableBeforeStop, tagging).map((row) => row.pid),
    );
    const untaggedBeforeStop = beforeStop
      .filter((row) => !taggedBeforeStop.has(row.pid))
      .map((row) => row.command);
    await hooks.beforeStop?.({ env, scratch });
    const stopStart = performance.now();
    await stationOk(['stop', `--instance=${instance}`], {
      env,
      timeoutMs: 120_000,
    });
    started = false;
    result.stopMs = performance.now() - stopStart;
    await wait(settings.stopGraceMs);
    const after = processTable();
    const left = withMemory(leftoverAfterStop(beforeStop, after, tagging));
    const cleanup = signalIfSame(left, 'SIGKILL');
    result.metrics.leftoverAfterStopMemoryBytes = beforeStop.length
      ? measured(sum(left, 'memoryBytes'), 'bytes', {
          basis: MEMORY_BASIS,
          processCount: left.length,
          processes: processRows(left),
          afterSeconds: settings.stopGraceMs / 1000,
          beforeStopProcessCount: beforeStop.length,
          beforeStopUntagged: untaggedBeforeStop,
          killed: cleanup.signalled,
          notSignalledPidReused: cleanup.skipped,
          gap: LEFTOVER_GAP,
        })
      : notMeasured(
          "the instance's process tree was empty before stop: nothing was measured",
          'bytes',
        );
    result.outcome = 'completed';
  } catch (error) {
    result.error = error.stack ?? String(error);
  } finally {
    if (started)
      await station(['stop', `--instance=${instance}`], {
        env,
        timeoutMs: 120_000,
      }).catch(() => undefined);
    // Whatever still carries the run's environment, Station's or the
    // control's, is the run's to end; identity is rechecked per signal.
    try {
      const strays = taggedRows(processTable(), {
        ...tagging,
        excludeTags: [],
      });
      if (strays.length)
        result.cleanupKilled = signalIfSame(strays, 'SIGKILL').signalled;
    } catch (error) {
      result.cleanupError = String(error?.message ?? error);
    }
    writeFileSync(
      join(outputDir, 'requests.json'),
      `${JSON.stringify(stub.requests, null, 2)}\n`,
    );
    await stub.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  evaluateRun(result, { baselinePath, record, reportOnly });
  write();
  return { ...result, outputDir };
}

/**
 * One `station start` of the built instance: the time from launch until the
 * UI listener's readiness route answers `ready`.
 */
async function launchInstance(instance, ports, scratch, env) {
  const launch = performance.now();
  const startCommand = station(
    [
      'start',
      `--instance=${instance}`,
      '--temp-home',
      '--force',
      `--port=${ports.server}`,
      `--ui-port=${ports.ui}`,
      `--log=${join(scratch, 'server.log')}`,
    ],
    { env, timeoutMs: 10 * 60_000 },
  );
  // The UI listener's readiness route is the one the launcher itself
  // trusts: unauthenticated, and `ready` only once the sibling server
  // confirmed its own boot identity. The server's /api/system/identity needs
  // a credential, and unauthenticated polling there trips the auth rate
  // limiter.
  const launcher = { done: false, status: null };
  const startOutcome = startCommand.then(
    (outcome) => {
      launcher.done = true;
      launcher.status = outcome.status;
      launcher.returnedMs = performance.now() - launch;
      return outcome;
    },
    (error) => {
      launcher.done = true;
      throw error;
    },
  );
  const readyAt = poll(
    'the UI readiness attestation',
    10 * 60_000,
    async () => {
      if (launcher.done && launcher.status !== 0)
        throw Object.assign(new Error('station start failed'), {
          fatal: true,
        });
      const response = await fetch(
        `http://127.0.0.1:${ports.ui}/api/system/readiness`,
        {
          headers: { 'x-station-readiness-budget-ms': '1600' },
          signal: AbortSignal.timeout(2_000),
        },
      );
      const body = await response.json().catch(() => null);
      return response.ok && body?.ready === true && body?.status === 'ready'
        ? performance.now()
        : false;
    },
    100,
  ).catch((error) => error);
  const startResult = await startOutcome;
  assert.equal(
    startResult.status,
    0,
    `station start exited ${startResult.status}:\n${startResult.output.slice(-4000)}`,
  );
  const ready = await readyAt;
  if (ready instanceof Error) throw ready;
  return {
    readyMs: ready - launch,
    launcherReturnedMs: launcher.returnedMs,
    launcherOutputTail: startResult.output.trim().split('\n').slice(-12),
  };
}

function printSummary(result) {
  const line = (text) => console.log(`[station-weight] ${text}`);
  for (const [id, metric] of Object.entries(result.metrics ?? {}))
    line(
      metric.status === 'measured'
        ? `MEASURED ${id}=${Number(metric.value.toFixed?.(2) ?? metric.value)} ${metric.unit}`
        : `NOT_MEASURED ${id}: ${metric.reason}`,
    );
  if (result.repoRules) line(`repoRules ${JSON.stringify(result.repoRules)}`);
  for (const text of formatVerdicts(result.budgets ?? [])) console.log(text);
  if (result.error) line(`ERROR ${result.error.split('\n')[0]}`);
  line(`host ${result.host?.label} fingerprint ${result.host?.fingerprint}`);
  line(result.gate.summary);
  line(
    result.gate.passed
      ? 'GATE PASS'
      : `GATE FAIL: ${result.gate.reasons.join('; ')}`,
  );
  if (result.outputDir) line(`result ${join(result.outputDir, 'result.json')}`);
}

if (invokedDirectly(import.meta.url)) {
  const args = Object.fromEntries(
    process.argv.slice(2).map((arg) => {
      const index = arg.indexOf('=');
      return index < 0
        ? [arg.replace(/^--/, ''), true]
        : [arg.slice(2, index), arg.slice(index + 1)];
    }),
  );
  const number = (name) =>
    args[name] === undefined ? undefined : Number(args[name]);
  const settings = Object.fromEntries(
    Object.entries({
      settleMs: number('settle-ms'),
      settleMaxMs: number('settle-max-ms'),
      cpuWindowMs: number('cpu-window-ms'),
      idleSessions: number('sessions'),
      stopGraceMs: number('stop-grace-ms'),
      readyLaunches: number('ready-launches'),
    }).filter(([, value]) => value !== undefined),
  );
  const options = {
    baselinePath:
      typeof args.baseline === 'string'
        ? resolve(args.baseline)
        : DEFAULT_BASELINE_PATH,
    record: args['record-baseline'] === true,
    reportOnly: args['report-only'] === true,
  };
  if (options.record && options.reportOnly)
    throw new Error('--record-baseline and --report-only exclude each other');
  let result;
  if (typeof args.evaluate === 'string') {
    // Re-applies the baseline to a saved result without measuring again.
    const path = resolve(args.evaluate);
    result = evaluateRun(JSON.parse(readFileSync(path, 'utf8')), options);
    result.outputDir = dirname(path);
  } else
    result = await runStationWeight({
      out: typeof args.out === 'string' ? args.out : undefined,
      allowDirty: args['allow-dirty'] === true,
      settings,
      ...options,
    });
  printSummary(result);
  process.exitCode = result.gate.passed ? 0 : 1;
}
