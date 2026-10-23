import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rename,
  rm,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dump, load } from 'js-yaml';
import { readReceiverArtifactManifest } from '../packages/telemetry-broker/artifact-manifest.mjs';
import { invokedDirectly } from './lib/module-entry.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEPLOYMENT = [
  'compose.yaml',
  'compose.diagnostics.yaml',
  'collector.yaml',
  'prometheus.yml',
  'tempo.yaml',
  'grafana-datasources.yaml',
  'grafana-dashboards.yaml',
  'dashboards/station.json',
  'README.md',
];
const FILES = [
  'dist/main.mjs',
  'dist/index.mjs',
  'dist/artifact-manifest.json',
  'Dockerfile',
  ...DEPLOYMENT.map((file) => `deployment/${file}`),
].sort();
const LIMIT = 32 * 1024 * 1024;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function bytes(path, limit = LIMIT) {
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit)
      throw new Error('Companion input must be a bounded regular file');
    const value = await handle.readFile();
    if (value.length > limit)
      throw new Error('Companion input exceeds its byte limit');
    return value;
  } finally {
    await handle.close();
  }
}

function imagePins(document) {
  const pins = [];
  for (const [name, service] of Object.entries(document.services ?? {})) {
    if (name === 'receiver') continue;
    if (
      typeof service.image !== 'string' ||
      !/^\S+@sha256:[a-f0-9]{64}$/.test(service.image)
    )
      throw new Error(
        `Companion service ${name} requires an immutable image digest`,
      );
    pins.push(service.image);
  }
  return pins;
}

export async function packageTelemetryCompanion(
  output,
  { projectRoot = ROOT } = {},
) {
  output = resolve(output);
  projectRoot = resolve(projectRoot);
  const receiver = await readReceiverArtifactManifest(
    join(projectRoot, 'packages/telemetry-broker/dist'),
    projectRoot,
  );
  const snapshots = new Map(
    [...receiver.bundles].map(([name, value]) => [`dist/${name}`, value]),
  );
  snapshots.set(
    'dist/artifact-manifest.json',
    Buffer.from(`${JSON.stringify(receiver.manifest, null, 2)}\n`),
  );
  for (const file of DEPLOYMENT)
    snapshots.set(
      `deployment/${file}`,
      await bytes(join(projectRoot, 'deployment/telemetry', file)),
    );
  const compose = load(snapshots.get('deployment/compose.yaml').toString());
  const diagnostics = load(
    snapshots.get('deployment/compose.diagnostics.yaml').toString(),
  );
  const images = [
    ...new Set([...imagePins(compose), ...imagePins(diagnostics)]),
  ].sort();
  // A packaged profile cannot build from an unrelated caller's checkout.
  delete compose.services.receiver.build;
  snapshots.set(
    'deployment/compose.yaml',
    Buffer.from(dump(compose, { noRefs: true })),
  );
  const dockerfile = await bytes(join(projectRoot, 'Dockerfile'));
  const nodeImage = dockerfile
    .toString()
    .match(/^FROM (\S+@sha256:[a-f0-9]{64}) AS telemetry-runtime$/m)?.[1];
  if (!nodeImage) throw new Error('Pinned telemetry runtime image is missing');
  images.push(nodeImage);
  snapshots.set(
    'Dockerfile',
    Buffer.from(
      `FROM ${nodeImage}\nWORKDIR /app\nCOPY --chown=node:node dist ./dist\nUSER node\nEXPOSE 43891\nCMD ["node", "dist/main.mjs"]\n`,
    ),
  );
  const manifest = {
    schemaVersion: 1,
    kind: 'station-telemetry-companion',
    scope: 'build-only',
    source: receiver.manifest.provenance.head,
    target: 'node24-unix',
    images: [...new Set(images)].sort(),
    files: FILES.map((path) => ({
      path,
      bytes: snapshots.get(path).length,
      sha256: digest(snapshots.get(path)),
    })),
  };
  const stage = await mkdtemp(join(dirname(output), '.telemetry-companion-'));
  try {
    for (const [path, value] of snapshots) {
      await mkdir(dirname(join(stage, path)), { recursive: true });
      await writeFile(join(stage, path), value, { flag: 'wx', mode: 0o600 });
    }
    await writeFile(
      join(stage, 'companion-manifest.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    await verifyTelemetryCompanion(stage);
    // mkdir is the exclusive output reservation: existing installations are never replaced.
    await mkdir(output, { mode: 0o700 });
    try {
      await rename(stage, join(output, 'candidate'));
    } catch (error) {
      await rmdir(output).catch(() => {});
      throw error;
    }
    return { directory: join(output, 'candidate'), manifest };
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function verifyTelemetryCompanion(directory) {
  directory = resolve(directory);
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Companion package root must be a real directory');
  const manifest = JSON.parse(
    (
      await bytes(join(directory, 'companion-manifest.json'), 64 * 1024)
    ).toString(),
  );
  if (
    manifest?.schemaVersion !== 1 ||
    manifest.kind !== 'station-telemetry-companion' ||
    manifest.scope !== 'build-only' ||
    manifest.target !== 'node24-unix' ||
    !/^[a-f0-9]{40}$/.test(manifest.source) ||
    !Array.isArray(manifest.files) ||
    JSON.stringify(manifest.files.map((file) => file.path)) !==
      JSON.stringify(FILES) ||
    !Array.isArray(manifest.images) ||
    manifest.images.length < 5 ||
    !manifest.images.every(
      (image) =>
        typeof image === 'string' && /^\S+@sha256:[a-f0-9]{64}$/.test(image),
    )
  )
    throw new Error('Invalid build-only companion manifest');
  const actual = [];
  async function inventory(path, prefix = '') {
    for await (const entry of await opendir(path)) {
      const name = `${prefix}${entry.name}`;
      if (entry.isDirectory()) {
        if (!FILES.some((file) => file.startsWith(`${name}/`)))
          throw new Error('Companion package contains an unexpected directory');
        await inventory(join(path, entry.name), `${name}/`);
      } else if (entry.isFile()) {
        actual.push(name);
        if (actual.length > FILES.length + 1)
          throw new Error('Companion package inventory exceeds its bound');
      } else
        throw new Error(
          'Companion packages cannot contain links or special files',
        );
    }
  }
  await inventory(directory);
  if (
    JSON.stringify(actual.sort()) !==
    JSON.stringify([...FILES, 'companion-manifest.json'].sort())
  )
    throw new Error('Companion package inventory differs from its manifest');
  for (const file of manifest.files) {
    const value = await bytes(join(directory, file.path));
    if (value.length !== file.bytes || digest(value) !== file.sha256)
      throw new Error(`Companion package digest mismatch: ${file.path}`);
  }
  const receiver = JSON.parse(
    (await bytes(join(directory, 'dist/artifact-manifest.json'))).toString(),
  );
  if (
    receiver.kind !== 'station-product-receiver-build' ||
    receiver.scope !== 'build-only' ||
    receiver.provenance?.head !== manifest.source ||
    receiver.provenance?.dirty === true
  )
    throw new Error('Companion source differs from its receiver build');
  const compose = load(
    (await bytes(join(directory, 'deployment/compose.yaml'))).toString(),
  );
  const diagnostics = load(
    (
      await bytes(join(directory, 'deployment/compose.diagnostics.yaml'))
    ).toString(),
  );
  const runtimeImage = (await bytes(join(directory, 'Dockerfile')))
    .toString()
    .match(/^FROM (\S+@sha256:[a-f0-9]{64})$/m)?.[1];
  const images = [
    ...new Set([
      ...imagePins(compose),
      ...imagePins(diagnostics),
      runtimeImage,
    ]),
  ].sort();
  if (
    !runtimeImage ||
    compose.services?.receiver?.build !== undefined ||
    JSON.stringify(images) !== JSON.stringify(manifest.images)
  )
    throw new Error('Companion image inventory differs from its deployment');
  return manifest;
}

if (invokedDirectly(import.meta.url)) {
  const [action, directory, ...extra] = process.argv.slice(2);
  if (!['pack', 'verify'].includes(action) || !directory || extra.length)
    throw new Error(
      'Usage: node scripts/package-telemetry-companion.mjs <pack|verify> <directory>',
    );
  const result =
    action === 'pack'
      ? await packageTelemetryCompanion(directory)
      : await verifyTelemetryCompanion(directory);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
