#!/usr/bin/env node
/**
 * Conversation continuation benchmark (#2540).
 *
 * Boots a REAL Station server on an isolated home and free port, then drives
 * one conversation per engine through a first turn and N follow-ups on the
 * same routes the CLI and app use (`POST /api/orchestration/chat`, then
 * `/chat/:conversationId/continue`). For every turn it records:
 *
 *   - acceptance and first-text latency, and total turn time;
 *   - the engine processes descending from the server, and their RSS, sampled
 *     after the turn settles;
 *   - the execution Session the turn ran in (a new one per follow-up is the
 *     child-per-turn model this issue replaces);
 *   - failures, with the server's own error text.
 *
 * It measures; it asserts nothing. Real engines spend real tokens: the prompt
 * asks for a one-word answer and the default is three follow-ups.
 *
 *   node scripts/bench/conversation-continuation-bench.mjs \
 *     --engines=codex,claude --followups=3 [--out=bench.json] [--keep]
 *
 * Requires built `dist-server/` (`npm run build:server`).
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findFreePort } from '../lib/free-ports.mjs';
import { invokedDirectly } from '../lib/module-entry.mjs';
import { executeOwnedProcess } from '../lib/owned-process.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const [key, value] = arg.replace(/^--/, '').split('=');
    return [key, value ?? 'true'];
  }),
);
const ENGINES = (args.engines ?? 'codex,claude').split(',').filter(Boolean);
const FOLLOWUPS = Number(args.followups ?? 3);
const TURN_TIMEOUT_MS = Number(args.timeout ?? 180_000);
const PROMPT = 'Reply with exactly one word: OK';

const log = (...a) => console.error('[bench]', ...a);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Every process descending from `rootPid` in `ps -o pid=,ppid=,rss=,command=`
 * output, with RSS in KiB.
 */
export function descendantProcesses(psOutput, rootPid) {
  const rows = psOutput
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, rss, command]) => ({
      pid: Number(pid),
      ppid: Number(ppid),
      rss: Number(rss),
      command,
    }));
  const children = new Map();
  for (const row of rows) {
    if (!children.has(row.ppid)) children.set(row.ppid, []);
    children.get(row.ppid).push(row);
  }
  const out = [];
  const stack = [...(children.get(rootPid) ?? [])];
  while (stack.length) {
    const row = stack.pop();
    out.push(row);
    stack.push(...(children.get(row.pid) ?? []));
  }
  return out;
}

function processTree(rootPid) {
  return descendantProcesses(
    execFileSync('ps', ['-A', '-o', 'pid=,ppid=,rss=,command='], {
      encoding: 'utf8',
      windowsHide: true,
    }),
    rootPid,
  );
}

function sampleProcesses(serverPid) {
  const tree = processTree(serverPid);
  return {
    count: tree.length,
    rssMb: Math.round(tree.reduce((sum, row) => sum + row.rss, 0) / 1024),
    // Direct children are the engine processes the adapters spawn.
    engines: tree
      .filter((row) => row.ppid === serverPid)
      .map((row) => row.command.split(/\s+/).slice(0, 3).join(' ')),
  };
}

async function main() {
  if (!existsSync(join(ROOT, 'dist-server/command-station.js'))) {
    throw new Error('dist-server is not built: run `npm run build:server`.');
  }
  const port = await findFreePort();
  const api = `http://127.0.0.1:${port}`;
  const root = mkdtempSync(join(tmpdir(), 'station-continuation-bench-'));
  const home = join(root, 'instances', 'bench');
  mkdirSync(home, { recursive: true });
  const workdir = join(root, 'work');
  mkdirSync(workdir, { recursive: true });
  execFileSync('git', ['init', '-q', workdir], { windowsHide: true });

  // Owned process group: engines the server spawns die with it.
  const owned = executeOwnedProcess(
    process.execPath,
    ['dist-server/command-station.js'],
    undefined,
    'station bench server',
    {
      cwd: ROOT,
      env: {
        ...process.env,
        STATION_ROOT: root,
        STATION_HOME: home,
        PORT: String(port),
        MCP_UI_FRAME_PORT: '0',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const server = owned.child;
  let serverLog = '';
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));

  const results = { engines: {}, startedAt: new Date().toISOString() };
  const abort = new AbortController();
  try {
    // The server writes its per-boot local-grant secret once it is up.
    const secretPath = join(home, 'runtime', 'local-grant.secret');
    for (let i = 0; i < 120 && !existsSync(secretPath); i += 1)
      await sleep(500);
    if (!existsSync(secretPath)) {
      throw new Error(
        `server never wrote ${secretPath}\n${serverLog.slice(-800)}`,
      );
    }
    // The secret can land before the listener is up; retry the exchange.
    let grant;
    for (let i = 0; i < 120 && !grant; i += 1) {
      grant = await fetch(`${api}/.well-known/station/v1/pairing/local-grant`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          secret: readFileSync(secretPath, 'utf8').trim(),
          deviceName: 'continuation-bench',
          clientInstanceId: crypto.randomUUID(),
        }),
      }).catch(() => undefined);
      if (!grant) await sleep(500);
    }
    if (!grant?.ok) {
      throw new Error(
        `local-grant ${grant?.status ?? 'unreachable'}\n${serverLog.slice(-800)}`,
      );
    }
    const { credential } = await grant.json();
    const auth = { authorization: `Bearer ${credential}` };
    const call = async (method, path, body) => {
      const res = await fetch(`${api}${path}`, {
        method,
        headers: { ...auth, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = { raw: text.slice(0, 400) };
      }
      return { status: res.status, json };
    };

    // One event stream for the whole run; turns look their events up by id.
    const events = [];
    const stream = await fetch(`${api}/api/orchestration/events`, {
      headers: auth,
      signal: abort.signal,
    });
    if (!stream.ok) throw new Error(`event stream ${stream.status}`);
    (async () => {
      const decoder = new TextDecoder();
      let buffer = '';
      for await (const chunk of stream.body) {
        buffer += decoder.decode(chunk, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const parsed = JSON.parse(line.slice(5).trim());
              const event = parsed?.event ?? parsed;
              events.push({ at: performance.now(), event });
            } catch {}
          }
        }
      }
    })().catch(() => {});

    // Engine agents are discovered after boot; wait until each is listed.
    let slugs = [];
    for (let i = 0; i < 120; i += 1) {
      const agents = (await call('GET', '/api/agents')).json;
      const list = agents?.data ?? agents;
      slugs = Array.isArray(list) ? list.map((agent) => agent.slug) : [];
      if (ENGINES.every((engine) => slugs.includes(engine))) break;
      await sleep(1000);
    }
    log('agents:', slugs.join(', '));

    for (const engine of ENGINES) {
      const record = { turns: [], sessions: new Set() };
      results.engines[engine] = record;
      const conversationId = `bench:${engine}:${Date.now()}`;
      for (let turn = 0; turn <= FOLLOWUPS; turn += 1) {
        if (
          turn > 0 &&
          !record.turns.some((row) => row.turn === 0 && !row.error)
        ) {
          break;
        }
        let started = performance.now();
        const send = () =>
          turn === 0
            ? call('POST', '/api/orchestration/chat', {
                target: {
                  environment: { kind: 'current' },
                  agent: engine,
                  workspace: { kind: 'directory', cwd: workdir },
                },
                message: PROMPT,
                conversationId,
              })
            : call(
                'POST',
                `/api/orchestration/chat/${encodeURIComponent(conversationId)}/continue`,
                { environment: { kind: 'current' }, message: PROMPT },
              );
        let response = await send();
        // A catalog refresh after boot is transient; the server says so.
        for (
          let retry = 0;
          retry < 20 && /refreshing/i.test(JSON.stringify(response.json ?? ''));
          retry += 1
        ) {
          await sleep(1000);
          started = performance.now();
          response = await send();
        }
        const accepted = performance.now();
        const receipt = response.json?.data ?? response.json;
        const sessionId = receipt?.sessionId;
        const turnId = receipt?.providerTurnId;
        const row = {
          turn,
          status: response.status,
          sessionId,
          acceptMs: Math.round(accepted - started),
        };
        if (response.status >= 300 || !sessionId || !turnId) {
          row.error =
            receipt?.error ?? response.json?.error ?? JSON.stringify(receipt);
          record.turns.push(row);
          log(engine, `turn ${turn} FAILED`, row.error);
          continue;
        }
        record.sessions.add(sessionId);
        const mine = (entry) =>
          entry.at >= started &&
          entry.event?.threadId === sessionId &&
          (entry.event?.turnId === undefined || entry.event.turnId === turnId);
        let terminal;
        const deadline = started + TURN_TIMEOUT_MS;
        while (!terminal && performance.now() < deadline) {
          terminal = events.find(
            (entry) =>
              mine(entry) &&
              ['turn.completed', 'turn.aborted', 'runtime.error'].includes(
                entry.event.method,
              ),
          );
          if (!terminal) await sleep(100);
        }
        const firstText = events.find(
          (entry) => mine(entry) && entry.event.method === 'content.text-delta',
        );
        row.firstTextMs = firstText ? Math.round(firstText.at - started) : null;
        row.totalMs = terminal ? Math.round(terminal.at - started) : null;
        row.outcome = terminal?.event.method ?? 'timeout';
        if (terminal?.event.method === 'runtime.error') {
          row.error = terminal.event.message;
        }
        // Let exits and reaping settle before sampling.
        await sleep(1500);
        row.processes = sampleProcesses(server.pid);
        record.turns.push(row);
        log(
          engine,
          `turn ${turn}: ${row.outcome} first-text=${row.firstTextMs}ms total=${row.totalMs}ms session=${sessionId.slice(-12)} procs=${row.processes.count} rss=${row.processes.rssMb}MB`,
        );
      }
      record.sessions = [...record.sessions];
    }
    results.finalProcesses = sampleProcesses(server.pid);
  } finally {
    abort.abort();
    await owned.forceTerminate().catch(() => {});
    await owned.completion;
    if (args.keep !== 'true') rmSync(root, { recursive: true, force: true });
  }

  results.summary = summarize(results.engines);
  const json = JSON.stringify(results, null, 2);
  if (args.out) writeFileSync(args.out, json);
  console.log(json);
}

/** Per-engine follow-up outcome, sessions used, and peak process footprint. */
export function summarize(engines) {
  return Object.fromEntries(
    Object.entries(engines).map(([engine, record]) => {
      const followups = record.turns.filter((row) => row.turn > 0);
      const ok = followups.filter((row) => row.outcome === 'turn.completed');
      const median = (values) => {
        const sorted = values
          .filter((v) => typeof v === 'number')
          .sort((a, b) => a - b);
        return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
      };
      return [
        engine,
        {
          followups: followups.length,
          followupFailures: followups.length - ok.length,
          sessionsUsed: record.sessions.length,
          medianFollowupFirstTextMs: median(ok.map((row) => row.firstTextMs)),
          medianFollowupTotalMs: median(ok.map((row) => row.totalMs)),
          maxProcesses: Math.max(
            0,
            ...record.turns.map((row) => row.processes?.count ?? 0),
          ),
          maxRssMb: Math.max(
            0,
            ...record.turns.map((row) => row.processes?.rssMb ?? 0),
          ),
        },
      ];
    }),
  );
}

if (invokedDirectly(import.meta.url)) {
  main().catch((error) => {
    console.error('[bench] FAIL', error?.stack ?? error);
    process.exit(1);
  });
}
