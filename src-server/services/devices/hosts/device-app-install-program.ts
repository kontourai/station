export const DEVICE_INSTALL_HOST_PHASE_BUDGET_MS = 120_000;

/** Fixed program sent to a device host; all per-install values are data. */
export interface DeviceAppInstallParams {
  platform: 'ios' | 'android';
  deviceId: string;
  digest: string;
  executables?: { adb?: string; xcrun?: string; plutil?: string };
  files: Array<{
    path: string;
    size: number;
    sha256: string;
    executable: boolean;
  }>;
}

export const DEVICE_APP_INSTALL_SCRIPT = String.raw`(function (require, rest, p) {
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const MAX_BYTES = 128 * 1024 * 1024;
const IOS_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const ANDROID_ID = /^emulator-[0-9]{1,5}$/;
const APP_ID = /^[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)+$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const safePath = (value) => typeof value === 'string' && value.length > 0 && value.length <= 512 && !value.startsWith('/') && !value.includes('\\') && value.split('/').length <= 32 && value.split('/').every((part) => part && part !== '.' && part !== '..' && !part.includes(':') && !/[. ]$/.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) && ![...part].some((c) => { const n = c.codePointAt(0); return n < 32 || n === 127 || n === 65533; }));
const early = () => { process.stdout.write(JSON.stringify({ event: 'app-install', ok: false, code: 'invalid-request', effect: 'none' }) + '\n'); process.exitCode = 1; };
if (!p || !['ios', 'android'].includes(p.platform) || typeof p.deviceId !== 'string' || !(p.platform === 'ios' ? IOS_ID : ANDROID_ID).test(p.deviceId) || !DIGEST.test(p.digest) || !Array.isArray(p.files) || p.files.length < 1 || p.files.length > 10000) return early();
let total = 0;
const seen = new Set(), parents = new Set(), names = new Set();
for (const file of p.files) {
  if (!file || !safePath(file.path) || typeof file.executable !== 'boolean' || !Number.isSafeInteger(file.size) || file.size < 0 || !/^[0-9a-f]{64}$/.test(file.sha256)) return early();
  const key = file.path.normalize('NFD').toLowerCase(), parts = key.split('/');
  const ancestors = parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join('/'));
  if (seen.has(key) || parents.has(key) || ancestors.some((parent) => names.has(parent))) return early();
  seen.add(key); names.add(key); for (const parent of ancestors) parents.add(parent);
  total += file.size;
  if (total > MAX_BYTES) return early();
}
if (!total || (p.platform === 'android' && (p.files.length !== 1 || p.files[0].path !== 'Application.apk')) || (p.platform === 'ios' && !p.files.some((file) => file.path === 'Info.plist'))) return early();
for (let i = 1; i < p.files.length; i++) if (Buffer.compare(Buffer.from(p.files[i-1].path), Buffer.from(p.files[i].path)) >= 0) return early();
let stage;
try { stage = fs.mkdtempSync(path.join(os.tmpdir(), 'station-device-app-')); fs.chmodSync(stage, 0o700); } catch { return early(); }
const root = p.platform === 'ios' ? path.join(stage, 'Application.app') : stage;
try { if (p.platform === 'ios') fs.mkdirSync(root, { mode: 0o700 }); } catch { try { fs.rmSync(stage, { recursive: true, force: true }); } catch {} return early(); }
let active = null, done = false, phase = 'receiving', current = null, index = 0, written = 0, fileHash = null, actionStarted = false;
let admit;
const admission = new Promise((resolve) => { admit = resolve; });
const overall = crypto.createHash('sha256');
if (p.platform === 'ios') overall.update('station-device-app-tree/v1\0');
const finish = (result) => {
  if (done) return;
  done = true; clearTimeout(deadline);
  if (current) { try { fs.closeSync(current.fd); } catch {} current = null; }
  const cleanup = () => {
    try { fs.rmSync(stage, { recursive: true, force: true }); } catch { result = { ok: false, code: 'cleanup-failed', effect: actionStarted ? 'unknown' : 'none' }; }
    process.stdout.write(JSON.stringify(Object.assign({ event: 'app-install' }, result)) + '\n', () => process.exit(result.ok ? 0 : 1));
  };
  if (active) {
    const child = active;
    child.once('close', cleanup);
    try { child.kill('SIGKILL'); } catch {}
  } else cleanup();
};
const cancel = () => finish({ ok: false, code: 'interrupted', effect: actionStarted ? 'unknown' : 'none' });
let deadline = setTimeout(() => finish({ ok: false, code: 'tool-timeout', effect: actionStarted ? 'unknown' : 'none' }), ${DEVICE_INSTALL_HOST_PHASE_BUDGET_MS} + Math.ceil(total / (128 * 1024)) * 1000);
const run = (command, args) => new Promise((resolve, reject) => {
  if (p.executables && p.executables[command]) command = p.executables[command];
  if (done) return reject(new Error('interrupted'));
  let child;
  try { child = spawn(command, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return reject(new Error('tool-unavailable')); }
  active = child;
  const chunks = []; let size = 0, settled = false;
  const settle = (error, value) => { if (settled) return; settled = true; if (active === child) active = null; error ? reject(error) : resolve(value); };
  child.stdout.on('data', (chunk) => { size += chunk.length; if (size > 1024 * 1024) { try { child.kill('SIGKILL'); } catch {} settle(new Error('tool-failed')); } else chunks.push(chunk); });
  child.stdout.on('error', () => settle(new Error('tool-failed')));
  child.on('error', (error) => settle(new Error(error && error.code === 'ENOENT' ? 'tool-unavailable' : 'tool-failed')));
  child.on('close', (code) => code === 0 ? settle(null, Buffer.concat(chunks).toString('utf8')) : settle(new Error('tool-failed')));
});
const text = (value, max) => typeof value === 'string' && value.length > 0 && value.length <= max && ![...value].some((c) => { const n = c.codePointAt(0); return n < 32 || n === 127; }) ? value : null;
const version = (value) => typeof value === 'string' || typeof value === 'number' ? text(String(value), 128) : null;
const parseVersion = (value) => typeof value === 'string' && /^\d+(?:\.\d+){0,3}$/.test(value) ? value.split('.').map(Number) : null;
const atLeast = (actual, minimum) => { for (let i = 0; i < Math.max(actual.length, minimum.length); i++) { const a = actual[i] || 0, b = minimum[i] || 0; if (a !== b) return a > b; } return true; };
async function ios() {
  const raw = await run('plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Info.plist')]);
  let info; try { info = JSON.parse(raw); } catch { throw new Error('incompatible-artifact'); }
  const appId = text(info.CFBundleIdentifier, 255), executable = text(info.CFBundleExecutable, 255);
  const versionName = version(info.CFBundleShortVersionString), build = version(info.CFBundleVersion);
  if (!appId || !APP_ID.test(appId) || !executable || !/^[A-Za-z0-9._-]+$/.test(executable) || executable === '.' || executable === '..' || !versionName || !build || info.CFBundlePackageType !== 'APPL' || !Array.isArray(info.CFBundleSupportedPlatforms) || !info.CFBundleSupportedPlatforms.includes('iPhoneSimulator')) throw new Error('incompatible-artifact');
  if (!p.files.some((file) => file.path === executable && file.executable)) throw new Error('incompatible-artifact');
  const hostArch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x86_64' : null;
  if (!hostArch) throw new Error('incompatible-artifact');
  let minimum = null, mainBinary = false;
  const magic = new Set([0xfeedface,0xfeedfacf,0xcefaedfe,0xcffaedfe,0xcafebabe,0xbebafeca,0xcafebabf,0xbfbafeca]);
  for (const file of p.files) {
    const candidate = path.join(root, ...file.path.split('/'));
    const fd = fs.openSync(candidate, 'r'), header = Buffer.alloc(4); let count;
    try { count = fs.readSync(fd, header, 0, 4, 0); } finally { fs.closeSync(fd); }
    if (count !== 4 || !magic.has(header.readUInt32BE(0))) continue;
    if (file.path === executable) mainBinary = true;
    const archs = (await run('xcrun', ['lipo', '-archs', candidate])).trim().split(/\s+/);
    if (!archs.includes(hostArch)) throw new Error('incompatible-artifact');
    const buildInfo = await run('xcrun', ['vtool', '-arch', hostArch, '-show-build', candidate]);
    const platforms = [...buildInfo.matchAll(/^\s*platform\s+(\S+)/gm)].map((m) => m[1]);
    const match = /^\s*minos\s+(\S+)/m.exec(buildInfo), min = match && parseVersion(match[1]);
    if (platforms.length !== 1 || platforms[0] !== 'IOSSIMULATOR' || !min) throw new Error('incompatible-artifact');
    if (!minimum || atLeast(min, minimum)) minimum = min;
  }
  if (!mainBinary || !minimum) throw new Error('incompatible-artifact');
  let list; try { list = JSON.parse(await run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'])); } catch { throw new Error('tool-failed'); }
  let runtime = null;
  for (const [key, devices] of Object.entries(list.devices || {})) {
    if (!Array.isArray(devices)) continue;
    if (devices.some((device) => device && device.udid === p.deviceId && device.state === 'Booted')) {
      const match = /\.iOS-(\d+(?:-\d+)*)$/.exec(key);
      if (!match || runtime) throw new Error('tool-failed');
      runtime = match[1].split('-').map(Number);
    }
  }
  if (!runtime || !atLeast(runtime, minimum)) throw new Error('incompatible-artifact');
  const urlSchemes = Array.isArray(info.CFBundleURLTypes) ? [...new Set(info.CFBundleURLTypes.flatMap((item) => Array.isArray(item?.CFBundleURLSchemes) ? item.CFBundleURLSchemes : []).filter((scheme) => typeof scheme === 'string' && /^[A-Za-z][A-Za-z0-9+.-]{0,31}$/.test(scheme)).map((scheme) => scheme.toLowerCase()))] : [];
  const metadata = { platform: 'ios', abi: hostArch, appId, version: versionName, build, revision: null, urlSchemes };
  return { metadata, install: async () => {
    actionStarted = true;
    await run('xcrun', ['simctl', 'install', p.deviceId, root]);
    const installed = (await run('xcrun', ['simctl', 'get_app_container', p.deviceId, appId, 'app'])).trim();
    if (!installed || !path.isAbsolute(installed)) throw new Error('postcondition-failed');
    let real, base; try { real = fs.realpathSync(installed); base = fs.realpathSync(path.join(os.homedir(), 'Library', 'Developer', 'CoreSimulator', 'Devices', p.deviceId)); } catch { throw new Error('postcondition-failed'); }
    const relation = path.relative(base, real);
    if (!relation || relation === '..' || relation.startsWith('..' + path.sep) || path.isAbsolute(relation)) throw new Error('postcondition-failed');
    let observed; try { observed = JSON.parse(await run('plutil', ['-convert', 'json', '-o', '-', path.join(installed, 'Info.plist')])); } catch { throw new Error('postcondition-failed'); }
    if (observed.CFBundleIdentifier !== appId || version(observed.CFBundleShortVersionString) !== versionName || version(observed.CFBundleVersion) !== build) throw new Error('postcondition-failed');
    return metadata;
  } };
}
function aapt() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (process.platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Android', 'Sdk') : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') : path.join(os.homedir(), 'Android', 'Sdk'));
  let versions; try { versions = fs.readdirSync(path.join(sdk, 'build-tools')).filter((entry) => /^\d+\.\d+\.\d+$/.test(entry)).sort((a,b) => { const x=a.split('.').map(Number), y=b.split('.').map(Number); for (let i=0;i<3;i++) if (x[i] !== y[i]) return y[i]-x[i]; return 0; }); } catch { throw new Error('tool-unavailable'); }
  for (const item of versions) { const candidate = path.join(sdk, 'build-tools', item, process.platform === 'win32' ? 'aapt.exe' : 'aapt'); if (fs.existsSync(candidate)) return candidate; }
  throw new Error('tool-unavailable');
}
async function android() {
  const apk = path.join(stage, 'Application.apk');
  const badging = await run(aapt(), ['dump', 'badging', apk]);
  const match = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']*)'/m.exec(badging);
  if (!match || !APP_ID.test(match[1]) || match[1].length > 255 || !/^\d{1,20}$/.test(match[2]) || (match[3] && !text(match[3], 128))) throw new Error('incompatible-artifact');
  const appId = match[1], build = match[2], versionName = match[3] || null;
  const native = /^native-code:\s*(.*)$/m.exec(badging);
  const abis = native ? [...native[1].matchAll(/'([^']+)'/g)].map((v) => v[1]) : [];
  if (native && (!abis.length || abis.some((abi) => !/^[A-Za-z0-9_-]{1,64}$/.test(abi)))) throw new Error('incompatible-artifact');
  const deviceAbis = (await run('adb', ['-s', p.deviceId, 'shell', 'getprop', 'ro.product.cpu.abilist'])).trim().split(',');
  if (!deviceAbis.length || deviceAbis.some((abi) => !/^[A-Za-z0-9_-]{1,64}$/.test(abi)) || (abis.length && !abis.some((abi) => deviceAbis.includes(abi)))) throw new Error('incompatible-artifact');
  const min = /^sdkVersion:'(\d+)'/m.exec(badging), sdk = (await run('adb', ['-s', p.deviceId, 'shell', 'getprop', 'ro.build.version.sdk'])).trim();
  if (!min || !/^\d+$/.test(sdk) || Number(sdk) < Number(min[1])) throw new Error('incompatible-artifact');
  const manifest = await run(aapt(), ['dump', 'xmltree', apk, 'AndroidManifest.xml']);
  const urlSchemes = []; let intentIndent = -1;
  for (const line of manifest.split(/\r?\n/)) {
    const element = /^(\s*)E: ([^ ]+)/.exec(line);
    if (element) { const indent = element[1].length; if (intentIndent >= 0 && indent <= intentIndent) intentIndent = -1; if (element[2] === 'intent-filter') intentIndent = indent; }
    const scheme = /android:scheme(?:\([^)]*\))?=\"([^\"]+)\"/.exec(line);
    if (intentIndent >= 0 && scheme && /^[A-Za-z][A-Za-z0-9+.-]{0,31}$/.test(scheme[1])) urlSchemes.push(scheme[1].toLowerCase());
  }
  const metadata = { platform: 'android', abi: abis.length ? abis.join(',') : 'universal', appId, version: versionName, build, revision: null, urlSchemes: [...new Set(urlSchemes)] };
  return { metadata, install: async () => {
    actionStarted = true;
    const result = await run('adb', ['-s', p.deviceId, 'install', '-r', apk]);
    if (!/^Success\s*$/m.test(result)) throw new Error('postcondition-failed');
    const observed = await run('adb', ['-s', p.deviceId, 'shell', 'dumpsys', 'package', appId]);
    const observedBuild = /\bversionCode=(\d+)/.exec(observed), observedVersion = /\bversionName=([^\r\n]*)/.exec(observed);
    if (!observedBuild || observedBuild[1] !== build || (versionName !== null && (!observedVersion || observedVersion[1].trim() !== versionName))) throw new Error('postcondition-failed');
    return metadata;
  } };
}
function verifyStaged() {
  const combined = crypto.createHash('sha256');
  if (p.platform === 'ios') combined.update('station-device-app-tree/v1\0');
  for (const file of p.files) {
    const parts = file.path.split('/'); let parent = root;
    for (const part of parts.slice(0, -1)) { parent = path.join(parent, part); const stat = fs.lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('invalid-artifact'); }
    const candidate = path.join(root, ...parts), before = fs.lstatSync(candidate);
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.size !== file.size) throw new Error('invalid-artifact');
    const fd = fs.openSync(candidate, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size || opened.nlink !== 1) throw new Error('invalid-artifact');
      if (p.platform === 'ios') { const name = Buffer.from(file.path), header = Buffer.alloc(13); header.writeUInt32BE(name.length, 0); header.writeUInt8(file.executable ? 1 : 0, 4); header.writeBigUInt64BE(BigInt(file.size), 5); combined.update(header).update(name); }
      const hash = crypto.createHash('sha256'), chunk = Buffer.alloc(1024 * 1024); let offset = 0;
      while (offset < file.size) { const count = fs.readSync(fd, chunk, 0, Math.min(chunk.length, file.size - offset), offset); if (count <= 0) throw new Error('invalid-artifact'); hash.update(chunk.subarray(0,count)); combined.update(chunk.subarray(0,count)); offset += count; }
      const after = fs.fstatSync(fd), final = fs.lstatSync(candidate);
      if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || final.isSymbolicLink() || final.dev !== opened.dev || final.ino !== opened.ino || hash.digest('hex') !== file.sha256) throw new Error('invalid-artifact');
    } finally { fs.closeSync(fd); }
  }
  if ('sha256:' + combined.digest('hex') !== p.digest) throw new Error('invalid-artifact');
}
async function work() {
  try {
    const prepared = p.platform === 'ios' ? await ios() : await android();
    if (done) return;
    phase = 'waiting';
    process.stdout.write(JSON.stringify({ event: 'app-ready', metadata: prepared.metadata }) + '\n');
    await admission;
    if (done) return;
    phase = 'working'; verifyStaged();
    const metadata = await prepared.install();
    if (!done) finish({ ok: true, metadata, digest: p.digest });
  } catch (error) {
    const allowed = ['invalid-artifact', 'incompatible-artifact', 'tool-unavailable', 'tool-failed', 'postcondition-failed'];
    finish({ ok: false, code: error && allowed.includes(error.message) ? error.message : 'tool-failed', effect: actionStarted ? 'unknown' : 'none' });
  }
}
function finishFile() { fs.closeSync(current.fd); if (fileHash.digest('hex') !== current.file.sha256) throw new Error('mismatch'); current = null; index++; }
function openNext() {
  while (index < p.files.length) {
    const file = p.files[index], destination = path.join(root, ...file.path.split('/'));
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    current = { file, fd: fs.openSync(destination, 'wx', file.executable ? 0o700 : 0o600) };
    fileHash = crypto.createHash('sha256'); written = 0;
    if (p.platform === 'ios') { const name = Buffer.from(file.path), header = Buffer.alloc(13); header.writeUInt32BE(name.length,0); header.writeUInt8(file.executable ? 1 : 0,4); header.writeBigUInt64BE(BigInt(file.size),5); overall.update(header).update(name); }
    if (file.size) return;
    finishFile();
  }
}
function consume(chunk) {
  if (phase === 'waiting') { if (chunk.length !== 1 || chunk[0] !== 71) throw new Error('invalid-admission'); phase = 'admitted'; admit(); return; }
  if (phase !== 'receiving' && chunk.length) throw new Error('overflow');
  let offset = 0;
  while (offset < chunk.length) {
    if (!current) openNext();
    if (!current) throw new Error('overflow');
    const take = Math.min(current.file.size - written, chunk.length - offset), piece = chunk.subarray(offset, offset + take);
    let position = 0; while (position < piece.length) { const count = fs.writeSync(current.fd, piece, position, piece.length - position); if (count <= 0) throw new Error('short-write'); position += count; }
    fileHash.update(piece); overall.update(piece); written += take; offset += take;
    if (written === current.file.size) finishFile();
  }
  if (!current) openNext();
  if (!current && index === p.files.length) {
    if ('sha256:' + overall.digest('hex') !== p.digest) throw new Error('mismatch');
    clearTimeout(deadline); deadline = setTimeout(() => finish({ ok: false, code: 'tool-timeout', effect: actionStarted ? 'unknown' : 'none' }), ${DEVICE_INSTALL_HOST_PHASE_BUDGET_MS});
    phase = 'inspecting'; void work();
  }
}
process.stdin.on('data', (chunk) => { if (!done) try { consume(chunk); } catch { finish({ ok: false, code: 'invalid-artifact', effect: actionStarted ? 'unknown' : 'none' }); } });
process.stdin.on('end', cancel); process.stdin.on('close', cancel); process.stdin.on('error', cancel);
try { consume(rest); } catch { finish({ ok: false, code: 'invalid-artifact', effect: 'none' }); }
process.stdin.resume();
})`;
