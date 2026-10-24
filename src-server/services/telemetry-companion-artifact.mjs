import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export const COMPANION_DEPLOYMENT_FILES = [
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
export const COMPANION_FILES = [
  'dist/main.mjs',
  'dist/index.mjs',
  'dist/artifact-manifest.json',
  'Dockerfile',
  ...COMPANION_DEPLOYMENT_FILES.map((file) => `deployment/${file}`),
].sort();
const LIMIT = 32 * 1024 * 1024;
export const companionDigest = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');

export async function readCompanionFile(path, limit = LIMIT) {
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

/** Byte identity only; this build-only inventory grants no installation authority. */
export async function verifyTelemetryCompanionFiles(directory) {
  directory = resolve(directory);
  const root = await lstat(directory);
  if (!root.isDirectory() || root.isSymbolicLink())
    throw new Error('Companion package root must be a real directory');
  const manifest = JSON.parse(
    (
      await readCompanionFile(
        join(directory, 'companion-manifest.json'),
        64 * 1024,
      )
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
      JSON.stringify(COMPANION_FILES) ||
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
        if (!COMPANION_FILES.some((file) => file.startsWith(`${name}/`)))
          throw new Error('Companion package contains an unexpected directory');
        await inventory(join(path, entry.name), `${name}/`);
      } else if (entry.isFile()) {
        actual.push(name);
        if (actual.length > COMPANION_FILES.length + 1)
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
    JSON.stringify([...COMPANION_FILES, 'companion-manifest.json'].sort())
  )
    throw new Error('Companion package inventory differs from its manifest');
  for (const file of manifest.files) {
    const value = await readCompanionFile(join(directory, file.path));
    if (value.length !== file.bytes || companionDigest(value) !== file.sha256)
      throw new Error(`Companion package digest mismatch: ${file.path}`);
  }
  return manifest;
}
