import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { open, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { version as esbuildVersion } from 'esbuild';
import { execFileSyncBounded } from '../../scripts/lib/bounded-capture.mjs';
import { createPackagedReleaseManifest } from '../../scripts/lib/container-release-metadata.mjs';
import { sanitizedGitEnvironment } from '../../scripts/lib/git-environment.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ARTIFACTS = ['index.mjs', 'main.mjs'];
const INPUT_LIMIT = 16 * 1024 * 1024;
const BUNDLE_LIMIT = 64 * 1024 * 1024;
export const RECEIVER_REQUIRED_BUILD_INPUTS = [
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  'packages/telemetry-broker/package.json',
  'packages/telemetry-broker/build.mjs',
  'packages/telemetry-broker/artifact-manifest.mjs',
  'packages/telemetry-broker/src/index.ts',
  'packages/telemetry-broker/src/main.ts',
  'scripts/lib/bounded-capture.mjs',
  'scripts/lib/git-environment.mjs',
  'scripts/lib/container-release-metadata.mjs',
  'scripts/lib/module-entry.mjs',
  'packages/shared/src/release-manifest.mjs',
  'packages/shared/src/portable-server-targets.mjs',
  'packages/shared/src/release-rings.generated.mjs',
];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fields = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

async function regularBytes(file, limit) {
  const handle = await open(
    file,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > limit)
      throw new Error(
        'Receiver build file must be regular and within its size bound',
      );
    const bytes = Buffer.alloc(metadata.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await handle.read(
        bytes,
        length,
        bytes.length - length,
        length,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== metadata.size)
      throw new Error('Receiver build file size changed during capture');
    return bytes.subarray(0, length);
  } finally {
    await handle.close();
  }
}

async function inputPath(repoRoot, file) {
  const resolved = await realpath(file);
  const path = relative(repoRoot, resolved);
  if (path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path))
    throw new Error('Receiver build input is outside its owned checkout');
  return path.split(sep).join('/');
}

export async function receiverBuildProvenance(repoRoot) {
  if (existsSync(join(repoRoot, '.git'))) {
    const git = (args) =>
      execFileSyncBounded('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true,
        env: sanitizedGitEnvironment(),
      }).trim();
    return {
      kind: 'checkout',
      head: git(['rev-parse', 'HEAD']),
      dirty: git(['status', '--porcelain', '--untracked-files=all']) !== '',
    };
  }
  const supplied = JSON.parse(
    (
      await regularBytes(join(repoRoot, '.station-release.json'), 64 * 1024)
    ).toString('utf8'),
  );
  const release = createPackagedReleaseManifest({
    tag: supplied.ref,
    sha: supplied.sha,
    createdAt: supplied.createdAt,
  });
  return {
    kind: 'declared-release',
    head: release.sha,
    ref: release.ref,
    createdAt: release.createdAt,
  };
}

export function receiverBuildInputs(repoRoot) {
  const inputs = new Map();
  const capture = async (file) => {
    const path = await inputPath(repoRoot, file);
    const bytes = await regularBytes(join(repoRoot, path), INPUT_LIMIT);
    const digest = hash(bytes);
    const prior = inputs.get(path);
    if (prior && prior !== digest)
      throw new Error('Receiver build input changed during capture');
    inputs.set(path, digest);
    return bytes;
  };
  const plugin = {
    name: 'receiver-build-inputs',
    setup(builder) {
      builder.onLoad({ filter: /.*/, namespace: 'file' }, async (args) => {
        const extension = extname(args.path).slice(1);
        const loader = ['ts', 'tsx', 'jsx', 'json'].includes(extension)
          ? extension
          : 'js';
        return {
          contents: await capture(args.path),
          loader,
          resolveDir: dirname(args.path),
        };
      });
    },
  };
  const records = () =>
    [...inputs]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, sha256]) => ({ path, sha256 }));
  return { capture, plugin, records };
}

async function assertInputs(repoRoot, inputs) {
  for (const input of inputs) {
    if (
      !input ||
      !fields(input, ['path', 'sha256']) ||
      typeof input.path !== 'string' ||
      input.path.startsWith('/') ||
      input.path.includes('\\') ||
      input.path
        .split('/')
        .some((part) => !part || part === '.' || part === '..') ||
      !SHA256.test(input.sha256)
    )
      throw new Error('Invalid receiver build input record');
    const file = join(repoRoot, input.path);
    if (
      (await inputPath(repoRoot, file)) !== input.path ||
      hash(await regularBytes(file, INPUT_LIMIT)) !== input.sha256
    )
      throw new Error('Receiver build inputs differ from the artifact');
  }
}

function inputInventory(inputs) {
  const paths = inputs.map((input) => input?.path);
  if (
    new Set(paths).size !== inputs.length ||
    !RECEIVER_REQUIRED_BUILD_INPUTS.every((path) => paths.includes(path)) ||
    paths.some((path, index) => index > 0 && paths[index - 1] >= path)
  )
    throw new Error('Invalid receiver build input inventory');
  return { count: inputs.length, sha256: hash(JSON.stringify(inputs)) };
}

export async function writeReceiverArtifactManifest(
  repoRoot,
  outdir,
  outputFiles,
  inputs,
  provenance,
) {
  await assertInputs(repoRoot, inputs);
  const inventory = inputInventory(inputs);
  const current = await receiverBuildProvenance(repoRoot);
  if (JSON.stringify(current) !== JSON.stringify(provenance))
    throw new Error('Receiver source provenance changed during build');
  const artifacts = [];
  for (const name of ARTIFACTS) {
    const file = outputFiles.find(
      (output) => output.path === join(outdir, name),
    );
    if (
      !file ||
      file.contents.byteLength === 0 ||
      file.contents.byteLength > BUNDLE_LIMIT
    )
      throw new Error('Receiver build omitted or exceeded a required artifact');
    await writeFile(file.path, file.contents);
    artifacts.push({
      path: name,
      sha256: hash(file.contents),
      bytes: file.contents.byteLength,
    });
  }
  const manifest = {
    schemaVersion: 1,
    kind: 'station-product-receiver-build',
    scope: 'build-only',
    target: 'node24',
    build: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      esbuild: esbuildVersion,
    },
    provenance,
    inputs,
    inputInventory: inventory,
    artifacts,
  };
  await writeFile(
    join(outdir, 'artifact-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

export async function readReceiverArtifactManifest(outdir, repoRoot) {
  repoRoot = await realpath(repoRoot);
  const bytes = await regularBytes(
    join(outdir, 'artifact-manifest.json'),
    1024 * 1024,
  );
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (
    manifest?.schemaVersion !== 1 ||
    !fields(manifest, [
      'schemaVersion',
      'kind',
      'scope',
      'target',
      'build',
      'provenance',
      'inputs',
      'inputInventory',
      'artifacts',
    ]) ||
    manifest.kind !== 'station-product-receiver-build' ||
    manifest.scope !== 'build-only' ||
    manifest.target !== 'node24' ||
    !SHA.test(manifest.provenance?.head) ||
    !fields(manifest.build, ['node', 'platform', 'arch', 'esbuild']) ||
    !['node', 'platform', 'arch', 'esbuild'].every(
      (key) =>
        typeof manifest.build[key] === 'string' &&
        manifest.build[key].length > 0 &&
        manifest.build[key].length <= 80,
    ) ||
    !['checkout', 'declared-release'].includes(manifest.provenance?.kind) ||
    !Array.isArray(manifest.inputs) ||
    !fields(manifest.inputInventory, ['count', 'sha256']) ||
    !Number.isSafeInteger(manifest.inputInventory.count) ||
    !SHA256.test(manifest.inputInventory.sha256) ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== ARTIFACTS.length
  )
    throw new Error('Invalid receiver artifact manifest');
  await assertInputs(repoRoot, manifest.inputs);
  const inventory = inputInventory(manifest.inputs);
  if (
    inventory.count !== manifest.inputInventory.count ||
    inventory.sha256 !== manifest.inputInventory.sha256
  )
    throw new Error('Receiver build input inventory differs from its manifest');
  if (manifest.provenance.kind === 'checkout') {
    if (
      !fields(manifest.provenance, ['kind', 'head', 'dirty']) ||
      typeof manifest.provenance.dirty !== 'boolean'
    )
      throw new Error('Invalid receiver source provenance');
  } else {
    if (!fields(manifest.provenance, ['kind', 'head', 'ref', 'createdAt']))
      throw new Error('Invalid receiver source provenance');
    createPackagedReleaseManifest({
      tag: manifest.provenance.ref,
      sha: manifest.provenance.head,
      createdAt: manifest.provenance.createdAt,
    });
  }
  const bundles = new Map();
  for (const name of ARTIFACTS) {
    const entries = manifest.artifacts.filter((entry) => entry?.path === name);
    if (
      entries.length !== 1 ||
      !fields(entries[0], ['path', 'sha256', 'bytes']) ||
      !Number.isSafeInteger(entries[0].bytes) ||
      entries[0].bytes < 1 ||
      entries[0].bytes > BUNDLE_LIMIT ||
      !SHA256.test(entries[0].sha256)
    )
      throw new Error('Invalid receiver artifact record');
    const artifact = await regularBytes(join(outdir, name), BUNDLE_LIMIT);
    if (
      artifact.byteLength !== entries[0].bytes ||
      hash(artifact) !== entries[0].sha256
    )
      throw new Error('Receiver bundle differs from its build manifest');
    bundles.set(name, artifact);
  }
  const current = await receiverBuildProvenance(repoRoot);
  if (JSON.stringify(current) !== JSON.stringify(manifest.provenance))
    throw new Error('Receiver artifact source revision is stale');
  if (current.kind === 'checkout' && current.dirty)
    throw new Error('Receiver qualification requires a clean source checkout');
  return { manifest, bundles };
}
