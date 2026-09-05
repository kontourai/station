import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { EventStore } from '../../orchestration/event-store.js';
import { computePluginContentDigest } from '../plugin-content-integrity.js';
import {
  captureLocalPluginInstallation,
  createLocalPluginInstallationService,
} from '../plugin-installation-local.js';
import { readPluginGrantState } from '../plugin-permissions.js';
import { capturePluginRuntimeArtifact } from '../plugin-runtime-artifact.js';
import {
  AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
  type RegistryPackageClaim,
  registryPackageSignaturePayload,
  verifyRegistryPackage,
} from '../registry-supply-chain.js';

const roots: string[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function collisionFixture() {
  const root = mkdtempSync(join(tmpdir(), 'station-tree-v2-legacy-'));
  roots.push(root);
  const manifest = Buffer.from(
    JSON.stringify({
      $schema: AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
      name: 'framing-fixture',
      version: '1.0.0',
    }),
  );
  const original = { a: Buffer.from('x\0b\0file\0y'), 'plugin.json': manifest };
  const replacement = {
    a: Buffer.from('x'),
    b: Buffer.from('y'),
    'plugin.json': manifest,
  };
  // Regression-only reproduction of the retired format; never a production fallback.
  const legacy = (files: Record<string, Buffer>) => {
    const hash = createHash('sha256');
    for (const path of Object.keys(files).sort())
      hash.update(path).update('\0file\0').update(files[path]!).update('\0');
    return `sha256:${hash.digest('hex')}`;
  };
  const oldDigest = legacy(original);
  expect(legacy(replacement)).toBe(oldDigest);
  const source = join(root, 'source');
  mkdirSync(source);
  for (const [path, bytes] of Object.entries(replacement))
    writeFileSync(join(source, path), bytes);
  return { root, source, oldDigest, replacement };
}

test('legacy bound approvals are withheld under v2 without rewriting grants or data', () => {
  const f = collisionFixture();
  const plugins = join(f.root, 'plugins'),
    installed = join(plugins, 'framing-fixture');
  mkdirSync(installed, { recursive: true });
  for (const [path, bytes] of Object.entries(f.replacement))
    writeFileSync(join(installed, path), bytes);
  const grantsPath = join(f.root, 'plugin-grants.json');
  const grants = JSON.stringify({
    'framing-fixture': {
      permissions: ['network.fetch', 'plugin.server'],
      contentDigest: f.oldDigest,
    },
  });
  writeFileSync(grantsPath, grants);
  const data = join(f.root, 'retained-data');
  mkdirSync(data);
  writeFileSync(join(data, 'state'), 'retain-me');
  const current = computePluginContentDigest(plugins, 'framing-fixture');
  expect(current).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(current).not.toBe(f.oldDigest);
  expect(readPluginGrantState(f.root, 'framing-fixture')).toMatchObject({
    binding: 'changed',
    granted: [],
    withheld: ['network.fetch', 'plugin.server'],
    recordedDigest: f.oldDigest,
    currentDigest: current,
  });
  expect(readFileSync(grantsPath, 'utf8')).toBe(grants);
  expect(readFileSync(join(data, 'state'), 'utf8')).toBe('retain-me');
});

test('a legacy managed-journal digest cannot admit retained runtime code and is not rewritten', async () => {
  const f = collisionFixture(),
    plugins = join(f.root, 'plugins');
  mkdirSync(plugins);
  const store = new EventStore(join(f.root, 'events.sqlite'));
  stores.push(store);
  const journal = store.createPackageMcpAdmissionJournal();
  const currentDigest = computePluginContentDigest(f.root, 'source')!;
  expect(currentDigest).not.toBe(f.oldDigest);
  await createLocalPluginInstallationService(
    plugins,
    journal,
    f.source,
  ).install({
    installation: 'framing-fixture',
    expected: null,
    artifact: { digest: currentDigest },
    origin: 'a'.repeat(64),
  });
  const before = journal.currentInstallation('framing-fixture');
  if (before.state !== 'observed')
    throw new Error('Missing setup installation');
  const capture = captureLocalPluginInstallation(
    plugins,
    journal,
    'framing-fixture',
  );
  if (!capture?.root.dataRoot) throw new Error('Missing retained data scope');
  writeFileSync(join(capture.root.dataRoot, 'state'), 'retain-me');
  expect(
    capturePluginRuntimeArtifact(plugins, 'framing-fixture', journal),
  ).not.toBeNull();
  // Simulate a record produced by the previous binary, preserving physical code/data.
  const legacy = journal.recordInstallation({
    pluginId: 'framing-fixture',
    contentDigest: f.oldDigest,
    materialization: before.installation.materialization,
    dataScope: before.installation.dataScope,
    origin: before.installation.origin,
    previous: before.installation,
  });
  if (legacy.state !== 'recorded')
    throw new Error('Legacy journal setup failed');
  const logical = captureLocalPluginInstallation(
    plugins,
    journal,
    'framing-fixture',
  );
  expect(logical?.isCurrent()).toBe(true); // correct route/identity; only byte proof is obsolete
  expect(
    capturePluginRuntimeArtifact(plugins, 'framing-fixture', journal),
  ).toBeNull();
  expect(journal.currentInstallation('framing-fixture')).toEqual({
    state: 'observed',
    installation: legacy.installation,
  });
  expect(readFileSync(join(capture.root.dataRoot, 'state'), 'utf8')).toBe(
    'retain-me',
  );
  expect(readFileSync(join(capture.root.packageRoot, 'b'), 'utf8')).toBe('y');
});

test('a valid signature over the legacy ambiguous digest refuses v2 source verification', () => {
  const f = collisionFixture(),
    pair = generateKeyPairSync('ed25519');
  const claim: RegistryPackageClaim = {
    packageSchema: AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
    registryId: 'framing-fixture',
    registryKey: 'registry:fixture',
    pluginName: 'framing-fixture',
    packageVersion: '1.0.0',
    source: 'https://example.test/framing.git#v1',
    packageDigest: f.oldDigest,
  };
  const signed = {
    ...claim,
    signature: {
      algorithm: 'ed25519' as const,
      keyId: 'fixture',
      value: sign(
        null,
        registryPackageSignaturePayload(claim),
        pair.privateKey,
      ).toString('base64'),
    },
  };
  expect(
    verifyRegistryPackage({
      claim: signed,
      observedPackageDigest: computePluginContentDigest(f.root, 'source')!,
      policy: {
        signatures: 'required',
        pins: 'exact',
        trustedEd25519Keys: {
          fixture: pair.publicKey
            .export({ type: 'spki', format: 'pem' })
            .toString(),
        },
      },
    }),
  ).toMatchObject({ kind: 'refused', reason: 'signature-mismatch' });
  expect(readFileSync(join(f.source, 'b'), 'utf8')).toBe('y');
});
