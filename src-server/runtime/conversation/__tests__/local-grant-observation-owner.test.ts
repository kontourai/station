import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs, {
  chmodSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { test, vi } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
  runtimeRequestPrincipalMayAccessHttpRoute,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { HomeWriterUnavailableError } from '../../../services/ssh/home-writer-owner.js';
import { captureEnvironmentLocalGrantObservationOwner } from '../local-grant-observation-owner.js';
import {
  ProviderCredentialObservationError,
  ProviderCredentialObservationStore,
  readObservedSdkProviderCredential,
} from '../provider-credential-observation.js';

const makeTempDir = trackTempDirs();

// Actual host/environment/request owners on an owned temporary home only.
// The server-only mint stamps/auth-boundary setters below are explicit test
// setup, not proof of a native local-grant ingress or user-authorized mint.
async function setup(
  mintKind: 'local-grant' | 'ui-bootstrap' | null = 'local-grant',
  scope?: string,
) {
  const home = realpathSync(makeTempDir('environment-observation-owner-'));
  chmodSync(home, 0o700);
  const admittedLoader = new ConfigLoader({
    projectHomeDir: home,
    enforceHomeSchema: true,
  });
  await admittedLoader.ensureHomeSchema();
  const environment = new EnvironmentSecurityService({ homeDir: home });
  const record = await environment.initialize();
  const offer = environment.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1:43979',
    ...(scope ? { scope } : {}),
  });
  const requested = environment.devicePairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'owned-fixture',
    requesterPosition: 'unproven',
  });
  environment.devicePairing.confirmRequest(requested.requestId, {
    kind: 'presented-credential',
  });
  const paired = environment.devicePairing.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: requested.requestId,
    locality: 'home-possession',
    ...(mintKind ? { mintKind } : {}),
  });
  const request = new Request('http://127.0.0.1:43979/api/orchestration/chat', {
    method: 'POST',
  });
  const principal = {
    kind: 'credential' as const,
    authority: 'device-credential' as const,
    credential: paired.credential,
    source: 'bearer' as const,
    locality: 'home-possession' as const,
    ...(mintKind ? { mintKind } : {}),
  };
  setRuntimeAuthenticatedRequestPrincipal(request, principal);
  bindRuntimeLocalOperator(request);
  const adapter = new FileStorageAdapter(home);
  await adapter.saveProviderConnection({
    id: 'selected',
    name: 'fixture',
    type: 'anthropic',
    enabled: true,
    capabilities: ['llm'],
    config: {
      apiKey: 'synthetic-provider-key',
      baseUrl: 'https://api.anthropic.com/v1',
    },
  });
  const loader = new ConfigLoader({ projectHomeDir: home });
  const store = (
    authority: Awaited<
      ReturnType<typeof captureEnvironmentLocalGrantObservationOwner>
    >,
  ) =>
    new ProviderCredentialObservationStore(home, {
      adapter,
      authority,
      captureConfigurationFence: () =>
        loader.capturePreparationConfigurationFence(['worker']),
      // UNWIRED(#91): configuration-only fixture; actual runtime/projection composition remains pending.
      captureRuntimeFence: () =>
        loader.capturePreparationConfigurationFence(['worker']),
    });
  return {
    home,
    environment,
    record,
    paired,
    request,
    principal,
    store,
    keyPath: join(
      home,
      'security',
      `revision-evidence-${record.environmentId}.key`,
    ),
  };
}
function denied(action: () => unknown) {
  assert.throws(
    action,
    (error: unknown) =>
      error instanceof ProviderCredentialObservationError &&
      error.code === 'authorization_unavailable',
  );
}
async function deniedAsync(action: () => Promise<unknown>) {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof ProviderCredentialObservationError &&
      error.code === 'authorization_unavailable',
  );
}
test('actual environment identity and current request owners compose a private bound observation lease', async () => {
  const h = await setup();
  {
    assert.equal(
      isRuntimeRequestPrincipalCurrent(h.request, h.environment),
      true,
    );
    const owner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    const lease = owner.requireCurrentLocalGrant(h.request);
    assert.equal(lease.hostContextId, h.record.environmentId);
    assert.equal(lease.principalCredential, h.paired.credential);
    assert.match(lease.privateHostContextWitness, /^[A-Za-z0-9_-]{43}$/);
    lease.assertCurrent();
    assert.equal(JSON.stringify(owner), '{}');
    assert.equal(Object.isFrozen(lease), true);
    assert.equal(JSON.stringify(lease).includes(h.paired.credential), false);
    assert.equal(
      JSON.stringify(lease).includes(lease.privateHostContextWitness),
      false,
    );
    const observation = h.store(owner).capture(h.request, 'selected');
    assert.equal(
      JSON.stringify(observation).includes(lease.privateHostContextWitness),
      false,
    );
    assert.equal(
      JSON.stringify(observation).includes(h.record.environmentId),
      false,
    );
    const nextOwner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    assert.equal(
      h.store(nextOwner).revalidate(h.request, observation.observationId)
        .observationId,
      observation.observationId,
    );
    denied(() => owner.requireCurrentLocalGrant(new Request(h.request)));
  }
});
test('request JSON, UI bootstrap, read-only scope and principal restamping cannot become the local-grant owner', async () => {
  for (const kind of [
    'ui-bootstrap',
    'read-only',
    'unbound',
    'restamp',
  ] as const) {
    const h = await setup(
      kind === 'ui-bootstrap' ? 'ui-bootstrap' : 'local-grant',
      kind === 'read-only' ? 'orchestration:read' : undefined,
    );
    {
      if (kind === 'restamp') {
        const owner = await captureEnvironmentLocalGrantObservationOwner(
          h.request,
          h.environment,
          h.environment,
        );
        const lease = owner.requireCurrentLocalGrant(h.request);
        setRuntimeAuthenticatedRequestPrincipal(h.request, { ...h.principal });
        bindRuntimeLocalOperator(h.request);
        denied(lease.assertCurrent);
        continue;
      }
      const request =
        kind === 'unbound'
          ? new Request(h.request.url, {
              method: 'POST',
              body: JSON.stringify({ localGrant: true, approved: true }),
            })
          : h.request;
      await deniedAsync(() =>
        captureEnvironmentLocalGrantObservationOwner(
          request,
          h.environment,
          h.environment,
        ),
      );
    }
  }
});
test('actual credential revocation invalidates already captured finalizers and rejects new captures', async () => {
  const h = await setup();
  {
    const owner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    const lease = owner.requireCurrentLocalGrant(h.request);
    h.environment.devicePairing.revokeDevice(
      h.paired.device.id,
      'operator-credential',
    );
    denied(lease.assertCurrent);
    denied(() => owner.requireCurrentLocalGrant(h.request));
    await deniedAsync(() =>
      captureEnvironmentLocalGrantObservationOwner(
        h.request,
        h.environment,
        h.environment,
      ),
    );
  }
});
test.each(['revoke', 'narrow'] as const)(
  'another registry owner can %s a captured grant without a stale observer restoring it',
  async (change) => {
    const h = await setup();
    assert.equal(
      isRuntimeRequestPrincipalCurrent(h.request, h.environment),
      true,
    );
    const owner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    const lease = owner.requireCurrentLocalGrant(h.request);
    const other = await DevicePairingService.create({
      homeDir: h.home,
      environmentId: h.record.environmentId,
    });
    if (change === 'revoke')
      other.revokeDevice(h.paired.device.id, 'operator-credential');
    else
      other.setDeviceScope(h.paired.device.id, ['orchestration:read'], {
        kind: 'presented-credential',
      });
    assert.equal(
      isRuntimeRequestPrincipalCurrent(h.request, h.environment),
      false,
    );
    const path = join(h.home, 'security', 'paired-devices.json');
    const persisted = readFileSync(path);
    denied(lease.assertCurrent);
    await deniedAsync(() =>
      captureEnvironmentLocalGrantObservationOwner(
        h.request,
        h.environment,
        h.environment,
      ),
    );
    assert.deepEqual(readFileSync(path), persisted);
  },
);
test.each(['missing', 'corrupt'] as const)(
  'unavailable durable registry (%s) refuses observation without repairing the file',
  async (mode) => {
    const h = await setup();
    const owner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    const lease = owner.requireCurrentLocalGrant(h.request);
    const path = join(h.home, 'security', 'paired-devices.json');
    if (mode === 'missing') rmSync(path);
    else writeFileSync(path, 'invalid registry');
    const before = readdirSync(join(h.home, 'security')).sort();
    denied(lease.assertCurrent);
    await deniedAsync(() =>
      captureEnvironmentLocalGrantObservationOwner(
        h.request,
        h.environment,
        h.environment,
      ),
    );
    assert.deepEqual(readdirSync(join(h.home, 'security')).sort(), before);
    if (mode === 'corrupt')
      assert.equal(readFileSync(path, 'utf8'), 'invalid registry');
  },
);
test('a current read-only GET request cannot supply the observation mutation owner', async () => {
  const h = await setup('local-grant', 'orchestration:read');
  {
    const read = new Request('http://127.0.0.1:43979/api/orchestration', {
      method: 'GET',
    });
    setRuntimeAuthenticatedRequestPrincipal(read, h.principal);
    bindRuntimeLocalOperator(read);
    assert.equal(isRuntimeRequestPrincipalCurrent(read, h.environment), true);
    await deniedAsync(() =>
      captureEnvironmentLocalGrantObservationOwner(
        read,
        h.environment,
        h.environment,
      ),
    );
  }
});
test('authority-key replacement invalidates in-flight AND restarted observation use without changing environmentId', async () => {
  const h = await setup();
  {
    const owner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    const lease = owner.requireCurrentLocalGrant(h.request);
    const observation = h.store(owner).capture(h.request, 'selected');
    writeFileSync(h.keyPath, randomBytes(32).toString('base64url'), {
      mode: 0o600,
    });
    assert.equal(
      (await h.environment.readExistingRecord()).environmentId,
      h.record.environmentId,
    );
    denied(lease.assertCurrent);
    const nextOwner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    denied(() =>
      h.store(nextOwner).revalidate(h.request, observation.observationId),
    );
    const nextObservation = h.store(nextOwner).capture(h.request, 'selected');
    assert.notEqual(nextObservation.observationId, observation.observationId);
  }
});
test('environment reset and missing/corrupt key invalidate the host comparison without bootstrapping replacement state', async () => {
  for (const mode of ['reset', 'corrupt'] as const) {
    const h = await setup();
    {
      const owner = await captureEnvironmentLocalGrantObservationOwner(
        h.request,
        h.environment,
        h.environment,
      );
      const lease = owner.requireCurrentLocalGrant(h.request);
      if (mode === 'reset') await h.environment.resetEnvironment();
      else writeFileSync(h.keyPath, 'invalid', { mode: 0o600 });
      const before = readdirSync(join(h.home, 'security')).sort();
      denied(lease.assertCurrent);
      await deniedAsync(() =>
        captureEnvironmentLocalGrantObservationOwner(
          h.request,
          h.environment,
          h.environment,
        ),
      );
      assert.deepEqual(readdirSync(join(h.home, 'security')).sort(), before);
    }
  }
});
test('identity switch between initial async read and signing cannot bind an old host ID under a new host key', async () => {
  const h = await setup();
  {
    const originalRead = h.environment.readExistingRecord.bind(h.environment);
    let calls = 0;
    h.environment.readExistingRecord = async () => {
      const record = await originalRead();
      if (++calls === 1) {
        // Private fixture filesystem simulates an identity/key replacement
        // without revoking the same live paired credential, isolating the race.
        const nextId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
        writeFileSync(
          join(h.home, 'security', 'environment.json'),
          JSON.stringify({ ...record, environmentId: nextId }),
          { mode: 0o600 },
        );
        writeFileSync(
          join(h.home, 'security', `revision-evidence-${nextId}.key`),
          randomBytes(32).toString('base64url'),
          { mode: 0o600 },
        );
      }
      return record;
    };
    await deniedAsync(() =>
      captureEnvironmentLocalGrantObservationOwner(
        h.request,
        h.environment,
        h.environment,
      ),
    );
    assert.equal(calls, 2);
    assert.equal(
      getRuntimeAuthenticatedRequestPrincipal(h.request)?.credential,
      h.paired.credential,
    );
  }
});
test('old observation records with no private host witness require fresh preparation rather than assumed key continuity', async () => {
  const h = await setup();
  {
    const owner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    const observation = h.store(owner).capture(h.request, 'selected');
    const path = join(
      h.home,
      'security',
      'provider-credential-observations-v1',
      `${observation.observationId}.json`,
    );
    const record = JSON.parse(readFileSync(path, 'utf8'));
    record.schema = 1;
    delete record.privateHostContextWitness;
    writeFileSync(path, JSON.stringify(record));
    assert.throws(
      () => h.store(owner).revalidate(h.request, observation.observationId),
      ProviderCredentialObservationError,
    );
  }
});

test('one current-grant validation shares one home hold and observes a later revocation', async () => {
  const h = await setup();
  const owner = await captureEnvironmentLocalGrantObservationOwner(
    h.request,
    h.environment,
    h.environment,
  );
  const lease = owner.requireCurrentLocalGrant(h.request);
  const link = fs.linkSync;
  let holds = 0;
  const observe = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === join(h.home, 'security', '.home-writer.mutation'))
      holds++;
    return link(from, to);
  });
  const open = fs.openSync;
  let opens = 0;
  const read = vi
    .spyOn(fs, 'openSync')
    .mockImplementation((path, flags, mode) => {
      if (String(path) === join(h.home, 'security', '.home-writer.mutation'))
        opens++;
      return open(path, flags, mode);
    });
  syncBuiltinESMExports();
  try {
    lease.assertCurrent();
    assert.equal(holds, 1);
    assert.ok(opens > 0, 'Home inspection observer must execute');
    assert.ok(
      opens <= 13,
      `current-grant validation inspected Home ${opens} times; maximum 13`,
    );
    const other = await DevicePairingService.create({
      homeDir: h.home,
      environmentId: h.record.environmentId,
    });
    other.revokeDevice(h.paired.device.id, 'operator-credential');
    denied(lease.assertCurrent);
  } finally {
    observe.mockRestore();
    read.mockRestore();
    syncBuiltinESMExports();
  }
});

test('an observed SDK credential read shares one current home hold and canonical provider observation without caching later authority', async () => {
  const h = await setup();
  const owner = await captureEnvironmentLocalGrantObservationOwner(
    h.request,
    h.environment,
    h.environment,
  );
  const store = h.store(owner);
  const reference = store.capture(h.request, 'selected');
  const credential = store.captureSdkCredential(h.request, 'selected');
  const open = fs.openSync;
  let registryReads = 0;
  let providerReads = 0;
  const read = vi
    .spyOn(fs, 'openSync')
    .mockImplementation((path, flags, mode) => {
      if (String(path) === join(h.home, 'security', 'paired-devices.json'))
        registryReads++;
      if (String(path) === join(h.home, 'config', 'providers.json'))
        providerReads++;
      return open(path, flags, mode);
    });
  const link = fs.linkSync;
  let holds = 0;
  const observe = vi.spyOn(fs, 'linkSync').mockImplementation((from, to) => {
    if (String(to) === join(h.home, 'security', '.home-writer.mutation'))
      holds++;
    return link(from, to);
  });
  syncBuiltinESMExports();
  try {
    h.environment.withCurrentAuthority(() =>
      store.revalidate(h.request, reference.observationId),
    );
    const canonicalSourceReads = providerReads;
    assert.equal(
      canonicalSourceReads,
      3,
      'the canonical observation retains first, adapter-parity and confirming reads',
    );
    registryReads = 0;
    providerReads = 0;
    holds = 0;
    assert.equal(
      readObservedSdkProviderCredential(credential, 'anthropic', h.request)
        .connectionId,
      'selected',
    );
    assert.equal(holds, 1);
    assert.equal(registryReads, 2);
    const credentialSourceReads = providerReads;
    h.environment.devicePairing.revokeDevice(
      h.paired.device.id,
      'operator-credential',
    );
    denied(() =>
      readObservedSdkProviderCredential(credential, 'anthropic', h.request),
    );
    assert.equal(
      credentialSourceReads,
      canonicalSourceReads,
      'one credential read must use one complete canonical provider observation',
    );
  } finally {
    observe.mockRestore();
    read.mockRestore();
    syncBuiltinESMExports();
  }
});

test('a complete authority check refuses registry bytes changed during its synchronous callback', async () => {
  const h = await setup();
  const path = join(h.home, 'security', 'paired-devices.json');
  const original = readFileSync(path);
  try {
    assert.throws(
      () =>
        h.environment.withCurrentAuthority(() => {
          assert.equal(
            isRuntimeRequestPrincipalCurrent(h.request, h.environment),
            true,
          );
          const changed = JSON.parse(original.toString('utf8'));
          changed.devices[0].revokedAt = '2026-10-26T00:00:00.000Z';
          writeFileSync(path, JSON.stringify(changed));
          return true;
        }),
      /Paired-device registry revision changed/,
    );
  } finally {
    writeFileSync(path, original);
  }
});

test('uncertain publication of another Device fences the still-active grant before external policy', async () => {
  const h = await setup();
  const service = h.environment.devicePairing;
  const offer = service.createOffer({ endpoint: 'http://127.0.0.1:43979' });
  const requested = service.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'other-device',
    requesterPosition: 'unproven',
  });
  service.confirmRequest(requested.requestId, { kind: 'presented-credential' });
  const other = service.exchange({
    offerId: offer.offerId,
    proof: offer.challenge,
    requestId: requested.requestId,
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  const authorize = vi.fn(
    (candidate: string, route: { method: string; path: string }) =>
      h.environment.authorizeCredential(candidate, route),
  );
  const scope = vi.fn((candidate: string) =>
    h.environment.resolveGrantedScope(candidate),
  );
  const operator = vi.fn((candidate: string) =>
    h.environment.verifyOperatorCredential(candidate),
  );
  const owner = await captureEnvironmentLocalGrantObservationOwner(
    h.request,
    h.environment,
    {
      authorizeCredential: authorize,
      resolveGrantedScope: scope,
      verifyOperatorCredential: operator,
    },
  );
  const lease = owner.requireCurrentLocalGrant(h.request);
  const remove = fs.rmSync;
  let faultApplied = false;
  let checked = false;
  const fault = vi.spyOn(fs, 'rmSync').mockImplementation((...args) => {
    if (
      String(args[0]).includes('.paired-devices.json.') &&
      String(args[0]).endsWith('.tmp')
    ) {
      faultApplied = true;
      throw Error('controlled published-registry cleanup failure');
    }
    return remove(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(
      () =>
        owner.withObservationScope(h.request, () => {
          assert.throws(
            () => service.revokeDevice(other.device.id, 'operator-credential'),
            HomeWriterUnavailableError,
          );
          assert.equal(faultApplied, true);
          const committed = JSON.parse(
            readFileSync(
              join(h.home, 'security', 'paired-devices.json'),
              'utf8',
            ),
          );
          assert.equal(
            committed.devices.find(
              (device: { id: string }) => device.id === h.paired.device.id,
            ).revokedAt,
            null,
          );
          assert.notEqual(
            committed.devices.find(
              (device: { id: string }) => device.id === other.device.id,
            ).revokedAt,
            null,
          );
          authorize.mockClear();
          scope.mockClear();
          operator.mockClear();
          denied(lease.assertCurrent);
          assert.equal(authorize.mock.calls.length, 0);
          assert.equal(scope.mock.calls.length, 0);
          assert.equal(operator.mock.calls.length, 0);
          checked = true;
        }),
      /Paired-device registry revision changed/,
    );
    assert.equal(
      checked,
      true,
      'the target grant was checked inside the active uncertain span',
    );
  } finally {
    fault.mockRestore();
    syncBuiltinESMExports();
  }
});

test('route currency reads the operator record once and keeps signer checks independent', async () => {
  const h = await setup();
  const owner = await captureEnvironmentLocalGrantObservationOwner(
    h.request,
    h.environment,
    h.environment,
  );
  const lease = owner.requireCurrentLocalGrant(h.request);
  const legacy = legacyRouteSecurity(h.environment);
  const original = fs.readFileSync;
  let reads = 0;
  const probe = vi.spyOn(fs, 'readFileSync').mockImplementation((...args) => {
    if (String(args[0]) === join(h.home, 'security', 'environment.json'))
      reads++;
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    h.environment.verifyOperatorCredential(h.paired.credential);
    assert.ok(reads > 0, 'operator-record observer must execute');
    reads = 0;
    assert.equal(
      h.environment.withCurrentAuthority(() =>
        isRuntimeRequestPrincipalCurrent(h.request, legacy),
      ),
      true,
    );
    const legacyReads = reads;
    reads = 0;
    assert.equal(
      h.environment.withCurrentAuthority(() =>
        isRuntimeRequestPrincipalCurrent(h.request, h.environment),
      ),
      true,
    );
    const routeReads = reads;
    assert.ok(
      routeReads <= 1,
      `route currency read environment.json ${routeReads} times; maximum 1`,
    );
    assert.ok(
      routeReads < legacyReads,
      'assessment must avoid duplicate legacy record reads',
    );
    reads = 0;
    h.environment.signRevisionEvidenceAuthorityBinding('route-cost-control');
    const signerReads = reads;
    assert.equal(
      signerReads,
      2,
      'signer retains its before/after identity checks',
    );
    reads = 0;
    lease.assertCurrent();
    assert.ok(
      reads <= signerReads + 2 * routeReads,
      `owner currency read environment.json ${reads} times`,
    );
  } finally {
    probe.mockRestore();
    syncBuiltinESMExports();
  }
});

function legacyRouteSecurity(environment: EnvironmentSecurityService) {
  return {
    authorizeCredential: (
      credential: string,
      route: { method: string; path: string },
    ) => environment.authorizeCredential(credential, route),
    resolveGrantedScope: (credential: string) =>
      environment.resolveGrantedScope(credential),
    verifyOperatorCredential: (credential: string) =>
      environment.verifyOperatorCredential(credential),
  };
}

test.each([
  'operator',
  'local-grant',
  'ui-bootstrap',
  'read-only',
  'alias',
  'approver',
  'unknown',
  'revoked',
] as const)(
  'route assessment preserves legacy policy and fixed outcomes for %s',
  async (kind) => {
    const h = await setup(
      kind === 'approver'
        ? null
        : kind === 'ui-bootstrap'
          ? kind
          : 'local-grant',
      kind === 'read-only' ? 'orchestration:read' : undefined,
    );
    if (kind === 'approver')
      h.environment.devicePairing.setDeviceApprovalAuthority(
        h.paired.device.id,
        true,
        { kind: 'presented-credential' },
      );
    const alias =
      kind === 'alias'
        ? h.environment.devicePairing.issueRelayCredentialAlias(
            h.paired.credential,
            h.paired.device.id,
          )
        : undefined;
    const request = new Request(h.request.url, { method: 'POST' });
    setRuntimeAuthenticatedRequestPrincipal(request, {
      ...h.principal,
      credential:
        kind === 'operator'
          ? h.record.credential
          : kind === 'unknown'
            ? 'unknown'
            : (alias?.credential ?? h.paired.credential),
    });
    if (kind === 'revoked')
      h.environment.devicePairing.revokeDevice(
        h.paired.device.id,
        'operator-credential',
      );
    const routes = [
      {
        method: 'POST',
        path: '/api/orchestration/chat',
        allowed: ['operator', 'local-grant', 'ui-bootstrap', 'approver'],
      },
      {
        method: 'POST',
        path: '/api/environments/peers',
        allowed: ['operator'],
      },
      {
        method: 'POST',
        path: '/api/pairing/offers',
        allowed: ['operator', 'local-grant', 'ui-bootstrap'],
      },
      {
        method: 'POST',
        path: '/api/connections/agent/example/account-login',
        allowed: ['operator'],
      },
      {
        method: 'GET',
        path: '/api/operator/telemetry-companion',
        allowed: [
          'operator',
          'local-grant',
          'ui-bootstrap',
          'read-only',
          'alias',
          'approver',
        ],
      },
      {
        method: 'POST',
        path: '/api/pairing/requests/example/confirm',
        allowed: ['operator', 'local-grant', 'ui-bootstrap', 'approver'],
      },
      {
        method: 'DELETE',
        path: '/api/pairing/devices/example',
        allowed: ['operator', 'local-grant', 'ui-bootstrap'],
      },
      { method: 'POST', path: '/unmapped-authority-route', allowed: [] },
    ];
    const legacy = legacyRouteSecurity(h.environment);
    for (const held of [false, true]) {
      const check = () => {
        for (const route of routes) {
          const actual = runtimeRequestPrincipalMayAccessHttpRoute(
            request,
            h.environment,
            route,
          );
          assert.equal(
            actual,
            runtimeRequestPrincipalMayAccessHttpRoute(request, legacy, route),
            `${kind}: ${route.path}: legacy parity`,
          );
          assert.equal(
            actual,
            route.allowed.includes(kind),
            `${kind}: ${route.path}: fixed policy`,
          );
        }
      };
      if (held) h.environment.withCurrentAuthority(check);
      else check();
    }
  },
);

test('route assessment never reuses an operator decision within a span or after rotation', async () => {
  const h = await setup();
  const request = new Request(h.request.url, { method: 'POST' });
  setRuntimeAuthenticatedRequestPrincipal(request, {
    ...h.principal,
    credential: h.record.credential,
  });
  const path = join(h.home, 'security', 'environment.json');
  const original = readFileSync(path);
  try {
    h.environment.withCurrentAuthority(() => {
      assert.equal(
        isRuntimeRequestPrincipalCurrent(request, h.environment),
        true,
      );
      const replacement = `${path}.replacement`;
      writeFileSync(
        replacement,
        JSON.stringify({
          ...h.record,
          credential: randomBytes(32).toString('base64url'),
        }),
        { mode: 0o600 },
      );
      renameSync(replacement, path);
      assert.equal(
        isRuntimeRequestPrincipalCurrent(request, h.environment),
        false,
      );
    });
  } finally {
    writeFileSync(path, original, { mode: 0o600 });
  }
  assert.equal(isRuntimeRequestPrincipalCurrent(request, h.environment), true);
  await h.environment.rotateCredential();
  assert.equal(isRuntimeRequestPrincipalCurrent(request, h.environment), false);
});

test.each(['missing', 'corrupt'] as const)(
  'route assessment preserves record failure policy (%s)',
  async (mode) => {
    const h = await setup();
    const operator = new Request(h.request.url, { method: 'POST' });
    setRuntimeAuthenticatedRequestPrincipal(operator, {
      ...h.principal,
      credential: h.record.credential,
    });
    // Warm the existing cadence-based last-used touch before faulting only the record.
    assert.equal(
      isRuntimeRequestPrincipalCurrent(h.request, h.environment),
      true,
    );
    const path = join(h.home, 'security', 'environment.json');
    if (mode === 'missing') rmSync(path);
    else writeFileSync(path, 'invalid record');
    const legacy = legacyRouteSecurity(h.environment);
    for (const [request, expected] of [
      [operator, false],
      [h.request, true],
    ] as const) {
      assert.equal(
        isRuntimeRequestPrincipalCurrent(request, h.environment),
        expected,
      );
      assert.equal(isRuntimeRequestPrincipalCurrent(request, legacy), expected);
    }
  },
);

test('route assessment strips activity while ingress authorization counts the real request', async () => {
  const h = await setup();
  h.environment.withCurrentAuthority(() =>
    assert.equal(
      isRuntimeRequestPrincipalCurrent(h.request, h.environment),
      true,
    ),
  );
  const before = h.environment.devicePairing
    .listDevices()
    .find((device) => device.id === h.paired.device.id);
  assert.ok(before);
  const route = {
    method: 'POST',
    path: '/api/orchestration/chat',
    activity: { lastSeenFrom: 'tailnet' as const },
  };
  h.environment.withCurrentAuthority(() =>
    assert.ok(h.environment.assessCredentialRoute(h.paired.credential, route)),
  );
  const after = h.environment.devicePairing
    .listDevices()
    .find((device) => device.id === h.paired.device.id);
  assert.deepEqual(after, before);
  assert.equal(
    h.environment.authorizeCredential(h.paired.credential, route),
    true,
  );
  const counted = h.environment.devicePairing
    .listDevices()
    .find((device) => device.id === h.paired.device.id);
  assert.ok(counted);
  assert.equal(counted.usageCount, (before.usageCount ?? 0) + 1);
  assert.equal(counted.lastSeenFrom, 'tailnet');
});
