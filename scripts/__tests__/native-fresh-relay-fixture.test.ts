import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import {
  chmodSync,
  readFileSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createConnection, createServer, Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { expect, test } from 'vitest';
import { trackTempDirs } from '../../src-server/__test-utils__/temp-dirs.js';
import {
  createBrokerCredentialBundle,
  SelfHostedBrokerService,
} from '../../src-server/services/connections/self-hosted-broker-service.js';
import { EnvironmentSecurityService } from '../../src-server/services/ssh/environment-security-service.js';
import {
  assertNativeFreshBrokerLeaseCommitted,
  installNativeFreshNodeNetworkGuard,
  loadNativeFreshFixturePlan,
  prepareNativeFreshFixture,
  prepareNativeFreshFixtureSuccessor,
  readNativeFreshPrivateJson,
} from '../lib/native-fresh-relay-fixture.js';

const makeTempDir = trackTempDirs();
const revision = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

test('fresh fixture prepares a genuine unpaired Station and refuses private-plan scope substitution or unsafe custody', async () => {
  const directory = join(makeTempDir('native-fresh-plan-'), 'run');
  const prepared = await prepareNativeFreshFixture(directory, revision);
  const path = join(directory, 'plan.json');
  expect(loadNativeFreshFixturePlan(path)).toEqual(prepared);
  const security = new EnvironmentSecurityService({
    homeDir: join(directory, 'home'),
  });
  await security.initialize();
  expect(security.devicePairing.listDevices()).toEqual([]);
  expect(prepared).not.toHaveProperty('credential');
  expect(prepared.stationTrust).not.toHaveProperty('privateKey');
  writeFileSync(
    path,
    JSON.stringify({
      ...prepared,
      scope: {
        ...prepared.scope,
        stationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      },
    }),
  );
  expect(() => loadNativeFreshFixturePlan(path)).toThrow(
    'fixture_scope_mismatch',
  );
  writeFileSync(path, JSON.stringify(prepared));
  chmodSync(path, 0o644);
  expect(() => loadNativeFreshFixturePlan(path)).toThrow(
    'fixture_private_file_required',
  );
  chmodSync(path, 0o600);
  const linked = join(directory, 'linked.json');
  symlinkSync(path, linked);
  expect(() => readNativeFreshPrivateJson(linked)).toThrow(
    'fixture_private_file_required',
  );
  expect(
    JSON.parse(readFileSync(join(directory, 'operator.json'), 'utf8')),
  ).toHaveProperty('credential');
});

async function completedBrokerFixture(withdraw = true, expired = false) {
  const root = makeTempDir('native-successor-');
  const directory = join(root, 'first');
  const prior = await prepareNativeFreshFixture(directory, revision);
  const databasePath = join(root, 'broker.sqlite');
  let now = Date.now() - (expired ? 61_000 : 0);
  const broker = new SelfHostedBrokerService(databasePath, () => now);
  const bundle = createBrokerCredentialBundle();
  broker.provision(prior.scope, 60_000, bundle);
  if (expired) now = Date.now();
  if (withdraw) broker.withdraw(prior.scope, bundle.connector);
  const write = (name: string, value: unknown) =>
    writeFileSync(join(directory, name), JSON.stringify(value), {
      mode: 0o600,
    });
  write('broker-credentials.json', {
    version: 'station-self-hosted-broker-credentials/v1',
    scope: prior.scope,
    bundle,
  });
  write('broker-init.json', {
    version: 'station-self-hosted-broker/v1',
    databasePath,
    credentialsPath: join(directory, 'broker-credentials.json'),
    port: 18765,
    provision: [prior.scope],
  });
  const child = spawnSync(process.execPath, ['-e', ''], {
    windowsHide: true,
    timeout: 5000,
  });
  expect(child.status).toBe(0);
  write('runtime-owner.json', {
    runId: prior.runId,
    pid: child.pid,
    pgid: child.pid,
  });
  write('cleanup.json', {
    runId: prior.runId,
    primaryRuntimeFailed: false,
    outputTruncated: false,
    outputInvalidUtf8: false,
    processGroupSettled: true,
    brokerCleanupConfirmed: true,
  });
  return { root, directory, prior, broker, bundle, write };
}

function fixtureCli(...args: string[]) {
  return spawnSync(
    process.execPath,
    ['--import', 'tsx', 'scripts/native-fresh-relay-fixture.ts', ...args],
    {
      cwd: resolve(import.meta.dirname, '../..'),
      windowsHide: true,
      timeout: 30_000,
      encoding: 'utf8',
      maxBuffer: 65536,
    },
  );
}

test('explicit cleanup recovery observes expired owner withdrawal and permits only a freshly checked successor without rewriting failure evidence', async () => {
  const f = await completedBrokerFixture(false, true);
  try {
    const priorPath = join(f.directory, 'plan.json');
    const cleanup = JSON.parse(
      readFileSync(join(f.directory, 'cleanup.json'), 'utf8'),
    );
    f.write('cleanup.json', { ...cleanup, brokerCleanupConfirmed: false });
    const original = readFileSync(join(f.directory, 'cleanup.json'));
    expect(fixtureCli('confirm-recovered-cleanup', priorPath, '1').status).toBe(
      1,
    );
    expect(() => f.broker.register(f.prior.scope, f.bundle.connector)).toThrow(
      'broker_credential_refused',
    );
    f.broker.withdraw(f.prior.scope, f.bundle.connector);
    const confirmed = fixtureCli('confirm-recovered-cleanup', priorPath, '1');
    expect({ status: confirmed.status, error: confirmed.error?.name }).toEqual({
      status: 0,
      error: undefined,
    });
    const recoveryPath = join(f.directory, 'recovered-cleanup.json');
    const recovery = readNativeFreshPrivateJson(recoveryPath) as {
      runId: string;
      scope: typeof f.prior.scope;
      withdrawnAt: number;
    };
    expect(recovery.runId).toBe(f.prior.runId);
    expect(recovery.scope).toEqual(f.prior.scope);
    expect(recovery.withdrawnAt).toBeGreaterThan(0);
    expect(readFileSync(join(f.directory, 'cleanup.json'))).toEqual(original);
    expect(fixtureCli('confirm-recovered-cleanup', priorPath, '1').status).toBe(
      1,
    );
    const successorDirectory = join(f.root, 'second');
    expect(
      fixtureCli('prepare-successor', priorPath, successorDirectory, '1')
        .status,
    ).toBe(0);
    const successor = loadNativeFreshFixturePlan(
      join(successorDirectory, 'plan.json'),
    );
    expect(successor.scope.routingGeneration).toBe(2);
    expect(() => assertNativeFreshBrokerLeaseCommitted(successor)).toThrow();
    expect(readFileSync(join(f.directory, 'cleanup.json'))).toEqual(original);

    for (const invalid of [
      { ...recovery, runId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
      { ...recovery, scope: { ...recovery.scope, routingGeneration: 2 } },
      { ...recovery, withdrawnAt: 1 },
      { ...recovery, credentialsSha256: 'b'.repeat(64) },
      { ...recovery, extra: true },
    ]) {
      f.write('recovered-cleanup.json', invalid);
      await expect(
        prepareNativeFreshFixtureSuccessor(
          priorPath,
          join(f.root, 'refused'),
          1,
          revision,
        ),
      ).rejects.toThrow();
    }
    f.write('recovered-cleanup.json', recovery);
    chmodSync(recoveryPath, 0o644);
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'public'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_private_file_required');
    chmodSync(recoveryPath, 0o600);
    const owner = JSON.parse(
      readFileSync(join(f.directory, 'runtime-owner.json'), 'utf8'),
    );
    f.write('runtime-owner.json', { ...owner, pid: process.pid });
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'live'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_prior_process_live');
    f.write('runtime-owner.json', owner);
    f.broker.provision(
      { ...f.prior.scope, routingGeneration: 2 },
      60_000,
      createBrokerCredentialBundle(),
    );
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'newer'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_broker_generation_changed');
  } finally {
    f.broker.close();
  }
});

test('operator successor retains the genuine Station home and trust, provisions exact generation two, and fences old cleanup and newer owners', async () => {
  const f = await completedBrokerFixture();
  try {
    const unrelated = {
      ...f.prior.scope,
      stationId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const unrelatedBundle = createBrokerCredentialBundle();
    f.broker.provision(unrelated, 60_000, unrelatedBundle);
    const successorDirectory = join(f.root, 'second');
    const prepared = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/native-fresh-relay-fixture.ts',
        'prepare-successor',
        join(f.directory, 'plan.json'),
        successorDirectory,
        '1',
      ],
      {
        cwd: resolve(import.meta.dirname, '../..'),
        windowsHide: true,
        timeout: 30_000,
        encoding: 'utf8',
        maxBuffer: 65536,
      },
    );
    expect({
      status: prepared.status,
      errorType: prepared.error?.name,
    }).toEqual({ status: 0, errorType: undefined });
    const successor = loadNativeFreshFixturePlan(
      join(successorDirectory, 'plan.json'),
    );
    expect(successor.scope.routingGeneration).toBe(2);
    expect(successor.stationHome).toBe(join(f.directory, 'home'));
    expect(successor.stationTrust).toEqual(f.prior.stationTrust);
    expect(successor.applicationOrigin).toBe(f.prior.applicationOrigin);
    expect(successor.runId === f.prior.runId).toBe(false);
    const credentials = JSON.parse(
      readFileSync(
        join(successor.directory, 'broker-credentials.json'),
        'utf8',
      ),
    );
    expect(
      credentials.bundle.connector.secret === f.bundle.connector.secret,
    ).toBe(false);
    expect(() => assertNativeFreshBrokerLeaseCommitted(successor)).toThrow();
    // Normal production provisioning owns the transaction; preparation did not initialize a lease.
    const initialized = spawnSync(
      process.execPath,
      [
        '--import',
        'tsx',
        'scripts/self-hosted-broker.ts',
        'init',
        join(successor.directory, 'broker-init.json'),
      ],
      {
        cwd: resolve(import.meta.dirname, '../..'),
        windowsHide: true,
        timeout: 30_000,
        encoding: 'utf8',
        maxBuffer: 65536,
      },
    );
    expect({
      status: initialized.status,
      errorType: initialized.error?.name,
    }).toEqual({ status: 0, errorType: undefined });
    expect(() =>
      assertNativeFreshBrokerLeaseCommitted(successor),
    ).not.toThrow();
    expect(() =>
      f.broker.withdraw(f.prior.scope, f.bundle.connector),
    ).toThrow();
    expect(() =>
      assertNativeFreshBrokerLeaseCommitted(successor),
    ).not.toThrow();
    expect(() =>
      f.broker.register(unrelated, unrelatedBundle.connector),
    ).not.toThrow();
    await expect(
      prepareNativeFreshFixtureSuccessor(
        join(f.directory, 'plan.json'),
        join(f.root, 'stale'),
        1,
        revision,
      ),
    ).rejects.toThrow();
    f.broker.provision(
      { ...successor.scope, routingGeneration: 3 },
      60_000,
      credentials.bundle,
    );
    expect(() => assertNativeFreshBrokerLeaseCommitted(successor)).toThrow(
      'fixture_broker_generation_changed',
    );
  } finally {
    f.broker.close();
  }
});

test('successor refuses a live declared child, mismatched generation, incomplete cleanup, foreign private bundle and unsafe custody', async () => {
  const f = await completedBrokerFixture();
  try {
    const priorPath = join(f.directory, 'plan.json');
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'bad-generation'),
        2,
        revision,
      ),
    ).rejects.toThrow('fixture_expected_generation_mismatch');
    const owner = JSON.parse(
      readFileSync(join(f.directory, 'runtime-owner.json'), 'utf8'),
    );
    f.write('runtime-owner.json', { ...owner, pid: process.pid });
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'live'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_prior_process_live');
    f.write('runtime-owner.json', owner);
    const cleanup = JSON.parse(
      readFileSync(join(f.directory, 'cleanup.json'), 'utf8'),
    );
    f.write('cleanup.json', { ...cleanup, processGroupSettled: false });
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'unsettled'),
        1,
        revision,
      ),
    ).rejects.toThrow();
    f.write('cleanup.json', cleanup);
    const credentialPath = join(f.directory, 'broker-credentials.json');
    const credentials = JSON.parse(readFileSync(credentialPath, 'utf8'));
    f.write('broker-credentials.json', {
      ...credentials,
      bundle: {
        connector: {
          ...credentials.bundle.connector,
          secret: createBrokerCredentialBundle().connector.secret,
        },
        routing: credentials.bundle.routing,
      },
    });
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'foreign'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_broker_owner_mismatch');
    f.write('broker-credentials.json', credentials);
    chmodSync(credentialPath, 0o644);
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'public'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_private_file_required');
    chmodSync(credentialPath, 0o600);
    const saved = join(f.directory, 'saved-broker-credentials.json');
    renameSync(credentialPath, saved);
    symlinkSync(saved, credentialPath);
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'linked'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_private_file_required');
    unlinkSync(credentialPath);
    renameSync(saved, credentialPath);
    const config = JSON.parse(
      readFileSync(join(f.directory, 'broker-init.json'), 'utf8'),
    );
    const databaseLink = join(f.root, 'linked-broker.sqlite');
    symlinkSync(config.databasePath, databaseLink);
    f.write('broker-init.json', { ...config, databasePath: databaseLink });
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'linked-database'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_private_broker_database_required');
    f.write('broker-init.json', {
      ...config,
      provision: [
        {
          ...f.prior.scope,
          enrollmentId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        },
      ],
    });
    await expect(
      prepareNativeFreshFixtureSuccessor(
        priorPath,
        join(f.root, 'foreign-scope'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_broker_scope_mismatch');
  } finally {
    f.broker.close();
  }
  const live = await completedBrokerFixture(false);
  try {
    await expect(
      prepareNativeFreshFixtureSuccessor(
        join(live.directory, 'plan.json'),
        join(live.root, 'not-withdrawn'),
        1,
        revision,
      ),
    ).rejects.toThrow('fixture_prior_scope_not_withdrawn');
  } finally {
    live.broker.close();
  }
});

test('disposable native fixture network guard permits its real local listener and refuses foreign HTTPS, unowned local ports and Unix sockets', async () => {
  const directory = join(makeTempDir('native-fresh-network-'), 'run');
  const plan = await prepareNativeFreshFixture(directory, revision);
  const server = createServer((socket) => socket.end('fixed small text'));
  server.listen(plan.port, '127.0.0.1');
  await once(server, 'listening');
  const original = Socket.prototype.connect;
  try {
    installNativeFreshNodeNetworkGuard(plan);
    const client = createConnection({ host: '127.0.0.1', port: plan.port });
    const chunks: Buffer[] = [];
    client.on('data', (value) =>
      chunks.push(typeof value === 'string' ? Buffer.from(value) : value),
    );
    await once(client, 'end');
    expect(Buffer.concat(chunks).toString('utf8')).toBe('fixed small text');
    expect(() => createConnection({ host: 'example.com', port: 443 })).toThrow(
      'fixture_node_destination_refused',
    );
    expect(() =>
      createConnection({ host: 'relay-test.kontourai.com', port: 80 }),
    ).toThrow('fixture_node_destination_refused');
    expect(() =>
      createConnection({ host: '127.0.0.1', port: plan.port + 4 }),
    ).toThrow('fixture_node_destination_refused');
    expect(() =>
      createConnection({ path: '/private/tmp/native-fixture-unowned.sock' }),
    ).toThrow();
  } finally {
    Socket.prototype.connect = original;
    await new Promise<void>((resolveClose, reject) =>
      server.close((error) => (error ? reject(error) : resolveClose())),
    );
  }
});
