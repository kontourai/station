import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'vitest';
import { createBrokerCredentialBundle } from '../../../services/connections/self-hosted-broker-service.js';
import { ConnectionSigningKeyStore } from '../../../services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../../../services/ssh/environment-security-service.js';
import { SelfHostedBrokerRuntime } from '../self-hosted-broker-runtime.js';
import {
  createConnectorTrustOwner,
  loadSelfHostedBrokerConnectorConfig,
} from '../self-hosted-connector-config.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

const skipOnWindows = process.platform === 'win32';

function privateDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  chmodSync(dir, 0o700);
  return dir;
}

function writePrivate(path: string, contents: string | Buffer): void {
  writeFileSync(path, contents, { mode: 0o600 });
  chmodSync(path, 0o600);
}

function mintDtlsIdentity(
  dir: string,
  name: string,
): { cert: string; key: string } {
  const key = join(dir, `${name}.key.pem`);
  const cert = join(dir, `${name}.cert.pem`);
  execFileSync(
    'openssl',
    ['ecparam', '-genkey', '-name', 'prime256v1', '-out', key],
    { windowsHide: true },
  );
  chmodSync(key, 0o600);
  execFileSync(
    'openssl',
    [
      'req',
      '-new',
      '-x509',
      '-key',
      key,
      '-out',
      cert,
      '-days',
      '2',
      '-subj',
      '/CN=station-connector-test',
    ],
    { windowsHide: true },
  );
  chmodSync(cert, 0o600);
  return { cert, key };
}

async function keyedHome() {
  const home = privateDir('station-connector-config-home-');
  const environment = new EnvironmentSecurityService({ homeDir: home });
  await environment.initialize();
  const store = new ConnectionSigningKeyStore(home);
  const descriptor = await store.initialize();
  return { home, store, descriptor };
}

function credential(
  idChar: string,
  secretChar: string,
): { id: string; secret: string } {
  // Widths match the actual producer (16 random bytes -> 22 base64url
  // chars; 32 bytes -> 43 chars); values here are fixed for determinism.
  return { id: idChar.repeat(22), secret: secretChar.repeat(43) };
}

async function validSetup(overrides: Record<string, unknown> = {}) {
  const { home, store, descriptor } = await keyedHome();
  const dir = privateDir('station-connector-config-refs-');
  const { cert, key } = mintDtlsIdentity(dir, 'dtls');
  const credentialsPath = join(dir, 'connector.credentials.json');
  const scope = {
    stationId: descriptor.stationId,
    enrollmentId: descriptor.enrollmentId,
    // Routing generation is independent from the signing generation.
    routingGeneration: descriptor.generation + 41,
    browserOrigin: 'https://station-client.example',
  };
  writePrivate(
    credentialsPath,
    JSON.stringify({
      version: 'station-self-hosted-broker-credentials/v1',
      scope,
      bundle: {
        connector: credential('c', 's'),
        routing: credential('r', 't'),
      },
    }),
  );
  const executable = join(dir, 'pion-fixture');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(executable, 0o700);
  const configPath = join(dir, 'connector.json');
  writePrivate(
    configPath,
    JSON.stringify({
      version: 'station-self-hosted-connector/v1',
      brokerOrigin: 'https://broker.example',
      applicationOrigin: 'https://station-client.example',
      credentialsPath,
      pionExecutable: executable,
      certificatePath: cert,
      privateKeyPath: key,
      turn: {
        url: 'turns:turn.example:3478',
        username: 'user',
        password: 'pass',
      },
      ...overrides,
    }),
  );
  return {
    home,
    store,
    descriptor,
    dir,
    cert,
    key,
    credentialsPath,
    executable,
    configPath,
    scope,
  };
}

function fakeApplication() {
  return Object.freeze({
    signal: new AbortController().signal,
    fetch: async (_request: Request) => new Response('ok'),
  });
}

describe.skipIf(skipOnWindows)('self-hosted connector config', () => {
  test('no env means no broker activity and unchanged defaults', () => {
    expect(
      loadSelfHostedBrokerConnectorConfig({ homeDir: '/nonexistent', env: {} }),
    ).toBeNull();
  });

  test('relative config path refuses', async () => {
    const { home } = await keyedHome();
    expect(() =>
      loadSelfHostedBrokerConnectorConfig({
        homeDir: home,
        env: { STATION_BROKER_CONFIG_FILE: 'relative/connector.json' },
      }),
    ).toThrow('connector_config_path_not_absolute');
  });

  test('valid config loads, defaults apply, factory composes without network', async () => {
    const { home, configPath } = await validSetup();
    // Producer widths agree with the closed schema (22/43).
    const produced = createBrokerCredentialBundle();
    expect(produced.connector.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(produced.connector.secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const factory = loadSelfHostedBrokerConnectorConfig({
      homeDir: home,
      env: { STATION_BROKER_CONFIG_FILE: configPath },
    });
    expect(factory?.applicationOrigin).toBe('https://station-client.example');
    // Typed StationRuntimeOptions consumption: spread both entries into
    // normal StationRuntime construction. The runtime owns start/shutdown;
    // there is no fire-and-forget ready callback and no separate handle.
    expect(factory!.virtualApplication.origin).toBe(
      'https://station-client.example',
    );
    expect(typeof factory!.virtualApplication.ready).toBe('function');
    expect(typeof factory!.selfHostedBrokerConnector.create).toBe('function');
    const options = factory!.virtualApplication;
    expect(options.origin).toBe('https://station-client.example');
    expect(typeof options.ready).toBe('function');
    // Factory injection: typed options compose into a real runtime without
    // starting any network, binary, or key activity.
    const runtime = factory!.selfHostedBrokerConnector.create(
      fakeApplication(),
    );
    expect(runtime).toBeInstanceOf(SelfHostedBrokerRuntime);
    // Never started: no owned resources. Shutdown intentionally withdraws
    // even after an indeterminate registration, so it would perform I/O.
  });

  test('maxPeers and maxPeerLifetimeMs each work independently', async () => {
    const peersOnly = await validSetup({ maxPeers: 4 });
    const lifetimeOnly = await validSetup({ maxPeerLifetimeMs: 60_000 });
    expect(
      loadSelfHostedBrokerConnectorConfig({
        homeDir: peersOnly.home,
        env: { STATION_BROKER_CONFIG_FILE: peersOnly.configPath },
      }),
    ).not.toBeNull();
    expect(
      loadSelfHostedBrokerConnectorConfig({
        homeDir: lifetimeOnly.home,
        env: { STATION_BROKER_CONFIG_FILE: lifetimeOnly.configPath },
      }),
    ).not.toBeNull();
  });

  test('missing credential ref fails closed without leaking the canary path', async () => {
    const setup = await validSetup();
    const canary = join(setup.dir, 'canary-missing-credentials.json');
    const configPath = join(setup.dir, 'missing-ref.json');
    const raw = JSON.parse(readFileSync(setup.configPath, 'utf8'));
    raw.credentialsPath = canary;
    writePrivate(configPath, JSON.stringify(raw));
    let message = '';
    try {
      loadSelfHostedBrokerConnectorConfig({
        homeDir: setup.home,
        env: { STATION_BROKER_CONFIG_FILE: configPath },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^connector_config_/);
    expect(message).not.toContain('canary-missing-credentials');
  });

  test('credential scope for another station refuses', async () => {
    const setup = await validSetup();
    const other = await keyedHome();
    expect(() =>
      loadSelfHostedBrokerConnectorConfig({
        homeDir: other.home,
        env: { STATION_BROKER_CONFIG_FILE: setup.configPath },
      }),
    ).toThrow('connector_config_scope_mismatch');
  });

  test('certificate from another key refuses', async () => {
    const setup = await validSetup();
    const stray = mintDtlsIdentity(setup.dir, 'stray');
    const configPath = join(setup.dir, 'mismatched.json');
    writePrivate(
      configPath,
      JSON.stringify({
        version: 'station-self-hosted-connector/v1',
        brokerOrigin: 'https://broker.example',
        applicationOrigin: 'https://station-client.example',
        credentialsPath: setup.credentialsPath,
        pionExecutable: setup.executable,
        certificatePath: stray.cert,
        privateKeyPath: setup.key,
        turn: {
          url: 'turns:turn.example:3478',
          username: 'user',
          password: 'pass',
        },
      }),
    );
    expect(() =>
      loadSelfHostedBrokerConnectorConfig({
        homeDir: setup.home,
        env: { STATION_BROKER_CONFIG_FILE: configPath },
      }),
    ).toThrow('connector_config_cert_mismatch');
  });

  test('world-readable config refuses without exposing secrets', async () => {
    const { home, configPath } = await validSetup();
    chmodSync(configPath, 0o644);
    let message = '';
    try {
      loadSelfHostedBrokerConnectorConfig({
        homeDir: home,
        env: { STATION_BROKER_CONFIG_FILE: configPath },
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/^connector_config_/);
    expect(message).not.toContain('pass');
  });

  test('symlinked config refuses', async () => {
    const { home, configPath, dir } = await validSetup();
    const link = join(dir, 'link.json');
    symlinkSync(configPath, link);
    expect(() =>
      loadSelfHostedBrokerConnectorConfig({
        homeDir: home,
        env: { STATION_BROKER_CONFIG_FILE: link },
      }),
    ).toThrow(/^connector_config_/);
  });

  test('peer limit outside the closed range refuses', async () => {
    const { home, dir } = await validSetup({
      maxPeers: 64,
      maxPeerLifetimeMs: 300_000,
    });
    const configPath = join(dir, 'connector.json');
    expect(() =>
      loadSelfHostedBrokerConnectorConfig({
        homeDir: home,
        env: { STATION_BROKER_CONFIG_FILE: configPath },
      }),
    ).toThrow('connector_config_peer_limit_invalid');
  });

  test('trust owner compares full descriptor semantics, never identity', async () => {
    const { home, store, descriptor } = await keyedHome();
    const owner = createConnectorTrustOwner(home);
    expect(owner.isCurrent(descriptor)).toBe(true);
    // A fresh clone with identical semantics still passes.
    expect(owner.isCurrent(structuredClone(descriptor))).toBe(true);
    const rotated = await store.rotate(descriptor);
    expect(rotated.generation).toBe(descriptor.generation + 1);
    // The retired key fails closed even though it was once current.
    expect(owner.isCurrent(descriptor)).toBe(false);
    expect(owner.isCurrent(rotated)).toBe(true);
    expect(
      owner.isCurrent({
        ...structuredClone(rotated),
        stationId: 'other-station',
      }),
    ).toBe(false);
  });
});
