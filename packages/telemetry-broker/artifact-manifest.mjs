import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { open, readFile, realpath, writeFile } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path';
import { version as esbuildVersion } from 'esbuild';
import { execFileSyncBounded } from '../../scripts/lib/bounded-capture.mjs';
import { createPackagedReleaseManifest } from '../../scripts/lib/container-release-metadata.mjs';
import { sanitizedGitEnvironment } from '../../scripts/lib/git-environment.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const SHA = /^[0-9a-f]{40}$/;
const ARTIFACTS = ['index.mjs', 'main.mjs'];
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fields = (value, keys) =>
  value &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value).every((key) => keys.includes(key));

async function manifestBytes(outdir) {
  const handle = await open(
    join(outdir, 'artifact-manifest.json'),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > 1024 * 1024)
      throw new Error('Receiver artifact manifest exceeds its file bound');
    const bytes = Buffer.alloc(1024 * 1024 + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 1024 * 1024)
      throw new Error('Receiver artifact manifest exceeds its file bound');
    return bytes.subarray(0, bytesRead);
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
    await readFile(join(repoRoot, '.station-release.json'), 'utf8'),
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
    const bytes = await readFile(file);
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
      .sort(([a], [b]) => a.localeCompare(b))
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
      hash(await readFile(file)) !== input.sha256
    )
      throw new Error('Receiver build inputs differ from the artifact');
  }
}

export async function writeReceiverArtifactManifest(
  repoRoot,
  outdir,
  outputFiles,
  inputs,
  provenance,
) {
  await assertInputs(repoRoot, inputs);
  const current = await receiverBuildProvenance(repoRoot);
  if (JSON.stringify(current) !== JSON.stringify(provenance))
    throw new Error('Receiver source provenance changed during build');
  const artifacts = [];
  for (const name of ARTIFACTS) {
    const file = outputFiles.find(
      (output) => output.path === join(outdir, name),
    );
    if (!file) throw new Error('Receiver build omitted a required artifact');
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
  const bytes = await manifestBytes(outdir);
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
    manifest.inputs.length === 0 ||
    new Set(manifest.inputs.map((input) => input?.path)).size !==
      manifest.inputs.length ||
    !Array.isArray(manifest.artifacts) ||
    manifest.artifacts.length !== ARTIFACTS.length
  )
    throw new Error('Invalid receiver artifact manifest');
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
  for (const name of ARTIFACTS) {
    const entries = manifest.artifacts.filter((entry) => entry?.path === name);
    if (
      entries.length !== 1 ||
      !fields(entries[0], ['path', 'sha256', 'bytes']) ||
      !Number.isSafeInteger(entries[0].bytes) ||
      entries[0].bytes < 1 ||
      !SHA256.test(entries[0].sha256)
    )
      throw new Error('Invalid receiver artifact record');
    const artifact = await readFile(join(outdir, name));
    if (
      artifact.byteLength !== entries[0].bytes ||
      hash(artifact) !== entries[0].sha256
    )
      throw new Error('Receiver bundle differs from its build manifest');
  }
  await assertInputs(repoRoot, manifest.inputs);
  const current = await receiverBuildProvenance(repoRoot);
  if (JSON.stringify(current) !== JSON.stringify(manifest.provenance))
    throw new Error('Receiver artifact source revision is stale');
  if (current.kind === 'checkout' && current.dirty)
    throw new Error('Receiver qualification requires a clean source checkout');
  return manifest;
}
