import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { readPnpmLockfile } from './pnpm-lockfile.mjs';

export const LIFECYCLE_LOCKS = Object.freeze([
  { scope: 'root', path: 'package-lock.json' },
  { scope: 'sdk', path: 'packages/sdk/package-lock.json' },
  { scope: 'shared', path: 'packages/shared/package-lock.json' },
  { scope: 'root', path: 'pnpm-lock.yaml' },
]);

const DECISIONS = new Set(['execute', 'deny']);
const ARTIFACT_PROOFS = new Set([
  'esbuild-version',
  'node-pty-smoke',
  'fsevents-watch',
  'no-build-fallback',
]);
const SAFE_TOKEN = /^[A-Za-z0-9._/@+:-]+$/;
const SHA512 = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
const PACKAGE_PATH =
  /^(?:node_modules\/(?:@[^/]+\/)?[^/]+)(?:\/node_modules\/(?:@[^/]+\/)?[^/]+)*$/;
const LIFECYCLE_HOOKS = new Set(['preinstall', 'install', 'postinstall']);
export const PTY_HANDSHAKE_MARKER = 'STATION_NODE_PTY_READY_4296';
export const PTY_HANDSHAKE_TIMEOUT_MS = 8_000;

/**
 * The PTY probe always captures UTF-8 output. Keep this injection seam narrow:
 * callers do not implement `execFileSync`'s unrelated Buffer overloads.
 * @typedef {{ encoding: 'utf8', env: NodeJS.ProcessEnv, timeout: number, windowsHide: true }} NodePtyExecOptions
 * @typedef {(file: string, args: readonly string[], options: NodePtyExecOptions) => string} NodePtyExec
 */
/** @type {NodePtyExec} */
function executeNodePty(file, args, options) {
  return execFileSync(file, args, options);
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

export function allowlistDigest(allowlist) {
  return createHash('sha256').update(canonicalJson(allowlist)).digest('hex');
}

export function assertPtyHandshakeOutcome(output) {
  let result;
  try {
    result = JSON.parse(String(output).trim());
  } catch {
    throw new Error('node-pty handshake emitted no parseable outcome');
  }
  if (result?.marker !== PTY_HANDSHAKE_MARKER)
    throw new Error('node-pty handshake never observed its ready marker');
  if (result?.exitCode !== 0)
    throw new Error(
      `node-pty handshake child exited ${String(result?.exitCode)}`,
    );
  if (result?.signal !== undefined && result.signal !== 0)
    throw new Error(
      `node-pty handshake child was signalled: ${String(result.signal)}`,
    );
}

/**
 * A loadable `.node` only proves the linker accepted it. This isolated child
 * proves the real PTY bridge accepts output, accepts input, and lets its
 * process exit naturally. In particular, do not terminate a just-created
 * ConPTY: that races Windows' console-list attachment and hides its failure.
 */
/**
 * @param {string} packageRoot
 * @param {{ exec?: NodePtyExec }} options
 */
export function verifyNodePtyHandshake(
  packageRoot,
  { exec = executeNodePty } = {},
) {
  const child = String.raw`
const pty = require(process.argv[1]);
const marker = process.env.STATION_PTY_MARKER;
const terminal = pty.spawn(process.execPath, ['-e',
  'process.stdout.write(process.env.STATION_PTY_MARKER + "\\n"); process.stdin.resume(); process.stdin.once("data", () => process.exit(0));'
], { cols: 80, rows: 24, cwd: process.cwd(), env: process.env, name: 'xterm-256color' });
let seen = false;
let settled = false;
let transcript = '';
const finish = (code, message) => {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (message) process.stderr.write(message + '\n');
  if (code === 0) process.stdout.write(JSON.stringify({ marker: seen ? marker : null, exitCode: 0, signal: 0 }));
  process.exit(code);
};
terminal.onData((chunk) => {
  transcript += chunk;
  if (seen || !transcript.includes(marker)) return;
  seen = true;
  terminal.write('station-pty-ack\r');
});
terminal.onExit((event) => {
  if (!seen) return finish(1, 'node-pty child exited without ready marker: ' + transcript.slice(0, 1024));
  if (event.exitCode !== 0 || (event.signal !== undefined && event.signal !== 0))
    return finish(1, 'node-pty child did not exit naturally: code=' + event.exitCode + ', signal=' + event.signal);
  finish(0);
});
const timeout = setTimeout(() => {
  try { terminal.kill(); } catch {}
  finish(1, 'node-pty handshake timed out (marker seen: ' + seen + ')');
}, Number(process.env.STATION_PTY_TIMEOUT_MS));
`;
  let output;
  try {
    output = exec(process.execPath, ['-e', child, packageRoot], {
      encoding: 'utf8',
      env: {
        ...process.env,
        STATION_PTY_MARKER: PTY_HANDSHAKE_MARKER,
        STATION_PTY_TIMEOUT_MS: String(PTY_HANDSHAKE_TIMEOUT_MS),
      },
      timeout: 10_000,
      windowsHide: true,
    });
  } catch (error) {
    const detail = String(error?.stderr ?? error?.message ?? error).trim();
    throw new Error(`node-pty real PTY handshake failed: ${detail}`);
  }
  assertPtyHandshakeOutcome(output);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function packageNameFromPath(path) {
  const segment = path.slice(
    path.lastIndexOf('node_modules/') + 'node_modules/'.length,
  );
  const parts = segment.split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

export function npmPurl(name, version) {
  // The npm purl namespace keeps a scoped package's slash as hierarchy and
  // percent-encodes the literal @, matching CycloneDX npm inventories.
  return `pkg:npm/${name.startsWith('@') ? `%40${name.slice(1)}` : name}@${version}`;
}

export function collectLifecycleNodes(lock, { scope, path }) {
  if (!isObject(lock?.packages)) throw new Error(`${path} has no packages map`);
  return Object.entries(lock.packages)
    .filter(
      ([packagePath, meta]) =>
        packagePath && isObject(meta) && meta.hasInstallScript === true,
    )
    .map(([packagePath, meta]) => ({
      scope,
      lock: path,
      path: packagePath,
      name: packageNameFromPath(packagePath),
      version: meta.version,
      integrity: meta.integrity,
      optional: meta.optional === true,
      platform: { os: meta.os ?? [], cpu: meta.cpu ?? [] },
      purl: npmPurl(packageNameFromPath(packagePath), meta.version),
    }))
    .sort((left, right) =>
      `${left.lock}:${left.path}`.localeCompare(`${right.lock}:${right.path}`),
    );
}

export function readLifecycleLocks(
  root = process.cwd(),
  readFile = readFileSync,
) {
  if (lstatOrNull(resolve(root, 'pnpm-lock.yaml')))
    return readPnpmLifecycleNodes(root);
  const manifestPath = resolve(root, 'package.json');
  if (
    lstatOrNull(resolve(root, 'pnpm-workspace.yaml')) ||
    (lstatOrNull(manifestPath) &&
      JSON.parse(readFile(manifestPath, 'utf8')).packageManager?.startsWith(
        'pnpm@',
      ))
  )
    throw new Error('dependency lockfile is missing: pnpm-lock.yaml');
  return LIFECYCLE_LOCKS.filter((descriptor) =>
    descriptor.path.endsWith('.json'),
  ).flatMap((descriptor) =>
    collectLifecycleNodes(
      JSON.parse(readFile(resolve(root, descriptor.path), 'utf8')),
      descriptor,
    ),
  );
}

/** Inventory physical hoisted packages before any reviewed hook executes.
 * pnpm's lock does not enumerate lifecycle commands, so lock-only approval
 * cannot discover new hooks. The inert installed manifests are authoritative
 * for hook discovery; the lock remains authoritative for package integrity.
 */
export function readPnpmLifecycleNodes(root) {
  const lock = readPnpmLockfile(root);
  const policy = JSON.parse(
    readFileSync(
      resolve(root, 'config/dependency-lifecycle-allowlist.json'),
      'utf8',
    ),
  );
  const nodes = new Map();
  const knownNative = new Set(
    policy.entries
      .filter((entry) => entry.hooks.length === 0)
      .map((entry) => `${entry.name}@${entry.version}`),
  );
  const nodeFor = (name, version, path) => {
    const meta = lock.packages[`${name}@${version}`];
    if (!meta?.resolution?.integrity)
      throw new Error(
        `installed lifecycle package is not integrity-locked: ${name}@${version}`,
      );
    return {
      scope: 'root',
      lock: 'pnpm-lock.yaml',
      path,
      name,
      version,
      integrity: meta.resolution.integrity,
      optional: Boolean(meta.os?.length || meta.cpu?.length),
      platform: { os: meta.os ?? [], cpu: meta.cpu ?? [] },
      purl: npmPurl(name, version),
    };
  };
  const visited = new Set();
  const scan = (directory) => {
    if (!lstatOrNull(directory)) return;
    assertNoRedirectedPath(root, directory, 'lifecycle inventory');
    if (visited.has(directory)) return;
    visited.add(directory);
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      if (child.name.startsWith('.')) continue;
      const packageRoot = join(directory, child.name);
      if (child.name.startsWith('@')) {
        scan(packageRoot);
        continue;
      }
      // Workspace links carry Station-owned scripts and are not dependencies.
      // Other linked dependencies are unsupported by the hoisted contract.
      if (child.isSymbolicLink()) {
        const target = realpathSync(packageRoot);
        const rel = relative(realpathSync(root), target).split(sep).join('/');
        if (Object.keys(lock.importers).includes(rel) && rel !== '.') continue;
        throw new Error(
          `lifecycle inventory is redirected by a symlink or junction: ${packageRoot}`,
        );
      }
      if (!child.isDirectory()) continue;
      const manifestPath = join(packageRoot, 'package.json');
      if (!lstatOrNull(manifestPath)) continue;
      assertNoRedirectedPath(
        packageRoot,
        manifestPath,
        'installed package manifest',
      );
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (
        [...LIFECYCLE_HOOKS].some(
          (hook) => typeof manifest.scripts?.[hook] === 'string',
        ) ||
        knownNative.has(`${manifest.name}@${manifest.version}`) ||
        lstatOrNull(join(packageRoot, 'binding.gyp'))
      ) {
        const path = relative(root, packageRoot).split(sep).join('/');
        const node = nodeFor(manifest.name, manifest.version, path);
        nodes.set(path, node);
      }
      scan(join(packageRoot, 'node_modules'));
    }
  };
  scan(resolve(root, 'node_modules'));
  for (const importer of Object.keys(lock.importers)) {
    if (importer === '.') continue;
    const directory = resolve(root, importer, 'node_modules');
    assertNoRedirectedPath(root, directory, 'workspace lifecycle inventory');
    scan(directory);
  }
  // A platform-excluded approval remains checkable from lock metadata even
  // when pnpm correctly did not materialize that package on this machine.
  for (const entry of policy.entries) {
    if (nodes.has(entry.path) || platformMatches(entry)) continue;
    nodes.set(entry.path, nodeFor(entry.name, entry.version, entry.path));
  }
  return [...nodes.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function exactKeys(value, keys) {
  return (
    isObject(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}

function validString(value, max = 512) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    SAFE_TOKEN.test(value)
  );
}

function validateEntry(entry, index, findings) {
  const prefix = `allowlist entries[${index}]`;
  const keys = [
    'scope',
    'lock',
    'path',
    'name',
    'version',
    'integrity',
    'hooks',
    'decision',
    'owner',
    'reason',
    'platform',
    'artifact',
    'purl',
    'reviewedAt',
    'expiresAt',
    'recheck',
    'triggers',
  ];
  if (!exactKeys(entry, keys)) {
    findings.push(`${prefix} has unexpected or missing fields`);
    return;
  }
  if (
    !LIFECYCLE_LOCKS.some(
      (lock) => lock.scope === entry.scope && lock.path === entry.lock,
    )
  )
    findings.push(`${prefix} has an unknown lock scope`);
  if (typeof entry.path !== 'string' || !PACKAGE_PATH.test(entry.path))
    findings.push(`${prefix} has an invalid package path`);
  if (
    !validString(entry.name, 256) ||
    !validString(entry.version, 128) ||
    !SHA512.test(entry.integrity ?? '')
  )
    findings.push(`${prefix} has an invalid package identity`);
  if (!DECISIONS.has(entry.decision))
    findings.push(`${prefix} has an invalid decision`);
  if (
    !validString(entry.owner, 128) ||
    typeof entry.reason !== 'string' ||
    entry.reason.length < 12 ||
    entry.reason.length > 600
  )
    findings.push(`${prefix} lacks review ownership or reason`);
  if (
    !exactKeys(entry.platform, ['os', 'cpu']) ||
    !Array.isArray(entry.platform.os) ||
    !Array.isArray(entry.platform.cpu) ||
    !entry.platform.os.every((value) => validString(value, 32)) ||
    !entry.platform.cpu.every((value) => validString(value, 32))
  )
    findings.push(`${prefix} has an invalid platform selector`);
  if (
    !(
      exactKeys(entry.artifact, ['path', 'proof']) ||
      exactKeys(entry.artifact, ['path', 'platforms', 'proof']) ||
      exactKeys(entry.artifact, ['path', 'capability', 'proof'])
    ) ||
    typeof entry.artifact.path !== 'string' ||
    entry.artifact.path.startsWith('/') ||
    entry.artifact.path.includes('..') ||
    !ARTIFACT_PROOFS.has(entry.artifact.proof)
  )
    findings.push(`${prefix} has an invalid artifact proof`);
  if (
    entry.artifact.proof === 'no-build-fallback' &&
    !validString(entry.artifact.capability, 256)
  )
    findings.push(`${prefix} lacks a scoped fallback capability`);
  if (
    entry.artifact?.platforms !== undefined &&
    (!isObject(entry.artifact.platforms) ||
      !Object.entries(entry.artifact.platforms).every(
        ([selector, paths]) =>
          /^(darwin|linux|win32)\/(arm64|x64)$/.test(selector) &&
          Array.isArray(paths) &&
          paths.length > 0 &&
          paths.length <= 12 &&
          new Set(paths).size === paths.length &&
          paths.every(
            (path) =>
              typeof path === 'string' &&
              !path.startsWith('/') &&
              !path.includes('..'),
          ),
      ))
  )
    findings.push(`${prefix} has invalid platform artifact selectors`);
  if (entry.purl !== npmPurl(entry.name, entry.version))
    findings.push(`${prefix} has a non-canonical purl`);
  if (
    !Array.isArray(entry.triggers) ||
    entry.triggers.length === 0 ||
    !entry.triggers.every(
      (value) =>
        typeof value === 'string' && value.length > 4 && value.length < 240,
    )
  )
    findings.push(`${prefix} lacks maintenance triggers`);
  if (
    !Array.isArray(entry.hooks) ||
    !entry.hooks.every(
      (hook) =>
        exactKeys(hook, ['name', 'command']) &&
        LIFECYCLE_HOOKS.has(hook.name) &&
        typeof hook.command === 'string' &&
        hook.command.length > 0 &&
        hook.command.length < 400,
    )
    // npm's hasInstallScript marker also covers a shipped native prebuild with
    // no manifest lifecycle command (notably fsevents). Denied commands are
    // recorded too: preflight must notice their mutation even though it never
    // executes them.
  )
    findings.push(`${prefix} has an unapproved hook command`);
  const reviewed = Date.parse(`${entry.reviewedAt}T00:00:00.000Z`);
  const expires = Date.parse(`${entry.expiresAt}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.reviewedAt ?? '') ||
    !/^\d{4}-\d{2}-\d{2}$/.test(entry.expiresAt ?? '') ||
    !Number.isFinite(reviewed) ||
    !Number.isFinite(expires) ||
    expires <= reviewed ||
    typeof entry.recheck !== 'string' ||
    entry.recheck.length < 16
  )
    findings.push(`${prefix} lacks a valid review expiry and recheck trigger`);
  else if (entry.expiresAt < new Date().toISOString().slice(0, 10))
    findings.push(`${prefix} approval has expired`);
}

export function validateAllowlist(allowlist) {
  const findings = [];
  // This bootstrap validator intentionally has no third-party imports. It is
  // the bounded source-of-truth check used before the inert npm install, so a
  // fresh checkout never imports Ajv (or any other installed dependency).
  if (
    !exactKeys(allowlist, ['schemaVersion', 'entries']) ||
    allowlist.schemaVersion !== 1 ||
    !Array.isArray(allowlist.entries) ||
    allowlist.entries.length === 0
  )
    return [
      'allowlist schema / must contain schemaVersion 1 and non-empty entries',
    ];
  allowlist.entries.forEach((entry, index) =>
    validateEntry(entry, index, findings),
  );
  const ids = new Set();
  for (const entry of allowlist.entries) {
    const id = `${entry?.lock}:${entry?.path}`;
    if (ids.has(id)) findings.push(`allowlist duplicates ${id}`);
    ids.add(id);
  }
  return findings;
}

function nodeIdentity(node) {
  return `${node.lock}:${node.path}`;
}

export function evaluateLifecyclePolicy({ allowlist, nodes }) {
  const findings = validateAllowlist(allowlist);
  const byIdentity = new Map(
    allowlist.entries.map((entry) => [nodeIdentity(entry), entry]),
  );
  const seen = new Set();
  for (const node of nodes) {
    const entry = byIdentity.get(nodeIdentity(node));
    if (!entry) {
      findings.push(`unapproved install script: ${node.lock}:${node.path}`);
      continue;
    }
    seen.add(nodeIdentity(node));
    for (const field of [
      'scope',
      'lock',
      'path',
      'name',
      'version',
      'integrity',
      'purl',
    ])
      if (entry[field] !== node[field])
        findings.push(`identity drift for ${node.lock}:${node.path}: ${field}`);
    if (JSON.stringify(entry.platform) !== JSON.stringify(node.platform))
      findings.push(`platform drift for ${node.lock}:${node.path}`);
  }
  for (const entry of allowlist.entries)
    if (!seen.has(nodeIdentity(entry)))
      findings.push(`stale allowlist entry: ${entry.lock}:${entry.path}`);
  return findings.sort();
}

export function platformMatches(
  entry,
  platform = process.platform,
  arch = process.arch,
) {
  return (
    (!entry.platform.os.length || entry.platform.os.includes(platform)) &&
    (!entry.platform.cpu.length || entry.platform.cpu.includes(arch))
  );
}

export function resolvedPackagePath(root, entry) {
  const lockRoot = resolve(
    root,
    entry.lock === 'package-lock.json' || entry.lock === 'pnpm-lock.yaml'
      ? '.'
      : entry.lock.slice(0, -'/package-lock.json'.length),
  );
  return resolve(lockRoot, entry.path);
}

export function installedPackagePath(root, entry) {
  const lockedPath = resolvedPackagePath(root, entry);
  if (!lstatOrNull(lockedPath))
    throw new Error(
      `missing installed lifecycle package for ${entry.lock}:${entry.path}`,
    );
  const lockRoot = resolve(
    root,
    entry.lock === 'package-lock.json' || entry.lock === 'pnpm-lock.yaml'
      ? '.'
      : entry.lock.slice(0, -'/package-lock.json'.length),
  );
  const realLockRoot = realpathSync(lockRoot);
  assertNoRedirectedPath(lockRoot, lockedPath, 'installed lifecycle package');
  const realPackageRoot = realpathSync(lockedPath);
  const pathFromLockRoot = relative(realLockRoot, realPackageRoot);
  if (
    pathFromLockRoot === '..' ||
    pathFromLockRoot.startsWith(`..${sep}`) ||
    resolve(realLockRoot, pathFromLockRoot) !== realPackageRoot
  )
    throw new Error(
      `installed lifecycle package escapes lock root for ${entry.lock}:${entry.path}`,
    );
  return realPackageRoot;
}

function lstatOrNull(path) {
  try {
    return lstatSync(path);
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT')
      return null;
    throw error;
  }
}

function assertNoRedirectedPath(root, candidate, description) {
  const relativePath = relative(root, candidate);
  if (
    relativePath === '..' ||
    relativePath.startsWith(`..${sep}`) ||
    resolve(root, relativePath) !== candidate
  )
    throw new Error(`${description} escapes package root`);
  let cursor = root;
  for (const segment of relativePath.split(sep).filter(Boolean)) {
    cursor = join(cursor, segment);
    if (lstatOrNull(cursor)?.isSymbolicLink())
      throw new Error(`${description} is redirected by a symlink or junction`);
  }
}

/**
 * Confines an approved relative target twice: lexical paths cannot escape, and
 * every existing segment must remain a real, non-redirected child. Callers may
 * validate a generated target before it exists; its nearest existing ancestor
 * is checked now and the target itself is checked again before chmod/proof.
 */
export function confinedPackageTarget(
  packageRoot,
  relativePath,
  description,
  { mustExist = true, file = true } = {},
) {
  const candidate = resolve(packageRoot, relativePath);
  assertNoRedirectedPath(packageRoot, candidate, description);
  let existing = candidate;
  while (!lstatOrNull(existing)) {
    const parent = resolve(existing, '..');
    if (parent === existing)
      throw new Error(`${description} has no existing package ancestor`);
    existing = parent;
  }
  const realPackageRoot = realpathSync(packageRoot);
  const realExisting = realpathSync(existing);
  const fromRoot = relative(realPackageRoot, realExisting);
  if (
    fromRoot === '..' ||
    fromRoot.startsWith(`..${sep}`) ||
    resolve(realPackageRoot, fromRoot) !== realExisting
  )
    throw new Error(`${description} escapes package root`);
  const candidateStat = lstatOrNull(candidate);
  if (!candidateStat) {
    if (mustExist) {
      const absent = new Error(`missing ${description}`);
      absent.code = ARTIFACT_ABSENT;
      throw absent;
    }
    return candidate;
  }
  if (candidateStat.isSymbolicLink())
    throw new Error(`${description} is redirected by a symlink or junction`);
  const realCandidate = realpathSync(candidate);
  const fromRealRoot = relative(realPackageRoot, realCandidate);
  if (
    fromRealRoot === '..' ||
    fromRealRoot.startsWith(`..${sep}`) ||
    resolve(realPackageRoot, fromRealRoot) !== realCandidate
  )
    throw new Error(`${description} escapes package root`);
  if (file && !statSync(candidate).isFile())
    throw new Error(`${description} is not a file`);
  return realCandidate;
}

export function optionalPackageMayBeAbsent(
  root,
  entry,
  platform = process.platform,
  arch = process.arch,
) {
  if (entry.lock === 'pnpm-lock.yaml') {
    const meta =
      readPnpmLockfile(root).packages[`${entry.name}@${entry.version}`];
    return Boolean(
      meta &&
        !platformMatches(
          { platform: { os: meta.os ?? [], cpu: meta.cpu ?? [] } },
          platform,
          arch,
        ),
    );
  }
  const node = readLifecycleLocks(root).find(
    (candidate) => nodeIdentity(candidate) === nodeIdentity(entry),
  );
  return Boolean(node?.optional && !platformMatches(node, platform, arch));
}

/**
 * npm preserves the upstream node-pty macOS prebuild as a regular file even
 * though node-pty execs spawn-helper through its native addon. Restoring only
 * the executable bit is an explicit Station-owned post-install action, bound
 * to the exact allowlisted artifact path; it does not execute package code.
 */
export function prepareLifecycleArtifacts(
  root,
  entry,
  platform = process.platform,
  arch = process.arch,
) {
  if (
    entry.artifact.proof !== 'node-pty-smoke' ||
    platform === 'win32' ||
    !platformMatches(entry, platform, arch)
  )
    return;
  const packageRoot = installedPackagePath(root, entry);
  const paths = entry.artifact.platforms?.[`${platform}/${arch}`] ?? [];
  for (const path of paths.filter((path) => path.endsWith('spawn-helper'))) {
    const artifact = confinedPackageTarget(
      packageRoot,
      path,
      `lifecycle artifact for ${entry.lock}:${entry.path}: ${path}`,
    );
    chmodSync(artifact, statSync(artifact).mode | 0o111);
  }
}

export function preflightLifecycleArtifactTargets(
  root,
  entry,
  platform = process.platform,
  arch = process.arch,
) {
  if (!platformMatches(entry, platform, arch)) return;
  const packageRoot = installedPackagePath(root, entry);
  const artifactPaths = entry.artifact.platforms?.[`${platform}/${arch}`] ?? [
    entry.artifact.path
      .replaceAll('{platform}', platform)
      .replaceAll('{arch}', arch),
  ];
  for (const artifactPath of artifactPaths)
    confinedPackageTarget(
      packageRoot,
      artifactPath,
      `lifecycle artifact target for ${entry.lock}:${entry.path}: ${artifactPath}`,
      { mustExist: false },
    );
}

export function verifyArtifact(
  root,
  entry,
  platform = process.platform,
  arch = process.arch,
) {
  if (!platformMatches(entry, platform, arch))
    return {
      skipped: true,
      detail: `platform ${platform}/${arch} does not select ${entry.lock}:${entry.path}`,
    };
  const packageRoot = installedPackagePath(root, entry);
  const manifest = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  );
  if (manifest.version !== entry.version)
    throw new Error(`installed version drift for ${entry.lock}:${entry.path}`);
  const artifactPaths = entry.artifact.platforms?.[`${platform}/${arch}`] ?? [
    entry.artifact.path
      .replaceAll('{platform}', platform)
      .replaceAll('{arch}', arch),
  ];
  const artifacts =
    entry.artifact.proof === 'no-build-fallback'
      ? []
      : artifactPaths.map((artifactPath) => {
          const artifact = confinedPackageTarget(
            packageRoot,
            artifactPath,
            `lifecycle artifact for ${entry.lock}:${entry.path}: ${artifactPath}`,
          );
          return { path: artifactPath, absolute: artifact };
        });
  if (
    platform !== 'win32' &&
    artifacts.some(
      ({ path, absolute }) =>
        path.endsWith('spawn-helper') &&
        (statSync(absolute).mode & 0o111) === 0,
    )
  )
    throw new Error(
      `lifecycle spawn helper is not executable for ${entry.path}`,
    );
  if (entry.artifact.proof === 'esbuild-version') {
    const executable = artifacts[0].absolute;
    const contents = readFileSync(executable, 'utf8');
    const command = /^(#!.*\bnode|['"]use strict['"])/.test(contents)
      ? process.execPath
      : executable;
    const args =
      command === process.execPath ? [executable, '--version'] : ['--version'];
    const version = execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 10_000,
      windowsHide: true,
    }).trim();
    if (version !== entry.version)
      throw new Error(`esbuild artifact version drift for ${entry.path}`);
  }
  if (entry.artifact.proof === 'node-pty-smoke') {
    for (const artifact of artifacts.filter(({ path }) =>
      path.endsWith('.node'),
    ))
      createRequire(join(packageRoot, 'package.json'))(artifact.absolute);
    const module = createRequire(join(packageRoot, 'package.json'))(
      packageRoot,
    );
    if (typeof module.spawn !== 'function')
      throw new Error(
        `node-pty did not load its native smoke surface for ${entry.path}`,
      );
    verifyNodePtyHandshake(packageRoot);
  }
  if (entry.artifact.proof === 'fsevents-watch') {
    const module = createRequire(join(packageRoot, 'package.json'))(
      packageRoot,
    );
    if (typeof module.watch !== 'function')
      throw new Error(
        `fsevents did not load its native watch surface for ${entry.path}`,
      );
    const stop = module.watch(packageRoot, () => {});
    if (typeof stop !== 'function')
      throw new Error(
        `fsevents did not create a native watch for ${entry.path}`,
      );
    stop();
  }
  if (entry.artifact.proof === 'no-build-fallback')
    execFileSync(
      process.execPath,
      ['-e', 'require(process.argv[1])', entry.artifact.capability],
      { cwd: packageRoot, stdio: 'ignore', timeout: 10_000, windowsHide: true },
    );
  return {
    skipped: false,
    detail: `${entry.lock}:${entry.path}:${artifactPaths.join(',')}`,
  };
}

export function expectedLifecyclePurls(allowlist) {
  return [...new Set(allowlist.entries.map((entry) => entry.purl))].sort();
}

/**
 * #1244: which allowlist entries back a bounded product surface Station can
 * run without. node-pty is the only one — it powers interactive terminal
 * panes and nothing else, and it is the only Station dependency that needs a
 * C++ toolchain on Linux. For such an entry, a failed build or artifact
 * verification is reported as a LOUD capability degradation by the install
 * orchestrator instead of aborting the install; the runtime, `station
 * doctor`, and the system-status capability record then all carry the same
 * degraded-terminal reason. This deliberately trades the former install-time
 * "completed install has a working terminal" guarantee for installability on
 * toolchain-less hosts — the product decision recorded on the issue.
 *
 * The artifact PROOF itself stays fail-closed: `verifyArtifact` still throws,
 * and confinement/tamper preflights are never relaxed. Only the install
 * orchestrator consults this to decide that the failure degrades a
 * capability rather than the install.
 */
/**
 * The ONLY verifyArtifact failure a degradable capability may treat as
 * degradation: the artifact is simply not there, which is what a host with no
 * C++ toolchain produces. Every other throw from that function is a
 * trust-boundary result — a path escaping the package root, a symlink
 * redirect, installed-version drift, a non-file target, or a failed real-PTY
 * handshake — and those must keep aborting the install. Degrading them would
 * accept a tampered or mis-identified native module as merely "unavailable".
 */
export const ARTIFACT_ABSENT = 'station:lifecycle:artifact-absent';

export function isArtifactAbsent(error) {
  return error?.code === ARTIFACT_ABSENT;
}

export function degradableLifecycleCapability(entry) {
  if (entry?.artifact?.proof !== 'node-pty-smoke') return undefined;
  return {
    capability: 'terminal',
    consequence:
      'interactive terminal panes will be unavailable (agent execution is unaffected)',
    remediation:
      'install a C++ toolchain (g++, make, python3), run `npm run dependencies:install` in the Station checkout, then restart Station',
  };
}

// ── node-pty Linux prebuild staging (#1245) ─────────────────────────────

/**
 * Repository-relative home of the attested Linux prebuild channel. The
 * manifest pins the node-pty version and each artifact's sha256; an empty
 * `artifacts` map means no prebuild ships and every Linux install compiles
 * from source exactly as before. See packaging/node-pty-prebuilds/README.md
 * for the trust chain.
 */
export const NODE_PTY_PREBUILD_DIR = 'packaging/node-pty-prebuilds';
export const NODE_PTY_PREBUILD_TARGETS = Object.freeze([
  'linux-x64',
  'linux-arm64',
]);

export function readNodePtyPrebuildManifest(root) {
  const path = resolve(root, NODE_PTY_PREBUILD_DIR, 'manifest.json');
  if (!lstatOrNull(path)) return null;
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.package !== 'node-pty' ||
    typeof manifest.version !== 'string' ||
    !isObject(manifest.artifacts) ||
    !Object.entries(manifest.artifacts).every(
      ([target, record]) =>
        NODE_PTY_PREBUILD_TARGETS.includes(target) &&
        isObject(record) &&
        /^[0-9a-f]{64}$/.test(record.sha256 ?? ''),
    )
  )
    throw new Error('node-pty prebuild manifest is malformed');
  return manifest;
}

/**
 * The manifest and the allowlist must flip together: a target with a pinned
 * prebuild must be verified AT the prebuild path, and a target without one
 * must still be verified at the from-source build path. Any mixed state
 * would either verify a file staging never wrote or skip verifying the file
 * the loader actually uses, so it fails the whole policy check.
 */
export function assertNodePtyPrebuildConsistency(allowlist, manifest) {
  const entry = allowlist.entries?.find?.(
    (candidate) => candidate?.artifact?.proof === 'node-pty-smoke',
  );
  if (!entry) return;
  for (const target of NODE_PTY_PREBUILD_TARGETS) {
    const paths = entry.artifact.platforms?.[target.replace('-', '/')] ?? [];
    const pinned = Boolean(manifest?.artifacts?.[target]);
    const verifiedAtPrebuild = paths.includes(`prebuilds/${target}/pty.node`);
    if (pinned !== verifiedAtPrebuild)
      throw new Error(
        `node-pty prebuild manifest and allowlist disagree for ${target}: ` +
          (pinned
            ? 'a pinned prebuild exists but the allowlist still verifies build/Release/pty.node'
            : 'the allowlist expects a prebuild no manifest entry pins'),
      );
  }
  if (
    manifest &&
    Object.keys(manifest.artifacts).length > 0 &&
    manifest.version !== entry.version
  )
    throw new Error(
      `node-pty prebuild manifest pins version ${manifest.version} but the approved entry is ${entry.version}; rebuild the prebuilds`,
    );
}

/**
 * Stages the pinned, attested Linux prebuild into
 * `node_modules/node-pty/prebuilds/<target>/pty.node` BEFORE the approved
 * install hook runs, so upstream's `node scripts/prebuild.js || node-gyp
 * rebuild` takes its prebuild branch and no C++ toolchain is needed (#1245).
 *
 * Fail-closed rules: a digest mismatch is treated as tampering and aborts
 * the install; an absent manifest, absent target, or explicit
 * `npm_config_build_from_source=true` quietly keeps today's compile path.
 */
export function stageNodePtyPrebuild(
  root,
  entry,
  {
    platform = process.platform,
    arch = process.arch,
    env = process.env,
    manifest,
  } = {},
) {
  if (entry?.artifact?.proof !== 'node-pty-smoke')
    return { staged: false, reason: 'entry has no prebuild channel' };
  if (platform !== 'linux')
    return { staged: false, reason: `${platform} uses upstream prebuilds` };
  if (env.npm_config_build_from_source === 'true')
    return {
      staged: false,
      reason: 'npm_config_build_from_source requested a source build',
    };
  const resolved =
    manifest === undefined ? readNodePtyPrebuildManifest(root) : manifest;
  const target = `${platform}-${arch}`;
  const record = resolved?.artifacts?.[target];
  if (!record)
    return { staged: false, reason: `no pinned prebuild for ${target}` };
  if (resolved.version !== entry.version)
    throw new Error(
      `node-pty prebuild manifest pins ${resolved.version}, entry approves ${entry.version}`,
    );
  const source = resolve(root, NODE_PTY_PREBUILD_DIR, target, 'pty.node');
  if (!lstatOrNull(source))
    throw new Error(
      `manifest pins a prebuild that is not committed: ${target}`,
    );
  const digest = createHash('sha256')
    .update(readFileSync(source))
    .digest('hex');
  if (digest !== record.sha256)
    throw new Error(
      `node-pty prebuild digest mismatch for ${target}; refusing to stage a tampered artifact`,
    );
  const packageRoot = installedPackagePath(root, entry);
  const destination = confinedPackageTarget(
    packageRoot,
    `prebuilds/${target}/pty.node`,
    `staged node-pty prebuild for ${entry.path}`,
    { mustExist: false },
  );
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(source, destination);
  return { staged: true, target, sha256: digest };
}
