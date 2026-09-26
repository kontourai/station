import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPackagedReleaseManifest } from './container-release-metadata.mjs';
import {
  NON_RUNTIME_ARTIFACT,
  stageDesktopServerRuntime,
} from './desktop-server-runtime.mjs';
import { STATION_SERVER_EXTERNALS } from './server-build-config.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORTABLE_NODE_RUNTIME_CONFIG = join(
  'config',
  'portable-server-node-runtime.json',
);
const LAUNCHER_SOURCE = join('packaging', 'portable-server', 'bin');
/** The archive's single top-level directory, as in the source portable. */
export const PORTABLE_ARCHIVE_ROOT = 'station';
const SHA256 = /^[0-9a-f]{64}$/;

/**
 * Each supported `${process.platform}-${process.arch}`. A portable archive
 * carries platform-specific native modules copied from the build host's
 * install, so it is only ever built for the host it runs on.
 */
export const PORTABLE_SERVER_TARGETS = Object.freeze({
  'darwin-arm64': { format: 'tar.gz' },
  'darwin-x64': { format: 'tar.gz' },
  'linux-arm64': { format: 'tar.gz' },
  'linux-x64': { format: 'tar.gz' },
  'win32-x64': { format: 'zip' },
});

export function readPortableNodeRuntime(projectRoot = REPO_ROOT) {
  const config = JSON.parse(
    readFileSync(join(projectRoot, PORTABLE_NODE_RUNTIME_CONFIG), 'utf8'),
  );
  if (config?.schemaVersion !== 1 || typeof config.version !== 'string') {
    throw new Error(
      `${PORTABLE_NODE_RUNTIME_CONFIG} must declare schemaVersion 1 and a version`,
    );
  }
  return config;
}

export function resolvePortableServerTarget(
  platform,
  arch,
  runtime = readPortableNodeRuntime(),
) {
  const id = `${platform}-${arch}`;
  const target = PORTABLE_SERVER_TARGETS[id];
  if (!target) {
    throw new Error(
      `No portable server archive is defined for ${id}; supported: ${Object.keys(PORTABLE_SERVER_TARGETS).join(', ')}`,
    );
  }
  const distribution = runtime.distributions?.[id];
  if (
    typeof distribution?.file !== 'string' ||
    !SHA256.test(distribution.sha256 ?? '')
  ) {
    throw new Error(
      `${PORTABLE_NODE_RUNTIME_CONFIG} has no pinned Node.js distribution for ${id}`,
    );
  }
  const windows = platform === 'win32';
  return {
    id,
    platform,
    format: target.format,
    archiveName: `station-server-${id}.${target.format}`,
    node: {
      version: runtime.version,
      url: new URL(distribution.file, runtime.origin).href,
      file: distribution.file,
      sha256: distribution.sha256,
      // Official distributions unpack into a directory named after the file.
      directory: distribution.file.replace(/\.(?:tar\.gz|zip)$/, ''),
      binary: windows ? 'node.exe' : join('bin', 'node'),
    },
    launcher: windows ? join('bin', 'station.cmd') : join('bin', 'station'),
  };
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256File(path) {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * Reads a Node.js distribution once and returns those exact bytes only when
 * they match the pinned digest. Callers use the returned bytes, never the
 * path again, so the file cannot change between the check and its use.
 */
function readVerifiedDistribution(path, expectedSha256) {
  const bytes = readFileSync(path);
  const actual = sha256Hex(bytes);
  if (actual !== expectedSha256) {
    throw new Error(
      `${path} has sha256 ${actual}; the pinned Node.js distribution is ${expectedSha256}`,
    );
  }
  return bytes;
}

/**
 * Returns the verified bytes of the pinned Node.js distribution. A cached or
 * caller-supplied file is re-verified every time: the pin, not the cache, is
 * the trust root. A download is verified before it becomes the cache.
 *
 * @param {{ node: { file: string, url: string, sha256: string } }} target
 * @param {{
 *   cacheDir: string,
 *   nodeDistribution?: string,
 *   fetchImpl?: (url: string) => Promise<Response>,
 * }} options
 */
export async function obtainNodeDistribution(
  target,
  { cacheDir, nodeDistribution, fetchImpl = fetch },
) {
  if (nodeDistribution) {
    return readVerifiedDistribution(nodeDistribution, target.node.sha256);
  }
  mkdirSync(cacheDir, { recursive: true });
  const cached = join(cacheDir, target.node.file);
  if (existsSync(cached)) {
    return readVerifiedDistribution(cached, target.node.sha256);
  }
  const response = await fetchImpl(target.node.url);
  if (!response.ok) {
    throw new Error(
      `Downloading ${target.node.url} failed with HTTP ${response.status}`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = sha256Hex(bytes);
  if (actual !== target.node.sha256) {
    throw new Error(
      `${target.node.url} has sha256 ${actual}; the pinned Node.js distribution is ${target.node.sha256}`,
    );
  }
  const partial = `${cached}.partial`;
  writeFileSync(partial, bytes);
  renameSync(partial, cached);
  return bytes;
}

/**
 * bsdtar reads and writes both formats. On Windows use the one shipped in
 * System32 by path: a Git-for-Windows GNU tar earlier on PATH cannot read zip
 * and misparses drive-letter paths.
 */
export function archiveTool(platform = process.platform, env = process.env) {
  return platform === 'win32'
    ? join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    : 'tar';
}

let tarFlavor;
/** GNU tar (Linux runners) and bsdtar (macOS, Windows) spell options apart. */
function isGnuTar() {
  tarFlavor ??= execFileSync(archiveTool(), ['--version'], {
    encoding: 'utf8',
    windowsHide: true,
  }).includes('GNU tar')
    ? 'gnu'
    : 'bsd';
  return tarFlavor === 'gnu';
}

/**
 * Entries record root ownership with no user or group names, so the archive
 * does not carry the build runner's account and extraction by an ordinary
 * user never tries to assign it.
 */
function normalizedOwnershipArgs() {
  return isGnuTar()
    ? ['--owner=0', '--group=0', '--numeric-owner']
    : ['--uid', '0', '--gid', '0', '--numeric-owner'];
}

function runTar(args, options = {}) {
  execFileSync(archiveTool(), args, {
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
    ...options,
    // macOS bsdtar otherwise records AppleDouble `._*` metadata entries.
    env: { ...process.env, COPYFILE_DISABLE: '1', ...options.env },
  });
}

function stageNodeRuntime(target, distributionBytes, runtimeDir) {
  // Extract from a private copy written from the verified bytes, never by
  // reopening the path that was hashed.
  const scratch = mkdtempSync(join(tmpdir(), 'station-node-extract-'));
  try {
    const distribution = join(scratch, target.node.file);
    writeFileSync(distribution, distributionBytes, { mode: 0o600 });
    const members = [
      `${target.node.directory}/${target.node.binary.replaceAll('\\', '/')}`,
      `${target.node.directory}/LICENSE`,
    ];
    runTar(['-xf', distribution, '-C', scratch, ...members]);
    const unpacked = join(scratch, target.node.directory);
    mkdirSync(join(runtimeDir, dirname(target.node.binary)), {
      recursive: true,
    });
    cpSync(
      join(unpacked, target.node.binary),
      join(runtimeDir, target.node.binary),
    );
    chmodSync(join(runtimeDir, target.node.binary), 0o755);
    cpSync(join(unpacked, 'LICENSE'), join(runtimeDir, 'LICENSE'));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function pruneNonRuntimeArtifacts(root) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) pruneNonRuntimeArtifacts(path);
    else if (NON_RUNTIME_ARTIFACT.test(entry.name)) rmSync(path);
  }
}

function stageLaunchers(projectRoot, stageRoot) {
  const source = join(projectRoot, LAUNCHER_SOURCE);
  const bin = join(stageRoot, 'bin');
  mkdirSync(bin, { recursive: true });
  cpSync(join(source, 'station'), join(bin, 'station'));
  chmodSync(join(bin, 'station'), 0o755);
  cpSync(join(source, 'station.mjs'), join(bin, 'station.mjs'));
  // cmd.exe mis-parses blocks in LF-only batch files, and the repository
  // checks every text file out as LF (.gitattributes), so write CRLF here.
  const cmd = readFileSync(join(source, 'station.cmd'), 'utf8');
  writeFileSync(join(bin, 'station.cmd'), cmd.replace(/\r?\n/g, '\r\n'));
}

/**
 * Bundles the CLI that `./station` runs from a checkout
 * (scripts/station-cli.ts) into `lib/station-cli.mjs`, so the archive runs
 * `station start`, `stop` and `service` without tsx or a source tree.
 *
 * Deliberately not the published `@kontourai/station-cli` bundle
 * (`packages/cli/dist/station.mjs`): that is the client tier, and
 * packages/cli/src/distribution.ts refuses every lifecycle verb in it. The
 * externals are the server build's, so the CLI and the server resolve the
 * same staged node_modules closure.
 */
async function bundleStationCli(projectRoot, stageRoot) {
  const esbuild = await import('esbuild');
  await esbuild.build({
    absWorkingDir: projectRoot,
    entryPoints: [join(projectRoot, 'scripts', 'station-cli.ts')],
    outfile: join(stageRoot, 'lib', 'station-cli.mjs'),
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    minify: true,
    keepNames: true,
    external: STATION_SERVER_EXTERNALS,
    banner: {
      js: "import { createRequire as __stationCreateRequire } from 'node:module'; const require = __stationCreateRequire(import.meta.url);",
    },
    logLevel: 'warning',
  });
}

/**
 * The build manifest `station start` compares the served identity against.
 * It is the shape lifecycle.ts's `validateBuildManifest` accepts, filled the
 * way its `resolveSourceBuildManifest` fills it for a packaged release tree:
 * the release SHA, with the release ref as the branch.
 */
function writeServerBuildManifest(serverDir, release) {
  writeFileSync(
    join(serverDir, 'station-build.json'),
    `${JSON.stringify({ sha: release.sha, branch: release.ref, builtAt: release.createdAt }, null, 2)}\n`,
  );
}

/** Every staged entry takes the release time, so rebuilds differ only in content. */
function normalizeMtimes(root, time) {
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) pending.push(path);
      utimesSync(path, time, time);
    }
  }
  utimesSync(root, time, time);
}

function treeFootprint(root) {
  let files = 0;
  let bytes = 0;
  let longestPath = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      files += 1;
      bytes += lstatSync(path).size;
      longestPath = Math.max(longestPath, path.length - root.length);
    }
  }
  return { files, bytes, longestRelativePath: longestPath };
}

/**
 * Assembles the extracted archive tree at `stageRoot`:
 *
 *   .station-release.json   provenance (the installer's schemaVersion 2 shape)
 *   bin/station[.cmd]       launcher that runs runtime/, never a host Node
 *   bin/station.mjs         entry: release identity for --version, else the CLI
 *   lib/station-cli.mjs     the lifecycle-capable Station CLI, bundled
 *   runtime/                the pinned, digest-verified official Node.js
 *   dist-server/            the server bundle, stamped with this provenance,
 *                           plus the station-build.json `station start` reads
 *   dist-ui/ schemas/       built UI and the server's data schemas
 *   node_modules/           the desktop stager's pruned runtime closure
 *
 * The runtime dependency closure is staged by the same function that stages
 * desktop installers, so both ship one externals list and one prune policy.
 */
async function stagePortableServerTree({
  projectRoot = REPO_ROOT,
  stageRoot,
  target,
  nodeDistributionBytes,
  release,
}) {
  const uiIndex = join(projectRoot, 'dist-ui', 'index.html');
  if (!existsSync(uiIndex)) {
    throw new Error(`${uiIndex} is missing; run \`npm run build:ui\` first`);
  }
  // Removes and recreates stageRoot, then stages node_modules into it.
  stageDesktopServerRuntime({ projectRoot, outputRoot: stageRoot });
  const serverDir = join(stageRoot, 'dist-server');
  // Rebuild rather than copy dist-server: the bundle bakes its build
  // identity, and a portable release must report its release channel, not
  // the `source-checkout` channel an ordinary checkout build stamps.
  execFileSync(process.execPath, ['esbuild.config.mjs'], {
    cwd: projectRoot,
    env: {
      ...process.env,
      STATION_BUILD_SERVER_DIR: serverDir,
      STATION_CHANNEL: release.channel,
    },
    stdio: ['ignore', 'ignore', 'inherit'],
    windowsHide: true,
  });
  pruneNonRuntimeArtifacts(serverDir);
  writeServerBuildManifest(serverDir, release);
  await bundleStationCli(projectRoot, stageRoot);
  cpSync(join(projectRoot, 'dist-ui'), join(stageRoot, 'dist-ui'), {
    recursive: true,
  });
  cpSync(join(projectRoot, 'schemas'), join(stageRoot, 'schemas'), {
    recursive: true,
  });
  stageNodeRuntime(target, nodeDistributionBytes, join(stageRoot, 'runtime'));
  stageLaunchers(projectRoot, stageRoot);
  writeFileSync(
    join(stageRoot, '.station-release.json'),
    `${JSON.stringify(release, null, 2)}\n`,
    { mode: 0o644 },
  );
  normalizeMtimes(stageRoot, new Date(release.createdAt));
  return treeFootprint(stageRoot);
}

function createPortableArchive({ stageParent, target, outputDir }) {
  mkdirSync(outputDir, { recursive: true });
  const archivePath = join(outputDir, target.archiveName);
  rmSync(archivePath, { force: true });
  // `-a` selects the format from the suffix; bsdtar writes zip for `.zip`.
  const create =
    target.format === 'zip'
      ? ['-a', '-cf', archivePath]
      : ['-czf', archivePath];
  runTar([
    ...create,
    ...normalizedOwnershipArgs(),
    '-C',
    stageParent,
    PORTABLE_ARCHIVE_ROOT,
  ]);
  return archivePath;
}

async function describePortableArchive({
  archivePath,
  target,
  release,
  footprint,
}) {
  return {
    schemaVersion: 1,
    name: target.archiveName,
    target: target.id,
    format: target.format,
    sha256: await sha256File(archivePath),
    size: statSync(archivePath).size,
    root: PORTABLE_ARCHIVE_ROOT,
    launcher: `${PORTABLE_ARCHIVE_ROOT}/${target.launcher.replaceAll('\\', '/')}`,
    node: {
      version: target.node.version,
      distribution: target.node.file,
      sha256: target.node.sha256,
    },
    release,
    unpacked: footprint,
  };
}

/**
 * The provenance an archive embeds names the commit its bytes were built
 * from, so the build refuses a SHA other than the checked-out HEAD and a
 * working tree with uncommitted or untracked changes. `git` runs one git
 * command in the checkout and returns its stdout.
 */
export function assertBuildSourceIsCheckout({ sha, git }) {
  const head = git(['rev-parse', 'HEAD']).trim().toLowerCase();
  if (sha.toLowerCase() !== head) {
    throw new Error(
      `--sha ${sha} is not the checked-out HEAD ${head}; the archive would claim a commit it was not built from`,
    );
  }
  const status = git(['status', '--porcelain']).trim();
  if (status.length > 0) {
    throw new Error(
      `the working tree has uncommitted changes, so the archive would not be the bytes of ${head}:\n${status}`,
    );
  }
}

export async function buildPortableServerArchive({
  projectRoot = REPO_ROOT,
  outputDir = resolve(projectRoot, 'dist-portable-server'),
  platform = process.platform,
  arch = process.arch,
  tag,
  sha,
  createdAt,
  nodeDistribution,
  keepStage = false,
}) {
  const target = resolvePortableServerTarget(
    platform,
    arch,
    readPortableNodeRuntime(projectRoot),
  );
  const release = createPackagedReleaseManifest({ tag, sha, createdAt });
  const distributionBytes = await obtainNodeDistribution(target, {
    cacheDir: join(outputDir, 'node-cache'),
    nodeDistribution,
  });
  // A short, fixed stage path keeps deep node_modules paths well inside
  // Windows MAX_PATH while the archive is assembled.
  const stageParent = join(outputDir, `stage-${target.id}`);
  rmSync(stageParent, { recursive: true, force: true, maxRetries: 5 });
  const stageRoot = join(stageParent, PORTABLE_ARCHIVE_ROOT);
  try {
    const footprint = await stagePortableServerTree({
      projectRoot,
      stageRoot,
      target,
      nodeDistributionBytes: distributionBytes,
      release,
    });
    const archivePath = createPortableArchive({
      stageParent,
      target,
      outputDir,
    });
    const descriptor = await describePortableArchive({
      archivePath,
      target,
      release,
      footprint,
    });
    const descriptorPath = `${archivePath}.json`;
    writeFileSync(descriptorPath, `${JSON.stringify(descriptor, null, 2)}\n`);
    return { archivePath, descriptorPath, descriptor };
  } finally {
    if (!keepStage) {
      try {
        rmSync(stageParent, { recursive: true, force: true, maxRetries: 5 });
      } catch (error) {
        // A leftover stage is only disk; it must not turn a verified archive
        // into a failed build. The next build removes it before staging.
        console.warn(`warning: could not remove ${stageParent}: ${error}`);
      }
    }
  }
}
