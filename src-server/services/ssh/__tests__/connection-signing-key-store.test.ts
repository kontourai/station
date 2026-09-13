import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ApprovedStationConnectionTrust,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import { createStationConnectionProofVerifier } from '@kontourai/station-shared/connection-proof';
import { afterEach, expect, test } from 'vitest';
import { ConnectionSigningKeyStore } from '../connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../environment-security-service.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'station-signing-custody-'));
  roots.push(home);
  const environment = new EnvironmentSecurityService({ homeDir: home });
  const identity = await environment.initialize();
  const store = new ConnectionSigningKeyStore(home);
  return {
    home,
    environment,
    identity,
    store,
    path: join(home, 'security', 'connection-signing-key.json'),
  };
}
function binding(
  trust: ApprovedStationConnectionTrust,
): StationConnectionProofBinding {
  return {
    stationId: trust.stationId,
    enrollmentId: trust.enrollmentId,
    generation: trust.generation,
    connectionId: randomUUID(),
    clientNonce: 'a'.repeat(43),
    offerSha256: 'b'.repeat(43),
    answerSha256: 'c'.repeat(43),
    clientFingerprint: Array(32).fill('AA').join(':'),
    stationFingerprint: Array(32).fill('BB').join(':'),
  };
}

test('initialization converges on one private key, reopening preserves it, and projections omit secrets', async () => {
  const { home, store, identity, path, environment } = await fixture();
  expect(store.readDescriptor()).toBeNull();
  const other = new ConnectionSigningKeyStore(home);
  const [first, second] = await Promise.all([
    store.initialize(),
    other.initialize(),
  ]);
  expect(first).toEqual(second);
  expect(first.stationId).toBe(identity.environmentId);
  expect(new ConnectionSigningKeyStore(home).readDescriptor()).toEqual(first);
  expect(environment.verifyOperatorCredential(identity.credential)).toBe(true);
  const projected = JSON.stringify(first);
  expect(projected).not.toContain('privateKey');
  expect(projected).not.toContain(identity.credential);
  expect(projected).not.toContain('PRIVATE KEY');
  (first.signingKey as { x: string }).x = 'x'.repeat(43);
  expect(store.readDescriptor()).toEqual(second);
  if (process.platform !== 'win32')
    expect(statSync(path).mode & 0o777).toBe(0o600);
});

test('rotation is generation-checked, retired issuers cannot sign old bindings, and direct credentials survive', async () => {
  const { store, home, environment, identity } = await fixture();
  const original = await store.initialize();
  const oldBinding = binding(original);
  const issuer = store.createIssuer(() => true);
  const proof = await issuer.issue(oldBinding);
  const oldVerifier = createStationConnectionProofVerifier({
    trust: original,
    expected: oldBinding,
    isCurrent: () => store.readDescriptor()?.generation === original.generation,
  });
  const contenders = await Promise.allSettled([
    store.rotate(1),
    new ConnectionSigningKeyStore(home).rotate(1),
  ]);
  expect(
    contenders.filter((value) => value.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    contenders.filter((value) => value.status === 'rejected'),
  ).toHaveLength(1);
  const current = store.readDescriptor()!;
  expect(current.generation).toBe(2);
  expect(current.enrollmentId).toBe(original.enrollmentId);
  expect(current.signingKey).not.toEqual(original.signingKey);
  await expect(oldVerifier.verifyAndConsume(proof)).rejects.toThrow(
    'Station connection proof refused',
  );
  await expect(issuer.issue(oldBinding)).rejects.toThrow(
    'Station connection proof refused',
  );
  const next = binding(current);
  await expect(
    createStationConnectionProofVerifier({
      trust: current,
      expected: next,
      isCurrent: () => true,
    }).verifyAndConsume(await issuer.issue(next)),
  ).resolves.toEqual(next);
  expect(environment.verifyOperatorCredential(identity.credential)).toBe(true);
  await expect(
    store.rotate(undefined as unknown as number),
  ).rejects.toMatchObject({ code: 'key_generation_conflict' });
});

test.each([
  'corrupt-json',
  'invalid-private-key',
  'wrong-station',
  'unknown-field',
  'future-version',
])(
  'refuses %s without replacing or exposing the private record',
  async (kind) => {
    const { store, path } = await fixture();
    await store.initialize();
    const record = JSON.parse(readFileSync(path, 'utf8'));
    if (kind === 'invalid-private-key')
      record.privateKeyPem = 'private-fixture-marker-not-a-key';
    if (kind === 'wrong-station') record.stationId = randomUUID();
    if (kind === 'unknown-field') record.operator = true;
    if (kind === 'future-version') record.schemaVersion = 2;
    const bytes =
      kind === 'corrupt-json'
        ? 'private-fixture-marker{'
        : JSON.stringify(record);
    writeFileSync(path, bytes, { mode: 0o600 });
    expect(() => store.readDescriptor()).toThrow('key_store_invalid');
    await expect(store.initialize()).rejects.toThrow('key_store_invalid');
    expect(readFileSync(path, 'utf8')).toBe(bytes);
    try {
      store.readDescriptor();
    } catch (error) {
      expect(String(error)).not.toContain('private-fixture-marker');
    }
  },
);

test('rejects linked, oversized or non-private records and does not adopt a reset Station', async () => {
  const { store, path, home, environment } = await fixture();
  const original = await store.initialize();
  const bytes = readFileSync(path);
  const alias = join(home, 'alias.json');
  linkSync(path, alias);
  expect(() => store.readDescriptor()).toThrow('key_store_invalid');
  unlinkSync(alias);
  expect(store.readDescriptor()).toEqual(original);
  writeFileSync(path, Buffer.alloc(8193, 32));
  expect(() => store.readDescriptor()).toThrow('key_store_invalid');
  writeFileSync(path, bytes);
  if (process.platform !== 'win32') {
    chmodSync(path, 0o644);
    expect(() => store.readDescriptor()).toThrow('key_store_invalid');
    chmodSync(path, 0o600);
  }
  await environment.resetEnvironment();
  expect(() => store.readDescriptor()).toThrow('key_store_invalid');
  await expect(store.initialize()).rejects.toThrow('key_store_invalid');
  expect(readFileSync(path)).toEqual(bytes);
});
