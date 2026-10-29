#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { cpus, loadavg, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as idleWait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { execFileSyncBounded } from '../lib/bounded-capture.mjs';
import { findFreePortBlock } from '../lib/free-ports.mjs';
import { invokedDirectly } from '../lib/module-entry.mjs';
import {
  captureOwnedProcessOutput,
  executeOwnedProcess,
  terminateSuiteExecution,
  waitForSuiteSettlement,
} from '../lib/owned-process.mjs';
import { STATION_SERVER_EXTERNALS } from '../lib/server-build-config.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../..');
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const git = (root, ...args) =>
  execFileSyncBounded('git', args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
const digest = (path) =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

async function stop(owned) {
  const result = await terminateSuiteExecution(owned, {
    processLabel: 'server scenario',
    terminationGraceMs: 5000,
    terminationForceMs: 5000,
    waitForSuiteSettlement,
  });
  assert(
    result.settled && !result.errors.length,
    `process cleanup failed: ${JSON.stringify(result)}`,
  );
  return result;
}

async function command(root, args, env, signal, timeoutMs = 180_000) {
  signal?.throwIfAborted();
  const owned = executeOwnedProcess(
    process.execPath,
    args,
    undefined,
    'scenario setup',
    { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  const output = captureOwnedProcessOutput(owned);
  const onAbort = () => {
    void owned.forceTerminate();
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  const timer = setTimeout(() => {
    void owned.forceTerminate();
  }, timeoutMs);
  try {
    const result = await owned.completion;
    signal?.throwIfAborted();
    const captured = output.finish();
    assert.equal(result.status, 0, `setup failed: ${captured.stderr.text}`);
    assert(
      !captured.truncated && !captured.invalidUtf8,
      'setup output incomplete',
    );
    return captured.stdout.text;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    await stop(owned);
  }
}

function children(pid) {
  const rows = execFileSyncBounded('ps', ['-A', '-o', 'pid=,ppid='], {
    encoding: 'utf8',
    windowsHide: true,
  })
    .trim()
    .split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number));
  const ids = new Set([pid]);
  let previous;
  do {
    previous = ids.size;
    for (const [child, parent] of rows) if (ids.has(parent)) ids.add(child);
  } while (ids.size !== previous);
  return ids.size - 1;
}

/**
 * @typedef {{ elapsedMs: number, cpuMs: number, requests: number, rssBytes: number, eventLoopDelayMs: { samples: number, p50: number|null, p99: number|null, max: number|null }, latencyMs?: number, eventCount?: number, imageCount?: number, sessionCount?: number, hasMore?: boolean, childProcessCount?: number }} ScenarioPhase
 * @typedef {{ outcome: string, spawnToReadyMs: number, spawnToBootMs: number, fixture: { sessions: number, events: number, images: number }, phases: Record<string, ScenarioPhase>, cleanup: { settled: boolean } }} ServerScenarioReceipt
 */

/**
 * A failed HTTP read or incomplete fixture never becomes a timing sample.
 * @param {{ root?: string, out?: string, sessions?: number, turns?: number, images?: number, idleMs?: number, allowDirty?: boolean }} options
 * @returns {Promise<ServerScenarioReceipt>}
 */
export async function runServerScenario({
  root = ROOT,
  out,
  sessions = 1000,
  turns = 2500,
  images = 20,
  idleMs = 60_000,
  allowDirty = false,
} = {}) {
  assert(
    ['darwin', 'linux'].includes(process.platform),
    'scenario requires POSIX ps (Linux/macOS)',
  );
  for (const [name, value] of Object.entries({
    sessions,
    turns,
    images,
    idleMs,
  }))
    assert(Number.isSafeInteger(value) && value > 0, `invalid ${name}`);
  assert(images <= turns, 'images must fit the turn count');
  root = resolve(root);
  const sha = git(root, 'rev-parse', 'HEAD');
  const dirty = git(root, 'status', '--porcelain');
  assert(
    allowDirty || !dirty,
    'commit first: scenario requires a clean source tree',
  );
  const runId = randomUUID();
  const outputDir = resolve(
    out ?? join(ROOT, '.kontourai/server-scenario', sha, runId),
  );
  mkdirSync(outputDir, { recursive: true });
  const scratch = mkdtempSync(join(tmpdir(), 'station-server-scenario-'));
  const home = join(scratch, 'instances', 'scenario');
  const generated = join(root, '.kontourai/server-scenario-build', runId);
  mkdirSync(generated, { recursive: true });
  const port = await findFreePortBlock(4);
  assert(![3000, 3141].some((p) => p >= port && p < port + 4), 'reserved port');
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    HOME: join(scratch, 'user'),
    TMPDIR: scratch,
    DOTENV_CONFIG_PATH: join(scratch, 'no-inherited-dotenv'),
    STATION_ROOT: scratch,
    STATION_HOME: home,
    STATION_INSTANCE_ID: `perf-${runId}`,
    PORT: String(port),
    MCP_UI_FRAME_PORT: String(port + 2),
    STATION_STDOUT_HANDSHAKE: '1',
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
  };
  for (const path of [
    home,
    env.HOME,
    env.CODEX_HOME,
    env.CLAUDE_CONFIG_DIR,
    env.STATION_EXTERNAL_OPENCODE_SOURCE_ROOT,
    env.STATION_EXTERNAL_GROK_SOURCE_ROOT,
  ])
    mkdirSync(path, { recursive: true });
  const receipt = {
    schemaVersion: 1,
    scenario: 'station-server-v1',
    sourceRevision: sha,
    harnessRevision: git(ROOT, 'rev-parse', 'HEAD'),
    harnessDigest: createHash('sha256')
      .update(
        [
          'server-scenario.mjs',
          'server-scenario-probe.mjs',
          'server-scenario-seed.mjs',
        ]
          .map((name) => digest(join(HERE, name)))
          .join(':'),
      )
      .digest('hex'),
    harnessDirty: Boolean(git(ROOT, 'status', '--porcelain')),
    dirty: Boolean(dirty),
    runId,
    startedAt: new Date().toISOString(),
    outcome: 'failed',
    host: {
      platform: platform(),
      release: release(),
      arch: process.arch,
      node: process.version,
      cpus: cpus().length,
      cpuModel: cpus()[0]?.model,
      totalMemoryBytes: totalmem(),
      loadStart: loadavg(),
    },
    workload: {
      sessions,
      turns,
      images,
      idleMs,
      engine: 'deterministic-canonical-event-tape',
      turnDispatch: false,
    },
    instrumentation: {
      eventLoopResolutionMs: 1,
      idle: 'process.cpuUsage delta; no HTTP polling',
      startup:
        'spawn to structured listening handshake; excludes build and seed',
      latency: 'HTTP round trip through full JSON body parse',
      childCount: 'all descendants from ps snapshot; excludes server itself',
    },
    phases: {},
  };
  let owned;
  let capture;
  const controller = new AbortController();
  const onSignal = () => {
    controller.abort(Error('scenario interrupted'));
    if (owned) void owned.forceTerminate();
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    // Always rebuild the selected tree: a stale dist-server must not acquire
    // the current checkout SHA simply because it already exists on disk.
    const npmCli = process.env.npm_execpath;
    assert(npmCli, 'run through npm run perf:server-scenario');
    await command(
      root,
      [npmCli, 'run', 'build:server'],
      {
        ...process.env,
        STATION_BUILD_SERVER_DIR: generated,
      },
      controller.signal,
    );
    const serverPath = join(generated, 'command-station.js');
    receipt.serverBundleSha256 = digest(serverPath);
    const seedPath = join(generated, 'seed.mjs');
    await build({
      entryPoints: [join(HERE, 'server-scenario-seed.mjs')],
      outfile: seedPath,
      bundle: true,
      platform: 'node',
      format: 'esm',
      external: STATION_SERVER_EXTERNALS,
      alias: {
        '@scenario/event-store': join(
          root,
          'src-server/services/orchestration/event-store.ts',
        ),
        '@scenario/database-path': join(
          root,
          'src-server/domain/migrations/003-orchestration-events.ts',
        ),
        '@scenario/principal': join(
          root,
          'src-server/services/identity/principal-resolver.ts',
        ),
      },
      banner: {
        js: "import { createRequire as __scenarioCreateRequire } from 'node:module'; const require = __scenarioCreateRequire(import.meta.url);",
      },
    });
    const spawned = performance.now();
    owned = executeOwnedProcess(
      process.execPath,
      ['--import', join(HERE, 'server-scenario-probe.mjs'), serverPath],
      undefined,
      'real Station scenario',
      { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
    );
    controller.signal.throwIfAborted();
    capture = captureOwnedProcessOutput(owned);
    const server = owned.child;
    let sequence = 0;
    const probe = (action) =>
      new Promise((done, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          server.off('message', onMessage);
          reject(Error(`probe ${action} timed out`));
        }, 30_000);
        function onMessage(value) {
          if (value?.type !== 'server-scenario-probe' || value.id !== id)
            return;
          clearTimeout(timer);
          server.off('message', onMessage);
          const { type: _type, id: _id, ...sample } = value;
          done(sample);
        }
        server.on('message', onMessage);
        server.send({ type: 'server-scenario-probe', id, action });
      });
    await new Promise((done, reject) => {
      let buffer = '';
      const timer = setTimeout(
        () => finish(Error('structured readiness handshake timed out')),
        120_000,
      );
      const onData = (chunk) => {
        buffer += chunk;
        const lines = buffer.split('\n');
        buffer = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('{')) continue;
          let value;
          try {
            value = JSON.parse(line);
          } catch {
            continue;
          }
          if (value.event === 'listening') {
            if (value.port !== port)
              return finish(Error('readiness port mismatch'));
            receipt.spawnToReadyMs = performance.now() - spawned;
            finish();
          }
        }
      };
      const finish = (error) => {
        clearTimeout(timer);
        server.stdout.off('data', onData);
        error ? reject(error) : done();
      };
      server.stdout.on('data', onData);
      owned.completion.then((result) =>
        finish(
          Error(
            `server exited before scenario completed: ${JSON.stringify(result)}`,
          ),
        ),
      );
    });
    receipt.phases.startup = await probe('sample');
    const api = `http://127.0.0.1:${port}`;
    let credential;
    const call = async (path, body) => {
      const response = await fetch(`${api}${path}`, {
        method: body ? 'POST' : 'GET',
        headers: {
          'content-type': 'application/json',
          ...(credential ? { authorization: `Bearer ${credential}` } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(60_000),
        ]),
      });
      const text = await response.text();
      assert(
        response.ok,
        `${path}: HTTP ${response.status}: ${text.slice(0, 300)}`,
      );
      const json = JSON.parse(text);
      assert(json.success !== false, `${path}: unsuccessful payload`);
      return { json, bytes: Buffer.byteLength(text) };
    };
    const phase = async (name, action) => {
      await probe('reset');
      const start = performance.now();
      const facts = await action();
      const elapsedMs = performance.now() - start;
      // Let a pending histogram tick observe a synchronous request stall.
      await sleep(5);
      receipt.phases[name] = {
        ...(await probe('sample')),
        latencyMs: elapsedMs,
        ...facts,
      };
    };
    await phase('homeBoot', async () => {
      const grant = await call('/.well-known/station/v1/pairing/local-grant', {
        secret: readFileSync(
          join(home, 'runtime/local-grant.secret'),
          'utf8',
        ).trim(),
        deviceName: 'server-scenario',
        clientInstanceId: runId,
      });
      credential = grant.json.credential;
      assert(credential, 'local grant must issue credential');
      const start = performance.now();
      const boot = await call('/api/boot');
      receipt.spawnToBootMs = performance.now() - spawned;
      assert.equal(boot.json.version, 1, 'Home boot version');
      for (const name of [
        'auth',
        'config',
        'capabilities',
        'branding',
        'agents',
        'projects',
        'models',
      ])
        assert(
          boot.json.sections?.[name] && !boot.json.sections[name].error,
          `Home boot section ${name} unavailable`,
        );
      return {
        bootLatencyMs: performance.now() - start,
        responseBytes: boot.bytes,
      };
    });
    const seedOutput = await command(
      root,
      [seedPath, JSON.stringify({ home, sessions, turns, images })],
      env,
      controller.signal,
    );
    receipt.fixture = JSON.parse(seedOutput.trim().split('\n').at(-1));
    assert.equal(receipt.fixture.sessions, sessions, 'seeded session count');
    await phase('idle', async () => {
      await idleWait(idleMs, undefined, { signal: controller.signal });
      return { childProcessCount: children(server.pid) };
    });
    await phase('sessionDetail', async () => {
      const response = await call('/api/orchestration/sessions/perf-history');
      assert.equal(
        response.json.data?.events?.length,
        1 + turns * 4,
        'detail must reach seeded history',
      );
      const media = response.json.data.events.flatMap(
        (event) => event.attachments ?? [],
      );
      assert.equal(media.length, images, 'detail must reach seeded images');
      assert(
        media.every(
          (image) =>
            image.blobRef &&
            image.dataUrl?.startsWith('data:image/png;base64,'),
        ),
        'detail must hydrate real image blobs',
      );
      return {
        eventCount: response.json.data.events.length,
        imageCount: media.length,
        responseBytes: response.bytes,
      };
    });
    await phase('eventWindow', async () => {
      const response = await call(
        '/api/orchestration/sessions/perf-history/event-window?turnLimit=20',
      );
      const data = response.json.data;
      assert.equal(data?.session?.threadId, 'perf-history', 'window identity');
      assert(data.events.length > 0, 'transcript window must contain history');
      assert.equal(data.hasMore, turns > 20, 'transcript must be paginated');
      const media = data.events.flatMap((row) => row.event.attachments ?? []);
      assert.equal(
        media.length,
        Math.min(images, 20),
        'transcript must reach seeded images',
      );
      assert(
        media.every((image) => image.blobRef && !image.dataUrl),
        'window must contain projected image references',
      );
      return {
        eventCount: data.events.length,
        imageCount: media.length,
        hasMore: data.hasMore,
        responseBytes: response.bytes,
      };
    });
    await phase('sessionList', async () => {
      const response = await call('/api/orchestration/sessions/read-model');
      assert.equal(
        response.json.data?.filter((s) => s.threadId.startsWith('perf-'))
          .length,
        sessions,
        'read model must reach seeded sessions',
      );
      return {
        sessionCount: response.json.data.length,
        responseBytes: response.bytes,
      };
    });
    receipt.afterWorkload = {
      ...(await probe('sample')),
      childProcessCount: children(server.pid),
    };
    assert.equal(
      git(root, 'rev-parse', 'HEAD'),
      sha,
      'source SHA changed during scenario',
    );
    assert.equal(
      git(root, 'status', '--porcelain'),
      dirty,
      'source tree changed during scenario',
    );
    receipt.outcome = 'completed';
  } catch (error) {
    receipt.error = error.stack ?? String(error);
    throw error;
  } finally {
    try {
      if (owned) receipt.cleanup = await stop(owned);
    } catch (error) {
      receipt.outcome = 'failed';
      receipt.cleanupError = error.stack ?? String(error);
    } finally {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (capture) {
        const logs = capture.finish();
        writeFileSync(join(outputDir, 'server.stdout.log'), logs.stdout.text);
        writeFileSync(join(outputDir, 'server.stderr.log'), logs.stderr.text);
        if (logs.truncated || logs.invalidUtf8) {
          receipt.outcome = 'failed';
          receipt.logCaptureIncomplete = true;
        }
      }
      receipt.host.loadEnd = loadavg();
      writeFileSync(
        join(outputDir, 'receipt.json'),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      rmSync(scratch, { recursive: true, force: true });
      rmSync(generated, { recursive: true, force: true });
      console.log(
        `Server scenario receipt: ${join(outputDir, 'receipt.json')}`,
      );
    }
  }
  assert.equal(receipt.outcome, 'completed', 'scenario incomplete');
  return receipt;
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
  await runServerScenario({
    root: args.root,
    out: args.out,
    allowDirty: args['allow-dirty'] === true,
  });
}
