import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, verify } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL } from '@kontourai/station-contracts/registry-trust';
import { registryPackageSignaturePayload } from '@kontourai/station-shared/plugin-registry-signature';
import { computePluginTreeDigest } from '@kontourai/station-shared/plugin-tree-digest';

const tool = dirname(fileURLToPath(import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'station-signing-example-'));
const source = join(root, 'source');
const privateKeyFile = join(root, 'key.pem');
const output = join(root, 'output');
const stationHome = join(root, 'absent-station-home');
try {
  mkdirSync(source);
  writeFileSync(
    join(source, 'plugin.json'),
    JSON.stringify({
      $schema: AGENT_PLUGINS_1_0_MANIFEST_SCHEMA_URL,
      name: 'registry-author-example',
      version: '1.0.0',
    }),
  );
  writeFileSync(join(source, 'README.md'), 'Source snapshot.\n');
  const pair = generateKeyPairSync('ed25519');
  writeFileSync(
    privateKeyFile,
    pair.privateKey.export({ format: 'pem', type: 'pkcs8' }),
    { mode: 0o600, flag: 'wx' },
  );
  const base = {
    package: source,
    source: 'https://github.com/example/example-plugin.git#v1.0.0',
    registry: 'https://plugins.example.org/catalog.json',
    'key-id': 'test-key',
    'private-key': privateKeyFile,
    out: output,
  };
  const run = (overrides: Partial<typeof base> = {}) => {
    const args = Object.entries({ ...base, ...overrides }).flatMap(
      ([key, value]) => [`--${key}`, value],
    );
    return spawnSync(
      process.execPath,
      ['--import', 'tsx', join(tool, 'prepare.ts'), ...args],
      {
        cwd: tool,
        env: { ...process.env, STATION_HOME: stationHome },
        encoding: 'utf8',
        timeout: 15_000,
        maxBuffer: 128 * 1024,
        windowsHide: true,
      },
    );
  };
  const first = run();
  assert.equal(first.status, 0, first.stderr);
  const original = readFileSync(join(output, 'catalog.json'), 'utf8');
  const catalog = JSON.parse(original);
  const claim = catalog.plugins[0].claim;
  assert.equal(claim.pluginName, 'registry-author-example');
  assert.equal(claim.packageDigest, computePluginTreeDigest(source));
  const publicKey = readFileSync(join(output, 'signer-public-key.pem'));
  const signature = Buffer.from(claim.signature.value, 'base64');
  assert.equal(
    verify(null, registryPackageSignaturePayload(claim), publicKey, signature),
    true,
  );
  assert.equal(original.includes('PRIVATE KEY'), false);
  const changed = { ...claim, packageDigest: `sha256:${'0'.repeat(64)}` };
  assert.equal(
    verify(
      null,
      registryPackageSignaturePayload(changed),
      publicKey,
      signature,
    ),
    false,
  );

  const existing = run();
  assert.notEqual(existing.status, 0);
  assert.equal(readFileSync(join(output, 'catalog.json'), 'utf8'), original);

  const insideOutput = join(source, 'output');
  const inside = run({ out: insideOutput });
  assert.notEqual(inside.status, 0);
  assert.match(inside.stderr, /outside the signed package/);
  assert.equal(existsSync(insideOutput), false);

  const insideKey = join(source, 'private.pem');
  copyFileSync(privateKeyFile, insideKey);
  const keyOutput = join(root, 'key-output');
  const keyRefusal = run({ 'private-key': insideKey, out: keyOutput });
  assert.notEqual(keyRefusal.status, 0);
  assert.match(keyRefusal.stderr, /outside the signed package/);
  assert.equal(existsSync(keyOutput), false);
  rmSync(insideKey);

  const invalid = join(root, 'invalid');
  cpSync(source, invalid, { recursive: true });
  const invalidManifest = JSON.parse(
    readFileSync(join(invalid, 'plugin.json'), 'utf8'),
  );
  invalidManifest.extensions = {
    'io.kontourai.station': {
      schemaVersion: '1.0',
      entrypoint: 'missing-dot.js',
    },
  };
  writeFileSync(join(invalid, 'plugin.json'), JSON.stringify(invalidManifest));
  const invalidOutput = join(root, 'invalid-output');
  const invalidRefusal = run({ package: invalid, out: invalidOutput });
  assert.notEqual(invalidRefusal.status, 0);
  assert.match(invalidRefusal.stderr, /namespace validation failed/);
  assert.equal(existsSync(invalidOutput), false);

  const credentialOutput = join(root, 'credential-output');
  const credentialRefusal = run({
    source: 'https://user:fixture-secret@example.org/plugin.git#v1.0.0',
    out: credentialOutput,
  });
  assert.notEqual(credentialRefusal.status, 0);
  assert.match(credentialRefusal.stderr, /without credentials/);
  assert.equal(
    (credentialRefusal.stdout + credentialRefusal.stderr).includes(
      'fixture-secret',
    ),
    false,
  );
  assert.equal(existsSync(credentialOutput), false);
  assert.equal(existsSync(stationHome), false);
  console.log(
    'PASS: packaged CLI signing, tamper, output/key placement, namespace, credential redaction, and no-home checks.',
  );
} finally {
  // This root and its ephemeral keys are created only by this verification.
  rmSync(root, { recursive: true, force: true });
}
