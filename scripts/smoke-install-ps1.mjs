// Windows smoke for install.ps1 (#2675 slice W1): stages two real prebuilt
// Windows archives of this candidate through install.ps1 on a host where no
// Node.js is on PATH, under a Station root long enough that the deepest
// installed path crosses MAX_PATH (#2484).
//
//   node scripts/smoke-install-ps1.mjs --archive1 <zip> --archive2 <zip> --work <dir>
//
// Each archive's descriptor (<zip>.json, written by build:portable-server)
// supplies its release identity. The manifests are signed with a throwaway
// key served through install.ps1's test-only key override (behind
// STATION_INSTALL_ALLOW_INSECURE_TEST_URLS=1), under the pinned key id of the
// archive's ring, and everything is served from a loopback HTTP server.
//
// It proves, on Windows:
//   1. Windows PowerShell 5.1, no Node.js anywhere: install.ps1 downloads the
//      pinned Node.js zip, checks its sha256, and stages archive 1 as a
//      sealed, complete version that runs its bundled Node.js;
//   2. PowerShell 7, with `current` a junction to that version: install.ps1
//      verifies with the installed Station's Node.js and stages archive 2
//      beside it;
//   3. `irm | iex` style (the script text through Invoke-Expression): the
//      active version again is "nothing to do", and the caller's session
//      survives;
//   4. a caller script that runs the text through Invoke-Expression and was
//      itself given an argument: install.ps1 neither exits the caller nor
//      takes the caller's arguments;
//   5. refusals on this host: archive bytes that differ from the signed
//      sha256; a manifest signed by another key; a copy of install.ps1 whose
//      pinned Node.js digest is wrong; and a Station root outside the user
//      profile, whose planted `current\runtime\node.exe` must not run before
//      verification. None stages anything.
//   6. the full install (#2675 slice W2), in a Station root of its own:
//      Windows PowerShell 5.1 installs archive 1 (no Node.js anywhere) on
//      chosen ports, with `current` a junction, the owned station-beta.cmd
//      launcher, schema 4 state and an install root restricted to the user,
//      and Station answers as archive 1; `station-beta.cmd upgrade`, with no
//      manifest URL in its environment, runs the version's install.ps1 with
//      the installed Node.js and Station answers as archive 2 on the same
//      ports; archive 1 again is refused as a downgrade; the installed
//      install.ps1 uninstalls, keeping the data; and an install root another
//      account can write is refused, its Node.js never run.
//   7. a profile path that is not ASCII: the launcher stays ASCII through
//      %USERPROFILE% and runs the installed version, and passes an argument
//      with `^` and `%` unchanged, with the environment it sets.
//   8. the Windows service in the update path (#2675 slice W3), under the
//      real user profile (the service runs with it): `station service
//      install` registers a user-level Task Scheduler task whose cmd.exe
//      wrapper runs the fixed launcher with the node.exe frozen beside it,
//      from the launcher's own directory; a supervisor killed by force is
//      relaunched by the launcher itself (Task Scheduler reruns nothing);
//      `station upgrade` stages archive 2 and hands the switch to the
//      running service, whose launcher trials and commits it while the
//      wrapper keeps running; a staged version whose trial exits is rolled
//      back to archive 2; a request with no version (the server's) is staged
//      by the service through install.ps1 and answered up to date; `service
//      stop` ends the wrapper and the launcher stops Station in order; and
//      `service uninstall` and install.ps1 uninstall remove it all.
// Windows only: it drives powershell.exe, pwsh.exe and NTFS junctions.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { join, resolve, win32 } from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalManifestJson } from '../packages/shared/src/release-manifest.mjs';
import {
  assertWindowsPathsTrusted,
  runWindowsTrustCommand,
} from '../packages/shared/src/windows-path-trust.ts';

const repoRoot = resolve(import.meta.dirname, '..');
const installScript = join(repoRoot, 'install.ps1');
const KEY_IDS = {
  nightly: 'station-portable-nightly-2026-09',
  stable: 'station-portable-release-2026-09',
  preview: 'station-portable-release-2026-09',
};
const RUNTIME = { stable: 'stable', preview: 'beta', nightly: 'nightly' };
// Past MAX_PATH (260), with room to spare.
const LONG_PATH_TARGET = 300;
const RUN_TIMEOUT_MS = 30 * 60_000;

function check(condition, message) {
  if (!condition) throw new Error(`smoke failed: ${message}`);
}

const { values } = parseArgs({
  options: {
    archive1: { type: 'string' },
    archive2: { type: 'string' },
    work: { type: 'string' },
  },
});
check(process.platform === 'win32', 'this smoke runs on Windows only');
for (const name of ['archive1', 'archive2', 'work'])
  check(values[name], `--${name} is required`);

function describeArchive(path) {
  const descriptor = JSON.parse(readFileSync(`${path}.json`, 'utf8'));
  const ring = descriptor.release.releaseChannel;
  return {
    path,
    ring,
    runtime: RUNTIME[ring],
    version: descriptor.release.ref.replace(/^v/, ''),
    tag: descriptor.release.ref,
    sha: descriptor.release.sha,
    sha256: descriptor.sha256,
    size: descriptor.size,
    nodeVersion: descriptor.node.version,
    longest: descriptor.unpacked.longestRelativePath,
  };
}

const first = describeArchive(resolve(values.archive1));
const second = describeArchive(resolve(values.archive2));
check(first.ring === second.ring, 'both archives must be of one ring');
check(first.version !== second.version, 'the archives must be two versions');

const work = resolve(values.work);
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });

// --- served files -------------------------------------------------------------

const served = new Map();
const server = createServer((request, response) => {
  const body = served.get(request.url);
  if (body === undefined) {
    response.statusCode = 404;
    response.end();
    return;
  }
  response.setHeader('content-length', String(body.length));
  response.end(body);
});
await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
const origin = `http://127.0.0.1:${server.address().port}`;

const testKey = generateKeyPairSync('ed25519');
served.set(
  '/test-key.pem',
  Buffer.from(testKey.publicKey.export({ format: 'pem', type: 'spki' })),
);

function publish(name, archive, { bytes, privateKey } = {}) {
  const archivePath = `/${name}.zip`;
  served.set(archivePath, bytes ?? readFileSync(archive.path));
  const payload = {
    schemaVersion: 2,
    channel: archive.ring,
    version: archive.version,
    releaseTag: archive.tag,
    sourceSha: archive.sha,
    publishedAt: new Date('2026-09-29T00:00:00.000Z').toISOString(),
    nodeVersion: archive.nodeVersion,
    launcherProtocol: { min: 1, max: 1 },
    artifacts: [
      {
        os: 'win32',
        arch: 'x64',
        name: 'station-server-win32-x64.zip',
        url: `${origin}${archivePath}`,
        sha256: archive.sha256,
        size: archive.size,
        format: 'zip',
      },
    ],
  };
  const envelope = {
    schemaVersion: 1,
    algorithm: 'ed25519',
    keyId: KEY_IDS[archive.ring],
    payload,
    signature: sign(
      null,
      Buffer.from(canonicalManifestJson(payload)),
      privateKey ?? testKey.privateKey,
    ).toString('base64'),
  };
  served.set(`/${name}.json`, Buffer.from(JSON.stringify(envelope)));
  return `${origin}/${name}.json`;
}

// --- environment ----------------------------------------------------------------

const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
const windowsPowerShell = win32.join(
  systemRoot,
  'System32',
  'WindowsPowerShell',
  'v1.0',
  'powershell.exe',
);
const pwsh = win32.join(
  process.env.ProgramFiles ?? 'C:\\Program Files',
  'PowerShell',
  '7',
  'pwsh.exe',
);
check(existsSync(windowsPowerShell), `${windowsPowerShell} is missing`);
check(existsSync(pwsh), `${pwsh} is missing`);
const PATH = [
  win32.join(systemRoot, 'System32'),
  systemRoot,
  win32.dirname(windowsPowerShell),
  win32.dirname(pwsh),
].join(';');
for (const dir of PATH.split(';'))
  check(
    !existsSync(win32.join(dir, 'node.exe')),
    `node.exe must not be on the smoke PATH, but ${dir} has one`,
  );

const profile = join(work, 'profile');
mkdirSync(profile, { recursive: true });

function environment(stationRoot, manifestUrl, overrides = {}) {
  return {
    SystemRoot: systemRoot,
    windir: systemRoot,
    ComSpec: win32.join(systemRoot, 'System32', 'cmd.exe'),
    PATH,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: profile,
    HOMEDRIVE: process.env.HOMEDRIVE,
    LOCALAPPDATA: process.env.LOCALAPPDATA,
    APPDATA: process.env.APPDATA,
    PSModulePath: '',
    STATION_ROOT: stationRoot,
    STATION_CHANNEL: first.runtime,
    STATION_INSTALL_STAGE_ONLY: '1',
    STATION_INSTALL_PUBLIC_MANIFEST_URL: manifestUrl,
    STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: `${origin}/test-key.pem`,
    STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
    ...overrides,
  };
}

function runAsync(
  program,
  args,
  env,
  cwd = undefined,
  { startsStation = false, verbatim = false } = {},
) {
  // The server answers in this process, so the child must not block it:
  // spawn and wait on its exit rather than spawnSync.
  return new Promise((done) => {
    const child = spawn(program, args, {
      env,
      windowsHide: true,
      cwd,
      // A cmd.exe line quoted by hand, so `^` and `%` reach the launcher.
      windowsVerbatimArguments: verbatim,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    let finished = false;
    const finish = (status, held) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      process.stdout.write(
        `--- ${program} ${args.join(' ')} -> ${status}\n${stdout}${stderr}\n`,
      );
      // Windows PowerShell starts the installer core through .NET, which
      // passes every inheritable handle on, so a Station the run started
      // keeps PowerShell's own output handle, and a caller reading it
      // through a pipe (as here) sees its end only when Station stops: an
      // accepted gap, so a run that starts Station resolves on its exit. Any
      // other run must not leave its output held, and PowerShell itself must
      // always exit (#2675 W2: the installer once kept PowerShell waiting).
      if (held && !startsStation)
        throw new Error(
          'smoke failed: the run exited, but a process it left behind still holds its output open',
        );
      if (held)
        process.stdout.write(
          '(the Station this run started still holds its output; resolved on exit)\n',
        );
      done({ status, stdout, stderr });
    };
    child.on('exit', (status) => {
      setTimeout(() => finish(status, true), 15_000).unref();
    });
    child.on('close', (status) => finish(status, false));
  });
}

function runFile(
  shell,
  env,
  script = installScript,
  args = ['install'],
  options = {},
) {
  return runAsync(
    shell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      script,
      ...args,
    ],
    env,
    undefined,
    options,
  );
}

function lastLine(text) {
  return text.trim().split(/\r?\n/).at(-1);
}

function versionsOf(installRoot) {
  const versions = join(installRoot, 'versions');
  return existsSync(versions) ? readdirSync(versions).sort() : [];
}

function assertStagedVersion(installRoot, archive) {
  const dir = join(installRoot, 'versions', archive.version);
  check(
    readFileSync(join(dir, '.station-install-complete'), 'utf8') ===
      `${archive.sha256}\n`,
    `${dir} has no completion sentinel for ${archive.sha256}`,
  );
  check(existsSync(join(dir, 'install.ps1')), `${dir} carries no install.ps1`);
  check(
    (statSync(join(dir, 'bin', 'station.mjs')).mode & 0o200) === 0,
    `${dir}\\bin\\station.mjs is not read-only`,
  );
  const report = spawnSync(
    join(dir, 'runtime', 'node.exe'),
    [join(dir, 'bin', 'station.mjs'), '--version', '--json'],
    { encoding: 'utf8', windowsHide: true },
  );
  check(report.status === 0, `the staged ${archive.version} did not run`);
  const identity = JSON.parse(report.stdout);
  check(
    identity.ref === archive.tag && identity.node === `v${archive.nodeVersion}`,
    `the staged ${archive.version} reports ${report.stdout}`,
  );
}

function portIsFree(port) {
  return new Promise((done) => {
    const probe = createNetServer();
    probe.once('error', () => done(false));
    probe.listen(port, '127.0.0.1', () => probe.close(() => done(true)));
  });
}

async function identityOf(uiPort) {
  const deadline = Date.now() + 5 * 60_000;
  let last = 'no answer';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${uiPort}/__station/identity`,
      );
      if (response.ok) return await response.json();
      last = `HTTP ${response.status}`;
    } catch (error) {
      last = error.message;
    }
    await new Promise((wait) => setTimeout(wait, 2000));
  }
  throw new Error(`smoke failed: Station never answered on ${uiPort}: ${last}`);
}

async function portClosed(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/__station/identity`);
    return false;
  } catch {
    return true;
  }
}

/** The install root's DACL is the installer core's: this user alone. */
function assertRestrictedToUser(path) {
  assertWindowsPathsTrusted(runWindowsTrustCommand, [
    { kind: 'directory', path },
  ]);
}

// 6. The full install (#2675 W2): install, upgrade through the launcher,
// downgrade refusal, uninstall, and an install root another account can
// write.
/** A user profile's ACL: the user, SYSTEM and Administrators alone. */
function hardenLikeProfile(path) {
  const result = spawnSync(
    win32.join(systemRoot, 'System32', 'icacls.exe'),
    [
      path,
      '/inheritance:r',
      '/grant:r',
      `${process.env.USERNAME}:(OI)(CI)F`,
      '*S-1-5-18:(OI)(CI)F',
      '*S-1-5-32-544:(OI)(CI)F',
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  check(result.status === 0, `icacls failed: ${result.stdout}${result.stderr}`);
}

// 8. The Windows service in the update path (#2675 W3).
const cmdExe = win32.join(systemRoot, 'System32', 'cmd.exe');

function sha256Of(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

async function waitUntil(what, probe, timeoutMs = 5 * 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value) return value;
    await new Promise((wait) => setTimeout(wait, 1000));
  }
  throw new Error(`smoke failed: timed out waiting for ${what}`);
}

/** The pid of a live process, or null once it is gone. */
function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Sets (or, with null, removes) a variable of the user's own environment. */
function userEnvironment(name, value) {
  const reg = win32.join(systemRoot, 'System32', 'reg.exe');
  const result = spawnSync(
    reg,
    value === null
      ? ['delete', 'HKCU\\Environment', '/v', name, '/f']
      : [
          'add',
          'HKCU\\Environment',
          '/v',
          name,
          '/t',
          'REG_SZ',
          '/d',
          value,
          '/f',
        ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (value !== null)
    check(
      result.status === 0,
      `reg add ${name}: ${result.stdout}${result.stderr}`,
    );
}

async function serviceUpdates() {
  // The task runs with the real user profile, and install.ps1 (which the
  // service runs to stage) installs only beneath it.
  const realProfile = process.env.USERPROFILE;
  check(realProfile, 'USERPROFILE is not set');
  const stationRoot = join(realProfile, 'station-w3-smoke');
  rmSync(stationRoot, { recursive: true, force: true });
  const installRoot = join(stationRoot, 'installs', first.runtime);
  const runtime = join(installRoot, 'runtime');
  const home = join(stationRoot, 'instances', first.runtime);
  const binDir = join(stationRoot, 'bin');
  const launcher = join(binDir, `station-${first.runtime}.cmd`);
  const instance = 'w3smoke';
  const taskName = `\\KontourStation-${instance}`;
  const wrapper = join(home, 'service', `station-${instance}.cmd`);
  const serviceLog = join(home, 'logs', `${instance}-service.log`);
  const serverPort = 47241;
  const uiPort = 47100;
  check(
    (await portIsFree(serverPort)) && (await portIsFree(uiPort)),
    'the smoke ports 47241/47100 are in use',
  );
  const env = (manifestUrl, overrides = {}) =>
    environment(stationRoot, manifestUrl, {
      STATION_INSTALL_STAGE_ONLY: '',
      USERPROFILE: realProfile,
      STATION_BIN_DIR: binDir,
      ...overrides,
    });
  const cli = (args, options = {}) =>
    runAsync(
      cmdExe,
      ['/d', '/c', launcher, ...args],
      env(''),
      undefined,
      options,
    );
  const state = () => readJson(join(runtime, 'service-state.json'));
  const launcherPid = () => readJson(join(runtime, 'service-state.lock'))?.pid;
  const currentVersion = () =>
    win32.basename(realpathSync(join(installRoot, 'current')));
  // A service staging for itself runs install.ps1 in the task's own
  // environment, which must carry the test-only key override for the
  // throwaway-signed manifests this smoke serves.
  const taskTestEnvironment = {
    STATION_INSTALL_ALLOW_INSECURE_TEST_URLS: '1',
    STATION_INSTALL_MANIFEST_PUBLIC_KEY_URL: `${origin}/test-key.pem`,
  };
  for (const [name, value] of Object.entries(taskTestEnvironment))
    userEnvironment(name, value);
  try {
    const manifestUrl = publish('w3', first);
    const installed = await runFile(
      windowsPowerShell,
      env(manifestUrl, {
        STATION_INSTALL_SERVER_PORT: String(serverPort),
        STATION_INSTALL_UI_PORT: String(uiPort),
        STATION_INSTALL_NO_START: '1',
      }),
    );
    check(
      installed.status === 0,
      'installing archive 1 for the service failed',
    );

    console.log(
      '== service install: a Task Scheduler task runs the fixed launcher',
    );
    const serviceInstall = await cli(
      [
        'service',
        'install',
        `--instance=${instance}`,
        `--base=${home}`,
        `--port=${serverPort}`,
        `--ui-port=${uiPort}`,
      ],
      { startsStation: true },
    );
    check(serviceInstall.status === 0, '`station service install` failed');
    const wrapperText = readFileSync(wrapper, 'utf8');
    check(
      wrapperText.includes(`cd /d "${runtime}" || exit /b 1`) &&
        wrapperText.includes(
          `"${join(runtime, 'node.exe')}" "${join(runtime, 'station-launcher.mjs')}" "service" "run"`,
        ) &&
        !wrapperText.includes('\\versions\\') &&
        !wrapperText.includes('\\current'),
      `the wrapper does not run the frozen launcher from its own directory:\n${wrapperText}`,
    );
    check(
      sha256Of(join(runtime, 'node.exe')) ===
        sha256Of(
          join(installRoot, 'versions', first.version, 'runtime', 'node.exe'),
        ),
      'runtime\\node.exe is not the installed version node.exe',
    );
    const one = await identityOf(uiPort);
    check(
      one?.sha === first.sha,
      `the service answers as ${JSON.stringify(one)}`,
    );
    check(one.bootId, 'the identity names no boot to tell generations apart');
    check(
      state()?.activeVersion === first.version,
      `unexpected launcher state ${JSON.stringify(state())}`,
    );
    const launcherAtStart = launcherPid();
    check(
      Number.isInteger(launcherAtStart) && alive(launcherAtStart),
      'no live launcher holds the service lock',
    );

    console.log(
      '== a supervisor killed by force is relaunched by its launcher',
    );
    const children = spawnSync(
      windowsPowerShell,
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "ParentProcessId=${launcherAtStart}" | Where-Object { $_.CommandLine -like '*service run*' } | ForEach-Object { $_.ProcessId }`,
      ],
      { encoding: 'utf8', windowsHide: true },
    );
    const supervisors = children.stdout.trim().split(/\s+/).filter(Boolean);
    check(
      supervisors.length === 1,
      `expected one supervisor under the launcher, found: ${children.stdout}${children.stderr}`,
    );
    const killed = spawnSync(
      win32.join(systemRoot, 'System32', 'taskkill.exe'),
      ['/F', '/PID', supervisors[0]],
      { encoding: 'utf8', windowsHide: true },
    );
    check(
      killed.status === 0,
      `taskkill failed: ${killed.stdout}${killed.stderr}`,
    );
    const relaunched = await waitUntil('a new Station generation', async () => {
      const now = await identityOf(uiPort).catch(() => null);
      return now?.bootId && now.bootId !== one.bootId ? now : null;
    });
    check(relaunched.sha === first.sha, 'the relaunch serves another version');
    check(
      launcherPid() === launcherAtStart,
      'the launcher itself was replaced; it should have relaunched its child',
    );
    check(
      readFileSync(serviceLog, 'utf8').includes('relaunching in'),
      'the service log does not show the launcher relaunching',
    );

    console.log('== station upgrade hands archive 2 to the running service');
    publish('w3', second);
    const upgrade = await cli(['upgrade']);
    check(upgrade.status === 0, '`station upgrade` under the service failed');
    check(
      upgrade.stdout.includes(
        `Asked the Station service to switch to ${second.version}`,
      ) &&
        upgrade.stdout.includes(
          `The Station service now runs ${second.version}.`,
        ),
      'the upgrade did not hand the switch to the service launcher',
    );
    const committed = state();
    check(
      committed?.activeVersion === second.version &&
        committed.update?.status === 'committed' &&
        committed.update.fromVersion === first.version,
      `unexpected launcher state ${JSON.stringify(committed)}`,
    );
    check(
      currentVersion() === second.version,
      'current did not follow the commit',
    );
    const two = await identityOf(uiPort);
    check(
      two?.sha === second.sha,
      `after the update the service answers as ${JSON.stringify(two)}`,
    );
    // The same wrapper and launcher ran through the switch.
    check(
      launcherPid() === launcherAtStart,
      'the launcher restarted for the update',
    );

    console.log('== a trial that exits is rolled back');
    const broken = `${second.version.replace(/\.(\d+)$/, (_, n) => `.${Number(n) + 1}`)}`;
    const brokenDir = join(installRoot, 'versions', broken);
    mkdirSync(join(brokenDir, 'bin'), { recursive: true });
    mkdirSync(join(brokenDir, 'runtime'), { recursive: true });
    copyFileSync(
      join(installRoot, 'versions', second.version, 'runtime', 'node.exe'),
      join(brokenDir, 'runtime', 'node.exe'),
    );
    writeFileSync(join(brokenDir, 'bin', 'station.mjs'), 'process.exit(3);\n');
    writeFileSync(
      join(brokenDir, '.station-install-complete'),
      `${'0'.repeat(64)}\n`,
    );
    const request = (targetVersion) => {
      const id = randomUUID();
      const path = join(runtime, 'update-request.json');
      writeFileSync(
        `${path}.smoke`,
        JSON.stringify({
          id,
          requestedAt: new Date().toISOString(),
          ...(targetVersion ? { targetVersion } : {}),
        }),
      );
      renameSync(`${path}.smoke`, path);
      return id;
    };
    const failing = request(broken);
    const rolledBack = await waitUntil('the rollback', () => {
      const update = state()?.update;
      return update?.requestId === failing && update.status !== 'pending'
        ? update
        : null;
    });
    check(
      rolledBack.status === 'rolled-back' &&
        rolledBack.reason === 'candidate-exited:3' &&
        state().activeVersion === second.version,
      `unexpected rollback ${JSON.stringify(state())}`,
    );
    check(
      currentVersion() === second.version,
      'current did not return after the rollback',
    );
    const restored = await waitUntil('archive 2 serving again', async () => {
      const now = await identityOf(uiPort).catch(() => null);
      return now && now.bootId !== two.bootId ? now : null;
    });
    check(
      restored.sha === second.sha,
      `after the rollback the service answers as ${JSON.stringify(restored)}`,
    );

    console.log(
      "== the server's request (no version) is staged by the service with install.ps1",
    );
    const unversioned = request(undefined);
    const answered = await waitUntil('the staging answer', () => {
      const result = readJson(join(runtime, 'update-request-result.json'));
      return result?.requestId === unversioned ? result : null;
    });
    check(
      answered.status === 'up-to-date' && answered.version === second.version,
      `the service's own staging answered ${JSON.stringify(answered)}`,
    );

    console.log(
      '== service stop ends the wrapper; the launcher stops Station in order',
    );
    const stopped = await cli([
      'service',
      'stop',
      `--instance=${instance}`,
      `--base=${home}`,
    ]);
    check(stopped.status === 0, '`station service stop` failed');
    check(
      !existsSync(join(runtime, 'service-state.lock')),
      'the launcher still holds its lock',
    );
    check(!alive(launcherAtStart), 'the launcher outlived `service stop`');
    check(
      await portClosed(uiPort),
      'Station still answers after `service stop`',
    );
    check(
      readFileSync(serviceLog, 'utf8').includes('is gone; stopping'),
      'the launcher did not stop on its own when its wrapper ended',
    );
    const started = await cli(
      ['service', 'start', `--instance=${instance}`, `--base=${home}`],
      { startsStation: true },
    );
    check(started.status === 0, '`station service start` failed');
    const again = await identityOf(uiPort);
    check(
      again?.sha === second.sha,
      `after a restart the service answers as ${JSON.stringify(again)}`,
    );

    console.log('== service uninstall, then install.ps1 uninstall');
    const removed = await cli([
      'service',
      'uninstall',
      `--instance=${instance}`,
      `--base=${home}`,
    ]);
    check(removed.status === 0, '`station service uninstall` failed');
    check(!existsSync(wrapper), 'the uninstall left the wrapper');
    check(
      await portClosed(uiPort),
      'Station still answers after the service uninstall',
    );
    const uninstalled = await runFile(
      windowsPowerShell,
      env(''),
      join(installRoot, 'current', 'install.ps1'),
      ['uninstall'],
    );
    check(
      uninstalled.status === 0,
      'install.ps1 uninstall after the service failed',
    );
    check(!existsSync(installRoot), 'the uninstall left the install root');
  } catch (error) {
    for (const log of [serviceLog, join(home, 'logs', `${instance}.log`)])
      if (existsSync(log))
        process.stdout.write(
          `===== ${log} (last 200 lines) =====\n${readFileSync(log, 'utf8').split(/\r?\n/).slice(-200).join('\n')}\n`,
        );
    process.stdout.write(
      `===== launcher state =====\n${JSON.stringify(state())}\n`,
    );
    throw error;
  } finally {
    const schtasks = win32.join(systemRoot, 'System32', 'schtasks.exe');
    spawnSync(schtasks, ['/End', '/TN', taskName], { windowsHide: true });
    spawnSync(schtasks, ['/Delete', '/TN', taskName, '/F'], {
      windowsHide: true,
    });
    const pid = launcherPid();
    if (Number.isInteger(pid) && alive(pid)) process.kill(pid);
    for (const name of Object.keys(taskTestEnvironment))
      userEnvironment(name, null);
  }
}

// 7. A profile whose path is not ASCII (#2675 W2 review): cmd.exe reads a
// batch file in the OEM code page, so the launcher names its paths through
// %USERPROFILE% and must still run the installed version. A probe standing
// in for bin\station.cmd shows the launcher's environment and that an
// argument with `^` and `%` arrives unchanged (no CALL).
async function nonAsciiProfile() {
  const unicodeProfile = join(work, 'profile-José');
  mkdirSync(unicodeProfile, { recursive: true });
  hardenLikeProfile(unicodeProfile);
  const stationRoot = join(unicodeProfile, '.station');
  const installed = await runFile(
    windowsPowerShell,
    environment(stationRoot, publish('w2-unicode', first), {
      USERPROFILE: unicodeProfile,
      STATION_INSTALL_STAGE_ONLY: '',
      STATION_INSTALL_NO_START: '1',
    }),
  );
  check(installed.status === 0, 'install under a non-ASCII profile failed');
  const launcher = join(
    unicodeProfile,
    '.local',
    'bin',
    `station-${first.runtime}.cmd`,
  );
  const text = readFileSync(launcher, 'utf8');
  check(
    /^[\x20-\x7e\r\n]*$/.test(text) && text.includes('%USERPROFILE%'),
    `the launcher is not ASCII through %USERPROFILE%:\n${text}`,
  );
  // The probe below swaps the hand-over line, so the real one is checked
  // here: no CALL anywhere, and the hand-over is the last line.
  const handOver = text.trimEnd().split('\r\n').at(-1) ?? '';
  check(
    !/^\s*@?call\b/im.test(text) &&
      /^"[^"]+\\station\.cmd" %\*$/.test(handOver),
    `the launcher hands over through CALL or not last:\n${text}`,
  );
  // Only what a fresh console has: no STATION_* variables.
  const bare = {
    SystemRoot: systemRoot,
    windir: systemRoot,
    ComSpec: win32.join(systemRoot, 'System32', 'cmd.exe'),
    PATH,
    PATHEXT: '.COM;.EXE;.BAT;.CMD',
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
    USERPROFILE: unicodeProfile,
  };
  const cmd = win32.join(systemRoot, 'System32', 'cmd.exe');
  const version = await runAsync(
    cmd,
    ['/d', '/c', launcher, '--version'],
    bare,
  );
  check(
    version.status === 0 && version.stdout.includes(`Station ${first.tag}`),
    'the launcher under a non-ASCII profile did not run the installed version',
  );

  const node = join(
    stationRoot,
    'installs',
    first.runtime,
    'versions',
    first.version,
    'runtime',
    'node.exe',
  );
  const probeScript = join(work, 'launcher-probe.js');
  writeFileSync(
    probeScript,
    'process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), root: process.env.STATION_ROOT, channel: process.env.STATION_CHANNEL }));\n',
  );
  const probe = join(work, 'launcher-probe.cmd');
  // Through %USERPROFILE% as the launcher does: a batch file cannot name
  // the non-ASCII profile literally.
  writeFileSync(
    probe,
    `@"%USERPROFILE%${node.slice(unicodeProfile.length)}" "${probeScript}" %*\r\n`,
  );
  const lines = text.split('\r\n');
  const last = lines.findIndex((line) => line.endsWith('station.cmd" %*'));
  check(last > 0, 'the launcher has no hand-over line');
  lines[last] = `"${probe}" %*`;
  const probed = join(work, 'launcher-probed.cmd');
  writeFileSync(probed, lines.join('\r\n'));
  const argument = 'x^y%STATION_NO_SUCH%z';
  const run = await runAsync(
    cmd,
    ['/d', '/s', '/c', `""${probed}" "${argument}""`],
    bare,
    undefined,
    { verbatim: true },
  );
  check(run.status === 0, 'the probed launcher failed');
  const seen = JSON.parse(lastLine(run.stdout));
  check(
    seen.argv.length === 1 && seen.argv[0] === argument,
    `the launcher changed the argument: ${JSON.stringify(seen.argv)}`,
  );
  check(
    seen.root === stationRoot && seen.channel === first.runtime,
    `the launcher's environment: ${JSON.stringify(seen)}`,
  );
}

async function fullInstall() {
  const stationRoot = join(profile, 'w2');
  const installRoot = join(stationRoot, 'installs', first.runtime);
  const home = join(stationRoot, 'instances', first.runtime);
  const launcher = join(
    profile,
    '.local',
    'bin',
    `station-${first.runtime}.cmd`,
  );
  // Station derives its terminal, voice and consent ports from the server
  // port (+1..+3), so the two are chosen far apart, off every channel's
  // defaults, and checked free.
  const serverPort = 47141;
  const uiPort = 47000;
  check(
    (await portIsFree(serverPort)) && (await portIsFree(uiPort)),
    'the smoke ports 47141/47000 are in use',
  );
  const full = (manifestUrl, overrides = {}) =>
    environment(stationRoot, manifestUrl, {
      STATION_INSTALL_STAGE_ONLY: '',
      ...overrides,
    });
  const manifestUrl = publish('w2', first);

  const install = await runFile(
    windowsPowerShell,
    full(manifestUrl, {
      STATION_INSTALL_SERVER_PORT: String(serverPort),
      STATION_INSTALL_UI_PORT: String(uiPort),
    }),
    installScript,
    ['install'],
    { startsStation: true },
  );
  check(install.status === 0, 'full install (Windows PowerShell 5.1) failed');
  check(
    install.stdout.includes('Downloading Node.js'),
    'the full install did not verify with the pinned Node.js',
  );
  const current = join(installRoot, 'current');
  check(
    lstatSync(current).isSymbolicLink(),
    'current is not a junction after the install',
  );
  check(
    realpathSync(current) ===
      realpathSync(join(installRoot, 'versions', first.version)),
    `current names ${realpathSync(current)}`,
  );
  const launcherText = readFileSync(launcher, 'utf8');
  check(
    launcherText.includes('rem station-owned-launcher-v2\r\n') &&
      launcherText.includes(
        `\r\n"%USERPROFILE%${join(installRoot, 'current', 'bin', 'station.cmd').slice(profile.length)}" %*\r\n`,
      ),
    `the launcher is not the owned one:\n${launcherText}`,
  );
  const state = JSON.parse(
    readFileSync(join(installRoot, '.station-release-state.json'), 'utf8'),
  );
  check(
    state.schemaVersion === 4 &&
      state.manifestUrl === manifestUrl &&
      state.serverPort === serverPort &&
      state.uiPort === uiPort,
    `unexpected install state ${JSON.stringify(state)}`,
  );
  assertRestrictedToUser(installRoot);
  const one = await identityOf(uiPort);
  check(one?.sha === first.sha, `Station answers as ${JSON.stringify(one)}`);

  // The same URL now publishes archive 2; the upgrade finds it through the
  // recorded state, not the environment, and keeps the recorded ports.
  publish('w2', second);
  const upgrade = await runAsync(
    win32.join(systemRoot, 'System32', 'cmd.exe'),
    ['/d', '/c', launcher, 'upgrade'],
    full(''),
    undefined,
    { startsStation: true },
  );
  check(upgrade.status === 0, '`station upgrade` through the launcher failed');
  check(
    upgrade.stdout.includes('Using the Node.js of the installed Station'),
    'the upgrade did not verify with the installed Node.js',
  );
  check(
    realpathSync(current) ===
      realpathSync(join(installRoot, 'versions', second.version)),
    `after the upgrade current names ${realpathSync(current)}`,
  );
  check(
    existsSync(join(installRoot, 'versions', first.version)),
    'the upgrade removed the previous version (the rollback target)',
  );
  const two = await identityOf(uiPort);
  check(
    two?.sha === second.sha,
    `after the upgrade Station answers as ${JSON.stringify(two)}`,
  );

  const downgrade = await runFile(
    windowsPowerShell,
    full(publish('w2-old', first)),
  );
  check(
    downgrade.status === 1,
    `a downgrade: expected exit 1, got ${downgrade.status}`,
  );
  check(
    downgrade.stderr.includes(
      `Station install failed: refusing to downgrade Station from ${second.tag} to ${first.tag}`,
    ),
    'a downgrade: expected the downgrade refusal',
  );
  check(
    realpathSync(current) ===
      realpathSync(join(installRoot, 'versions', second.version)),
    'the refused downgrade moved current',
  );

  const uninstall = await runFile(
    windowsPowerShell,
    full(''),
    join(installRoot, 'current', 'install.ps1'),
    ['uninstall'],
  );
  check(
    uninstall.status === 0,
    'uninstall with the installed install.ps1 failed',
  );
  check(!existsSync(installRoot), 'uninstall left the install root');
  check(!existsSync(launcher), 'uninstall left the launcher');
  check(existsSync(home), 'uninstall removed the data');
  check(await portClosed(uiPort), 'Station still answers after uninstall');

  // An install root another account can write: its Node.js must not run,
  // and the core refuses the root.
  const loose = join(profile, 'w2-loose');
  const looseRoot = join(loose, 'installs', first.runtime);
  const seeded = await runFile(
    windowsPowerShell,
    environment(loose, publish('w2-loose', first), {
      STATION_INSTALL_STAGE_ONLY: '',
      STATION_INSTALL_NO_START: '1',
      STATION_BIN_DIR: join(loose, 'bin'),
    }),
  );
  check(seeded.status === 0, 'installing the root to loosen failed');
  const grant = spawnSync(
    win32.join(systemRoot, 'System32', 'icacls.exe'),
    [looseRoot, '/grant', '*S-1-5-32-545:(OI)(CI)M'],
    { encoding: 'utf8', windowsHide: true },
  );
  check(grant.status === 0, `icacls failed: ${grant.stdout}${grant.stderr}`);
  const refused = await runFile(
    windowsPowerShell,
    environment(loose, publish('w2-loose-2', second), {
      STATION_INSTALL_STAGE_ONLY: '',
      STATION_INSTALL_NO_START: '1',
      STATION_BIN_DIR: join(loose, 'bin'),
    }),
  );
  check(
    refused.status === 1,
    `a loosened root: expected exit 1, got ${refused.status}`,
  );
  check(
    !refused.stdout.includes('Using the Node.js of the installed Station'),
    'a loosened root: its Node.js ran before verification',
  );
  check(
    refused.stderr.includes('is not restricted to your account'),
    'a loosened root: expected the permission refusal',
  );
  check(
    !existsSync(join(looseRoot, 'versions', second.version)),
    'a loosened root: a version was staged in it',
  );
  // The way out the refusal names: a fresh install.ps1 uninstalls the
  // loosened root without running anything from it, then installs again.
  const looseEnv = (manifest) =>
    environment(loose, manifest, {
      STATION_INSTALL_STAGE_ONLY: '',
      STATION_INSTALL_NO_START: '1',
      STATION_BIN_DIR: join(loose, 'bin'),
    });
  const removed = await runFile(
    windowsPowerShell,
    looseEnv(''),
    installScript,
    ['uninstall'],
  );
  check(removed.status === 0, 'uninstalling the loosened root failed');
  check(
    !removed.stdout.includes('Using the Node.js of the installed Station'),
    'uninstalling the loosened root ran its Node.js',
  );
  check(
    removed.stderr.includes('removed without running anything from it'),
    'uninstalling the loosened root did not say it ran nothing from it',
  );
  check(!existsSync(looseRoot), 'uninstall left the loosened root');
  const reinstalled = await runFile(
    windowsPowerShell,
    looseEnv(publish('w2-loose-3', second)),
  );
  check(
    reinstalled.status === 0,
    'installing again after the uninstall failed',
  );
  assertRestrictedToUser(looseRoot);
}

try {
  // A user profile grants only the user, SYSTEM and Administrators (the
  // runner's temporary directory may grant more); the launcher directory
  // beneath it must not be writable by anyone else.
  hardenLikeProfile(profile);
  // Long enough that versions\<v>\<deepest path> crosses MAX_PATH.
  const suffix = `\\installs\\${first.runtime}\\versions\\${first.version}\\`;
  // Beneath the (smoke's) user profile: install.ps1 refuses any other root
  // until it checks install-root permissions (#2675 W2).
  const base = join(profile, 'r');
  const pad = Math.max(
    1,
    LONG_PATH_TARGET - (base.length + 1 + suffix.length + first.longest),
  );
  const stationRoot = join(base, 'p'.repeat(Math.min(pad, 200)));
  const installRoot = join(stationRoot, 'installs', first.runtime);
  check(
    stationRoot.length + suffix.length + first.longest > 260,
    'the Station root is not long enough to cross MAX_PATH',
  );
  console.log(
    `Station root ${stationRoot.length} characters; deepest installed path about ${stationRoot.length + suffix.length + first.longest}.`,
  );

  // 1. Windows PowerShell 5.1, no Node.js anywhere: the pinned zip.
  const one = await runFile(
    windowsPowerShell,
    environment(stationRoot, publish('first', first)),
  );
  check(one.status === 0, 'stage 1 (Windows PowerShell 5.1) failed');
  check(
    one.stdout.includes('Downloading Node.js'),
    'stage 1 did not verify with the pinned Node.js',
  );
  check(
    lastLine(one.stdout) === `STATION_STAGED_VERSION=${first.version}`,
    'stage 1 did not report the staged version last',
  );
  assertStagedVersion(installRoot, first);
  check(
    !existsSync(join(installRoot, 'current')),
    'stage-only created current',
  );

  // 2. PowerShell 7 with `current` a junction: the installed Node.js.
  symlinkSync(
    join(installRoot, 'versions', first.version),
    join(installRoot, 'current'),
    'junction',
  );
  const two = await runFile(
    pwsh,
    environment(stationRoot, publish('second', second)),
  );
  check(two.status === 0, 'stage 2 (PowerShell 7) failed');
  check(
    two.stdout.includes('Using the Node.js of the installed Station'),
    'stage 2 did not verify with the installed Node.js',
  );
  check(
    lastLine(two.stdout) === `STATION_STAGED_VERSION=${second.version}`,
    'stage 2 did not report the staged version last',
  );
  assertStagedVersion(installRoot, second);
  check(
    versionsOf(installRoot).join(' ') ===
      [first.version, second.version].sort().join(' '),
    `stage 2 left ${versionsOf(installRoot).join(' ')}`,
  );

  // 3. Invoke-Expression, as `irm <url> | iex` runs it.
  const three = await runAsync(
    windowsPowerShell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `Invoke-Expression ([IO.File]::ReadAllText('${installScript.replaceAll("'", "''")}')); Write-Output 'SESSION-ALIVE'`,
    ],
    environment(stationRoot, publish('again', first)),
  );
  check(three.status === 0, 'stage 3 (Invoke-Expression) failed');
  check(
    three.stdout.includes(
      `Station ${first.tag} is already installed; nothing to do.`,
    ) && three.stdout.includes(`STATION_STAGED_VERSION=${first.version}`),
    'stage 3 did not find the active version already installed',
  );
  check(
    lastLine(three.stdout) === 'SESSION-ALIVE',
    'Invoke-Expression ended the calling session',
  );

  // 4. A caller script, given its own argument, that runs install.ps1's text
  // through Invoke-Expression: install.ps1 must not take the caller's
  // argument (a usage error) nor exit the caller (the marker is lost).
  const setup = join(work, 'setup.ps1');
  // The first line records what text run through Invoke-Expression sees of
  // its caller ($PSCommandPath and $args), so the log shows why the gating
  // in install.ps1 matters (or does not) on each PowerShell.
  writeFileSync(
    setup,
    [
      `Invoke-Expression 'Write-Output ("IEX-SEES PSCommandPath=[" + $PSCommandPath + "] args=[" + ($args -join ",") + "]")'`,
      `Invoke-Expression ([IO.File]::ReadAllText('${installScript.replaceAll("'", "''")}'))`,
      "Write-Output 'SETUP-CONTINUED'",
      '',
    ].join('\r\n'),
  );
  for (const shell of [windowsPowerShell, pwsh]) {
    const four = await runFile(
      shell,
      environment(stationRoot, publish('caller', first)),
      setup,
      ['--caller-only-argument'],
    );
    check(four.status === 0, `the caller script failed under ${shell}`);
    check(
      four.stdout.includes(
        `Station ${first.tag} is already installed; nothing to do.`,
      ),
      `the caller script did not run the installer under ${shell}`,
    );
    check(
      lastLine(four.stdout) === 'SETUP-CONTINUED',
      `install.ps1 ended the caller script under ${shell}`,
    );
    check(
      !four.stderr.includes('unexpected argument') &&
        !four.stderr.includes('usage:'),
      `install.ps1 took the caller's argument under ${shell}`,
    );
  }

  // A relative root, after Set-Location to a directory outside the profile
  // that holds a planted current\runtime\node.exe, while the process
  // directory is the profile: .NET would resolve the root inside the profile
  // and PowerShell outside it. install.ps1 must refuse the root before it
  // looks for any Node.js.
  const elsewhere = join(work, 'elsewhere');
  const plantedInstall = join(elsewhere, 'rel-root', 'installs', first.runtime);
  mkdirSync(plantedInstall, { recursive: true });
  symlinkSync(
    join(installRoot, 'versions', first.version),
    join(plantedInstall, 'current'),
    'junction',
  );
  const relative = await runAsync(
    windowsPowerShell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Set-Location -LiteralPath '${elsewhere.replaceAll("'", "''")}'; & '${installScript.replaceAll("'", "''")}' install; exit $LASTEXITCODE`,
    ],
    environment('rel-root', publish('relative', first)),
    profile,
  );
  check(
    relative.status === 1,
    `a relative root: expected exit 1, got ${relative.status}`,
  );
  check(
    relative.stderr.includes(
      'Station install failed: STATION_ROOT must be an absolute path: rel-root',
    ),
    'a relative root: expected the absolute-path refusal',
  );
  check(
    !relative.stdout.includes('Using the Node.js of the installed Station') &&
      !relative.stdout.includes('Downloading Node.js'),
    'a relative root: a Node.js was looked for before the refusal',
  );

  // 5. Refusals on this host; each uses a fresh root and stages nothing.
  const tampered = Buffer.from(readFileSync(first.path));
  tampered[Math.floor(tampered.length / 2)] ^= 0x01;
  const refusals = [
    {
      name: 'bytes that differ from the signed sha256',
      manifest: publish('tampered', first, { bytes: tampered }),
      message: 'release checksum did not match',
    },
    {
      name: 'a manifest signed by another key',
      manifest: publish('rogue', first, {
        privateKey: generateKeyPairSync('ed25519').privateKey,
      }),
      message: 'public ecosystem manifest signature did not verify',
    },
  ];
  // A copy of install.ps1 whose pinned Node.js digest is wrong: the
  // downloaded zip must be refused before its node.exe runs. (No production
  // override exists; only an edited copy can do this.)
  const badPin = join(work, 'install-bad-pin.ps1');
  const pristineScript = readFileSync(installScript, 'utf8');
  const pinLine = /^\$PinnedNodeSha256 = '[0-9a-f]{64}'$/m;
  check(pinLine.test(pristineScript), 'install.ps1 has no pinned digest line');
  writeFileSync(
    badPin,
    pristineScript.replace(pinLine, `$PinnedNodeSha256 = '${'0'.repeat(64)}'`),
  );
  refusals.push({
    name: 'a pinned Node.js zip that does not match its digest',
    manifest: publish('bad-pin', first),
    message: 'node-v',
    script: badPin,
    stderrIncludes: 'does not match its pinned sha256',
  });
  // A Station root outside the profile, with a `current` whose
  // runtime\node.exe is planted there (a real Node.js here, standing in for
  // one another local user wrote): the script must not run it, and the core
  // must refuse the root.
  const outside = join(work, 'outside');
  const outsideInstall = join(outside, 'installs', first.runtime);
  mkdirSync(outsideInstall, { recursive: true });
  symlinkSync(
    join(installRoot, 'versions', first.version),
    join(outsideInstall, 'current'),
    'junction',
  );
  refusals.push({
    name: 'a Station root outside the user profile',
    manifest: publish('outside', first),
    message: 'on Windows, install.ps1 installs only beneath your user profile',
    root: outside,
    forbidStdout: 'Using the Node.js of the installed Station',
  });
  for (const [index, refusal] of refusals.entries()) {
    const root = refusal.root ?? join(profile, `refused-${index}`);
    const result = await runFile(
      windowsPowerShell,
      environment(root, refusal.manifest),
      refusal.script,
    );
    check(
      result.status === 1,
      `${refusal.name}: expected exit 1, got ${result.status}`,
    );
    check(
      result.stderr.includes(`Station install failed: ${refusal.message}`),
      `${refusal.name}: expected "${refusal.message}"`,
    );
    if (refusal.stderrIncludes)
      check(
        result.stderr.includes(refusal.stderrIncludes),
        `${refusal.name}: expected "${refusal.stderrIncludes}"`,
      );
    if (refusal.forbidStdout)
      check(
        !result.stdout.includes(refusal.forbidStdout),
        `${refusal.name}: printed "${refusal.forbidStdout}"`,
      );
    check(
      versionsOf(join(root, 'installs', first.runtime)).length === 0,
      `${refusal.name}: something was staged`,
    );
  }
  await fullInstall();
  await nonAsciiProfile();
  await serviceUpdates();
  console.log('install.ps1 smoke passed.');
} finally {
  server.close();
}
