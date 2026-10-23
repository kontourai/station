import { readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { beforeAll, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  packageTelemetryCompanion,
  verifyTelemetryCompanion,
} from '../package-telemetry-companion.mjs';

const makeTempDir = trackTempDirs();
beforeAll(() => {
  const result = spawnSyncBounded(
    process.execPath,
    ['packages/telemetry-broker/build.mjs'],
    {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60_000,
    },
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
});

test('packages the real receiver and standalone pinned deployment without claiming release qualification', async () => {
  const result = await packageTelemetryCompanion(
    join(makeTempDir('companion-package-'), 'output'),
  );
  const verified = await verifyTelemetryCompanion(result.directory);
  expect(verified.scope).toBe('build-only');
  const receiver = JSON.parse(
    await readFile(
      join(result.directory, 'dist/artifact-manifest.json'),
      'utf8',
    ),
  );
  expect(verified.source).toBe(receiver.provenance.head);
  expect(await readFile(join(result.directory, 'dist/main.mjs'))).toEqual(
    await readFile('packages/telemetry-broker/dist/main.mjs'),
  );
  const compose = load(
    await readFile(join(result.directory, 'deployment/compose.yaml'), 'utf8'),
  ) as {
    services: { receiver: { image: string; build?: unknown } };
  };
  expect(compose.services.receiver.build).toBeUndefined();
  expect(compose.services.receiver.image).toContain('TELEMETRY_RECEIVER_IMAGE');
  expect(
    await readFile(join(result.directory, 'Dockerfile'), 'utf8'),
  ).toContain('USER node');
});

test('rejects changed bundles, extra payloads and a manifest promoted to release scope', async () => {
  const { directory } = await packageTelemetryCompanion(
    join(makeTempDir('companion-integrity-'), 'output'),
  );
  const bundlePath = join(directory, 'dist/main.mjs');
  const original = await readFile(bundlePath);
  await writeFile(bundlePath, 'modified');
  await expect(verifyTelemetryCompanion(directory)).rejects.toThrow(
    'digest mismatch',
  );
  await writeFile(bundlePath, original);
  const extra = join(directory, 'unexpected.mjs');
  await writeFile(extra, 'extra');
  await expect(verifyTelemetryCompanion(directory)).rejects.toThrow(
    'inventory exceeds its bound',
  );
  await rm(extra);
  const manifestPath = join(directory, 'companion-manifest.json');
  const manifest = await readFile(manifestPath);
  await writeFile(
    manifestPath,
    manifest.toString().replace('build-only', 'qualified-release'),
  );
  await expect(verifyTelemetryCompanion(directory)).rejects.toThrow(
    'build-only companion manifest',
  );
  await writeFile(manifestPath, manifest);
  await expect(verifyTelemetryCompanion(directory)).resolves.toHaveProperty(
    'scope',
    'build-only',
  );
});

test('never replaces an existing installation directory', async () => {
  const output = makeTempDir('companion-existing-');
  await writeFile(join(output, 'retained-data'), 'keep');
  await expect(packageTelemetryCompanion(output)).rejects.toMatchObject({
    code: 'EEXIST',
  });
  expect(await readFile(join(output, 'retained-data'), 'utf8')).toBe('keep');
});

test.skipIf(process.platform === 'win32')(
  'rejects a linked receiver bundle',
  async () => {
    const { directory } = await packageTelemetryCompanion(
      join(makeTempDir('companion-link-'), 'output'),
    );
    const bundlePath = join(directory, 'dist/main.mjs');
    await rm(bundlePath);
    await symlink(
      join(process.cwd(), 'packages/telemetry-broker/dist/main.mjs'),
      bundlePath,
    );
    await expect(verifyTelemetryCompanion(directory)).rejects.toThrow(
      'links or special files',
    );
  },
);

test.skipIf(process.platform === 'win32')(
  'a symlinked CLI rejects an invalid package instead of silently succeeding',
  async () => {
    const root = makeTempDir('companion-cli-alias-');
    const alias = join(root, 'companion.mjs');
    await symlink(
      join(process.cwd(), 'scripts/package-telemetry-companion.mjs'),
      alias,
    );
    const result = spawnSyncBounded(process.execPath, [alias, 'verify', root], {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('companion-manifest.json');
  },
);

test('rejects a descriptor that disagrees with the packaged receiver or images', async () => {
  const { directory } = await packageTelemetryCompanion(
    join(makeTempDir('companion-descriptor-'), 'output'),
  );
  const path = join(directory, 'companion-manifest.json');
  const original = await readFile(path);
  const manifest = JSON.parse(original.toString());
  await writeFile(
    path,
    JSON.stringify({ ...manifest, source: '0'.repeat(40) }),
  );
  await expect(verifyTelemetryCompanion(directory)).rejects.toThrow(
    'source differs',
  );
  await writeFile(
    path,
    JSON.stringify({ ...manifest, images: [...manifest.images].reverse() }),
  );
  await expect(verifyTelemetryCompanion(directory)).rejects.toThrow(
    'image inventory differs',
  );
  await writeFile(path, original);
  await expect(verifyTelemetryCompanion(directory)).resolves.toHaveProperty(
    'scope',
    'build-only',
  );
});
