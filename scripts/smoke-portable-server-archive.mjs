#!/usr/bin/env node
// Proves a portable server archive runs on a host with no Node.js on PATH:
// extract it, run its launcher with a scrubbed environment, check the
// launcher's --version comes from the bundled runtime, then `station start`
// through the archive's own CLI on an isolated home and OS-chosen ports,
// probe the API (authenticated) and the UI origin, and `station stop`.
//
//   node scripts/smoke-portable-server-archive.mjs --archive <path> \
//     [--work-dir <dir>] [--long-path] [--keep]
//
// --long-path extracts beneath a deliberately long directory so the deepest
// node_modules file crosses Windows' 260-character MAX_PATH (#2484).
import { spawnSync } from 'node:child_process';
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
import { findFreePortBlock, findFreePortOutside } from './lib/free-ports.mjs';
import {
  archiveTool,
  PORTABLE_ARCHIVE_ROOT,
  readPortableNodeRuntime,
} from './lib/portable-server-archive.mjs';

const WINDOWS = process.platform === 'win32';
const MAX_PATH = 260;
// `station start` itself waits up to its own readiness budget.
const START_TIMEOUT_MS = 300_000;
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

function runLauncher(launcher, args, env, cwd, timeout = 30_000) {
  const { command, args: argv, options } = launcherInvocation(launcher, args);
  const result = spawnSync(command, argv, {
    ...options,
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  });
  const shown = args.map((arg) => arg.replace(cwd, '<home>')).join(' ');
  if (result.error) fail(`station ${shown}: ${result.error}`);
  log(
    `$ station ${shown} -> exit ${result.status}:\n${redact(result.stdout.trim())}`,
  );
  if (result.status !== 0) {
    fail(`launcher exited ${result.status}: ${redact(result.stderr)}`);
  }
  return result.stdout.trim();
}

/** Runs a command that must fail, and returns what it printed. */
function runLauncherExpectingFailure(launcher, args, env, cwd) {
  const { command, args: argv, options } = launcherInvocation(launcher, args);
  const result = spawnSync(command, argv, {
    ...options,
    cwd,
    env,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  const shown = args.map((arg) => arg.replace(cwd, '<home>')).join(' ');
  if (result.error) fail(`station ${shown}: ${result.error}`);
  const output = `${result.stdout}${result.stderr}`.trim();
  log(`$ station ${shown} -> exit ${result.status}:\n${redact(output)}`);
  if (result.status === 0) fail(`station ${shown} was expected to refuse`);
  return output;
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

/** A launch receipt names a single-use sign-in link; never echo the token. */
function redact(text) {
  return text.replace(/(#station-ui-bootstrap=)[^\s]+/g, '$1<redacted>');
}

async function fetchChecked(url, headers = {}) {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) fail(`${url} answered HTTP ${response.status}`);
  return response;
}

async function getJson(url, headers = {}) {
  return (await fetchChecked(url, headers)).json();
}

async function refusesConnections(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2_000),
    });
    return false;
  } catch {
    return true;
  }
}

/**
 * An OS-chosen server block (the server takes port..port+3: HTTP, terminal,
 * voice, consent) and a UI port outside it, none of them the owner's.
 */
async function choosePorts() {
  const serverPort = await findFreePortBlock(4);
  const uiPort = await findFreePortOutside(serverPort, 4);
  for (const port of [0, 1, 2, 3].map((n) => serverPort + n).concat(uiPort)) {
    if (RESERVED_PORTS.has(port)) fail(`refusing reserved port ${port}`);
  }
  return { serverPort, uiPort };
}

/**
 * Boots through the archive's own CLI exactly as a user would: a plain
 * `station start`, with no channel, instance or home given. The launcher
 * takes the channel from the archive, so the CLI picks that channel's home
 * under the (throwaway) HOME and serves the archive's prebuilt dist-server/
 * and dist-ui/, building nothing. Only the ports are explicit (flags and
 * environment): an unset port falls back to a channel default the owner's
 * own Station uses.
 */
async function bootAndProbe({ launcher, env, home, release }) {
  // The home a release of this channel owns (runtime-path-resolver's
  // runtimeInstancePath); a development checkout would pick instances/dev/<id>.
  const stationHome = join(home, '.station', 'instances', release.channel);
  const { serverPort, uiPort } = await choosePorts();
  const lifecycleEnv = {
    ...env,
    STATION_SERVER_PORT: String(serverPort),
    STATION_UI_PORT: String(uiPort),
  };
  let failure;
  try {
    const refused = runLauncherExpectingFailure(
      launcher,
      ['build'],
      lifecycleEnv,
      home,
    );
    if (!refused.includes('prebuilt Station archive')) {
      fail(`station build did not refuse as a prebuilt archive:\n${refused}`);
    }
    // An ephemeral instance first: stopping a --temp-home instance removes
    // the build it owned, and the archive's build is owned by none of them.
    // The plain start below proves it survived.
    const ephemeral = runLauncher(
      launcher,
      ['start', '--temp-home', `--port=${serverPort}`, `--ui-port=${uiPort}`],
      lifecycleEnv,
      home,
      START_TIMEOUT_MS,
    );
    const stopEphemeral = /Stop with: station (stop --instance=\S+)/.exec(
      ephemeral,
    )?.[1];
    if (!stopEphemeral) fail('station start --temp-home named no stop command');
    runLauncher(launcher, stopEphemeral.split(' '), lifecycleEnv, home);
    await waitUntilClosed([serverPort, uiPort]);
    // `stop` leaves the temporary home itself behind; the smoke owns it.
    const temporaryHome = /Station home: (.+) \(--temp-home\)/.exec(
      ephemeral,
    )?.[1];
    if (temporaryHome) rmSync(temporaryHome, { recursive: true, force: true });
    const started = runLauncher(
      launcher,
      ['start', `--port=${serverPort}`, `--ui-port=${uiPort}`],
      lifecycleEnv,
      home,
      START_TIMEOUT_MS,
    );
    const announced = /Station home: (.+) \(/.exec(started)?.[1];
    if (
      !announced ||
      !existsSync(stationHome) ||
      realpathSync(announced) !== realpathSync(stationHome)
    ) {
      fail(
        `station start chose home ${announced}; a ${release.channel} archive owns ${stationHome}`,
      );
    }
    log(`home is the ${release.channel} channel's: ${stationHome}`);
    const live = await getJson(
      `http://127.0.0.1:${serverPort}/api/system/liveness`,
    );
    if (live?.live !== true)
      fail(`server liveness answered ${JSON.stringify(live)}`);
    log(`server live on http://127.0.0.1:${serverPort}`);
    const { credential } = JSON.parse(
      readFileSync(join(stationHome, 'security', 'environment.json'), 'utf8'),
    );
    if (typeof credential !== 'string') {
      fail('server did not persist an operator credential');
    }
    const authorization = { Authorization: `Bearer ${credential}` };
    const status = await getJson(
      `http://127.0.0.1:${serverPort}/api/system/status`,
      authorization,
    );
    log(`/api/system/status 200 (${Object.keys(status).length} fields)`);
    const identity = await getJson(
      `http://127.0.0.1:${serverPort}/api/system/instance`,
      authorization,
    );
    const observed = {
      buildSha: identity.buildSha,
      shaSource: identity.shaSource,
      channel: identity.channel,
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
    // The UI origin must serve the archive's built UI, not the API's own
    // landing page, and proxy the API behind it.
    const page = await (
      await fetchChecked(`http://127.0.0.1:${uiPort}/`)
    ).text();
    if (!page.includes('<div id="root"')) {
      fail(
        `UI port ${uiPort} did not serve dist-ui's index.html:\n${page.slice(0, 400)}`,
      );
    }
    log(
      `UI http://127.0.0.1:${uiPort}/ serves dist-ui index.html (<div id="root">)`,
    );
    const proxied = await getJson(
      `http://127.0.0.1:${uiPort}/api/system/liveness`,
    );
    if (proxied?.live !== true) fail('UI origin does not proxy the API');
    log('UI origin proxies /api/system/liveness to the server');
  } catch (error) {
    failure = error;
  }
  // Stop even after a failed probe, so a smoke never leaves a server behind.
  try {
    runLauncher(launcher, ['stop'], lifecycleEnv, home);
  } catch (error) {
    failure ??= error;
  }
  if (failure) throw failure;
  await waitUntilClosed([serverPort, uiPort]);
}

async function waitUntilClosed(ports) {
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const closed = await Promise.all(ports.map(refusesConnections));
    if (closed.every(Boolean)) {
      log(`stopped: ports ${ports.join(' and ')} refuse connections`);
      return;
    }
    await new Promise((settle) => setTimeout(settle, POLL_MS));
  }
  fail(`server or UI still answering ${STOP_TIMEOUT_MS}ms after station stop`);
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
    const hostMetadata = members.filter((member) =>
      /(?:^|\/)(?:\.DS_Store|\._[^/]*)$/.test(member),
    );
    if (hostMetadata.length > 0) {
      fail(`archive carries build-host metadata: ${hostMetadata.join(', ')}`);
    }
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
    if (
      readFileSync(join(root, 'lib', 'station-cli.mjs'), 'utf8').startsWith(
        '#!',
      )
    ) {
      fail(
        'lib/station-cli.mjs still names an interpreter; it is only imported',
      );
    }
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
    await bootAndProbe({ launcher, env, home, release });
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
