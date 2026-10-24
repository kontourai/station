import { generateKeyPairSync } from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { beforeAll, expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import type { InstallProvenance } from '../../src-server/routes/system/install-provenance.js';
import { readTelemetryCompanionArtifactEvidence } from '../../src-server/services/telemetry-companion-release.js';
import { spawnSyncBounded } from '../lib/bounded-capture.mjs';
import {
  archiveTool,
  PORTABLE_ARCHIVE_ROOT,
} from '../lib/portable-server-archive.mjs';
import {
  packageTelemetryCompanion,
  verifyTelemetryCompanion,
} from '../package-telemetry-companion.mjs';
import {
  platformPayload,
  signEnvelope,
} from './fixtures/release-manifest-v2.js';

const makeTempDir = trackTempDirs();

test('retained parent signature and build inventory remain distinct from companion installation authority', async () => {
  const root = makeTempDir('companion-release-evidence-');
  const { directory, manifest } = await packageTelemetryCompanion(
    join(root, 'output'),
  );
  const archiveRoot = join(root, 'archive');
  await mkdir(archiveRoot);
  await rename(directory, join(archiveRoot, 'telemetry-companion'));
  const key = generateKeyPairSync('ed25519');
  const keys = {
    keys: [
      {
        keyId: 'fixture-companion',
        algorithm: 'ed25519',
        channels: ['nightly'],
        publicKeySpkiPem: key.publicKey
          .export({ type: 'spki', format: 'pem' })
          .toString(),
      },
    ],
  };
  const payload = platformPayload({ sourceSha: manifest.source });
  const envelope = signEnvelope(payload, 'fixture-companion', key.privateKey);
  const file = join(archiveRoot, '.station-signed-release-manifest.json');
  const provenance: InstallProvenance = {
    installKind: 'archive',
    archiveRoot,
    installRoot: root,
    version: '0.7.0-nightly.12',
    release: {
      schemaVersion: 2,
      sha: manifest.source,
      ref: 'v0.7.0-nightly.12',
      createdAt: '2026-09-25T00:00:00.000Z',
      channel: 'nightly',
      releaseChannel: 'nightly',
      prerelease: true,
    },
  };
  const options = { keys, platform: 'linux', arch: 'x64' };
  expect(
    await readTelemetryCompanionArtifactEvidence(provenance, options),
  ).toEqual({ kind: 'unavailable', reason: 'release-envelope-missing' });
  await writeFile(file, JSON.stringify(envelope));
  expect(
    await readTelemetryCompanionArtifactEvidence(provenance, options),
  ).toEqual({
    kind: 'parent-envelope-verified',
    version: provenance.version,
    source: manifest.source,
    artifactSha256: '4'.repeat(64),
    qualification: 'build-only',
    installationAuthority: false,
  });
  expect(await readTelemetryCompanionArtifactEvidence(provenance)).toEqual({
    kind: 'unavailable',
    reason: 'release-envelope-invalid',
  });
  expect(
    await readTelemetryCompanionArtifactEvidence(provenance, {
      ...options,
      platform: 'freebsd',
    }),
  ).toEqual({ kind: 'unavailable', reason: 'release-envelope-invalid' });
  await writeFile(
    file,
    JSON.stringify({
      ...envelope,
      signature: Buffer.alloc(64).toString('base64'),
    }),
  );
  expect(
    await readTelemetryCompanionArtifactEvidence(provenance, options),
  ).toEqual({ kind: 'unavailable', reason: 'release-envelope-invalid' });
  await writeFile(
    file,
    JSON.stringify(
      signEnvelope(
        { ...payload, sourceSha: 'a'.repeat(40) },
        'fixture-companion',
        key.privateKey,
      ),
    ),
  );
  expect(
    await readTelemetryCompanionArtifactEvidence(provenance, options),
  ).toEqual({ kind: 'unavailable', reason: 'release-envelope-invalid' });
  await writeFile(file, JSON.stringify(envelope));
  await writeFile(
    join(archiveRoot, 'telemetry-companion/dist/main.mjs'),
    'corrupted',
  );
  expect(
    await readTelemetryCompanionArtifactEvidence(provenance, options),
  ).toEqual({ kind: 'unavailable', reason: 'companion-payload-invalid' });
});
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
    services: {
      receiver: { image: string; build?: unknown; read_only?: boolean };
      postgres: { restart?: string };
    };
  };
  expect(compose.services.receiver.build).toBeUndefined();
  expect(compose.services.receiver.image).toContain('TELEMETRY_RECEIVER_IMAGE');
  expect(compose.services.receiver.read_only).toBe(true);
  expect(compose.services.postgres.restart).toBe('unless-stopped');
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
  'rejects a linked package root even when its payload is valid',
  async () => {
    const root = makeTempDir('companion-root-link-');
    const { directory } = await packageTelemetryCompanion(join(root, 'output'));
    await expect(verifyTelemetryCompanion(directory)).resolves.toHaveProperty(
      'scope',
      'build-only',
    );
    const alias = join(root, 'linked');
    await symlink(directory, alias, 'dir');
    await expect(verifyTelemetryCompanion(alias)).rejects.toThrow(
      'real directory',
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

test.each(['corrupt', 'foreign-source'] as const)(
  'the real archive consumer refuses a %s companion before server launch',
  async (fault) => {
    const root = makeTempDir('companion-archive-consumer-');
    const candidate = await packageTelemetryCompanion(join(root, 'output'));
    const stage = join(root, PORTABLE_ARCHIVE_ROOT);
    await mkdir(stage);
    await rename(candidate.directory, join(stage, 'telemetry-companion'));
    await writeFile(
      join(stage, '.station-release.json'),
      JSON.stringify({
        schemaVersion: 2,
        sha:
          fault === 'foreign-source'
            ? '0'.repeat(40)
            : candidate.manifest.source,
        ref: 'v0.1.11',
        createdAt: '2026-10-23T00:00:00.000Z',
        channel: 'stable',
        releaseChannel: 'stable',
        prerelease: false,
      }),
    );
    if (fault === 'corrupt')
      await writeFile(
        join(stage, 'telemetry-companion/dist/main.mjs'),
        'changed bundle',
      );
    const archive = join(root, 'server.tar.gz');
    const packed = spawnSyncBounded(
      archiveTool(),
      ['-czf', archive, '-C', root, PORTABLE_ARCHIVE_ROOT],
      { encoding: 'utf8', windowsHide: true, timeout: 30_000 },
    );
    expect(packed.error).toBeUndefined();
    expect(packed.status, packed.stderr).toBe(0);
    const result = spawnSyncBounded(
      process.execPath,
      [
        'scripts/smoke-portable-server-archive.mjs',
        '--archive',
        archive,
        '--require-telemetry-companion',
      ],
      {
        cwd: process.cwd(),
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      fault === 'corrupt'
        ? 'Companion package digest mismatch'
        : 'companion payload source differs from the archive release',
    );
  },
);
