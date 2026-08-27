#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  assertPackagedStationApp,
  createFixtureHome,
  createRetainedEvidenceSink,
  removeFixtureHome,
  startLoopbackFixture,
} from './lib/browser-preview-packaged-fixture.mjs';

function usage() {
  return `Usage: node scripts/browser-preview-packaged-fixture.mjs [--app /absolute/path/Station.app] [--keep]\n\nUses the current release bundle by default. Creates one temporary STATION_HOME, seeds exactly one Project and Coding layout, launches a numeric-loopback fixture and the supplied packaged Station app. It never uses a development grant path. Press Ctrl-C to stop the app and delete only the owned fixture root; use --keep to retain bounded evidence for review.`;
}

function parseArgs(argv) {
  const options = {
    app: join(
      process.cwd(),
      'src-desktop',
      'target',
      'release',
      'bundle',
      'macos',
      'Station.app',
    ),
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--app') {
      options.app = argv[++index] ?? null;
    } else if (value === '--keep') {
      options.keep = true;
    } else if (value === '--help' || value === '-h') {
      return { help: true };
    } else {
      throw new Error(`Unknown argument: ${value}`);
    }
  }
  if (!isAbsolute(options.app))
    throw new Error('--app must be an absolute path');
  return options;
}

async function reservePort() {
  const listener = createServer();
  await new Promise((resolveListen, rejectListen) => {
    listener.once('error', rejectListen);
    listener.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = listener.address();
  await new Promise((resolveClose, rejectClose) =>
    listener.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
  if (!address || typeof address === 'string')
    throw new Error('Could not reserve a numeric desktop service port.');
  return address.port;
}

export async function waitForProductionIdentity(
  apiBase,
  expected,
  internalApiToken,
  { deadlineMs = 30_000, request = fetch } = {},
) {
  const deadline = Date.now() + deadlineMs;
  let lastFailure = 'no authenticated response';
  while (Date.now() < deadline) {
    try {
      const response = await request(`${apiBase}/api/system/identity`, {
        headers: {
          'x-station-internal-token': internalApiToken,
          'x-station-proxy-caller': 'local',
        },
      });
      if (!response.ok) {
        lastFailure = `HTTP ${response.status}`;
      } else {
        const actual = await response.json();
        if (
          actual?.instanceId === expected.instanceId &&
          actual?.sha === expected.sha &&
          actual?.bootId === expected.bootId
        ) {
          return;
        }
        lastFailure = 'identity mismatch';
      }
    } catch (error) {
      lastFailure = error instanceof Error ? error.name : 'request failed';
      // The packaged sidecar owns startup; keep the retry bounded.
    }
    const retryDelayMs = Math.min(250, Math.max(0, deadline - Date.now()));
    if (retryDelayMs > 0) {
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, retryDelayMs),
      );
    }
  }
  throw new Error(
    `Packaged Station service did not present its expected authenticated identity within ${deadlineMs}ms (${lastFailure}).`,
  );
}

async function stopPackagedApp(child) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise((resolveExit) =>
    child.once('exit', () => resolveExit(true)),
  );
  child.kill('SIGTERM');
  return Promise.race([
    exited,
    new Promise((resolveTimeout) =>
      setTimeout(() => resolveTimeout(false), 5_000),
    ),
  ]);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const packaged = await assertPackagedStationApp(parsed.app);
  const home = await createFixtureHome();
  const loopback = await startLoopbackFixture(home);
  const servicePort = await reservePort();
  const apiBase = `http://127.0.0.1:${servicePort}`;
  const desktopLog = join(home, 'packaged-desktop.ndjson');
  // This is a per-run process capability used by Station's production internal
  // API contract. It is never emitted, persisted, or accepted as a grant.
  const internalApiToken = randomBytes(32).toString('base64url');
  const expectedIdentity = {
    instanceId: `browser-preview-${randomUUID()}`,
    sha: packaged.buildSha,
    bootId: randomUUID(),
  };
  const desktopEvidence = await createRetainedEvidenceSink(desktopLog);
  const appendLog = (stream, chunk) =>
    desktopEvidence.append({
      at: new Date().toISOString(),
      stream,
      text: chunk.toString(),
    });
  const child = spawn(packaged.executable, [], {
    cwd: join(packaged.app, 'Contents', 'Resources'),
    env: {
      ...process.env,
      STATION_HOME: home,
      STATION_DESKTOP_PORT: String(servicePort),
      STATION_LOG_LEVEL: 'info',
      STATION_INTERNAL_API_TOKEN: internalApiToken,
      STATION_INSTANCE_ID: expectedIdentity.instanceId,
      STATION_BUILD_SHA: expectedIdentity.sha,
      STATION_BOOT_ID: expectedIdentity.bootId,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => void appendLog('stdout', chunk));
  child.stderr.on('data', (chunk) => void appendLog('stderr', chunk));
  const manifest = {
    schemaVersion: 1,
    app: basename(packaged.app),
    project: 'browser-preview-fixture',
    startedAt: new Date().toISOString(),
    evidenceLimits: desktopEvidence.stats(),
  };
  try {
    await waitForProductionIdentity(
      apiBase,
      expectedIdentity,
      internalApiToken,
    );
    await writeFile(
      join(home, 'fixture-manifest.json'),
      `${JSON.stringify({ ...manifest, serviceReady: true }, null, 2)}\n`,
      { mode: 0o600 },
    );
  } catch (error) {
    const stopped = await stopPackagedApp(child);
    await loopback.close();
    await desktopEvidence.close();
    if (!parsed.keep && stopped) await removeFixtureHome(home);
    throw error;
  }
  process.stdout.write(
    `${JSON.stringify({ ...manifest, serviceReady: true })}\n`,
  );
  process.stdout.write(
    `Physical record: open Browser Preview in the seeded Coding layout, use ${loopback.endpoint}, then record focus/input, resize/z-order, close, and rediscovery/reopen. Ctrl-C cleans only this fixture root.\n`,
  );
  let closing = false;
  const close = async (signal) => {
    if (closing) return;
    closing = true;
    const stopped = await stopPackagedApp(child);
    await loopback.close().catch(() => {});
    await desktopEvidence.close().catch(() => {});
    if (!parsed.keep && stopped) await removeFixtureHome(home);
    process.stdout.write(
      `Fixture stopped (${signal}). ${parsed.keep || !stopped ? `Evidence retained at ${home}` : 'Owned temporary resources removed.'}\n`,
    );
  };
  process.once('SIGINT', () => void close('SIGINT'));
  process.once('SIGTERM', () => void close('SIGTERM'));
  child.once('exit', (code, signal) => {
    if (!closing) {
      process.stderr.write(
        `Packaged Station exited before fixture shutdown (code=${code}, signal=${signal}).\n`,
      );
      void close('desktop-exit');
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(
      `browser-preview-packaged-fixture: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
