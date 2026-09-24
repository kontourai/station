/**
 * The program Station runs on an SSH device host (#1973, D11).
 *
 * Adapted from t3code's `apps/server/src/device/sshDeviceScript.ts` (MIT,
 * © 2026 T3 Tools Inc.): one Node program, sent over the ssh session's
 * stdin, that probes the host, installs the hub, or runs it. Station
 * differs where the device toolchain lane already does:
 *
 * - The hub is not `npm install`ed on the host. Station installs it LOCALLY
 *   through the pinned lockfile + integrity path (`device-toolchain.ts`,
 *   `device-tool-verify.ts`), then sends that verified tree file by file with
 *   a sha256 manifest; this program writes each file into a fresh staging
 *   directory, re-hashes it, and publishes the tree only when every file
 *   matched. The pinned tree is platform-neutral (no os/cpu-specific
 *   packages; install scripts never run), so the same bytes serve a Mac or
 *   Linux host.
 * - What that proves, precisely: the files were verified AT INSTALL TIME.
 *   Later starts trust the install sentinel (`<version> <digest>` written
 *   last, inside the published directory) and do not re-hash the tree; a
 *   same-user process on the host that edits the files afterwards is not
 *   detected (it could equally edit anything else that user runs).
 * - Each verified tree is published into its own directory named by its
 *   manifest digest (`tools/expo-device-hub/<version>/<digest>/`), and a
 *   complete tree is never deleted or overwritten by an install: another
 *   Station (owner) sharing this user's home may be running a hub from it.
 *   Disclosed: nothing prunes old digest directories, so each hub pin
 *   change leaves one tree (tens of MB) under `~/.station-device-host/tools`
 *   until the operator removes it; pruning safely would need to know no
 *   owner's hub still runs from it.
 * - Each session has its own TMPDIR (`run/<owner>/tmp-<pid>`), so the stream
 *   helpers one session's hub starts are the only ones it kills, and
 *   `hub.json` is removed only while it still names that session's hub.
 * - The hub runs under the SAME guard (`device-hub-guard.ts`, sent as its
 *   source) with a per-launch secret Station generated and sent on stdin
 *   (never on a command line), the same allowlisted environment, the same
 *   arguments, and `--host 127.0.0.1 --port 0`.
 * - The hub lives exactly as long as the ssh session that started it: when
 *   stdin closes (Station stopped it, or the connection died) this program
 *   kills the hub's process group. A hub left behind by a session that was
 *   killed outright is found by its recorded pid and command line and
 *   stopped at the next start.
 *
 * Every parameter arrives as data in `p` (JSON), never through a shell.
 * Output is one JSON object per line on stdout; nothing else is printed
 * there.
 */

/** What Station sends in `p`. */
export type RemoteDeviceHostParams =
  | { mode: 'probe'; owner: string; version: string; digest: string | null }
  | {
      mode: 'install';
      version: string;
      digest: string;
      files: Array<{
        path: string;
        size: number;
        sha256: string;
        exec: boolean;
      }>;
    }
  | {
      mode: 'start';
      owner: string;
      version: string;
      digest: string;
      secret: string;
      guardSource: string;
      guardSecretEnv: string;
      envAllowlist: readonly string[];
      extraEnv: Record<string, string>;
      args: readonly string[];
      entry: readonly string[];
      readyTimeoutMs: number;
    }
  | { mode: 'avd'; serial: string };

/** The script, as a function expression the loader evaluates. */
export const REMOTE_DEVICE_HOST_SCRIPT = String.raw`(function (require, rest, p) {
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const out = (value) => process.stdout.write(JSON.stringify(value) + '\n');
const fail = (failure, code) => { out({ event: 'error', failure }); process.exitCode = code || 3; };
const OWNER = /^[0-9a-f]{24}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+$/;
const DIGEST = /^[0-9a-f]{64}$/;
const root = path.join(os.homedir(), '.station-device-host');
const versionDir = (version) => path.join(root, 'tools', 'expo-device-hub', version);
// One directory per verified tree: tools/expo-device-hub/<version>/<digest>/.
const toolDir = (version, digest) => path.join(versionDir(version), digest);
const readSentinel = (dir) => { try { return fs.readFileSync(path.join(dir, '.install-complete'), 'utf8').trim(); } catch { return null; } };
const complete = (version, digest) => readSentinel(toolDir(version, digest)) === version + ' ' + digest;
// digest null (a probe from a Station with no local install): any complete tree of this version.
const installed = (version, digest) => {
  if (digest !== null) return complete(version, digest);
  let names = [];
  try { names = fs.readdirSync(versionDir(version)); } catch {}
  return names.some((name) => DIGEST.test(name) && complete(version, name));
};
const run = (command, args) => { try { return spawnSync(command, args, { encoding: 'utf8', timeout: 15000, windowsHide: true }); } catch { return { status: 1, stdout: '' }; } };
const commandOf = (pid) => (run('ps', ['-p', String(pid), '-o', 'command=']).stdout || '').trim();
const nodeMajor = Number(process.versions.node.split('.')[0]);
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const runDir = (owner) => path.join(root, 'run', owner);
// Kill the serve-sim helpers ONE session's hub started: each session has its
// own TMPDIR (tmp-<session pid>), so a helper of an overlapping session of
// the same owner is never touched (review L-b).
const killHelpersIn = (tmp, installDir) => {
  let names = [];
  try { names = fs.readdirSync(path.join(tmp, 'serve-sim')); } catch {}
  for (const name of names) {
    if (!/^server-[A-Za-z0-9._-]+\.json$/.test(name)) continue;
    const helper = readJson(path.join(tmp, 'serve-sim', name));
    if (helper && Number.isSafeInteger(helper.pid) && helper.pid > 1 && commandOf(helper.pid).includes(installDir + path.sep)) {
      try { process.kill(helper.pid, 'SIGTERM'); } catch {}
    }
  }
};
// Remove hub.json only while it still names THIS session's hub: a newer
// session of the same owner may have written its own since (L-b).
const forgetRecordedIfOurs = (owner, pid) => {
  const file = path.join(runDir(owner), 'hub.json');
  const hub = readJson(file);
  if (hub && hub.pid === pid) { try { fs.rmSync(file, { force: true }); } catch {} }
};
// N5: a session killed outright (SIGKILL) never removes its TMPDIR. Remove
// every tmp-<pid> whose pid is gone — never our own.
const sweepStaleTmp = (owner) => {
  let names = [];
  try { names = fs.readdirSync(runDir(owner)); } catch {}
  for (const name of names) {
    const match = /^tmp-([0-9]{1,10})$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { alive = error.code === 'EPERM'; }
    if (!alive) { try { fs.rmSync(path.join(runDir(owner), name), { recursive: true, force: true }); } catch {} }
  }
};
const stopRecorded = (owner) => {
  const file = path.join(runDir(owner), 'hub.json');
  const hub = readJson(file);
  if (hub && Number.isSafeInteger(hub.pid) && hub.pid > 1 && typeof hub.entry === 'string' && commandOf(hub.pid).includes(hub.entry)) {
    try { process.kill(-hub.pid, 'SIGTERM'); } catch { try { process.kill(hub.pid, 'SIGTERM'); } catch {} }
    // Resolved first, so a ".." in a recorded path cannot escape the run dir.
    const tmp = typeof hub.tmp === 'string' ? path.resolve(hub.tmp) : '';
    if (tmp.startsWith(runDir(owner) + path.sep) && typeof hub.install === 'string' && hub.entry.startsWith(hub.install + path.sep)) killHelpersIn(tmp, hub.install);
  }
  fs.rmSync(file, { force: true });
};
const hubRunning = (owner) => {
  const hub = readJson(path.join(runDir(owner), 'hub.json'));
  return !!(hub && Number.isSafeInteger(hub.pid) && typeof hub.entry === 'string' && commandOf(hub.pid).includes(hub.entry));
};

if (p.mode === 'probe') {
  if (!OWNER.test(p.owner) || !VERSION.test(p.version) || (p.digest !== null && !DIGEST.test(p.digest))) return fail('protocol');
  const ios = process.platform === 'darwin' && run('xcrun', ['simctl', 'help']).status === 0;
  const android = run('adb', ['version']).status === 0;
  out({ event: 'probe', node: process.versions.node, nodeOk: nodeMajor >= 22, platform: process.platform, ios, android, hubInstalled: installed(p.version, p.digest), hubRunning: hubRunning(p.owner) });
  return;
}

if (p.mode === 'avd') {
  if (!/^emulator-[0-9]{1,5}$/.test(p.serial)) return fail('protocol');
  const result = run('adb', ['-s', p.serial, 'emu', 'avd', 'name']);
  const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const avd = result.status === 0 && lines[1] === 'OK' && /^[A-Za-z0-9._-]{1,128}$/.test(lines[0] || '') ? lines[0] : null;
  out({ event: 'avd', avd });
  return;
}

if (p.mode === 'install') {
  if (!VERSION.test(p.version) || !DIGEST.test(p.digest) || !Array.isArray(p.files) || p.files.length === 0 || p.files.length > 20000) return fail('protocol');
  for (const file of p.files) {
    const parts = typeof file.path === 'string' ? file.path.split('/') : [];
    if (parts.length === 0 || parts[0] !== 'node_modules' || parts.some((part) => part === '' || part === '.' || part === '..' || part.includes('\\') || part.includes('\0')) || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) return fail('protocol');
  }
  if (installed(p.version, p.digest)) { out({ event: 'installed', already: true }); return; }
  const parent = versionDir(p.version);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const staging = fs.mkdtempSync(path.join(parent, '.staging-'));
  let index = 0;
  let written = 0;
  let current = null;
  let hash = null;
  let pending = rest;
  let done = false;
  const cleanup = () => { try { fs.rmSync(staging, { recursive: true, force: true }); } catch {} };
  const openNext = () => {
    while (index < p.files.length) {
      const file = p.files[index];
      const target = path.join(staging, ...file.path.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      current = { file, fd: fs.openSync(target, 'wx', file.exec ? 0o755 : 0o644) };
      hash = crypto.createHash('sha256');
      written = 0;
      if (file.size > 0) return;
      finishFile();
    }
    current = null;
  };
  const finishFile = () => {
    fs.closeSync(current.fd);
    if (hash.digest('hex') !== current.file.sha256) throw new Error('mismatch');
    index += 1;
    current = null;
  };
  const consume = (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (!current) openNext();
      if (!current) throw new Error('overflow');
      const take = Math.min(current.file.size - written, chunk.length - offset);
      const slice = chunk.subarray(offset, offset + take);
      fs.writeSync(current.fd, slice);
      hash.update(slice);
      written += take;
      offset += take;
      if (written === current.file.size) finishFile();
    }
  };
  const finish = () => {
    if (done) return;
    done = true;
    try {
      if (!current) openNext();
      if (current || index !== p.files.length) throw new Error('short');
      fs.writeFileSync(path.join(staging, '.install-complete'), p.version + ' ' + p.digest + '\n');
      const target = toolDir(p.version, p.digest);
      // Race-safe (L-f): a directory at the target name only ever arrives by
      // renaming a staging tree whose sentinel was written first, and a
      // rename never replaces a non-empty directory. So if another installer
      // published this digest first, its tree is the same verified bytes:
      // that is success, and nothing is deleted.
      const publish = () => {
        try {
          fs.renameSync(staging, target);
          return true;
        } catch (error) {
          if (complete(p.version, p.digest)) return false;
          throw error;
        }
      };
      let published;
      try {
        published = publish();
      } catch (error) {
        // N4: something non-empty and NOT complete (no valid sentinel) holds
        // the name, so no hub can be running from it. Move it aside — never
        // delete in place — and publish once more. A complete tree is never
        // touched: complete() was false just above.
        if (!fs.existsSync(target) || complete(p.version, p.digest)) throw error;
        fs.renameSync(target, target + '.stale-' + process.pid + '-' + Date.now());
        published = publish();
      }
      if (!published) {
        cleanup();
        out({ event: 'installed', already: true });
        return;
      }
      out({ event: 'installed', already: false });
    } catch {
      cleanup();
      fail('install-failed');
    }
  };
  try {
    openNext();
    if (pending.length) consume(pending);
  } catch { done = true; cleanup(); return fail('install-failed'); }
  process.stdin.on('data', (chunk) => {
    if (done) return;
    try { consume(chunk); } catch { done = true; cleanup(); fail('install-failed'); process.stdin.destroy(); }
  });
  process.stdin.on('end', finish);
  process.stdin.resume();
  return;
}

if (p.mode === 'start') {
  if (!OWNER.test(p.owner) || !VERSION.test(p.version) || typeof p.digest !== 'string' || !DIGEST.test(p.digest) || typeof p.secret !== 'string' || !/^[0-9a-f]{64}$/.test(p.secret)) return fail('protocol');
  if (nodeMajor < 22) return fail('unsupported-node');
  if (!installed(p.version, p.digest)) return fail('hub-not-installed');
  const dir = runDir(p.owner);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  stopRecorded(p.owner);
  sweepStaleTmp(p.owner);
  const tmp = path.join(dir, 'tmp-' + process.pid);
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const guardPath = path.join(dir, 'hub-guard.cjs');
  fs.writeFileSync(guardPath, p.guardSource, { mode: 0o600 });
  fs.chmodSync(guardPath, 0o600);
  const install = toolDir(p.version, p.digest);
  const entry = path.join(install, 'node_modules', 'expo-device-hub', ...p.entry);
  const env = {};
  for (const key of p.envAllowlist) if (process.env[key] !== undefined) env[key] = process.env[key];
  Object.assign(env, p.extraEnv, {
    NODE_OPTIONS: '--require ' + JSON.stringify(guardPath),
    [p.guardSecretEnv]: p.secret,
    TMPDIR: tmp, TMP: tmp, TEMP: tmp,
  });
  const child = spawn(process.execPath, [entry, ...p.args], { cwd: install, env, detached: true, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let stopping = false;
  const killGroup = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
  const killHelpers = () => killHelpersIn(tmp, install);
  const stop = (reason) => {
    if (stopping) return;
    stopping = true;
    killGroup('SIGTERM');
    killHelpers();
    const timer = setTimeout(() => { killGroup('SIGKILL'); finalize(reason); }, 3000);
    child.once('exit', () => { clearTimeout(timer); finalize(reason); });
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); finalize(reason); }
  };
  let finalized = false;
  const finalize = (reason) => {
    if (finalized) return;
    finalized = true;
    forgetRecordedIfOurs(p.owner, child.pid);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    out({ event: 'stopped', reason });
    process.exit(0);
  };
  child.once('error', () => { fail('start-failed', 4); process.exit(4); });
  child.once('exit', (code, signal) => {
    if (stopping) return;
    out({ event: 'exited', code, signal });
    killHelpers();
    forgetRecordedIfOurs(p.owner, child.pid);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
    process.exit(4);
  });
  process.stdin.on('end', () => stop('session-closed'));
  process.stdin.on('close', () => stop('session-closed'));
  process.on('SIGHUP', () => stop('hangup'));
  process.on('SIGTERM', () => stop('terminated'));
  process.stdin.resume();
  fs.writeFileSync(path.join(dir, 'hub.json'), JSON.stringify({ pid: child.pid, entry, install, tmp }), { mode: 0o600 });
  let buffered = '';
  let port = null;
  const listening = /Local:\s+http:\/\/(?:localhost|127\.0\.0\.1):([0-9]{1,5})\b/;
  child.stdout.on('data', (chunk) => {
    if (port !== null) return;
    buffered = (buffered + chunk.toString('utf8')).slice(-4096);
    const match = listening.exec(buffered);
    if (!match) return;
    port = Number(match[1]);
    ready(port).catch(() => {});
  });
  const deadline = Date.now() + p.readyTimeoutMs;
  const timeout = setTimeout(() => { if (port === null) { fail('start-failed', 4); stop('ready-timeout'); } }, p.readyTimeoutMs);
  async function ready(port) {
    while (!stopping && Date.now() < deadline) {
      try {
        const response = await fetch('http://127.0.0.1:' + port + '/readyz', { headers: { 'x-station-hub-secret': p.secret }, redirect: 'error', signal: AbortSignal.timeout(2000) });
        if (response.ok) {
          clearTimeout(timeout);
          fs.writeFileSync(path.join(dir, 'hub.json'), JSON.stringify({ pid: child.pid, entry, install, tmp, port }), { mode: 0o600 });
          out({ event: 'ready', port, node: process.versions.node });
          return;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!stopping) { clearTimeout(timeout); fail('start-failed', 4); stop('ready-timeout'); }
  }
  return;
}

fail('protocol');
})`;
