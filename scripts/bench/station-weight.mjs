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
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
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
  formatVerdicts,
  hostClass,
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

const git = (...args) =>
  execFileSyncBounded('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();

// ---------------------------------------------------------------------------
// Process tree by ownership: descendants of the instance's registered roots.

/**
 * One `ps` snapshot. `started` (lstart) pairs with pid as the process
 * identity, so a reused pid is never mistaken for a survivor.
 */
export function processTable(run = execFileSyncBounded) {
  const text = run('ps', ['-A', '-o', 'pid=,ppid=,rss=,time=,lstart=,comm='], {
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, LC_ALL: 'C' },
  });
  const rows = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 10) continue;
    const [pid, ppid, rss, time, ...rest] = parts;
    rows.push({
      pid: Number(pid),
      ppid: Number(ppid),
      rssBytes: Number(rss) * 1024,
      cpuSeconds: parseCpuTime(time),
      started: rest.slice(0, 5).join(' '),
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

/** The rows owned by `roots`: the roots and every descendant by parent pid. */
export function ownedTree(table, roots) {
  const ids = new Set(roots.filter((pid) => Number.isInteger(pid) && pid > 0));
  let size;
  do {
    size = ids.size;
    for (const row of table) if (ids.has(row.ppid)) ids.add(row.pid);
  } while (ids.size !== size);
  return table.filter((row) => ids.has(row.pid));
}

/**
 * Rows from `before` still alive in `after` with the same start time, plus
 * anything they spawned since.
 */
export function survivors(before, after) {
  const identity = new Map(before.map((row) => [row.pid, row.started]));
  const alive = after
    .filter((row) => identity.get(row.pid) === row.started)
    .map((row) => row.pid);
  return ownedTree(after, alive);
}

const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const processRows = (rows) =>
  rows.map(({ pid, ppid, rssBytes, command }) => ({
    pid,
    ppid,
    rssBytes,
    command,
  }));

/** Linux only: voluntary + involuntary context switches across the tree. */
function contextSwitches(rows) {
  let total = 0;
  for (const row of rows) {
    try {
      const status = readFileSync(`/proc/${row.pid}/status`, 'utf8');
      for (const match of status.matchAll(
        /^(?:non)?voluntary_ctxt_switches:\s+(\d+)$/gm,
      ))
        total += Number(match[1]);
    } catch {
      // A process that exited between snapshots contributes nothing.
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// The launcher and the HTTP API.

async function station(args, { env, timeoutMs }) {
  const owned = executeOwnedProcess(
    join(ROOT, 'station'),
    args,
    undefined,
    `station ${args[0]}`,
    { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
  );
  const output = captureOwnedProcessOutput(owned);
  progress(`station ${args[0]} pid=${owned.child.pid}`);
  const timer = setTimeout(() => void owned.forceTerminate(), timeoutMs);
  try {
    const result = await owned.completion;
    const captured = output.finish();
    progress(
      `station ${args[0]} exited status=${result.status} signal=${result.signal}`,
    );
    return {
      status: result.status,
      output: `${captured.stdout.text}\n${captured.stderr.text}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

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
  const run = query({
    prompt: PROMPT,
    options: {
      cwd,
      env,
      pathToClaudeCodeExecutable: executable,
      // Same model as Station's turn, so model-specific lines cancel out.
      ...(model ? { model } : {}),
      spawnClaudeCodeProcess: (options) =>
        spawn(options.command, options.args, {
          cwd: options.cwd,
          env: options.env,
          signal: options.signal,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        }),
    },
  });
  const deadline = setTimeout(() => void run.interrupt?.(), 120_000);
  try {
    for await (const message of run) if (message.type === 'result') break;
  } finally {
    clearTimeout(deadline);
    run.close?.();
  }
  return stub.requests.slice(from);
}

// ---------------------------------------------------------------------------

function scrubbedEnvironment(scratch, stubUrl, claudeExecutable) {
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

function fixtureRepository(scratch, markers) {
  const repo = join(scratch, 'repo');
  mkdirSync(repo, { recursive: true });
  // CLAUDE.md deliberately does not import AGENTS.md, so each file's
  // marker answers for that file alone.
  writeFileSync(join(repo, 'AGENTS.md'), `# Rules\n\n${markers.agentsMd}\n`);
  writeFileSync(join(repo, 'CLAUDE.md'), `# Rules\n\n${markers.claudeMd}\n`);
  const run = (...args) =>
    execFileSyncBounded('git', args, {
      cwd: repo,
      encoding: 'utf8',
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'station-weight',
        GIT_AUTHOR_EMAIL: 'station-weight@example.invalid',
        GIT_COMMITTER_NAME: 'station-weight',
        GIT_COMMITTER_EMAIL: 'station-weight@example.invalid',
      },
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

/** Defaults are chosen for a quiet host; flags can lengthen them. */
export const DEFAULT_SETTINGS = Object.freeze({
  settleMs: 30_000,
  cpuWindowMs: 30_000,
  idleSessions: 3,
  stopGraceMs: 5_000,
  sideCallWindowMs: 5_000,
});

export async function runStationWeight({
  out,
  baselinePath = DEFAULT_BASELINE_PATH,
  record = false,
  allowDirty = false,
  settings: overrides = {},
} = {}) {
  const settings = { ...DEFAULT_SETTINGS, ...overrides };
  for (const [name, value] of Object.entries(settings))
    assert(Number.isSafeInteger(value) && value >= 0, `invalid ${name}`);
  assert(settings.idleSessions >= 1, 'idleSessions must be at least 1');
  const sha = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain');
  assert(allowDirty || !dirty, 'commit first: the check measures a clean tree');
  const runId = randomUUID();
  const outputDir = resolve(
    out ?? join(ROOT, '.kontourai/station-weight', sha, runId),
  );
  mkdirSync(outputDir, { recursive: true });
  const result = {
    schemaVersion: 1,
    kind: 'station-weight',
    sourceRevision: sha,
    dirty: Boolean(dirty),
    runId,
    startedAt: new Date().toISOString(),
    outcome: 'failed',
    host: {
      platform: platform(),
      arch: process.arch,
      release: release(),
      node: process.version,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      totalMemoryBytes: totalmem(),
      loadStart: loadavg(),
    },
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
    write();
    return result;
  }

  const scratch = mkdtempSync(join(tmpdir(), 'station-weight-'));
  const instance = `weight-${runId.slice(0, 8)}`;
  const markers = {
    claudeMd: `station-weight-claude-md-${runId}`,
    agentsMd: `station-weight-agents-md-${runId}`,
  };
  const stub = await startStubAnthropic();
  const claudeExecutable = bundledClaudeExecutable();
  const env = scrubbedEnvironment(scratch, stub.url, claudeExecutable);
  const repo = fixtureRepository(scratch, markers);
  const ports = await allocatePorts();
  const api = client(ports.server);
  let started = false;
  let roots = [];
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
    started = true;
    // The UI listener's readiness route is the one the launcher itself
    // trusts: unauthenticated, and `ready` only once the sibling server
    // confirmed its own boot identity. The server's
    // /api/system/identity needs a credential, and unauthenticated polling
    // there trips the auth rate limiter.
    const launcher = { done: false, status: null };
    const startOutcome = startCommand.then((outcome) => {
      launcher.done = true;
      launcher.status = outcome.status;
      launcher.returnedMs = performance.now() - launch;
      return outcome;
    });
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
    result.metrics.serverReadyMs = measured(ready - launch, 'ms', {
      endpoint: 'UI listener /api/system/readiness status:ready',
      launcherReturnedMs: launcher.returnedMs,
    });
    const instanceRecord = JSON.parse(
      readFileSync(
        join(ROOT, '.station/instances', `${instance}.json`),
        'utf8',
      ),
    );
    roots = [instanceRecord.serverPid, instanceRecord.uiPid];
    assert(
      Number.isInteger(instanceRecord.serverPid),
      'instance record has no server pid',
    );
    await api.pair(instanceRecord.baseDir);

    progress(`paired; settling ${settings.settleMs}ms`);
    await wait(settings.settleMs);
    const rest = ownedTree(processTable(), roots);
    result.metrics.restRssBytes = measured(sum(rest, 'rssBytes'), 'bytes', {
      processCount: rest.length,
      processes: processRows(rest),
    });

    const cpuStart = ownedTree(processTable(), roots);
    const switchesStart =
      process.platform === 'linux' ? contextSwitches(cpuStart) : 0;
    const windowStart = performance.now();
    await wait(settings.cpuWindowMs);
    const cpuEnd = ownedTree(processTable(), roots);
    const windowSeconds = (performance.now() - windowStart) / 1000;
    const startCpu = new Map(
      cpuStart.map((row) => [`${row.pid}:${row.started}`, row.cpuSeconds]),
    );
    const cpuSeconds = cpuEnd.reduce(
      (total, row) =>
        total +
        row.cpuSeconds -
        (startCpu.get(`${row.pid}:${row.started}`) ?? 0),
      0,
    );
    result.metrics.idleCpuPercent = measured(
      (cpuSeconds / windowSeconds) * 100,
      'percent of one core',
      { windowSeconds, cpuSeconds, processCount: cpuEnd.length },
    );
    result.metrics.idleWakeups = notMeasured(
      process.platform === 'darwin'
        ? 'macOS exposes per-process wakeups only through powermetrics (root) or libproc; top IDLEW did not advance between samples'
        : 'Linux has no per-process wakeup counter; see idleContextSwitches',
      'count',
    );
    result.metrics.idleContextSwitches =
      process.platform === 'linux'
        ? measured(contextSwitches(cpuEnd) - switchesStart, 'count', {
            note: 'voluntary + involuntary context switches over the window; a proxy, not wakeups',
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
      await wait(settings.settleMs);
      const idle = ownedTree(processTable(), roots);
      result.metrics.idleSessionsRssBytes = measured(
        sum(idle, 'rssBytes'),
        'bytes',
        {
          sessions: sessionIds.length,
          processCount: idle.length,
          processes: processRows(idle),
          note: 'each session was created by one stub-answered turn; no real model call',
        },
      );

      mkdirSync(join(scratch, 'claude-control'), { recursive: true });
      progress('idle-session sample taken; running the control request');
      const controlCalls = await controlRequest({
        cwd: repo,
        env: { ...env, CLAUDE_CONFIG_DIR: join(scratch, 'claude-control') },
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
          },
        );
        result.metrics['request.stationAddedToolDefinitionBytes'] = measured(
          diff.addedToolDefinitionBytes,
          'bytes',
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
      'idleSessionsRssBytes',
    ])
      result.metrics[id] ??= notMeasured(requestGap);
    result.repoRules ??= { status: 'not_measured', reason: requestGap };

    // Leftover after stop: the tree as it stood, then whatever of it lives on.
    progress('stopping');
    const beforeStop = ownedTree(processTable(), roots);
    const stopStart = performance.now();
    await stationOk(['stop', `--instance=${instance}`], {
      env,
      timeoutMs: 120_000,
    });
    started = false;
    result.stopMs = performance.now() - stopStart;
    await wait(settings.stopGraceMs);
    const left = survivors(beforeStop, processTable());
    result.metrics.leftoverAfterStopRssBytes = measured(
      sum(left, 'rssBytes'),
      'bytes',
      {
        processCount: left.length,
        processes: processRows(left),
        afterSeconds: settings.stopGraceMs / 1000,
      },
    );
    for (const row of left) {
      try {
        process.kill(row.pid, 'SIGKILL');
      } catch {
        // Already gone.
      }
    }
    result.outcome = 'completed';
  } catch (error) {
    result.error = error.stack ?? String(error);
  } finally {
    if (started)
      await station(['stop', `--instance=${instance}`], {
        env,
        timeoutMs: 120_000,
      }).catch(() => undefined);
    writeFileSync(
      join(outputDir, 'requests.json'),
      `${JSON.stringify(stub.requests, null, 2)}\n`,
    );
    await stub.close();
    rmSync(scratch, { recursive: true, force: true });
  }

  const baseline = existsSync(baselinePath)
    ? JSON.parse(readFileSync(baselinePath, 'utf8'))
    : undefined;
  result.hostClass = hostClass(result.host);
  result.budgets = evaluateBudgets(result, baseline);
  if (record && result.outcome === 'completed') {
    writeFileSync(
      baselinePath,
      `${JSON.stringify(recordBaseline(result, baseline), null, 2)}\n`,
    );
    result.baselineRecorded = baselinePath;
  }
  write();
  return { ...result, outputDir };
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
  line(`result ${join(result.outputDir ?? '', 'result.json')}`);
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
      cpuWindowMs: number('cpu-window-ms'),
      idleSessions: number('sessions'),
      stopGraceMs: number('stop-grace-ms'),
    }).filter(([, value]) => value !== undefined),
  );
  const result = await runStationWeight({
    out: typeof args.out === 'string' ? args.out : undefined,
    baselinePath:
      typeof args.baseline === 'string'
        ? resolve(args.baseline)
        : DEFAULT_BASELINE_PATH,
    record: args['record-baseline'] === true,
    allowDirty: args['allow-dirty'] === true,
    settings,
  });
  printSummary(result);
  const failed =
    result.outcome === 'failed' ||
    (result.budgets ?? []).some((entry) => entry.verdict === 'FAIL');
  process.exitCode = failed ? 1 : 0;
}
