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
//   4. refusals on this host: archive bytes that differ from the signed
//      sha256, and a manifest signed by another key; neither stages anything.
// Windows only: it drives powershell.exe, pwsh.exe and NTFS junctions.
import { spawn, spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { join, resolve, win32 } from 'node:path';
import { parseArgs } from 'node:util';
import { canonicalManifestJson } from '../packages/shared/src/release-manifest.mjs';

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

function environment(stationRoot, manifestUrl) {
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
  };
}

function runAsync(program, args, env) {
  // The server answers in this process, so the child must not block it:
  // spawn and wait on its exit rather than spawnSync.
  return new Promise((done) => {
    const child = spawn(program, args, { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => child.kill(), RUN_TIMEOUT_MS);
    child.on('close', (status) => {
      clearTimeout(timer);
      process.stdout.write(
        `--- ${program} ${args.join(' ')} -> ${status}\n${stdout}${stderr}\n`,
      );
      done({ status, stdout, stderr });
    });
  });
}

function runFile(shell, env) {
  return runAsync(
    shell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      installScript,
      'install',
    ],
    env,
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

try {
  // Long enough that versions\<v>\<deepest path> crosses MAX_PATH.
  const suffix = `\\installs\\${first.runtime}\\versions\\${first.version}\\`;
  const base = join(work, 'r');
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

  // 4. Refusals on this host; each uses a fresh root and stages nothing.
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
  for (const [index, refusal] of refusals.entries()) {
    const root = join(work, `refused-${index}`);
    const result = await runFile(
      windowsPowerShell,
      environment(root, refusal.manifest),
    );
    check(
      result.status === 1,
      `${refusal.name}: expected exit 1, got ${result.status}`,
    );
    check(
      result.stderr.includes(`Station install failed: ${refusal.message}`),
      `${refusal.name}: expected "${refusal.message}"`,
    );
    check(
      versionsOf(join(root, 'installs', first.runtime)).length === 0,
      `${refusal.name}: something was staged`,
    );
  }
  console.log('install.ps1 smoke passed.');
} finally {
  server.close();
}
