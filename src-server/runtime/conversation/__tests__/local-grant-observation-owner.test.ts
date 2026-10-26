import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';

import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  isRuntimeRequestPrincipalCurrent,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import { DevicePairingService } from '../../../services/ssh/device-pairing-service.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { captureEnvironmentLocalGrantObservationOwner } from '../local-grant-observation-owner.js';
import {
  ProviderCredentialObservationError,
  ProviderCredentialObservationStore,
} from '../provider-credential-observation.js';

const makeTempDir = trackTempDirs();

// Actual host/environment/request owners on an owned temporary home only.
// The server-only mint stamps/auth-boundary setters below are explicit test
// setup, not proof of a native local-grant ingress or user-authorized mint.
async function setup(
  mintKind: 'local-grant' | 'ui-bootstrap' = 'local-grant',
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
    mintKind,
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
    mintKind,
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
    const owner = await captureEnvironmentLocalGrantObservationOwner(
      h.request,
      h.environment,
      h.environment,
    );
    const lease = owner.requireCurrentLocalGrant(h.request);
    const other = new DevicePairingService({
      homeDir: h.home,
      environmentId: h.record.environmentId,
    });
    if (change === 'revoke')
      other.revokeDevice(h.paired.device.id, 'operator-credential');
    else
      other.setDeviceScope(h.paired.device.id, ['orchestration:read'], {
        kind: 'presented-credential',
      });
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
