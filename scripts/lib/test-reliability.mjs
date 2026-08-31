import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { cpus, loadavg, totalmem } from 'node:os';
import {
  basename,
  delimiter,
  dirname,
  relative,
  resolve,
  sep,
} from 'node:path';
import { normalizeGitOrigin } from '@kontourai/station-contracts/git-remote-identity';
import { assertSupportedNode } from '../node-runtime-contract.mjs';
// probe(#1095): diagnostic no-op to select the same test:changed corpus. Revert.
import {
  PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV,
  productLawObservationTimeoutMs,
} from './product-laws.mjs';

const MAX_UNTRACKED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_UNTRACKED_TOTAL_BYTES = 256 * 1024 * 1024;

/**
 * Environment is intentionally not hashed wholesale: host credentials,
 * paths, and unrelated shell state must never enter a receipt identity or
 * artifact. These are the verified lane inputs that can change what tests or
 * the started Station process actually exercise.
 *
 * `STATION_E2E_*` setup/status values are assigned by run-e2e-suite itself,
 * while PW_BASE_URL/PW_API_BASE_URL/STATION_PORT are per-run ports and
 * PW_REPORTER changes rendering only, so none of those inherited values are
 * request inputs. STATION_HOME/Vitest isolation paths likewise change where
 * disposable state lives, not the asserted product behavior.
 */
export const VERIFICATION_BEHAVIOR_ENVIRONMENT = Object.freeze([
  // ci:fast selects affected tests against this explicit base. Including it
  // keeps a same-HEAD receipt from being reused for a different diff range.
  'STATION_CI_FAST_BASE',
  'STATION_E2E_SEED_REGRESSION',
  'STATION_FEATURES',
  'STATION_SERVICE_ITEST',
  PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV,
]);

/**
 * Returns a non-secret identity for the allowlisted behavior toggles. Raw
 * values never leave the process: only this digest is stored in a receipt or
 * used for host-wide execution equivalence.
 */
export function digestVerificationEnvironment(env = process.env) {
  const identity = VERIFICATION_BEHAVIOR_ENVIRONMENT.map((name) => [
    name,
    name === PRODUCT_LAW_OBSERVATION_TIMEOUT_ENV
      ? productLawObservationTimeoutMs(env)
      : typeof env[name] === 'string'
        ? env[name]
        : null,
  ]);
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

function runGit(args, { cwd = process.cwd() } = {}) {
  const result = spawnSync('git', args, {
    cwd,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(' ')} exited with status ${result.status}`,
    );
  }
  return result.stdout;
}

/**
 * Adds one untracked regular file to a provenance hash without following
 * symlinks and while enforcing bounded total input.
 */
export function updateHashFromRegularFile(
  hash,
  file,
  total,
  {
    maxFileBytes = MAX_UNTRACKED_FILE_BYTES,
    maxTotalBytes = MAX_UNTRACKED_TOTAL_BYTES,
    lstat = lstatSync,
    open = openSync,
    fstat = fstatSync,
    read = readSync,
    close = closeSync,
  } = {},
) {
  const pathStat = lstat(file);
  if (!pathStat.isFile()) {
    throw new Error(`untracked provenance path is not a regular file: ${file}`);
  }
  if (pathStat.size > maxFileBytes) {
    throw new Error(
      `untracked provenance file exceeds its byte limit: ${file}`,
    );
  }
  if (total.bytes + pathStat.size > maxTotalBytes) {
    throw new Error('untracked provenance files exceed their total byte limit');
  }

  const descriptor = open(file, 'r');
  try {
    const openedStat = fstat(descriptor);
    if (
      !openedStat.isFile() ||
      openedStat.dev !== pathStat.dev ||
      openedStat.ino !== pathStat.ino ||
      openedStat.size !== pathStat.size
    ) {
      throw new Error(
        `untracked provenance file changed while opening: ${file}`,
      );
    }
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let fileBytes = 0;
    let bytesRead;
    do {
      bytesRead = read(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead > 0) {
        fileBytes += bytesRead;
        total.bytes += bytesRead;
        if (fileBytes > maxFileBytes) {
          throw new Error(
            `untracked provenance file exceeded its byte limit while reading: ${file}`,
          );
        }
        if (total.bytes > maxTotalBytes) {
          throw new Error(
            'untracked provenance files exceeded their total byte limit while reading',
          );
        }
        hash.update(chunk.subarray(0, bytesRead));
      }
    } while (bytesRead > 0);

    const finalStat = fstat(descriptor);
    if (
      finalStat.size !== openedStat.size ||
      finalStat.mtimeMs !== openedStat.mtimeMs ||
      fileBytes !== openedStat.size
    ) {
      throw new Error(
        `untracked provenance file changed while reading: ${file}`,
      );
    }
  } finally {
    close(descriptor);
  }
}

/**
 * Captures only workspace identity. Lanes add their own metadata rather than
 * silently making a pre-push receipt vocabulary part of every consumer.
 *
 * Every git command and untracked-file read is rooted at the Git top-level
 * (resolved from `cwd`), never at `process.cwd()`. Rooting at the top-level
 * makes the digest independent of the caller's subdirectory: `git ls-files`
 * from a subdirectory lists only that subtree, and untracked paths arrive
 * relative to the invocation directory, so a coordinator that does not `cd`
 * to the repo root would otherwise hash a different (smaller) file set and
 * derive a different `workspaceDigest` than a root invocation. The top-level
 * resolves to the same path regardless of which subdirectory `cwd` points at,
 * so collecting from the root and from `scripts/` produces matching stable
 * provenance fields.
 */
export function collectWorkspaceProvenance({ cwd = process.cwd() } = {}) {
  const repositoryRoot = realpathSync(
    resolve(
      runGit(['rev-parse', '--show-toplevel'], { cwd }).toString('utf8').trim(),
    ),
  );
  const headSha = runGit(['rev-parse', 'HEAD'], { cwd: repositoryRoot })
    .toString('utf8')
    .trim();
  const status = runGit(
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    { cwd: repositoryRoot },
  );
  const diff = runGit(['diff', '--binary', 'HEAD', '--'], {
    cwd: repositoryRoot,
  });
  const untracked = runGit(
    ['ls-files', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryRoot },
  )
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .sort();
  const workspaceHash = createHash('sha256').update(diff);
  const total = { bytes: 0 };
  for (const file of untracked) {
    workspaceHash.update('\0').update(file).update('\0');
    // `file` is relative to the top-level; resolve it before reading so the
    // open succeeds regardless of the caller's actual working directory.
    updateHashFromRegularFile(
      workspaceHash,
      resolve(repositoryRoot, file),
      total,
    );
  }

  return {
    headSha,
    dirty: status.length > 0,
    workspaceDigest: workspaceHash.digest('hex'),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    machine: machineConditions(),
  };
}

/**
 * Normalizes a git remote URL to a canonical, clone-path-independent form so
 * the same repository cloned over SSH, HTTPS, or with `.git`/credentials
 * derives one stable identity. Returns the empty string for a non-URL/empty
 * input (the caller then falls back to the common git directory).
 *
 * station#1498 slice 1: this function's body moved to
 * `packages/contracts/src/git-remote-identity.ts` (`docs/design/
 * portable-project-identity.md` §2.4, §3.3) — the manifest/binding contract
 * needs the same canonicalization this file already proved correct, so it is
 * promoted to a shared, tested home rather than duplicated. This file
 * re-exports it verbatim; `collectRepositoryIdentity` below keeps using it
 * unchanged. Imported (not `export ... from`) so this file's own reference
 * to `normalizeGitOrigin` below resolves to a real local binding — a bare
 * re-export statement does not introduce one.
 *
 * NEW DEPENDENCY this introduced: before #1498 this module imported only
 * `node:` builtins and ran from any checkout without `npm ci`. It now
 * requires an installed workspace, because that specifier resolves through
 * `node_modules/@kontourai/station-contracts`. Every failure mode is a hard
 * module-load error (never a silent fallback), and the child-process cases
 * in `scripts/__tests__/verification-receipt.test.ts` assert `status === 0`,
 * so a regression surfaces immediately — but on a wrong Node the operator
 * now sees `Unknown file extension ".ts"` instead of the node-runtime
 * contract's "Station requires Node.js 24.x", because ESM linking happens
 * before `assertSupportedNode()` runs. Accepted and disclosed (#1498 review,
 * MEDIUM-3), not fixed here.
 */
export { normalizeGitOrigin };

const npmVersionCache = new Map();

export class VerificationToolchainError extends Error {
  constructor(message) {
    super(`verification toolchain setup error: ${message}`);
    this.name = 'VerificationToolchainError';
  }
}

function regularRealPath(path) {
  try {
    const resolved = realpathSync(path);
    return lstatSync(resolved).isFile() ? resolved : null;
  } catch {
    return null;
  }
}

function toolchainFileIdentity(path, { contentDigest = false } = {}) {
  const resolved = regularRealPath(path);
  if (!resolved)
    throw new VerificationToolchainError(
      `toolchain executable is not a regular file: ${path}`,
    );
  const stat = lstatSync(resolved);
  const identity = {
    path: resolved,
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
  };
  if (contentDigest)
    identity.sha256 = createHash('sha256')
      .update(readFileSync(resolved))
      .digest('hex');
  return identity;
}

function exactToolchainIdentity(nodeExecutable, npmExecutable) {
  const identity = {
    node: toolchainFileIdentity(nodeExecutable),
    npm: toolchainFileIdentity(npmExecutable, { contentDigest: true }),
  };
  return Object.freeze({
    ...identity,
    digest: createHash('sha256').update(JSON.stringify(identity)).digest('hex'),
  });
}

export function assertVerificationToolchain(toolchain) {
  if (
    !toolchain?.nodeExecutable ||
    !toolchain?.npmExecutable ||
    !toolchain?.identity
  )
    throw new VerificationToolchainError(
      'missing bound Node/npm executable identity',
    );
  const actual = exactToolchainIdentity(
    toolchain.nodeExecutable,
    toolchain.npmExecutable,
  );
  if (actual.digest !== toolchain.identity.digest)
    throw new VerificationToolchainError(
      'the bound Node/npm executable identity changed after request admission',
    );
  return actual;
}

export function verificationExecutionEnvironment(toolchain, env = process.env) {
  const identity = assertVerificationToolchain(toolchain);
  const nodeDirectory = dirname(identity.node.path);
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH');
  const inheritedPath = pathKey ? env[pathKey] : undefined;
  const scoped = { ...env };
  if (pathKey && pathKey !== 'PATH') delete scoped[pathKey];
  scoped.PATH = [nodeDirectory, inheritedPath]
    .filter((value) => typeof value === 'string' && value.length > 0)
    .join(delimiter);
  return scoped;
}

function npmEntrypointsForNode(nodeExecutable) {
  const nodeDirectory = dirname(nodeExecutable);
  return [
    resolve(nodeDirectory, '../lib/node_modules/npm/bin/npm-cli.js'),
    resolve(nodeDirectory, '../node_modules/npm/bin/npm-cli.js'),
    resolve(nodeDirectory, 'node_modules/npm/bin/npm-cli.js'),
  ];
}

function npmEntrypointsFromPath(env) {
  const names = process.platform === 'win32' ? ['npm.cmd', 'npm'] : ['npm'];
  const candidates = [];
  for (const directory of String(env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    for (const name of names) {
      const executable = regularRealPath(resolve(directory, name));
      if (!executable) continue;
      if (process.platform === 'win32')
        candidates.push(
          resolve(dirname(executable), 'node_modules/npm/bin/npm-cli.js'),
        );
      else candidates.push(executable);
    }
  }
  return candidates;
}

/**
 * Resolves the exact Node executable that owns this coordinator and a JavaScript
 * npm entrypoint that it can execute directly. The lookup may discover npm on
 * PATH, but it never executes its shebang: every child is started by the
 * attested Node executable. This prevents an ambient Node/npm pair from
 * silently changing a phase's runtime after request provenance is recorded.
 */
export function resolveVerificationToolchain({
  cwd = process.cwd(),
  nodeExecutable = process.execPath,
  npmEntrypoint,
  env = process.env,
} = {}) {
  try {
    assertSupportedNode();
  } catch (error) {
    throw new VerificationToolchainError(
      error instanceof Error ? error.message : String(error),
    );
  }
  const node = regularRealPath(nodeExecutable);
  if (!node)
    throw new VerificationToolchainError(
      `the submitting Node executable is not a regular file: ${nodeExecutable}`,
    );
  const nodeVersionProbe = spawnSync(node, ['--version'], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  const nodeVersion =
    nodeVersionProbe.status === 0 && typeof nodeVersionProbe.stdout === 'string'
      ? nodeVersionProbe.stdout.trim()
      : '';
  if (nodeVersion !== process.version)
    throw new VerificationToolchainError(
      `the Node executable at ${node} reports ${nodeVersion || 'no version'} instead of the submitting parent ${process.version}`,
    );
  const npm = [
    ...(npmEntrypoint
      ? [npmEntrypoint]
      : [...npmEntrypointsForNode(node), ...npmEntrypointsFromPath(env)]),
  ]
    .map(regularRealPath)
    .find(Boolean);
  if (!npm)
    throw new VerificationToolchainError(
      'could not resolve an npm JavaScript entrypoint for the submitting Node executable',
    );
  const version = spawnSync(node, [npm, '--version'], {
    cwd,
    env,
    encoding: 'utf8',
    windowsHide: true,
  });
  const npmVersion =
    version.status === 0 && typeof version.stdout === 'string'
      ? version.stdout.trim()
      : '';
  if (!/^\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?$/.test(npmVersion))
    throw new VerificationToolchainError(
      `the npm entrypoint at ${npm} did not report a valid version under ${node}`,
    );
  const identity = exactToolchainIdentity(node, npm);
  return Object.freeze({
    nodeExecutable: identity.node.path,
    npmExecutable: identity.npm.path,
    toolchain: `npm@${npmVersion}`,
    identity,
  });
}

/**
 * Detects the installed npm version once (cached). Returns null if npm cannot
 * be invoked, so the toolchain identity degrades honestly rather than throwing.
 */
export function detectNpmVersion({ cwd = process.cwd() } = {}) {
  const cacheKey = resolve(cwd);
  if (npmVersionCache.has(cacheKey)) return npmVersionCache.get(cacheKey);
  let version;
  try {
    const result = spawnSync('npm', ['--version'], {
      cwd: cacheKey,
      encoding: 'utf8',
      windowsHide: true,
    });
    version =
      result.status === 0 && result.stdout ? result.stdout.trim() : null;
  } catch {
    version = null;
  }
  npmVersionCache.set(cacheKey, version);
  return version;
}

export function resetToolchainCacheForTesting() {
  npmVersionCache.clear();
}

/**
 * Toolchain identity captures the package manager by name and version — it
 * must not duplicate the Node version (already its own request field) so a
 * package-manager change (e.g. npm 10 → 11) actually invalidates a receipt.
 */
export function detectToolchainIdentity({ cwd = process.cwd() } = {}) {
  const npmVersion = detectNpmVersion({ cwd });
  return npmVersion ? `npm@${npmVersion}` : 'npm@unknown';
}

/**
 * Resolves immutable repository identity and this worktree's real path. The
 * repository identity is derived from the normalized origin URL, so it is
 * independent of where the repository happens to be cloned; the common git
 * directory is used only as a fallback for a local repository with no origin.
 *
 * Accepts an optional `cwd` so the git root resolves correctly even when the
 * caller is in a subdirectory — `--git-common-dir` is resolved against that
 * directory because git emits it relative to the invocation directory.
 */
export function collectRepositoryIdentity({ cwd = process.cwd() } = {}) {
  const toplevelRaw = runGit(['rev-parse', '--show-toplevel'], {
    cwd,
  })
    .toString('utf8')
    .trim();
  const repositoryRoot = realpathSync(resolve(cwd, toplevelRaw));
  const commonDirRaw = runGit(['rev-parse', '--git-common-dir'], {
    cwd,
  })
    .toString('utf8')
    .trim();
  const commonGitDirectory = realpathSync(resolve(cwd, commonDirRaw));
  let origin = '';
  try {
    origin = runGit(['config', '--get', 'remote.origin.url'], {
      cwd,
    })
      .toString('utf8')
      .trim();
  } catch {
    // A local-only repository has no origin; fall back to the common git dir.
  }
  const normalizedOrigin = normalizeGitOrigin(origin);
  const repositoryId = normalizedOrigin
    ? createHash('sha256').update(normalizedOrigin).digest('hex')
    : createHash('sha256').update(commonGitDirectory).digest('hex');
  return {
    repositoryId,
    repositoryRoot,
    // Git's top-level is stable when the caller starts from a subdirectory.
    worktree: repositoryRoot,
    commonGitDirectory,
    origin: normalizedOrigin,
  };
}

/** Returns a digest of a required regular repository file. */
export function digestRepositoryFile(path) {
  const stat = lstatSync(path);
  if (!stat.isFile()) {
    throw new Error(`repository digest input is not a regular file: ${path}`);
  }
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/**
 * Station's receipt-specific provenance projection. It extends, rather than
 * changes, the schema-v2 neutral workspace helper consumed by pre-push. The
 * toolchain defaults to the detected package-manager identity (name@version)
 * rather than duplicating the Node version.
 *
 * The lockfile defaults to the repository-root `package-lock.json`, resolved
 * from the Git toplevel — not `process.cwd()`. A subdirectory invocation (the
 * common case for a coordinator that does not `cd` to the repo root) must
 * digest the same lockfile as a root invocation, or its `dependencyDigest`
 * would point at a file that does not exist and silently invalidate every
 * receipt. `collectRepositoryIdentity` resolves the toplevel correctly even
 * when the caller is in a subdirectory.
 */
export function collectVerificationProvenance({
  cwd = process.cwd(),
  lockfile,
  toolchain,
  toolchainIdentity,
  env = process.env,
} = {}) {
  const repository = collectRepositoryIdentity({ cwd });
  const resolvedToolchain =
    toolchainIdentity ?? resolveVerificationToolchain({ cwd, env });
  const exactToolchain = assertVerificationToolchain(resolvedToolchain);
  // Root workspace collection at the resolved repository root so a
  // subdirectory invocation derives the same workspaceDigest as a root one.
  const workspace = collectWorkspaceProvenance({
    cwd: repository.repositoryRoot,
  });
  return {
    ...repository,
    ...workspace,
    dependencyDigest: digestRepositoryFile(
      lockfile
        ? resolve(cwd, lockfile)
        : resolve(repository.repositoryRoot, 'package-lock.json'),
    ),
    toolchain: toolchain ?? resolvedToolchain.toolchain,
    toolchainIdentity: exactToolchain,
    environmentDigest: digestVerificationEnvironment(env),
    // This finite, non-secret effective value is also represented in the
    // environment digest. Recording it makes any weaker passing policy visible.
    productLawObservationTimeoutMs: productLawObservationTimeoutMs(env),
  };
}

/**
 * What the box was doing while the run happened.
 *
 * Reliability receipts recorded the tree and the runtime but nothing about
 * contention, which is why an entire round of flake measurement had to be
 * thrown away (#844): the numbers looked like a flaky suite and were actually a
 * machine at load 11.7 with 37 competing processes, and nothing in the receipt
 * said so. A rate measured on a saturated box is not a rate — recording this
 * makes a contaminated run identifiable afterwards instead of quietly
 * comparable with a clean one.
 *
 * This reports `loadPerCpu` rather than a saturated/not-saturated verdict on
 * purpose. The contaminated round in #844 sat at load 11.7 on a 15-core box —
 * about 0.78 per core, which any "load > cores" rule would have waved through
 * while the results were already worthless. Rather than invent a threshold I
 * cannot defend, this records the ratio and leaves the judgement to whoever
 * compares two runs.
 */
export function machineConditions() {
  const [load1, load5, load15] = loadavg();
  const cpuCount = cpus().length;
  return {
    cpuCount,
    totalMemoryBytes: totalmem(),
    loadAverage: { 1: round2(load1), 5: round2(load5), 15: round2(load15) },
    loadPerCpu: cpuCount > 0 ? round2(load1 / cpuCount) : null,
  };
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

function identity(stat) {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Preflights a contained receipt path and returns directory identities to
 * revalidate immediately before publication. This narrows the unavoidable
 * pathname race around atomic rename and rejects directory/symlink targets.
 */
export function preflightReceiptDestination(
  output,
  receiptRoot = process.cwd(),
) {
  const root = resolve(receiptRoot);
  const rootStat = lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error(`receipt root is not a real directory: ${root}`);
  }
  const outputPath = resolve(root, output);
  const outputDirectory = dirname(outputPath);
  const contained = relative(root, outputDirectory);
  if (contained === '..' || contained.startsWith(`..${sep}`)) {
    throw new Error('receipt path must stay within the repository');
  }
  let current = root;
  const directories = [{ path: current, identity: identity(rootStat) }];
  for (const part of contained.split(sep).filter(Boolean)) {
    current = resolve(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    const currentStat = lstatSync(current);
    if (currentStat.isSymbolicLink()) {
      throw new Error(`receipt path contains a symbolic link: ${current}`);
    }
    if (!currentStat.isDirectory()) {
      throw new Error(`receipt path component is not a directory: ${current}`);
    }
    directories.push({ path: current, identity: identity(currentStat) });
  }
  if (existsSync(outputPath)) {
    const outputStat = lstatSync(outputPath);
    if (outputStat.isSymbolicLink()) {
      throw new Error(`receipt destination is a symbolic link: ${outputPath}`);
    }
    if (!outputStat.isFile()) {
      throw new Error(
        `receipt destination is not a regular file: ${outputPath}`,
      );
    }
  }
  return { root, outputPath, outputDirectory, directories };
}

function assertPrivateReceiptDirectory(stat, path) {
  // Node exposes synthetic POSIX mode/uid values on Windows; chmod does not
  // describe the directory's ACL and checking those bits rejects every valid
  // native-Windows destination. The path is still constrained beneath the
  // repository and revalidated by file identity before commit.
  if (process.platform === 'win32') return;
  if ((stat.mode & 0o777) !== 0o700) {
    throw new Error(`receipt directory is not mode 0700: ${path}`);
  }
  if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`receipt directory is not owned by this user: ${path}`);
  }
}

function revalidateReceiptDestination(destination, directoryDescriptor) {
  for (const directory of destination.directories) {
    const current = lstatSync(directory.path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      !sameIdentity(identity(current), directory.identity)
    ) {
      throw new Error(
        `receipt directory changed while writing: ${directory.path}`,
      );
    }
  }
  const outputDirectoryStat = lstatSync(destination.outputDirectory);
  assertPrivateReceiptDirectory(
    outputDirectoryStat,
    destination.outputDirectory,
  );
  if (directoryDescriptor !== undefined) {
    const heldDirectoryStat = fstatSync(directoryDescriptor);
    const expectedDirectory = destination.directories.at(-1).identity;
    if (
      !heldDirectoryStat.isDirectory() ||
      !sameIdentity(identity(heldDirectoryStat), expectedDirectory) ||
      !sameIdentity(identity(outputDirectoryStat), expectedDirectory)
    ) {
      throw new Error(
        `receipt directory identity changed before commit: ${destination.outputDirectory}`,
      );
    }
    assertPrivateReceiptDirectory(
      heldDirectoryStat,
      destination.outputDirectory,
    );
  }
  if (existsSync(destination.outputPath)) {
    const outputStat = lstatSync(destination.outputPath);
    if (outputStat.isSymbolicLink() || !outputStat.isFile()) {
      throw new Error(
        `receipt destination changed while writing: ${destination.outputPath}`,
      );
    }
  }
}

/**
 * Atomically replaces a repository-local receipt without following symlinks.
 */
export function writeReceiptSecurely(
  output,
  contents,
  receiptRoot = process.cwd(),
) {
  const destination = preflightReceiptDestination(output, receiptRoot);
  const { outputPath, outputDirectory } = destination;
  let directoryDescriptor;
  if (process.platform !== 'win32') {
    directoryDescriptor = openSync(
      outputDirectory,
      constants.O_RDONLY |
        (constants.O_DIRECTORY ?? 0) |
        (constants.O_NOFOLLOW ?? 0),
    );
    const directoryStat = fstatSync(directoryDescriptor);
    const expectedDirectory = destination.directories.at(-1).identity;
    if (
      !directoryStat.isDirectory() ||
      !sameIdentity(identity(directoryStat), expectedDirectory)
    ) {
      closeSync(directoryDescriptor);
      throw new Error(
        `receipt directory changed while opening: ${outputDirectory}`,
      );
    }
    // The receipt directory is the security boundary for the unavoidable
    // pathname-based rename below. Keep its stable descriptor open through
    // commit and make it non-writable by group/other.
    fchmodSync(directoryDescriptor, 0o700);
    assertPrivateReceiptDirectory(
      fstatSync(directoryDescriptor),
      outputDirectory,
    );
  } else {
    chmodSync(outputDirectory, 0o700);
  }

  const tempPath = resolve(
    outputDirectory,
    `.${basename(outputPath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(tempPath, 'wx', 0o600);
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    // Apply the private mode through the open descriptor so the temporary path
    // is not followed between creation and permission tightening.
    fchmodSync(descriptor, 0o600);
    closeSync(descriptor);
    descriptor = undefined;
    revalidateReceiptDestination(destination, directoryDescriptor);
    renameSync(tempPath, outputPath);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    if (existsSync(tempPath)) unlinkSync(tempPath);
    if (directoryDescriptor !== undefined) closeSync(directoryDescriptor);
  }
}

/**
 * Produces the stable aggregate used by reliability receipts.
 */
export function summarizeAttempts(attempts) {
  const passed = attempts.filter(
    (attempt) => attempt.status === 'passed',
  ).length;
  // `failed` is read from the reported status, never derived as
  // `attempts - passed`: an attempt is `passed`, `failed`, or
  // `infrastructure_error`, so the subtraction silently reported infrastructure
  // errors inside a field every consumer reads as the test-failure count
  // (station#1741, the same shape as station#1737 one layer up).
  const testFailures = attempts.filter(
    (attempt) => attempt.status === 'failed',
  ).length;
  const durations = attempts.map((attempt) => attempt.durationMs);
  return {
    attempts: attempts.length,
    passed,
    failed: testFailures,
    testFailures,
    infrastructureErrors: attempts.filter(
      (attempt) => attempt.status === 'infrastructure_error',
    ).length,
    passRate: attempts.length === 0 ? 0 : passed / attempts.length,
    durationMs: durations.reduce((total, duration) => total + duration, 0),
    slowestAttemptMs: durations.length === 0 ? 0 : Math.max(...durations),
  };
}
