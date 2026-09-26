#!/usr/bin/env node
// Proves a portable server archive runs on a host with no Node.js on PATH:
// extract it, run its launcher with a scrubbed environment, check the
// launcher's --version comes from the bundled runtime, then boot the server
// on an isolated home and an OS-assigned port, probe it authenticated, and
// stop it.
//
//   node scripts/smoke-portable-server-archive.mjs --archive <path> \
//     [--work-dir <dir>] [--long-path] [--keep]
//
// --long-path extracts beneath a deliberately long directory so the deepest
// node_modules file crosses Windows' 260-character MAX_PATH (#2484).
import { spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  highestSymbolVersion,
  symbolVersionFloor,
} from './lib/elf-symbol-floor.mjs';
import { runWindowsTaskkill } from './lib/owned-process.mjs';
import {
  archiveTool,
  PORTABLE_ARCHIVE_ROOT,
  readPortableNodeRuntime,
} from './lib/portable-server-archive.mjs';

const WINDOWS = process.platform === 'win32';
const MAX_PATH = 260;
const READY_TIMEOUT_MS = 90_000;
const STOP_TIMEOUT_MS = 20_000;
const POLL_MS = 250;
// Ports the owner's own Stations use; a smoke must never answer on them.
const RESERVED_PORTS = new Set([3000, 3141, 18141, 28141, 38141, 38000]);

const { values } = parseArgs({
  options: {
    archive: { type: 'string' },
    'work-dir': { type: 'string' },
    'long-path': { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
  strict: true,
});

function fail(message) {
  throw new Error(message);
}

function log(message) {
  console.log(`[portable-smoke] ${message}`);
}

/**
 * The environment of a host that never installed Node.js: only the base OS
 * directories on PATH and a throwaway HOME. Nothing is inherited.
 */
function scrubbedEnvironment(home) {
  if (!WINDOWS) return { HOME: home, PATH: '/usr/bin:/bin' };
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  return {
    SystemRoot: systemRoot,
    windir: systemRoot,
    ComSpec: join(systemRoot, 'System32', 'cmd.exe'),
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    PATH: `${join(systemRoot, 'System32')};${systemRoot}`,
    USERPROFILE: home,
    HOME: home,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TEMP: join(home, 'Temp'),
    TMP: join(home, 'Temp'),
  };
}

function assertNoNodeOnPath(env) {
  const probe = WINDOWS
    ? spawnSync(join(env.SystemRoot, 'System32', 'where.exe'), ['node'], {
        env,
        encoding: 'utf8',
        windowsHide: true,
      })
    : spawnSync('/bin/sh', ['-c', 'command -v node'], {
        env,
        encoding: 'utf8',
        windowsHide: true,
      });
  if (probe.error) fail(`could not probe PATH for node: ${probe.error}`);
  if (probe.status === 0) {
    fail(
      `a node is resolvable on the scrubbed PATH (${probe.stdout.trim()}); this host cannot prove the archive runs without one`,
    );
  }
  log(`no node on PATH=${env.PATH} (probe exit ${probe.status})`);
}

function launcherInvocation(launcher, args) {
  // Node refuses to spawn a .cmd directly; run it through cmd.exe exactly as
  // a user's shell would.
  return WINDOWS
    ? {
        command: join(
          process.env.SystemRoot ?? 'C:\\Windows',
          'System32',
          'cmd.exe',
        ),
        // `/s` strips exactly one outer pair of quotes, so wrap the quoted
        // launcher path and its arguments in one more, as Node's own
        // `shell: true` does.
        args: ['/d', '/s', '/c', `""${launcher}" ${args.join(' ')}"`],
        options: { windowsVerbatimArguments: true },
      }
    : { command: launcher, args, options: {} };
}

function runLauncher(launcher, args, env, cwd) {
  const { command, args: argv, options } = launcherInvocation(launcher, args);
  const result = spawnSync(command, argv, {
    ...options,
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    windowsHide: true,
  });
  if (result.error) fail(`${launcher} ${args.join(' ')}: ${result.error}`);
  log(
    `$ station ${args.join(' ')} -> exit ${result.status}: ${result.stdout.trim()}`,
  );
  if (result.status !== 0) {
    fail(`launcher exited ${result.status}: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** A directory whose deepest archive member lands past MAX_PATH. */
function longExtractionRoot(base, longestMember) {
  const launcherTail = `${sep}${PORTABLE_ARCHIVE_ROOT}${sep}runtime${sep}node.exe`;
  // Leave the runtime itself launchable: only node_modules must cross.
  const ceiling = MAX_PATH - launcherTail.length - 16;
  const wanted = MAX_PATH + 10 - longestMember;
  const length = Math.min(Math.max(wanted, base.length + 20), ceiling);
  let root = base;
  let index = 0;
  while (root.length < length) {
    root = join(root, `long-install-root-segment-${index}`);
    index += 1;
  }
  return root;
}

function archiveMembers(archive) {
  const listing = spawnSync(archiveTool(), ['-tf', archive], {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    windowsHide: true,
  });
  if (listing.status !== 0) fail(`cannot list ${archive}: ${listing.stderr}`);
  return listing.stdout.split(/\r?\n/).filter(Boolean);
}

function extract(archive, destination) {
  mkdirSync(destination, { recursive: true });
  const result = spawnSync(archiveTool(), ['-xf', archive, '-C', destination], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    fail(`extracting into ${destination} failed: ${result.stderr}`);
  }
}

function readinessPort(output) {
  for (const line of output.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event?.event === 'listening' && Number.isInteger(event.port)) {
        return event.port;
      }
    } catch {
      // Ordinary startup logs share stdout with the handshake.
    }
  }
  return undefined;
}

async function getJson(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) fail(`${url} answered HTTP ${response.status}`);
  return response.json();
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode };
  }
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(null), timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
  });
}

async function bootAndProbe({ launcher, env, home, cwd, release }) {
  const { command, args, options } = launcherInvocation(launcher, []);
  const child = spawn(command, args, {
    ...options,
    cwd,
    env: {
      ...env,
      PORT: '0',
      STATION_STDOUT_HANDSHAKE: '1',
      STATION_HOME: join(home, 'station-home'),
      STATION_HOST: '127.0.0.1',
      STATION_INSTANCE_ID: 'portable-smoke',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  const collect = (chunk) => {
    output = `${output}${chunk}`.slice(-64 * 1024);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const tail = () => output.split(/\r?\n/).slice(-40).join('\n');
  try {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    let port;
    while (Date.now() < deadline) {
      if (child.exitCode !== null || child.signalCode !== null) {
        fail(
          `server exited early (code ${child.exitCode}, signal ${child.signalCode}):\n${tail()}`,
        );
      }
      port ??= readinessPort(output);
      if (port !== undefined) {
        if (RESERVED_PORTS.has(port))
          fail(`server bound reserved port ${port}`);
        try {
          const live = await getJson(
            `http://127.0.0.1:${port}/api/system/liveness`,
          );
          if (live?.live === true) break;
        } catch {
          // Still starting.
        }
      }
      await new Promise((settle) => setTimeout(settle, POLL_MS));
    }
    if (port === undefined || Date.now() >= deadline) {
      fail(`server was not live within ${READY_TIMEOUT_MS}ms:\n${tail()}`);
    }
    log(`live on http://127.0.0.1:${port} (pid ${child.pid})`);
    const { credential } = JSON.parse(
      readFileSync(
        join(home, 'station-home', 'security', 'environment.json'),
        'utf8',
      ),
    );
    if (typeof credential !== 'string') {
      fail('server did not persist an operator credential');
    }
    const authorization = { Authorization: `Bearer ${credential}` };
    const status = await getJson(
      `http://127.0.0.1:${port}/api/system/status`,
      authorization,
    );
    log(`/api/system/status 200 (${Object.keys(status).length} fields)`);
    const instance = await getJson(
      `http://127.0.0.1:${port}/api/system/instance`,
      authorization,
    );
    const observed = {
      buildSha: instance.buildSha,
      shaSource: instance.shaSource,
      channel: instance.channel,
    };
    log(`/api/system/instance ${JSON.stringify(observed)}`);
    // The served bundle must be the one this archive's provenance names.
    if (observed.buildSha !== release.sha) {
      fail(`status buildSha ${observed.buildSha} is not ${release.sha}`);
    }
    if (observed.shaSource !== 'build-stamp') {
      fail(`status shaSource is ${observed.shaSource}, not build-stamp`);
    }
    if (observed.channel !== release.channel) {
      fail(`status channel ${observed.channel} is not ${release.channel}`);
    }
  } catch (error) {
    await stop(child);
    throw error;
  }
  const exit = await stop(child);
  if (!exit)
    fail(`server did not stop within ${STOP_TIMEOUT_MS}ms:\n${tail()}`);
  log(`stopped: code ${exit.code}, signal ${exit.signal}`);
  // POSIX launchers exec node, so SIGTERM reaches the server itself and a
  // graceful shutdown exits 0. Windows has no SIGTERM; the tree is killed.
  if (!WINDOWS && exit.code !== 0) {
    fail(`server exited ${exit.code} after SIGTERM:\n${tail()}`);
  }
}

/** Stops the server and waits for it; a stuck server is killed outright. */
async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) {
    if (WINDOWS) await runWindowsTaskkill(child.pid, true);
    else child.kill('SIGTERM');
  }
  const exit = await waitForExit(child, STOP_TIMEOUT_MS);
  if (!exit) {
    child.kill('SIGKILL');
    await waitForExit(child, STOP_TIMEOUT_MS);
  }
  return exit;
}

function isElf(path) {
  const fd = openSync(path, 'r');
  try {
    const magic = Buffer.alloc(4);
    return (
      readSync(fd, magic, 0, 4, 0) === 4 &&
      magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
    );
  } finally {
    closeSync(fd);
  }
}

/**
 * Reports the oldest glibc/libstdc++ a Linux host needs to run every ELF
 * object in the archive: the bundled node and each native module. A report,
 * not a gate; the supported floor is a product decision.
 */
function reportLinuxLibcFloor(root) {
  const objects = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && isElf(path)) {
        objects.push({
          path: path.slice(root.length + 1),
          glibc: symbolVersionFloor(path, 'GLIBC'),
          glibcxx: symbolVersionFloor(path, 'GLIBCXX'),
        });
      }
    }
  }
  for (const object of objects) {
    log(
      `libc floor ${object.glibc ?? '-'} ${object.glibcxx ?? '-'} ${object.path}`,
    );
  }
  const floor = {
    elfObjects: objects.length,
    glibc: highestSymbolVersion(objects.map((object) => object.glibc)),
    glibcxx: highestSymbolVersion(objects.map((object) => object.glibcxx)),
  };
  log(`libc floor ${JSON.stringify(floor)}`);
  return floor;
}

async function main() {
  if (!values.archive) fail('--archive is required');
  const archive = resolve(values.archive);
  if (!existsSync(archive)) fail(`${archive} does not exist`);
  const runtime = readPortableNodeRuntime();
  const work = values['work-dir']
    ? resolve(values['work-dir'])
    : mkdtempSync(join(tmpdir(), 'station-portable-smoke-'));
  mkdirSync(work, { recursive: true });
  try {
    const members = archiveMembers(archive);
    const longestMember = Math.max(...members.map((member) => member.length));
    const extractRoot = values['long-path']
      ? longExtractionRoot(join(work, 'x'), longestMember)
      : join(work, 'x');
    extract(archive, extractRoot);
    const root = realpathSync(join(extractRoot, PORTABLE_ARCHIVE_ROOT));
    log(
      `extracted ${members.length} entries to ${extractRoot} (${extractRoot.length} chars; deepest path ${extractRoot.length + 1 + longestMember} chars)`,
    );
    const release = JSON.parse(
      readFileSync(join(root, '.station-release.json'), 'utf8'),
    );
    if (process.platform === 'linux') reportLinuxLibcFloor(root);
    const launcher = join(root, 'bin', WINDOWS ? 'station.cmd' : 'station');
    const home = join(work, 'home');
    const env = scrubbedEnvironment(home);
    mkdirSync(env.TEMP ?? home, { recursive: true });
    mkdirSync(env.APPDATA ?? home, { recursive: true });
    mkdirSync(env.LOCALAPPDATA ?? home, { recursive: true });
    assertNoNodeOnPath(env);

    runLauncher(launcher, ['--version'], env, home);
    const identity = JSON.parse(
      runLauncher(launcher, ['--version', '--json'], env, home),
    );
    if (identity.node !== `v${runtime.version}`) {
      fail(`launcher ran Node ${identity.node}, not v${runtime.version}`);
    }
    if (!realpathSync(identity.execPath).startsWith(`${root}${sep}`)) {
      fail(`launcher ran ${identity.execPath}, outside the archive ${root}`);
    }
    if (identity.ref !== release.ref || identity.sha !== release.sha) {
      fail('launcher identity does not match .station-release.json');
    }
    if (identity.platform !== `${process.platform}-${process.arch}`) {
      fail(`archive reports ${identity.platform} on this host`);
    }
    await bootAndProbe({ launcher, env, home, cwd: home, release });
    log('PASS');
  } finally {
    if (!values.keep) {
      try {
        rmSync(work, { recursive: true, force: true, maxRetries: 5 });
      } catch (error) {
        // Never let cleanup mask the smoke's own verdict.
        console.error(`[portable-smoke] could not remove ${work}: ${error}`);
      }
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(
    `[portable-smoke] FAIL: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
