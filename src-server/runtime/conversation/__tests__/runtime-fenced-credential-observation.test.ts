import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { engineConnectionId } from '@kontourai/station-contracts/agent-identity';
import { test } from 'vitest';
import { trackTempDirs } from '../../../__test-utils__/temp-dirs.js';
import { ConfigLoader } from '../../../domain/config-loader.js';
import { FileStorageAdapter } from '../../../domain/file-storage-adapter.js';
import {
  bindRuntimeLocalOperator,
  getRuntimeAuthenticatedRequestPrincipal,
  setRuntimeAuthenticatedRequestPrincipal,
} from '../../../security/runtime-request-security.js';
import {
  type AgentMetadata,
  AgentService,
} from '../../../services/agents/agent-service.js';
import { ProviderService } from '../../../services/connections/provider-service.js';
import { EventStore } from '../../../services/orchestration/event-store.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { createLogger } from '../../../utils/logger.js';
import { StationRuntime } from '../../bootstrap/station-runtime.js';
import { readObservedSdkProviderCredential } from '../provider-credential-observation.js';
import {
  RuntimeCredentialObservationUnavailable,
  type RuntimeFencedCredentialObservationInput,
  RuntimeFencedCredentialObservationOwner,
  type RuntimeFencedCredentialObservationOwners,
} from '../runtime-fenced-credential-observation.js';

const makeTempDir = trackTempDirs();

type Lease = RuntimeFencedCredentialObservationOwners['runtime'];
async function setup() {
  const home = realpathSync(makeTempDir('runtime-observation-caller-'));
  chmodSync(home, 0o700);
  const loader = new ConfigLoader({
    projectHomeDir: home,
    enforceHomeSchema: true,
  });
  await loader.ensureHomeSchema();
  await loader.loadAppConfig();
  const environment = new EnvironmentSecurityService({ homeDir: home });
  await environment.initialize();
  const offer = environment.devicePairing.createOffer({
    endpoint: 'http://127.0.0.1:43979',
  });
  const requested = environment.devicePairing.requestPairing({
    offerId: offer.offerId,
    proof: offer.challenge,
    deviceName: 'runtime-caller-fixture',
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
    mintKind: 'local-grant',
  });
  const controller = new AbortController();
  const request = new Request('http://127.0.0.1:43979/api/orchestration/chat', {
    method: 'POST',
    signal: controller.signal,
  });
  setRuntimeAuthenticatedRequestPrincipal(request, {
    kind: 'credential',
    authority: 'device-credential',
    credential: paired.credential,
    source: 'bearer',
    locality: 'home-possession',
    mintKind: 'local-grant',
  });
  bindRuntimeLocalOperator(request);
  const adapter = new FileStorageAdapter(home);
  for (const id of ['selected', 'other'])
    await adapter.saveProviderConnection({
      id,
      name: id,
      type: 'anthropic',
      enabled: true,
      capabilities: ['llm'],
      config: {
        apiKey: `synthetic-${id}-key`,
        baseUrl: 'https://api.anthropic.com/v1',
      },
    });
  const metadata = new Map<string, AgentMetadata>([
    [
      'default',
      {
        slug: 'station',
        name: 'Station',
        execution: { modelId: 'initial-fixture-model' },
      },
    ],
  ]);
  const agentService = new AgentService(
    loader,
    adapter,
    new Map(),
    metadata,
    new Map(),
    createLogger({ name: 'runtime-observation-fixture', level: 'error' }),
  );
  let revision: number | null = 2;
  // Controlled lease scheduling only. Source/configuration/projection proof
  // remains the ACTUAL ConfigLoader and AgentService implementation above.
  const runtime: Lease = {
    getAgentConfigurationRevision: () => revision,
    async commitAgentConfigurationRead(expected, callback) {
      if (revision !== expected) throw new Error('Controlled stale lease');
      const result = await callback();
      if (revision !== expected) throw new Error('Controlled lease changed');
      return result;
    },
  };
  const owners: RuntimeFencedCredentialObservationOwners = {
    configLoader: loader,
    agentService,
    storageAdapter: adapter,
    environmentSecurityService: environment,
    requestSecurity: environment,
    runtime,
  };
  const service = new RuntimeFencedCredentialObservationOwner(owners);
  const input: RuntimeFencedCredentialObservationInput = {
    agentIds: ['station'],
    operation: { kind: 'capture', connectionId: 'selected' },
  };
  const directory = join(
    home,
    'security',
    'provider-credential-observations-v1',
  );
  const records = () =>
    existsSync(directory)
      ? readdirSync(directory).filter((n) => n.endsWith('.json'))
      : [];
  return {
    service,
    home,
    loader,
    environment,
    paired,
    adapter,
    metadata,
    owners,
    runtime,
    request,
    controller,
    input,
    directory,
    records,
    setRevision: (value: number | null) => {
      revision = value;
    },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
async function refused(action: () => Promise<unknown>) {
  await assert.rejects(
    action,
    (error: unknown) =>
      error instanceof RuntimeCredentialObservationUnavailable &&
      error.code === 'credential_observation_unavailable',
  );
}
function pauseAuthority(h: Awaited<ReturnType<typeof setup>>) {
  const read = h.environment.readExistingRecord.bind(h.environment);
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    started = resolve;
  });
  let count = 0;
  h.environment.readExistingRecord = async () => {
    const record = await read();
    if (++count === 1) {
      started();
      await gate;
    }
    return record;
  };
  return { began, release };
}

test('real config/runtime/local-grant owners capture and revalidate only DTO-safe credential-source observations', async () => {
  const h = await setup();
  try {
    const receipt = await h.service.observe(h.request, h.input);
    assert.deepEqual(Object.keys(receipt).sort(), [
      'expiresAtMs',
      'kind',
      'observationId',
      'observedAtMs',
    ]);
    assert.equal(receipt.kind, 'credential-source-observation');
    assert.equal(Object.isFrozen(receipt), true);
    const replay = await h.service.observe(h.request, {
      agentIds: ['station'],
      operation: { kind: 'revalidate', observationId: receipt.observationId },
    });
    assert.deepEqual(replay, receipt);
    assert.equal(h.records().length, 1);
  } finally {
    h.cleanup();
  }
});

test('input IDs and selected operation are snapshotted before asynchronous authority capture', async () => {
  const h = await setup();
  try {
    const input = {
      agentIds: ['station'],
      operation: { kind: 'capture' as const, connectionId: 'selected' },
    };
    const pause = pauseAuthority(h);
    const pending = h.service.observe(h.request, input);
    await pause.began;
    input.agentIds[0] = 'other-agent';
    input.operation.connectionId = 'other';
    pause.release();
    const receipt = await pending;
    const record = JSON.parse(
      readFileSync(join(h.directory, `${receipt.observationId}.json`), 'utf8'),
    );
    assert.equal(record.connectionId, 'selected');
    assert.equal(h.records().length, 1);
  } finally {
    h.cleanup();
  }
});

test('actual AgentService projection and ConfigLoader file changes across authority awaits refuse before persistence', async () => {
  for (const change of [
    'projection',
    'configuration',
    'revision',
    'reconciling',
    'abort',
  ] as const) {
    const h = await setup();
    try {
      const pause = pauseAuthority(h);
      const pending = h.service.observe(h.request, h.input);
      const denied = refused(() => pending);
      await pause.began;
      if (change === 'projection')
        h.metadata.set('default', {
          slug: 'station',
          name: 'Station',
          execution: { modelId: 'changed-fixture-model' },
        });
      if (change === 'configuration')
        writeFileSync(join(h.home, 'config', 'app.json'), '{}', {
          mode: 0o600,
        });
      if (change === 'revision') h.setRevision(4);
      if (change === 'reconciling') h.setRevision(null);
      if (change === 'abort') h.controller.abort();
      pause.release();
      await denied;
      assert.equal(h.records().length, 0, change);
    } finally {
      h.cleanup();
    }
  }
});

test('controlled lease rejection deactivates a queued callback before any late observation effect', async () => {
  const h = await setup();
  try {
    let late: (() => Promise<unknown>) | undefined;
    h.runtime.commitAgentConfigurationRead = async (_expected, callback) => {
      late = callback;
      throw new Error('Controlled lease timed out with callback queued');
    };
    await refused(() => h.service.observe(h.request, h.input));
    assert.ok(late);
    await refused(async () => late!());
    assert.equal(h.records().length, 0);
  } finally {
    h.cleanup();
  }
});

test('callback is single-use and post-effect lease failure suppresses disclosure rather than claiming rollback', async () => {
  for (const mode of [
    'replay',
    'post-effect-failure',
    'post-effect-revocation',
    'post-effect-projection',
    'post-effect-configuration',
  ] as const) {
    const h = await setup();
    try {
      let replay: (() => Promise<unknown>) | undefined;
      h.runtime.commitAgentConfigurationRead = async (_expected, callback) => {
        replay = callback;
        const result = await callback();
        if (mode === 'post-effect-failure')
          throw new Error('Controlled stale lease after effect');
        if (mode === 'post-effect-revocation')
          h.environment.devicePairing.revokeDevice(
            h.paired.device.id,
            'operator-credential',
          );
        if (mode === 'post-effect-projection')
          h.metadata.set('default', {
            slug: 'station',
            name: 'Station',
            execution: { modelId: 'changed-after-effect' },
          });
        if (mode === 'post-effect-configuration')
          writeFileSync(join(h.home, 'config', 'app.json'), '{}', {
            mode: 0o600,
          });
        return result;
      };
      if (mode === 'replay') {
        const receipt = await h.service.observe(h.request, h.input);
        assert.equal(receipt.kind, 'credential-source-observation');
      } else await refused(() => h.service.observe(h.request, h.input));
      assert.equal(h.records().length, 1);
      assert.ok(replay);
      await refused(async () => replay!());
      assert.equal(h.records().length, 1);
    } finally {
      h.cleanup();
    }
  }
});

test('callback performs the observation synchronously without an await between gate entry and persistence', async () => {
  const h = await setup();
  try {
    h.runtime.commitAgentConfigurationRead = async (_expected, callback) => {
      assert.equal(h.records().length, 0);
      const promise = callback();
      assert.equal(h.records().length, 1); // Effect already happened before callback yields its Promise.
      return promise;
    };
    assert.equal(
      (await h.service.observe(h.request, h.input)).kind,
      'credential-source-observation',
    );
  } finally {
    h.cleanup();
  }
});

test('unavailable initial runtime and aborted request never enter the controlled lease or persist an observation', async () => {
  for (const mode of ['reconciling', 'abort'] as const) {
    const h = await setup();
    try {
      let commits = 0;
      h.runtime.commitAgentConfigurationRead = async () => {
        commits++;
        throw new Error('Unexpected controlled lease');
      };
      if (mode === 'reconciling') h.setRevision(null);
      else h.controller.abort();
      await refused(() => h.service.observe(h.request, h.input));
      assert.equal(commits, 0);
      assert.equal(h.records().length, 0);
    } finally {
      h.cleanup();
    }
  }
});

for (const change of ['configuration', 'projection', 'revision'] as const) {
  test(`capture-time ${change} fence survives ordinary separate calls and fresh Request authorization`, async () => {
    const h = await setup();
    try {
      const observed = await h.service.observe(h.request, h.input);
      if (change === 'configuration')
        writeFileSync(join(h.home, 'config', 'app.json'), '{}', {
          mode: 0o600,
        });
      if (change === 'projection')
        h.metadata.set('default', {
          slug: 'station',
          name: 'Station',
          execution: { modelId: 'changed-between-calls' },
        });
      if (change === 'revision') h.setRevision(4);
      const next = new Request(h.request.url, { method: 'POST' });
      const principal = getRuntimeAuthenticatedRequestPrincipal(h.request)!;
      setRuntimeAuthenticatedRequestPrincipal(next, principal);
      bindRuntimeLocalOperator(next);
      await refused(() =>
        h.service.observe(next, {
          agentIds: ['station'],
          operation: {
            kind: 'revalidate',
            observationId: observed.observationId,
          },
        }),
      );
    } finally {
      h.cleanup();
    }
  });
}

for (const mixed of ['adapter', 'authority', 'agent'] as const) {
  test(`different actual ${mixed} home cannot borrow byte-identical providers from the selected home`, async () => {
    const h = await setup();
    const other = await setup();
    try {
      assert.equal(
        readFileSync(join(h.home, 'config', 'providers.json'), 'utf8'),
        readFileSync(join(other.home, 'config', 'providers.json'), 'utf8'),
      );
      const owners = {
        ...h.owners,
        ...(mixed === 'adapter'
          ? { storageAdapter: other.adapter }
          : mixed === 'authority'
            ? {
                environmentSecurityService: other.environment,
                requestSecurity: other.environment,
              }
            : { agentService: other.owners.agentService }),
      };
      await refused(async () =>
        new RuntimeFencedCredentialObservationOwner(owners).observe(
          mixed === 'authority' ? other.request : h.request,
          h.input,
        ),
      );
      assert.equal(h.records().length, 0);
      assert.equal(other.records().length, 0);
    } finally {
      h.cleanup();
      other.cleanup();
    }
  });
}

test('fresh Request authorization survives normal calls; restarted owner and changed agent selection require new preparation', async () => {
  const h = await setup();
  try {
    const observed = await h.service.observe(h.request, h.input);
    const next = new Request(h.request.url, { method: 'POST' });
    setRuntimeAuthenticatedRequestPrincipal(
      next,
      getRuntimeAuthenticatedRequestPrincipal(h.request)!,
    );
    bindRuntimeLocalOperator(next);
    const replay = {
      agentIds: ['station'],
      operation: {
        kind: 'revalidate' as const,
        observationId: observed.observationId,
      },
    };
    assert.deepEqual(await h.service.observe(next, replay), observed);
    await refused(() =>
      h.service.observe(next, { ...replay, agentIds: ['other-agent'] }),
    );
    const restarted = new RuntimeFencedCredentialObservationOwner(h.owners);
    await refused(() => restarted.observe(next, replay));
    assert.equal(
      (await restarted.observe(next, h.input)).kind,
      'credential-source-observation',
    );
    h.environment.devicePairing.revokeDevice(
      h.paired.device.id,
      'operator-credential',
    );
    await refused(() => h.service.observe(next, replay));
    assert.equal(h.records().length, 2);
  } finally {
    h.cleanup();
  }
});

for (const kind of ['capture', 'revalidate'] as const) {
  test(`${kind} refuses disclosure after real expiry across the outer lease await`, async () => {
    const h = await setup();
    try {
      const lifetimeMs = 1000;
      const capture = {
        agentIds: ['station'],
        operation: {
          kind: 'capture' as const,
          connectionId: 'selected',
          lifetimeMs,
        },
      };
      const prior =
        kind === 'revalidate'
          ? await h.service.observe(h.request, capture)
          : undefined;
      let callbackReceipt:
        | Awaited<ReturnType<typeof h.service.observe>>
        | undefined;
      h.runtime.commitAgentConfigurationRead = async (_expected, callback) => {
        const result = await callback();
        assert.ok(
          result &&
            typeof result === 'object' &&
            'expiresAtMs' in result &&
            typeof result.expiresAtMs === 'number' &&
            'observedAtMs' in result &&
            typeof result.observedAtMs === 'number' &&
            'observationId' in result &&
            typeof result.observationId === 'string' &&
            'kind' in result &&
            result.kind === 'credential-source-observation',
        );
        const { observationId, observedAtMs, expiresAtMs } = result;
        assert.ok(typeof observationId === 'string');
        assert.ok(typeof observedAtMs === 'number');
        assert.ok(typeof expiresAtMs === 'number');
        callbackReceipt = {
          observationId,
          observedAtMs,
          expiresAtMs,
          kind: 'credential-source-observation',
        };
        assert.ok(
          Date.now() < expiresAtMs,
          'callback must complete while observation is live',
        );
        assert.equal(result.expiresAtMs - result.observedAtMs, lifetimeMs);
        if (prior)
          assert.deepEqual(
            result,
            prior,
            'revalidation must preserve the original timestamp window',
          );
        // Real elapsed time, no replacement clock or synthetic expiry receipt.
        while (Date.now() <= expiresAtMs + 30)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.max(1, expiresAtMs + 31 - Date.now())),
          );
        return result;
      };
      await refused(() =>
        h.service.observe(
          h.request,
          prior
            ? {
                agentIds: ['station'],
                operation: {
                  kind: 'revalidate',
                  observationId: prior.observationId,
                },
              }
            : capture,
        ),
      );
      assert.ok(callbackReceipt);
      assert.ok(Date.now() >= callbackReceipt.expiresAtMs);
      assert.equal(
        h.records().length,
        1,
        'expired disclosure refusal does not claim persistence rollback',
      );
      const stored = JSON.parse(
        readFileSync(
          join(h.directory, `${callbackReceipt.observationId}.json`),
          'utf8',
        ),
      );
      assert.equal(stored.observedAtMs, callbackReceipt.observedAtMs);
      assert.equal(stored.expiresAtMs, callbackReceipt.expiresAtMs);
    } finally {
      h.cleanup();
    }
  });
}

test('unchanged live capture and revalidation retain the exact original timestamp window across the outer lease', async () => {
  const h = await setup();
  try {
    const capture = await h.service.observe(h.request, {
      agentIds: ['station'],
      operation: {
        kind: 'capture',
        connectionId: 'selected',
        lifetimeMs: 1000,
      },
    });
    assert.ok(Date.now() < capture.expiresAtMs);
    assert.equal(capture.expiresAtMs - capture.observedAtMs, 1000);
    const replay = await h.service.observe(h.request, {
      agentIds: ['station'],
      operation: { kind: 'revalidate', observationId: capture.observationId },
    });
    assert.deepEqual(replay, capture);
    assert.ok(Date.now() < replay.expiresAtMs);
  } finally {
    h.cleanup();
  }
});

for (const mode of ['observation', 'sdk'] as const) {
  test(`actual StationRuntime read queue refuses aborted queued ${mode} capture and admits a later current request`, async () => {
    const h = await setup();
    const events = new EventStore(join(h.home, 'lease-events.db'));
    const providers = new ProviderService(h.adapter, () =>
      h.loader.loadAppConfig(),
    );
    const station: StationRuntime = Object.create(StationRuntime.prototype);
    Object.assign(station, {
      agentConfigurationRevision: 2,
      agentConfigurationMutationQueue: Promise.resolve(),
      agentConfigurationPersistenceQueue: Promise.resolve(),
      agentConfigurationMutationsClosed: false,
      configLoader: h.loader,
      providerService: providers,
      orchestrationEventStore: events,
      loadedProviderLaunchabilityRevision: providers.getLaunchabilityRevision(),
      loadedAppConfigLaunchabilityRevision: h.loader.getLaunchabilityRevision(),
      loadedSelectedPackageFingerprint: createHash('sha256')
        .update('[]')
        .digest('hex'),
    });
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holding = station.commitAgentConfigurationRead(2, async () => {
      entered();
      await blocked;
    });
    let queued!: () => void;
    const queueEntered = new Promise<void>((resolve) => {
      queued = resolve;
    });
    const owner = new RuntimeFencedCredentialObservationOwner({
      ...h.owners,
      runtime: {
        getAgentConfigurationRevision: () => 2,
        commitAgentConfigurationRead(expected, operation) {
          queued();
          return station.commitAgentConfigurationRead(expected, operation);
        },
      },
    });
    try {
      await started;
      const capture = (request: Request) =>
        mode === 'observation'
          ? owner.observe(request, h.input)
          : owner.captureSdkCredential(request, {
              agentIds: ['station'],
              connectionId: 'selected',
              provider: 'anthropic',
            });
      const denied = refused(() => capture(h.request));
      void denied.catch(() => {});
      await queueEntered;
      assert.equal(h.records().length, 0);
      h.controller.abort();
      release();
      await holding;
      await denied;
      assert.equal(h.records().length, 0);
      const current = new Request(h.request.url, { method: 'POST' });
      setRuntimeAuthenticatedRequestPrincipal(
        current,
        getRuntimeAuthenticatedRequestPrincipal(h.request)!,
      );
      bindRuntimeLocalOperator(current);
      const receipt = await capture(current);
      if ('kind' in receipt)
        assert.equal(receipt.kind, 'credential-source-observation');
      else
        assert.equal(
          readObservedSdkProviderCredential(receipt, 'anthropic', current)
            .connectionId,
          'selected',
        );
      assert.equal(h.records().length, 1);
    } finally {
      release();
      await holding;
      events.close();
      h.cleanup();
    }
  });
}

test('SDK capture rejects configuration bytes changing between the configuration and runtime fence captures before persistence', async () => {
  const h = await setup();
  try {
    const capture =
      h.owners.agentService.capturePreparationConfigurationFence.bind(
        h.owners.agentService,
      );
    h.owners.agentService.capturePreparationConfigurationFence = (...args) => {
      const path = join(h.home, 'config', 'app.json');
      writeFileSync(path, `${readFileSync(path, 'utf8')}\n`, { mode: 0o600 });
      return capture(...args);
    };
    await assert.rejects(
      () =>
        h.service.captureSdkCredential(h.request, {
          agentIds: ['station'],
          connectionId: 'selected',
          provider: 'anthropic',
        }),
      RuntimeCredentialObservationUnavailable,
    );
    assert.equal(h.records().length, 0);
  } finally {
    h.cleanup();
  }
});

test('actual runtime lease issues an opaque SDK credential that remains bound to its request and capture fences', async () => {
  const h = await setup();
  try {
    const credential = await h.service.captureSdkCredential(h.request, {
      agentIds: ['station'],
      connectionId: 'selected',
      provider: 'anthropic',
    });
    assert.equal(JSON.stringify(credential), '{}');
    assert.equal(Object.isFrozen(credential), true);
    const observed = readObservedSdkProviderCredential(
      credential,
      'anthropic',
      h.request,
    );
    assert.equal(observed.apiKey, 'synthetic-selected-key');
    assert.equal(observed.connectionId, 'selected');
    assert.equal(h.records().length, 1);
    const copied = new Request(h.request.url, { method: 'POST' });
    setRuntimeAuthenticatedRequestPrincipal(
      copied,
      getRuntimeAuthenticatedRequestPrincipal(h.request)!,
    );
    bindRuntimeLocalOperator(copied);
    assert.throws(() =>
      readObservedSdkProviderCredential(credential, 'anthropic', copied),
    );
    h.controller.abort();
    assert.throws(() =>
      readObservedSdkProviderCredential(credential, 'anthropic', h.request),
    );
  } finally {
    h.cleanup();
  }
});

for (const change of [
  'configuration',
  'projection',
  'revision',
  'credential',
  'revoke',
] as const) {
  test(`issued SDK credential refuses later actual ${change} drift`, async () => {
    const h = await setup();
    try {
      const credential = await h.service.captureSdkCredential(h.request, {
        agentIds: ['station'],
        connectionId: 'selected',
        provider: 'anthropic',
      });
      assert.equal(
        readObservedSdkProviderCredential(credential, 'anthropic', h.request)
          .connectionId,
        'selected',
      );
      if (change === 'configuration')
        writeFileSync(join(h.home, 'config', 'app.json'), '{}', {
          mode: 0o600,
        });
      if (change === 'projection')
        h.metadata.set('default', {
          slug: 'station',
          name: 'Station',
          execution: { modelId: 'changed-after-sdk-capture' },
        });
      if (change === 'revision') h.setRevision(4);
      if (change === 'credential')
        await h.adapter.saveProviderConnection({
          id: 'selected',
          name: 'selected',
          type: 'anthropic',
          enabled: true,
          capabilities: ['llm'],
          config: {
            apiKey: 'changed-private-key',
            baseUrl: 'https://api.anthropic.com/v1',
          },
        });
      if (change === 'revoke')
        h.environment.devicePairing.revokeDevice(
          h.paired.device.id,
          'operator-credential',
        );
      assert.throws(() =>
        readObservedSdkProviderCredential(credential, 'anthropic', h.request),
      );
      assert.equal(h.records().length, 1);
    } finally {
      h.cleanup();
    }
  });
}

test('SDK capture refuses a timed-out queued callback before any credential persistence', async () => {
  const h = await setup();
  try {
    let late: (() => Promise<unknown>) | undefined;
    h.runtime.commitAgentConfigurationRead = async (_revision, callback) => {
      late = callback;
      throw Error('controlled queued lease timeout');
    };
    await refused(() =>
      h.service.captureSdkCredential(h.request, {
        agentIds: ['station'],
        connectionId: 'selected',
        provider: 'anthropic',
      }),
    );
    assert.ok(late);
    await refused(async () => late!());
    assert.equal(h.records().length, 0);
  } finally {
    h.cleanup();
  }
});

test('participating Agent preparation selects its configured managed connection, model and instructions', async () => {
  const h = await setup();
  try {
    await h.loader.saveAgent('reviewer', {
      name: 'Reviewer',
      prompt: 'Use the configured report-only instructions',
      execution: {
        modelConnectionId: 'selected',
        modelId: 'claude-sonnet-4-6',
      },
    });
    const prepared = await h.service.captureAgentSdkCredential(
      h.request,
      'reviewer',
    );
    assert.equal(prepared.agentId, 'reviewer');
    assert.equal(prepared.modelId, 'claude-sonnet-4-6');
    assert.equal(
      prepared.instructions,
      'Use the configured report-only instructions',
    );
    const observed = readObservedSdkProviderCredential(
      prepared.credential,
      'anthropic',
      h.request,
    );
    assert.equal(observed.connectionId, 'selected');
    assert.equal(observed.apiKey, 'synthetic-selected-key');
    assert.ok(!JSON.stringify(prepared).includes('synthetic-selected-key'));
    await h.loader.saveAgent('reviewer', {
      name: 'Reviewer',
      prompt: 'Later changed instructions',
      execution: { modelConnectionId: 'other', modelId: 'changed-model' },
    });
    assert.throws(() =>
      readObservedSdkProviderCredential(
        prepared.credential,
        'anthropic',
        h.request,
      ),
    );
  } finally {
    h.cleanup();
  }
});

test('native and ambiguous participating Agents cannot be converted into a paid SDK binding', async () => {
  const h = await setup();
  try {
    await h.loader.saveAgent('reviewer', {
      name: 'Reviewer',
      prompt: 'Report',
      execution: { modelId: 'claude-sonnet-4-6' },
    });
    await assert.rejects(() =>
      h.service.captureAgentSdkCredential(h.request, 'reviewer'),
    );
    assert.equal(h.records().length, 0);
    await h.loader.saveAgent('reviewer', {
      name: 'Reviewer',
      prompt: 'Report',
      execution: {
        agentConnectionId: engineConnectionId('claude'),
        modelConnectionId: 'selected',
        modelId: 'claude-sonnet-4-6',
      },
    });
    await assert.rejects(() =>
      h.service.captureAgentSdkCredential(h.request, 'reviewer'),
    );
    assert.equal(h.records().length, 0);
  } finally {
    h.cleanup();
  }
});

test('participating Agent changes during its read refuse before issuing a credential', async () => {
  const h = await setup();
  try {
    const original = {
      name: 'Reviewer',
      prompt: 'First instructions',
      execution: {
        modelConnectionId: 'selected',
        modelId: 'claude-sonnet-4-6',
      },
    };
    await h.loader.saveAgent('reviewer', original);
    const getAgent = h.owners.agentService.getAgent.bind(h.owners.agentService);
    h.owners.agentService.getAgent = async (id) => {
      const observed = await getAgent(id);
      await h.loader.saveAgent('reviewer', {
        ...original,
        prompt: 'Changed while reading',
      });
      return observed;
    };
    await assert.rejects(() =>
      h.service.captureAgentSdkCredential(h.request, 'reviewer'),
    );
    assert.equal(h.records().length, 0);
  } finally {
    h.cleanup();
  }
});

test('provider inventory drift between only-candidate selection and credential capture refuses mixed-generation preparation', async () => {
  const h = await setup();
  try {
    await h.adapter.deleteProviderConnection('other');
    await h.loader.saveAgent('reviewer', {
      name: 'Reviewer',
      prompt: 'Report',
      execution: { modelId: 'claude-sonnet-4-6' },
    });
    const capture = h.service.captureSdkCredential.bind(h.service);
    h.service.captureSdkCredential = async (request, input) => {
      await h.adapter.saveProviderConnection({
        id: 'other',
        name: 'New enabled alternative',
        type: 'anthropic',
        enabled: true,
        capabilities: ['llm'],
        config: {
          apiKey: 'synthetic-other-key',
          baseUrl: 'https://api.anthropic.com/v1',
        },
      });
      return capture(request, input);
    };
    await assert.rejects(() =>
      h.service.captureAgentSdkCredential(h.request, 'reviewer'),
    );
    assert.equal(
      h.records().length,
      1,
      'refused disclosure does not claim the inert observation was rolled back',
    );
  } finally {
    h.cleanup();
  }
});
