import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RegistryTrustConfiguration } from '@kontourai/station-contracts/registry-trust';
import { afterEach, expect, test } from 'vitest';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { ensureStationHomeSchema } from '../../../domain/home-schema-gate.js';
import { EventStore } from '../../orchestration/event-store.js';
import {
  registryAcquisitionRefusalDetails,
  verifyRegistryAcquisition,
} from '../registry-acquisition.js';
import {
  type RegistryPackageClaim,
  registryPackageSignaturePayload,
} from '../registry-supply-chain.js';
import {
  createLocalRegistryTrustPolicyAuthority,
  registryTrustPolicyIdentity,
} from '../registry-trust-policy.js';

const roots: string[] = [];
const stores: EventStore[] = [];
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = mkdtempSync(join(tmpdir(), 'station-registry-policy-'));
  roots.push(value);
  return value;
}
function key() {
  return generateKeyPairSync('ed25519')
    .publicKey.export({ format: 'pem', type: 'spki' })
    .toString();
}
function profile(publicKey: string): RegistryTrustConfiguration {
  return {
    profiles: [
      {
        registryKey: 'registry:public',
        signatures: 'required',
        trustedEd25519Keys: { primary: publicKey },
      },
    ],
  };
}
function store(path: string) {
  const value = new EventStore(path);
  stores.push(value);
  return value;
}

test('current and capture observations never create an absent home or a policy decision', async () => {
  const directory = root(),
    home = join(directory, 'absent-home');
  const decisions = store(
    join(directory, 'events.sqlite'),
  ).createRegistryTrustPolicyDecisions();
  const authority = createLocalRegistryTrustPolicyAuthority(home, decisions);
  expect(await authority.current()).toBeNull();
  await authority.captureApplication();
  expect(existsSync(home)).toBe(false);
  expect(decisions.read()).toBeNull();
});

test('policy observation does not migrate existing configuration or change its permissions', async () => {
  const directory = root(),
    home = join(directory, 'home'),
    config = join(home, 'config');
  mkdirSync(config, { recursive: true, mode: 0o755 });
  const path = join(config, 'app.json');
  const bytes =
    '{"defaultModel":"us.anthropic.claude-sonnet-4-20250514-v1:0"}\n';
  writeFileSync(path, bytes, { mode: 0o644 });
  const mode = statSync(config).mode;
  const decisions = store(
    join(directory, 'events.sqlite'),
  ).createRegistryTrustPolicyDecisions();
  const authority = createLocalRegistryTrustPolicyAuthority(home, decisions);
  expect(await authority.current()).toBeNull();
  await authority.captureApplication();
  expect(readFileSync(path, 'utf8')).toBe(bytes);
  expect(statSync(config).mode).toBe(mode);
  expect(decisions.read()).toBeNull();
});

test('applied A→B→A across two configuration owners uses fresh CAS epochs and survives database close/reopen', async () => {
  const directory = root(),
    home = join(directory, 'home'),
    database = join(directory, 'events.sqlite');
  mkdirSync(home);
  await ensureStationHomeSchema(home);
  const firstLoader = new ConfigLoader({ projectHomeDir: home }),
    secondLoader = new ConfigLoader({ projectHomeDir: home });
  const firstStore = store(database),
    secondStore = store(database);
  const first = createLocalRegistryTrustPolicyAuthority(
    home,
    firstStore.createRegistryTrustPolicyDecisions(),
  );
  const second = createLocalRegistryTrustPolicyAuthority(
    home,
    secondStore.createRegistryTrustPolicyDecisions(),
  );
  const a = profile(key()),
    b = profile(key());
  await firstLoader.mutateAppConfig(() => ({ registryTrust: a }));
  await expect(first.current()).rejects.toThrow(/awaiting/);
  const a1 = await first.publishApplied(await first.captureApplication(), a);
  const admittedA = await first.captureAdmission();
  expect(admittedA.isApplied()).toBe(true);
  const staleA = await first.captureApplication();
  await secondLoader.mutateAppConfig(() => ({ registryTrust: b }));
  // A file edit is a candidate, not a completed policy withdrawal. New
  // asynchronous admissions refuse the mismatch; accepted epochs fence
  // already captured local handles synchronously.
  expect(admittedA.isApplied()).toBe(true);
  await expect(admittedA.assertCurrent()).rejects.toThrow(/awaiting/);
  await expect(first.current()).rejects.toThrow(/awaiting/);
  const b1 = await second.publishApplied(await second.captureApplication(), b);
  expect(admittedA.isApplied()).toBe(false);
  await firstLoader.mutateAppConfig(() => ({ registryTrust: a }));
  await expect(first.publishApplied(staleA, a)).rejects.toThrow(/changed/);
  expect(secondStore.createRegistryTrustPolicyDecisions().read()).toEqual(b1);
  const a2 = await first.publishApplied(await first.captureApplication(), a);
  expect(a2?.identity).toEqual(a1?.identity);
  expect(a2?.epoch).not.toBe(a1?.epoch);
  expect(a2?.scope).toBe(a1?.scope);
  expect(admittedA.isApplied()).toBe(false);
  for (const previous of [firstStore, secondStore]) {
    previous.close();
    stores.splice(stores.indexOf(previous), 1);
  }
  const restarted = createLocalRegistryTrustPolicyAuthority(
    home,
    store(database).createRegistryTrustPolicyDecisions(),
  );
  expect(await restarted.current()).toEqual(a2);
  expect(JSON.stringify(a2)).not.toContain('BEGIN PUBLIC KEY');
});

test('failed or mismatched application cannot publish a candidate as accepted', async () => {
  const directory = root(),
    home = join(directory, 'home');
  mkdirSync(home);
  await ensureStationHomeSchema(home);
  const loader = new ConfigLoader({ projectHomeDir: home }),
    decisions = store(
      join(directory, 'events.sqlite'),
    ).createRegistryTrustPolicyDecisions();
  const authority = createLocalRegistryTrustPolicyAuthority(home, decisions),
    a = profile(key()),
    b = profile(key());
  await loader.mutateAppConfig(() => ({ registryTrust: a }));
  const application = await authority.captureApplication();
  await expect(authority.publishApplied(application, b)).rejects.toThrow(
    /changed/,
  );
  expect(decisions.read()).toBeNull();
  const second = await authority.captureApplication();
  await loader.mutateAppConfig(() => ({ registryTrust: b }));
  await expect(authority.publishApplied(second, a)).rejects.toThrow(/changed/);
  expect(decisions.read()).toBeNull();
});

test('identity ordering is ordinal and SPKI identity is independent of property order and PEM line endings', () => {
  const first = key(),
    second = key();
  const a = {
    profiles: [
      {
        registryKey: 'é',
        signatures: 'required',
        trustedEd25519Keys: { z: first, A: second },
      },
      { registryKey: 'z', signatures: 'optional', trustedEd25519Keys: {} },
    ],
  };
  const b = {
    profiles: [
      { registryKey: 'z', signatures: 'optional', trustedEd25519Keys: {} },
      {
        registryKey: 'é',
        signatures: 'required',
        trustedEd25519Keys: { A: second.replaceAll('\n', '\r\n'), z: first },
      },
    ],
  };
  const identity = registryTrustPolicyIdentity(a);
  expect(identity).toEqual(registryTrustPolicyIdentity(b));
  expect(identity.profiles.map((value) => value.registryKey)).toEqual([
    'z',
    'é',
  ]);
  expect(identity.profiles[1]?.trustedKeys.map((value) => value.keyId)).toEqual(
    ['A', 'z'],
  );
  expect(() =>
    registryTrustPolicyIdentity(profile(first).profiles.map(() => ({}))),
  ).toThrow();
  expect(() =>
    registryTrustPolicyIdentity({
      profiles: [
        {
          registryKey: 'x',
          signatures: 'required',
          trustedEd25519Keys: { 'invalid key': first },
        },
      ],
    }),
  ).toThrow(/key is invalid/);
});

test('a self-consistent hash does not make malformed persisted policy identity valid', () => {
  const directory = root(),
    database = join(directory, 'events.sqlite'),
    owner = store(database);
  const parts = {
    configured: true,
    profiles: [
      {
        registryKey: 'x',
        signatures: 'required',
        trustedKeys: [
          { keyId: 'primary', spkiFingerprint: 'not-a-fingerprint' },
        ],
      },
    ],
  };
  const identity = {
    ...parts,
    fingerprint: `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`,
  };
  const external = new DatabaseSync(database);
  try {
    external
      .prepare(
        'INSERT INTO registry_trust_policy_decisions(scope,epoch,identity_json) VALUES (?,?,?)',
      )
      .run(randomUUID(), randomUUID(), JSON.stringify(identity));
  } finally {
    external.close();
  }
  expect(() => owner.createRegistryTrustPolicyDecisions().read()).toThrow(
    /Registry trust policy/,
  );
});

test('an unprofiled stable app-config symlink remains compatible with actual ConfigLoader and policy observation', async () => {
  const directory = root(),
    home = join(directory, 'home');
  mkdirSync(home);
  await ensureStationHomeSchema(home);
  const loader = new ConfigLoader({ projectHomeDir: home });
  const config = await loader.loadAppConfig();
  const path = join(home, 'config', 'app.json'),
    target = join(directory, 'linked-app.json');
  const bytes = readFileSync(path, 'utf8');
  writeFileSync(target, bytes);
  unlinkSync(path);
  symlinkSync(target, path);
  expect(await loader.loadAppConfig()).toEqual(config);
  const decisions = store(
    join(directory, 'events.sqlite'),
  ).createRegistryTrustPolicyDecisions();
  expect(
    await createLocalRegistryTrustPolicyAuthority(home, decisions).current(),
  ).toBeNull();
  expect(lstatSync(path).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, 'utf8')).toBe(bytes);
  expect(decisions.read()).toBeNull();
});

test('private key material is refused before app configuration is persisted', async () => {
  const pair = generateKeyPairSync('ed25519');
  const privatePem = pair.privateKey
    .export({ format: 'pem', type: 'pkcs8' })
    .toString();
  const publicPem = pair.publicKey
    .export({ format: 'pem', type: 'spki' })
    .toString();
  expect(() => registryTrustPolicyIdentity(profile(privatePem))).toThrow(
    /public SPKI/,
  );
  expect(() => registryTrustPolicyIdentity(profile(publicPem))).not.toThrow();
  const directory = root(),
    home = join(directory, 'home');
  mkdirSync(home);
  await ensureStationHomeSchema(home);
  const loader = new ConfigLoader({ projectHomeDir: home });
  await loader.loadAppConfig();
  await expect(
    loader.mutateAppConfig(() => ({ registryTrust: profile(privatePem) })),
  ).rejects.toThrow();
  expect(
    readFileSync(join(home, 'config', 'app.json'), 'utf8').includes(privatePem),
  ).toBe(false);
});

test('exact claim continuity includes configured signing principal, actual SPKI and applied policy epoch', async () => {
  const directory = root(),
    home = join(directory, 'home');
  mkdirSync(home);
  await ensureStationHomeSchema(home);
  const loader = new ConfigLoader({ projectHomeDir: home });
  const firstKey = generateKeyPairSync('ed25519'),
    secondKey = generateKeyPairSync('ed25519');
  const publicPem = (pair: typeof firstKey) =>
    pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  const configuration: RegistryTrustConfiguration = {
    profiles: [
      {
        registryKey: 'registry:public',
        signatures: 'optional',
        trustedEd25519Keys: {
          first: publicPem(firstKey),
          second: publicPem(secondKey),
        },
      },
    ],
  };
  await loader.mutateAppConfig(() => ({ registryTrust: configuration }));
  const authority = createLocalRegistryTrustPolicyAuthority(
    home,
    store(
      join(directory, 'events.sqlite'),
    ).createRegistryTrustPolicyDecisions(),
  );
  await authority.publishApplied(
    await authority.captureApplication(),
    configuration,
  );
  const admission = await authority.captureAdmission();
  const source =
    'https://example.invalid/package?token=fixture-not-to-disclose';
  const observedSourceDigest = `sha256:${createHash('sha256').update('observed source bytes').digest('hex')}`;
  const plain: RegistryPackageClaim = {
    packageSchema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    registryId: 'claim-fixture',
    registryKey: 'registry:public',
    pluginName: 'claim-fixture',
    packageVersion: '1.0.0',
    source,
    packageDigest: observedSourceDigest,
  };
  const signed = (
    keyId: string,
    pair: typeof firstKey,
  ): RegistryPackageClaim => ({
    ...plain,
    signature: {
      algorithm: 'ed25519',
      keyId,
      value: sign(
        null,
        registryPackageSignaturePayload(plain),
        pair.privateKey,
      ).toString('base64'),
    },
  });
  const input = {
    admission,
    registryId: plain.registryId,
    registryKey: plain.registryKey,
    fresh: true,
    source,
    pluginName: plain.pluginName,
    packageVersion: plain.packageVersion,
    observedSourceDigest,
  };
  const receipt = await verifyRegistryAcquisition({
    ...input,
    claim: signed('first', firstKey),
  });
  expect(receipt?.signer?.spkiFingerprint).toBe(
    `sha256:${createHash('sha256')
      .update(firstKey.publicKey.export({ type: 'spki', format: 'der' }))
      .digest('hex')}`,
  );
  expect(JSON.stringify(receipt)).not.toContain('fixture-not-to-disclose');
  await expect(
    verifyRegistryAcquisition({
      ...input,
      claim: signed('first', firstKey),
      previous: receipt,
    }),
  ).resolves.toEqual(receipt);
  for (const claim of [signed('second', secondKey), plain]) {
    await expect(
      verifyRegistryAcquisition({ ...input, claim, previous: receipt }),
    ).rejects.toMatchObject({ reason: 'continuity-change' });
  }
  await expect(
    verifyRegistryAcquisition({
      ...input,
      claim: signed('first', firstKey),
      observedSourceDigest: `sha256:${'0'.repeat(64)}`,
    }),
  ).rejects.toMatchObject({ reason: 'signature-mismatch' });
  const rotated = {
    profiles: [
      {
        ...configuration.profiles[0]!,
        trustedEd25519Keys: { first: publicPem(secondKey) },
      },
    ],
  };
  await loader.mutateAppConfig(() => ({ registryTrust: rotated }));
  await authority.publishApplied(await authority.captureApplication(), rotated);
  const current = await authority.captureAdmission();
  expect(admission.isApplied()).toBe(false);
  await expect(
    verifyRegistryAcquisition({
      ...input,
      admission: current,
      claim: signed('first', secondKey),
      previous: receipt,
    }),
  ).rejects.toMatchObject({ reason: 'continuity-change' });
  await verifyRegistryAcquisition({
    ...input,
    admission: current,
    claim: signed('first', firstKey),
  }).then(
    () => {
      throw new Error('Expected signing-key refusal');
    },
    (error: unknown) => {
      expect(registryAcquisitionRefusalDetails(error)).toMatchObject({
        reason: 'signature-mismatch',
      });
      expect(
        JSON.stringify(registryAcquisitionRefusalDetails(error)),
      ).not.toContain('fixture-not-to-disclose');
    },
  );
});
