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
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { constants, cpus, loadavg, release, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
  formatValue,
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
 * `started` is the birth token of the table read (whole-second lstart on
 * macOS); `exactStart` is the finer one a signal is rechecked against (see
 * exactStarts), known only for a kill-eligible process.
 * @typedef {{ pid: number, started: string, exactStart?: string }} ProcessIdentity
 * @typedef {{ nonceEntry: string, scratchRoot: string, excludeEntries: string[], argumentMarkers: string[], uid: number, notBeforeMs: number }} Tagging
 * @typedef {ProcessRow & { tag: 'nonce' | 'path', exactStart?: string }} TaggedRow
 * @typedef {ProcessRow & { killEligible: boolean, exactStart?: string }} OwnedRow
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
 * ancestry. Every process the instance starts inherits the run's
 * `STATION_WEIGHT_RUN=<nonce>` entry; the nonce is a random 128-bit value, so
 * a process carrying that exact entry is the run's and is the only process
 * the run ever signals individually (the other signal is the launcher's own
 * process group on a timeout; see runLauncher). A
 * process that dropped the nonce but kept a `HOME` or `TMPDIR` inside the
 * scratch root (by path segment, after resolving links on both sides) is
 * counted as the run's, never signalled. An entry matches only as a whole
 * NUL-separated entry. A process qualifies only if it runs as this user
 * (effective uid) and started after the run did, and a process naming the
 * nonce in its arguments is excluded: the nonce is only ever passed through
 * the environment. The slack absorbs whole-second birth times (macOS
 * lstart, Linux btime).
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
  assert(scratch.startsWith('/'), 'the scratch root is an absolute path');
  return {
    nonceEntry: `STATION_WEIGHT_RUN=${nonce}`,
    scratchRoot: canonicalPath(scratch),
    excludeEntries: controlConfigDir
      ? [`CLAUDE_CONFIG_DIR=${controlConfigDir}`]
      : [],
    argumentMarkers: [nonce],
    uid,
    notBeforeMs: Math.floor(startedAtMs / 1000) * 1000 - 2_000,
  };
}

/**
 * `path` with every link resolved and every `.` and `..` applied, as the
 * kernel would resolve it. A path that does not exist (yet, or any more)
 * resolves its longest existing prefix and appends the rest, so
 * `<scratch>/link/missing` still follows `link` out of the scratch root.
 * @param {string} path an absolute path
 * @returns {string}
 */
export function canonicalPath(path) {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) return path;
    return resolve(canonicalPath(parent), basename(path));
  }
}

/** Whether canonical `path` is `root` or inside it, by whole path segment. */
const within = (path, root) =>
  path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);

const SCRATCH_VARIABLES = new Set(['HOME', 'TMPDIR']);

/**
 * How exact environment `entries` (one `NAME=value` string each, as the
 * kernel stores them) tie a process to the run: `'nonce'` for the exact
 * `STATION_WEIGHT_RUN=<nonce>` entry, `'path'` for a `HOME` or `TMPDIR`
 * whose resolved value lies inside the resolved scratch root, `null` for
 * neither or for an excluded entry. A tag inside another variable's value
 * (`INNOCENT=x HOME=/scratch/user`) is not an entry, so it never matches.
 * `HOME=<scratch>/../outside` and a link under the scratch root that points
 * outside it resolve outside, so neither matches.
 * @param {string[]} entries
 * @param {Tagging} tagging
 * @returns {'nonce' | 'path' | null}
 */
export function runTagKind(entries, tagging) {
  let kind = null;
  for (const entry of entries) {
    if (tagging.excludeEntries.includes(entry)) return null;
    if (entry === tagging.nonceEntry) {
      kind = 'nonce';
      continue;
    }
    const equals = entry.indexOf('=');
    if (kind || equals <= 0 || !SCRATCH_VARIABLES.has(entry.slice(0, equals)))
      continue;
    const value = entry.slice(equals + 1);
    if (
      value.startsWith('/') &&
      within(canonicalPath(value), tagging.scratchRoot)
    )
      kind = 'path';
  }
  return kind;
}

/**
 * The macOS helper: sysctl through `python3 -I` ctypes, three modes.
 *
 * Read (default): the exact argument and environment entries of each pid
 * from KERN_PROCARGS2, the kernel's copy of the NUL-separated block a process
 * was started with (argc, executable path, argv, then environment entries up
 * to the first empty one). `ps -E` prints the same entries joined by spaces,
 * which cannot tell an entry from a space inside a value. Each pid's start
 * time (p_starttime from KERN_PROC_PID, in microseconds) is read before and
 * after; a pid whose start changed, or that cannot be read (exited, another
 * user's, EPERM), is omitted, so it is never tagged. A block that does not
 * parse strictly is answered as `{ malformed: <reason> }`: its size must be
 * 4 bytes to `kern.argmax`, `argc` must be 0 or more and no more than the
 * block can hold, and the executable path, every argument and every
 * environment entry must end with a NUL inside the returned size. A
 * malformed block is never tagged and is counted as a read failure. Bytes
 * that are not UTF-8 are kept as lone surrogates and never equal a tag.
 * `--test-recheck-offset-us=<n>` shifts the start read after the block by
 * `n`, so a test can drive a real read into the replaced-process branch.
 * `--test-parse` parses the blocks given on stdin (JSON `{ pid: hex }`)
 * with the same parser and limit instead of reading any process.
 *
 * `--starts`: pid -> start time in microseconds.
 *
 * `--signal=<n> <pid>:<start>...`: sends signal `n` to each pid whose start
 * time read immediately before is still `<start>` microseconds, and reports
 * which were signalled and which were skipped (start changed, or gone).
 */
const PROCARGS_SCRIPT = String.raw`
import ctypes, json, os, struct, sys
libc = ctypes.CDLL(None, use_errno=True)
libc.sysctl.argtypes = [ctypes.POINTER(ctypes.c_int), ctypes.c_uint, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t), ctypes.c_void_p, ctypes.c_size_t]
def sysctl(mib, size):
    names = (ctypes.c_int * len(mib))(*mib)
    buffer = ctypes.create_string_buffer(size)
    length = ctypes.c_size_t(size)
    if libc.sysctl(names, len(mib), buffer, ctypes.byref(length), None, 0) != 0:
        return None
    return buffer.raw[:length.value]
def started(pid):
    info = sysctl([1, 14, 1, pid], 4096)
    if info is None or len(info) < 16:
        return None
    seconds, micros = struct.unpack_from('qi', info, 0)
    return seconds * 1000000 + micros
def text(block, start, end):
    return block[start:end].decode('utf-8', 'surrogateescape')
def parse(block, limit):
    # argc, the executable path, NUL padding, argc arguments, then
    # environment entries up to an empty one. Returns (argv, env), or a
    # reason string when any part is out of bounds or unterminated.
    if len(block) < 4 or len(block) > limit:
        return 'size %d outside 4..%d' % (len(block), limit)
    argc = struct.unpack_from('i', block, 0)[0]
    # Each argument takes at least its NUL, after the path's.
    if argc < 0 or argc > len(block) - 5:
        return 'argc %d inconsistent with a %d-byte block' % (argc, len(block))
    end = block.find(b'\0', 4)
    if end < 0:
        return 'unterminated executable path'
    index = end
    while index < len(block) and block[index] == 0:
        index += 1
    argv = []
    for _ in range(argc):
        end = block.find(b'\0', index)
        if end < 0:
            return 'unterminated argument %d of %d' % (len(argv), argc)
        argv.append(text(block, index, end))
        index = end + 1
    env = []
    while index < len(block):
        end = block.find(b'\0', index)
        if end < 0:
            return 'unterminated environment entry %d' % len(env)
        if end == index:
            break
        env.append(text(block, index, end))
        index = end + 1
    return argv, env
args = sys.argv[1:]
mode, signal, offset = 'read', None, 0
while args and args[0].startswith('--'):
    flag = args.pop(0)
    if flag == '--starts':
        mode = 'starts'
    elif flag == '--test-parse':
        mode = 'parse'
    elif flag.startswith('--signal='):
        mode, signal = 'signal', int(flag.split('=', 1)[1])
    elif flag.startswith('--test-recheck-offset-us='):
        offset = int(flag.split('=', 1)[1])
    else:
        sys.exit('unknown flag ' + flag)
if mode == 'starts':
    out = {}
    for pid in map(int, args):
        start = started(pid)
        if start is not None:
            out[str(pid)] = start
elif mode == 'signal':
    out = {'signalled': [], 'skipped': []}
    for item in args:
        pid, want = map(int, item.split(':'))
        if started(pid) != want:
            out['skipped'].append(pid)
            continue
        try:
            os.kill(pid, signal)
            out['signalled'].append(pid)
        except OSError:
            out['skipped'].append(pid)
else:
    out = {}
    argmax = struct.unpack('i', sysctl([1, 8], 4))[0]
    def answer(pid, startedUs, block):
        parsed = parse(block, argmax)
        if isinstance(parsed, str):
            out[str(pid)] = {'malformed': parsed}
        else:
            out[str(pid)] = {'startedUs': startedUs, 'argv': parsed[0], 'env': parsed[1]}
    if mode == 'parse':
        for pid, hex in json.load(sys.stdin).items():
            answer(int(pid), 0, bytes.fromhex(hex))
    for pid in (map(int, args) if mode == 'read' else []):
        before = started(pid)
        block = sysctl([1, 49, pid], argmax)
        if before is None or block is None:
            continue
        after = started(pid)
        if after is None or after + offset != before:
            continue
        answer(pid, before, block)
json.dump(out, sys.stdout)
`;

/**
 * Runs the macOS helper with `args` and parses its JSON answer. A helper that
 * cannot run (no `python3` or `ctypes`) is an error, never an empty answer.
 * @param {string[]} args
 * @param {RunCommand} run
 * @param {string} [input] stdin, for `--test-parse`
 */
function darwinHelper(args, run, input) {
  let text;
  try {
    // -I: no PYTHON* variables, user site or script directory on the path.
    text = run('python3', ['-I', '-c', PROCARGS_SCRIPT, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      env: PS_ENV,
      ...(input === undefined ? {} : { input }),
    });
  } catch (error) {
    throw new Error(
      `cannot read process environments exactly (python3 -I with ctypes, sysctl KERN_PROCARGS2): ${String(error?.message ?? error).split('\n')[0]}`,
    );
  }
  return JSON.parse(text);
}

/**
 * pid -> the process's exact argument and environment entries, or
 * `{ malformed }` for a block that did not parse strictly (see
 * PROCARGS_SCRIPT). A pid that could not be read at all is absent.
 * `testing.blocks` (pid -> raw block) runs the same parser on given bytes
 * instead of reading processes.
 * @param {number[]} pids
 * @param {RunCommand} run
 * @param {{ recheckOffsetUs?: number, blocks?: Map<number, Buffer> }} [testing]
 * @returns {Map<number, { startedUs: number, argv: string[], env: string[] } | { malformed: string }>}
 */
export function darwinProcessArguments(
  pids,
  run = /** @type {RunCommand} */ (execFileSyncBounded),
  { recheckOffsetUs = 0, blocks } = {},
) {
  if (!pids.length && !blocks?.size) return new Map();
  const flags = recheckOffsetUs
    ? [`--test-recheck-offset-us=${recheckOffsetUs}`]
    : [];
  const answer = blocks
    ? darwinHelper(
        ['--test-parse'],
        run,
        JSON.stringify(
          Object.fromEntries(
            [...blocks].map(([pid, block]) => [pid, block.toString('hex')]),
          ),
        ),
      )
    : darwinHelper([...flags, ...pids.map(String)], run);
  return new Map(
    Object.entries(answer).map(([pid, entry]) => [Number(pid), entry]),
  );
}

/**
 * pid -> the finest birth token the host offers, for rechecking a process
 * right before it is signalled: `darwin:<p_starttime in microseconds>` on
 * macOS, and on Linux the `/proc` start ticks the table already uses
 * (`linux:<boot id>:<ticks>`, 1/CLK_TCK s). A pid that cannot be read is
 * absent.
 * @param {number[]} pids
 * @param {{ platform?: string, run?: RunCommand, readFile?: (path: string, encoding: 'utf8') => string, bootId?: string }} [options]
 * @returns {Map<number, string>}
 */
export function exactStarts(
  pids,
  {
    platform: platformName = process.platform,
    run = /** @type {RunCommand} */ (execFileSyncBounded),
    readFile = readFileSync,
    bootId,
  } = {},
) {
  const starts = new Map();
  if (!pids.length) return starts;
  if (platformName === 'linux') {
    bootId ??= defaultLinuxContext().bootId;
    for (const pid of pids) {
      try {
        const stat = parseProcStat(readFile(`/proc/${pid}/stat`, 'utf8'));
        if (stat) starts.set(pid, `linux:${bootId}:${stat.startTicks}`);
      } catch {
        // Exited: no birth to recheck against.
      }
    }
    return starts;
  }
  for (const [pid, us] of Object.entries(
    darwinHelper(['--starts', ...pids.map(String)], run),
  ))
    if (Number.isSafeInteger(us)) starts.set(Number(pid), `darwin:${us}`);
  return starts;
}

/**
 * pid -> exact environment and argument entries for each row whose read
 * still belongs to that row's process. Linux: `/proc/<pid>/environ` and
 * `cmdline`, accepted only if the pid still has the row's start ticks
 * afterwards. macOS: KERN_PROCARGS2 (see darwinProcessArguments), accepted
 * only if the start time read around it is the row's birth second. Each
 * entry carries the exact birth it was read under (see exactStarts). A
 * process whose entries cannot be read gets no entry, so it is never tagged;
 * one whose block was malformed is also added to `readFailures`.
 */
function environments(
  rows,
  { run, platformName, readFile, readArguments, readFailures },
) {
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
      tests.set(row.pid, {
        env: entries.split('\0').filter(Boolean),
        argv: argv.split('\0').filter(Boolean),
        exactStart: row.started,
      });
    }
    return tests;
  }
  const read = readArguments(
    rows.map((row) => row.pid),
    run,
  );
  for (const row of rows) {
    const entry = read.get(row.pid);
    if (entry && 'malformed' in entry) {
      readFailures?.push({
        pid: row.pid,
        started: row.started,
        command: row.command,
        reason: entry.malformed,
      });
      continue;
    }
    if (!entry || !Number.isSafeInteger(entry.startedUs)) continue;
    // lstart, and so the row, has whole seconds.
    if (Math.floor(entry.startedUs / 1_000_000) * 1000 !== row.startedAtMs)
      continue;
    tests.set(row.pid, {
      env: entry.env,
      argv: entry.argv,
      exactStart: `darwin:${entry.startedUs}`,
    });
  }
  return tests;
}

/**
 * Rows of `table` that are the run's by environment (see runTagging): the
 * same effective uid, started after the run, carrying the run's nonce or a
 * scratch path as an exact entry and none of `excludeEntries` (the control
 * engine shares the run's environment but is not Station's), with no
 * argument naming the nonce. These are found whatever their ancestry: a
 * double-forked daemon or a child spawned during shutdown has no path back to
 * the roots. Each row says how it was tagged (`tag`) and carries the exact
 * birth its environment was read under (`exactStart`). A process whose
 * environment block was malformed is never tagged and is appended to
 * `readFailures` when given.
 */
/**
 * @param {ProcessRow[]} table
 * @param {Tagging} tagging
 * @param {{ run?: RunCommand, platform?: string, readFile?: (path: string, encoding: 'utf8') => string, readArguments?: typeof darwinProcessArguments, readFailures?: Array<{ pid: number, started: string, command: string, reason: string }> }} [options]
 * @returns {TaggedRow[]}
 */
export function taggedRows(
  table,
  tagging,
  {
    run = /** @type {RunCommand} */ (execFileSyncBounded),
    platform: platformName = process.platform,
    readFile = readFileSync,
    readArguments = darwinProcessArguments,
    readFailures,
  } = {},
) {
  const { argumentMarkers, uid, notBeforeMs } = tagging;
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
    readArguments,
    readFailures,
  });
  /** @type {TaggedRow[]} */
  const tagged = [];
  for (const row of candidates) {
    const entry = environment.get(row.pid);
    if (
      entry === undefined ||
      argumentMarkers.some((marker) =>
        entry.argv.some((argument) => argument.includes(marker)),
      )
    )
      continue;
    const tag = runTagKind(entry.env, tagging);
    if (tag) tagged.push({ ...row, tag, exactStart: entry.exactStart });
  }
  return tagged;
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
 * Which of `rows` the run may signal. Kill-eligible: only a row tagged by the
 * exact `STATION_WEIGHT_RUN=<nonce>` entry, with the exact birth its
 * environment was read under. Every other row, a recorded root without the
 * entry included, found by ancestry, by an identity seen earlier or by a
 * scratch `HOME` or `TMPDIR`, is report-only: it counts as the run's, and is
 * never signalled.
 * @param {ProcessRow[]} rows
 * @param {TaggedRow[]} tagged
 * @returns {OwnedRow[]}
 */
export function killEligibility(rows, tagged) {
  const exact = new Map();
  for (const row of tagged)
    if (row.tag === 'nonce' && row.exactStart)
      exact.set(identityKey(row), row.exactStart);
  return rows.map((row) => {
    const exactStart = exact.get(identityKey(row));
    return exactStart
      ? { ...row, killEligible: true, exactStart }
      : { ...row, killEligible: false };
  });
}

/**
 * What lives on after stop: every process seen in the instance's tree during
 * the run that is still alive with the same birth token (see processLedger),
 * every recorded root, and every process still carrying the run's
 * environment, whether it detached or was spawned after the last read, plus
 * their descendants; each marked kill-eligible or report-only (see
 * killEligibility).
 * @param {ProcessIdentity[]} seen
 * @param {ProcessRow[]} after
 * @param {Tagging} tagging
 * @param {Parameters<typeof taggedRows>[2]} [options]
 * @param {ProcessIdentity[]} [roots]
 */
export function leftoverAfterStop(seen, after, tagging, options, roots = []) {
  const tagged = taggedRows(after, tagging, options);
  return killEligibility(
    ownedTree(after, [...roots, ...seen, ...tagged]),
    tagged,
  );
}

/**
 * Every process identity (pid plus birth token) ever seen in the instance's
 * tree. Ownership by identity does not depend on the environment: a child
 * that rewrites its environment area (a long `process.title` on macOS) or
 * detaches is still counted as the run's once a read saw it in the tree. It
 * is never signalled on that basis (see killEligibility). Once following
 * starts, it also measures the reads: how many, and the longest interval
 * between the starts of two consecutive ones.
 */
function processLedger() {
  /** @type {Map<string, ProcessIdentity>} */
  const seen = new Map();
  let lastAt = -Infinity;
  let following = false;
  let reads = 0;
  let maxIntervalMs = 0;
  return {
    /**
     * @template {ProcessRow} T
     * @param {T[]} rows
     * @param {number} [at] when the table the rows came from was read
     * @returns {T[]}
     */
    remember(rows, at = performance.now()) {
      for (const row of rows)
        seen.set(identityKey(row), { pid: row.pid, started: row.started });
      if (following) {
        if (reads > 0) maxIntervalMs = Math.max(maxIntervalMs, at - lastAt);
        reads += 1;
      }
      lastAt = Math.max(lastAt, at);
      return rows;
    },
    follow() {
      following = true;
    },
    /** @returns {ProcessIdentity[]} */
    identities: () => [...seen.values()],
    get size() {
      return seen.size;
    },
    get lastAt() {
      return lastAt;
    },
    get reads() {
      return reads;
    },
    get maxIntervalMs() {
      return maxIntervalMs;
    },
  };
}

/**
 * Reads the tree by ancestry every `intervalMs` into `ledger`, from the
 * recorded roots and everything already seen, and skips a tick when another
 * read fed the ledger within the interval (the CPU window reads at the same
 * rate). The timer shares the event loop with every synchronous read the run
 * makes (memory footprints, environment scans), so a tick can come late; the
 * ledger measures the real intervals. A failed read is kept in `errors`: what
 * it missed is unknown, so the caller must not report the leftover check as
 * complete. Identities this follower itself read go into `followed`.
 * @param {ReturnType<typeof processLedger>} ledger
 * @param {() => ProcessIdentity[]} roots
 * @param {Set<string>} followed
 * @param {{ intervalMs: number, read: () => ProcessRow[] }} options
 */
function followTree(ledger, roots, followed, { intervalMs, read }) {
  /** @type {string[]} */
  const errors = [];
  const tick = (force = false) => {
    if (!force && performance.now() - ledger.lastAt < intervalMs) return;
    try {
      const at = performance.now();
      const rows = ownedTree(read(), [...roots(), ...ledger.identities()]);
      ledger.remember(rows, at);
      for (const row of rows) followed.add(identityKey(row));
    } catch (error) {
      errors.push(String(error?.message ?? error).split('\n')[0]);
    }
  };
  const timer = setInterval(tick, intervalMs);
  return {
    errors,
    tick,
    stop: () => clearInterval(timer),
  };
}

/**
 * The run's ownership of processes in one place: the recorded roots, every
 * identity seen in the tree since (followed every `intervalMs` from the
 * moment the first roots are known), and the environment tag. The runner
 * reads the tree, the leftovers and the cleanup set only through this.
 * @param {Tagging} tagging
 * @param {{ intervalMs: number, read?: () => ProcessRow[], tagOptions?: Parameters<typeof taggedRows>[2] }} options
 */
export function runOwnership(
  tagging,
  { intervalMs, read = processTable, tagOptions },
) {
  /** @type {Map<string, ProcessIdentity & { learnedAt: string }>} */
  const roots = new Map();
  const ledger = processLedger();
  /** @type {Set<string>} */
  const followed = new Set();
  /** @type {WeakMap<ProcessRow[], number>} */
  const readAt = new WeakMap();
  /** @type {ReturnType<typeof followTree> | undefined} */
  let follower;
  const rootList = () => [...roots.values()];
  const known = () => [...rootList(), ...ledger.identities()];
  const at = (table) => readAt.get(table) ?? performance.now();
  return {
    ledger,
    /** One process table, timed for the ledger. */
    readTable() {
      const started = performance.now();
      const table = read();
      readAt.set(table, started);
      return table;
    },
    /**
     * Adds the roots `next` names (an instance record's) and, the first
     * time, starts following the tree, with one read right away. A root is
     * counted as the run's; it is kill-eligible only if its own environment
     * carries the nonce entry (see killEligibility). Returns how many roots
     * were new.
     * @param {ProcessIdentity[]} next
     */
    setRoots(next) {
      const fresh = next.filter((root) => !roots.has(identityKey(root)));
      if (fresh.length) {
        const learnedAt = new Date().toISOString();
        for (const { pid, started } of fresh)
          roots.set(identityKey({ pid, started }), { pid, started, learnedAt });
      }
      if (!follower) {
        ledger.follow();
        follower = followTree(ledger, rootList, followed, { intervalMs, read });
        follower.tick(true);
      } else if (fresh.length) follower.tick(true);
      return fresh.length;
    },
    roots: rootList,
    /** The tree now: roots, identities seen, tagged rows, descendants. */
    tree(table = this.readTable()) {
      return ledger.remember(
        instanceSnapshot(table, known(), tagging, tagOptions),
        at(table),
      );
    },
    /**
     * The tree by ancestry only, from what is known and `tagged`.
     * @param {ProcessRow[]} table
     * @param {ProcessRow[]} tagged
     */
    ancestry(table, tagged) {
      return ledger.remember(instanceTree(table, known(), tagged), at(table));
    },
    /**
     * What lives on after stop, each row kill-eligible or report-only; ends
     * the following.
     * @param {ProcessRow[]} after
     */
    leftover(after) {
      follower?.stop();
      return ledger.remember(
        leftoverAfterStop(
          ledger.identities(),
          after,
          tagging,
          tagOptions,
          rootList(),
        ),
        at(after),
      );
    },
    /**
     * How the tree was followed: reads, the longest interval between them,
     * every root with when it was learned, and the roots the follower's own
     * reads found alive.
     */
    follow() {
      return {
        nominalIntervalMs: intervalMs,
        reads: ledger.reads,
        maxIntervalMs: ledger.maxIntervalMs,
        errors: [...(follower?.errors ?? [])],
        roots: rootList().map(({ pid, started, learnedAt }) => ({
          pid,
          started,
          learnedAt,
        })),
        rootsFollowed: rootList()
          .filter((root) => followed.has(identityKey(root)))
          .map(({ pid, started }) => ({ pid, started })),
      };
    },
    /** Reads of the tree that failed while following. */
    followErrors: () => follower?.errors ?? [],
    /**
     * Everything still alive that is the run's, the control engine
     * included, each kill-eligible or report-only.
     * @param {ProcessRow[]} table
     */
    strays(table) {
      return leftoverAfterStop(
        ledger.identities(),
        table,
        { ...tagging, excludeEntries: [] },
        tagOptions,
        rootList(),
      );
    },
    stop: () => follower?.stop(),
  };
}

/**
 * Sends `signal` to each kill-eligible row whose exact birth (see
 * exactStarts) still holds when read immediately before the signal. On macOS
 * the helper reads each start time and signals in one pass, so the recheck
 * and the signal are microseconds apart; on Linux the `/proc` start ticks are
 * read right before `process.kill`. Only a row whose `killEligible` is
 * exactly `true` (see killEligibility) and that has an exact birth is
 * signalled; an omitted flag means not eligible. No POSIX call signals a pid only if it
 * still names one process, so the guarantee is this recheck, not more: a
 * pid would have to be freed and reused, with the recorded birth, between
 * the recheck and the signal.
 * @param {Array<Partial<OwnedRow> & { pid: number, killEligible: boolean, exactStart?: string }>} rows
 * @param {NodeJS.Signals} signal
 * @param {{ platform?: string, run?: RunCommand, readFile?: (path: string, encoding: 'utf8') => string, kill?: (pid: number, signal: NodeJS.Signals) => unknown, bootId?: string }} [options]
 */
export function signalIfSame(
  rows,
  signal,
  {
    platform: platformName = process.platform,
    run = /** @type {RunCommand} */ (execFileSyncBounded),
    readFile = readFileSync,
    kill = process.kill,
    bootId,
  } = {},
) {
  /** @type {number[]} */
  const signalled = [];
  /** @type {number[]} */
  const skipped = [];
  const eligible = [];
  for (const row of rows)
    if (row.killEligible !== true || !row.exactStart) skipped.push(row.pid);
    else eligible.push(row);
  if (platformName === 'linux') {
    for (const row of eligible) {
      const now = exactStarts([row.pid], {
        platform: platformName,
        readFile,
        bootId,
      }).get(row.pid);
      if (now !== row.exactStart) {
        skipped.push(row.pid);
        continue;
      }
      try {
        kill(row.pid, signal);
        signalled.push(row.pid);
      } catch {
        // Exited between the check and the signal.
        skipped.push(row.pid);
      }
    }
    return { signalled, skipped };
  }
  const darwin = [];
  for (const row of eligible)
    if (/^darwin:\d+$/.test(/** @type {string} */ (row.exactStart)))
      darwin.push(row);
    else skipped.push(row.pid);
  if (!darwin.length) return { signalled, skipped };
  const number = constants.signals[signal];
  assert(Number.isInteger(number), `unknown signal ${signal}`);
  const answer = darwinHelper(
    [
      `--signal=${number}`,
      ...darwin.map(
        (row) =>
          `${row.pid}:${/** @type {string} */ (row.exactStart).slice('darwin:'.length)}`,
      ),
    ],
    run,
  );
  signalled.push(...answer.signalled);
  skipped.push(...answer.skipped);
  return { signalled, skipped };
}

/** Report lines carry at most this many characters of a command line. */
const COMMAND_LINE_MAX_CHARS = 1000;

/**
 * The command line of each row, cut to its first COMMAND_LINE_MAX_CHARS
 * characters, for reporting what a run left running: `/proc/<pid>/cmdline`
 * on Linux, the helper's argument read on macOS, the table's command name
 * when neither can be read.
 * @param {ProcessRow[]} rows
 * @param {{ platform?: string, run?: RunCommand, readFile?: (path: string, encoding: 'utf8') => string }} [options]
 * @returns {Array<{ pid: number, started: string, command: string }>}
 */
export function describeProcesses(
  rows,
  {
    platform: platformName = process.platform,
    run = /** @type {RunCommand} */ (execFileSyncBounded),
    readFile = readFileSync,
  } = {},
) {
  /** @type {Map<number, string[]>} */
  const argv = new Map();
  try {
    if (platformName === 'linux')
      for (const row of rows) {
        try {
          argv.set(
            row.pid,
            readFile(`/proc/${row.pid}/cmdline`, 'utf8')
              .split('\0')
              .filter(Boolean),
          );
        } catch {
          // Exited: the table's command name stands.
        }
      }
    else {
      const born = new Map(rows.map((row) => [row.pid, row.startedAtMs]));
      // Only a read of the row's own process (its birth second).
      for (const [pid, entry] of darwinProcessArguments(
        rows.map((row) => row.pid),
        run,
      ))
        if (
          'argv' in entry &&
          Math.floor(entry.startedUs / 1_000_000) * 1000 === born.get(pid)
        )
          argv.set(pid, entry.argv);
    }
  } catch {
    // Unreadable: the table's command names stand.
  }
  return rows.map((row) => ({
    pid: row.pid,
    started: row.started,
    command: (argv.get(row.pid)?.join(' ') || row.command).slice(
      0,
      COMMAND_LINE_MAX_CHARS,
    ),
  }));
}

/**
 * Ends what the run may end and reports the rest: kill-eligible rows get
 * SIGKILL through signalIfSame; report-only rows are never signalled and are
 * returned with pid, birth and command line.
 * @param {OwnedRow[]} rows
 * @param {Parameters<typeof signalIfSame>[2]} [options]
 */
export function endRunProcesses(rows, options) {
  const outcome = signalIfSame(
    rows.filter((row) => row.killEligible),
    'SIGKILL',
    options,
  );
  return {
    killed: outcome.signalled,
    notSignalledBirthChanged: outcome.skipped,
    leftRunning: describeProcesses(
      rows.filter((row) => !row.killEligible),
      options,
    ),
  };
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
/** How long a timed-out launcher's output may stay open after the signal. */
const LAUNCHER_KILL_GRACE_MS = 5_000;

/**
 * Runs one launcher command as an owned process group and returns its exit
 * status and output. Output that overflowed its capture bound or is not valid
 * UTF-8, and a process that could not run at all, are errors: an incomplete
 * capture is never taken as a complete success.
 *
 * A launcher that outlives `timeoutMs` is an error. Its process group, the
 * one this spawn created, gets SIGKILL only while the launcher, the group's
 * leader, has not been reaped (see forceTerminate in owned-process.mjs):
 * until then the group id cannot name another group. Once the launcher has
 * exited the group is not signalled, and whatever it left is found and
 * reported by the run's leftover accounting instead.
 * @param {string} executable
 * @param {string[]} args
 * @param {{ env: NodeJS.ProcessEnv, timeoutMs: number, cwd?: string, maxBytes?: number, killGraceMs?: number }} options
 */
export async function runLauncher(
  executable,
  args,
  {
    env,
    timeoutMs,
    cwd = ROOT,
    maxBytes = LAUNCHER_OUTPUT_MAX_BYTES,
    killGraceMs = LAUNCHER_KILL_GRACE_MS,
  },
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
  /** @type {Promise<string> | undefined} */
  let termination;
  let timer;
  const expired = new Promise((resolveExpired) => {
    timer = setTimeout(() => {
      termination = owned
        .forceTerminate({ onlyWhileLeaderUnreaped: true })
        .then(
          (outcome) =>
            outcome?.signalled === true
              ? 'sent SIGKILL to the process group it created'
              : 'did not signal its process group: the launcher had already exited, so the group id may name another group',
          (error) =>
            `failed to signal its process group: ${String(error?.message ?? error)}`,
        );
      resolveExpired(undefined);
    }, timeoutMs);
  });
  try {
    let result = await Promise.race([owned.completion, expired]);
    if (result === undefined) {
      const how = await termination;
      result = await Promise.race([
        owned.completion,
        wait(killGraceMs).then(() => undefined),
      ]);
      if (result === undefined) {
        // Something outside the group still holds the output open.
        owned.child.stdout?.destroy();
        owned.child.stderr?.destroy();
      }
      throw new Error(
        `${label} did not finish within ${timeoutMs} ms; the run ${how}${result === undefined ? `, and its output was still open ${killGraceMs} ms later` : ''}`,
      );
    }
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
  `not counted: CPU a process used after its last read before exiting (up to ${Math.ceil(maxReadSpanMs)} ms per process, the longest span observed between the start of one read and the end of the next; the nominal interval is ${intervalMs} ms), processes that started and exited between two reads, and processes that left the tree by detaching before any read saw them in it and exited before the window's end (the window follows ancestry and identities already seen, and rescans the environment only at its end)`;

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
 * What the leftover check cannot find; reported with the metric, with the
 * intervals this run actually observed. Nothing ties such a process to the
 * run: no subreaper or cgroup follows it on macOS, and a process group or
 * session can be left with setsid and its id reused.
 * @param {{ nominalIntervalMs: number, maxIntervalMs: number }} follow
 */
export const LEFTOVER_GAP = ({ nominalIntervalMs, maxIntervalMs }) =>
  `not found: a process that left the instance tree before any read saw it there and whose environment carries neither the run tag nor a scratch HOME or TMPDIR as an exact entry (started with env: {}, or with its environment area overwritten, as a long process.title does on macOS). The tree is read from the moment the instance record names its roots, while station start is still running, until after stop: nominally every ${nominalIntervalMs} ms, but the reads share the event loop with synchronous memory and environment reads, and the longest interval observed between the starts of two reads was ${Math.ceil(maxIntervalMs)} ms. A double fork that completes within one such interval, or before the run learned the roots (follow.roots[].learnedAt against follow.recordStartedAt), escapes ancestry; neither a recorded identity, ancestry nor environment then ties it to the run`;

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
  // Processes whose environment block did not parse: never kill-eligible,
  // and reported.
  /** @type {Array<{ pid: number, started: string, command: string, reason: string }>} */
  const readFailures = [];
  const tagOptions = { readFailures };
  // Every process seen in the tree is the run's by identity from then on.
  const ownership = runOwnership(tagging, {
    intervalMs: settings.cpuSampleIntervalMs,
    tagOptions,
  });
  const treeNow = (table = ownership.readTable()) => ownership.tree(table);
  const recordPath = join(ROOT, '.station/instances', `${instance}.json`);
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
      launches.push(
        await launchInstance(instance, ports, scratch, env, {
          recordPath,
          intervalMs: settings.cpuSampleIntervalMs,
          // Following starts as soon as the record names the roots, while
          // station start is still running.
          onRecord: (record) => ownership.setRoots(recordedRoots(record)),
        }),
      );
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
    const instanceRecord = JSON.parse(readFileSync(recordPath, 'utf8'));
    const instanceRoots = recordedRoots(instanceRecord);
    // The roots were learned while station start ran (launchInstance), and
    // the tree is read every interval from then until after stop. A root
    // first learned here means the following started late; it is counted.
    result.follow = {
      recordStartedAt: instanceRecord.startedAt,
      instanceRoots,
      rootsLearnedAfterLaunch: ownership.setRoots(instanceRoots),
    };
    await api.pair(instanceRecord.baseDir);

    progress('paired; settling');
    const memorySnapshot = () => withMemory(treeNow());
    result.metrics.restMemoryBytes = restMetric(
      await settleTree(memorySnapshot, settings),
    );

    // The window walks the tree by ancestry from the roots, the processes
    // tagged at its start and every identity seen so far (a full environment
    // scan every 250 ms would be the heaviest thing on the host), and
    // rescans for tagged processes at its end.
    const taggedAtStart = taggedRows(ownership.readTable(), tagging);
    const linux = process.platform === 'linux';
    // Context switches are read from /proc when the window opens and when it
    // closes, not from the rows afterwards (both would then read the end).
    let switchesStart;
    let switchesEnd;
    const sampled = await sampleTreeCpu(
      (final) => {
        const table = ownership.readTable();
        const rows = final
          ? treeNow(table)
          : ownership.ancestry(table, taggedAtStart);
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

    // Leftover after stop: whatever was ever seen in the tree and lives on,
    // plus anything still carrying the run's environment however it got
    // there (a double-forked daemon, a child spawned during shutdown).
    progress('stopping');
    const tableBeforeStop = ownership.readTable();
    const beforeStop = treeNow(tableBeforeStop);
    // How each pre-stop process is the run's: by the nonce (kill-eligible),
    // only by a scratch path, or only by ancestry (both report-only).
    const tagBeforeStop = new Map(
      taggedRows(tableBeforeStop, tagging, tagOptions).map((row) => [
        row.pid,
        row.tag,
      ]),
    );
    const beforeStopOwnership = {
      runTag: beforeStop.filter((row) => tagBeforeStop.get(row.pid) === 'nonce')
        .length,
      pathOnly: beforeStop
        .filter((row) => tagBeforeStop.get(row.pid) === 'path')
        .map((row) => row.command),
      ancestryOnly: beforeStop
        .filter((row) => !tagBeforeStop.has(row.pid))
        .map((row) => row.command),
    };
    await hooks.beforeStop?.({ env, scratch });
    const stopStart = performance.now();
    await stationOk(['stop', `--instance=${instance}`], {
      env,
      timeoutMs: 120_000,
    });
    started = false;
    result.stopMs = performance.now() - stopStart;
    await wait(settings.stopGraceMs);
    const left = withMemory(ownership.leftover(ownership.readTable()));
    const followErrors = ownership.followErrors();
    // Only kill-eligible processes are signalled; the rest are counted here
    // and reported as left running.
    const ended = endRunProcesses(left);
    result.follow = { ...result.follow, ...ownership.follow() };
    const leftoverDetail = {
      basis: MEMORY_BASIS,
      processCount: left.length,
      processes: left.map((row) => ({
        ...processRows([row])[0],
        started: row.started,
        killEligible: row.killEligible,
      })),
      afterSeconds: settings.stopGraceMs / 1000,
      beforeStopProcessCount: beforeStop.length,
      beforeStopOwnership,
      seenProcessCount: ownership.ledger.size,
      killed: ended.killed,
      notSignalledBirthChanged: ended.notSignalledBirthChanged,
      reportOnly: ended.leftRunning,
      maxReadIntervalMs: result.follow.maxIntervalMs,
      gap: LEFTOVER_GAP(result.follow),
    };
    result.metrics.leftoverAfterStopMemoryBytes = !beforeStop.length
      ? notMeasured(
          "the instance's process tree was empty before stop: nothing was measured",
          'bytes',
        )
      : followErrors.length
        ? {
            ...notMeasured(
              `${followErrors.length} reads of the tree failed, so processes seen only then are unknown: ${followErrors[0]}`,
              'bytes',
            ),
            ...leftoverDetail,
          }
        : measured(sum(left, 'memoryBytes'), 'bytes', leftoverDetail);
    result.outcome = 'completed';
  } catch (error) {
    result.error = error.stack ?? String(error);
  } finally {
    ownership.stop();
    if (started)
      await station(['stop', `--instance=${instance}`], {
        env,
        timeoutMs: 120_000,
      }).catch(() => undefined);
    result.follow = { ...result.follow, ...ownership.follow() };
    // Only a process carrying the run's nonce (Station's or the control's)
    // is the run's to end, its exact birth rechecked right before the
    // signal. Anything else still alive that the run counted (a recorded
    // root without the nonce, seen in the tree, or with a scratch HOME or
    // TMPDIR) is left running and reported, never signalled.
    try {
      const strays = ownership.strays(processTable());
      if (strays.length) {
        const ended = endRunProcesses(strays);
        result.cleanupKilled = ended.killed;
        result.leftRunning = ended.leftRunning;
      }
    } catch (error) {
      result.cleanupError = String(error?.message ?? error);
    }
    // One entry per process, however many reads met its malformed block.
    result.environmentReadFailures = [
      ...new Map(
        readFailures.map((failure) => [
          `${failure.pid} ${failure.started}`,
          failure,
        ]),
      ).values(),
    ];
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
 * UI listener's readiness route answers `ready`. While it runs, the instance
 * record at `recordPath` is read every `intervalMs`, and `onRecord` gets each
 * record that names process fingerprints: the launcher writes the record
 * right after spawning the roots, well before readiness, so the run can
 * follow the tree from then on. A record left by an earlier launch names
 * roots that have exited, which own nothing.
 * @param {string} instance
 * @param {{ server: number, ui: number }} ports
 * @param {string} scratch
 * @param {NodeJS.ProcessEnv} env
 * @param {{ recordPath: string, intervalMs: number, onRecord: (record: any) => void }} follow
 */
async function launchInstance(
  instance,
  ports,
  scratch,
  env,
  { recordPath, intervalMs, onRecord },
) {
  const watchRecord = () => {
    let record;
    try {
      record = JSON.parse(readFileSync(recordPath, 'utf8'));
    } catch {
      return; // Not written yet, or mid-write.
    }
    if (record?.serverFingerprint || record?.uiFingerprint) onRecord(record);
  };
  const recordTimer = setInterval(() => {
    try {
      watchRecord();
    } catch (error) {
      progress(`instance record not followed yet: ${error?.message ?? error}`);
    }
  }, intervalMs);
  try {
    return await launchAndWait(instance, ports, scratch, env);
  } finally {
    clearInterval(recordTimer);
  }
}

async function launchAndWait(instance, ports, scratch, env) {
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
        ? `MEASURED ${id}=${formatValue(metric.value)} ${metric.unit}`
        : `NOT_MEASURED ${id}: ${metric.reason}`,
    );
  if (result.repoRules) line(`repoRules ${JSON.stringify(result.repoRules)}`);
  for (const text of formatVerdicts(result.budgets ?? [])) console.log(text);
  // What the run counted as its own but may not signal: left running.
  for (const row of result.leftRunning ?? [])
    line(
      `LEFT RUNNING pid=${row.pid} birth=${JSON.stringify(row.started)} command=${JSON.stringify(row.command)}`,
    );
  for (const row of result.environmentReadFailures ?? [])
    line(
      `ENVIRONMENT UNREADABLE pid=${row.pid} birth=${JSON.stringify(row.started)} reason=${JSON.stringify(row.reason)}`,
    );
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
