/**
 * Free local native approval journey: real macOS WebView, Keychain, broker HTTP,
 * Station candidate signer, explicit human-comparison inputs, and revocation.
 * It does not open a Pion application route or establish account/Device access.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import {
  formatStationConnectionKeyConfirmationCode,
  stationConnectionKeyConfirmationCode,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { Hono } from 'hono';
import { createSelfHostedBrokerRoutes } from '../../src-server/routes/connections/self-hosted-broker.js';
import { createSelfHostedBrokerPionRuntime } from '../../src-server/runtime/bootstrap/self-hosted-broker-pion-runtime.js';
import { SelfHostedBrokerService } from '../../src-server/services/connections/self-hosted-broker-service.js';
import { ConnectionKeyCandidateIssuer } from '../../src-server/services/ssh/connection-key-candidate-issuer.js';
import { ConnectionSigningKeyStore } from '../../src-server/services/ssh/connection-signing-key-store.js';
import { EnvironmentSecurityService } from '../../src-server/services/ssh/environment-security-service.js';
import {
  startTauriShellFixture,
  type TauriShellFixture,
} from './direct-webdriver.js';

const APP_IDENTIFIER = 'io.kontourai.station.webdriver';
const PROOF_SERVICE = 'io.kontourai.station.relay-proof';
const TRUST_SERVICE = 'io.kontourai.station.connection-trust';

function keyringAccount(service: string, account: string) {
  return { service, account };
}

function inspectKeyring(item: ReturnType<typeof keyringAccount>) {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', item.service, '-a', item.account],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error || ![0, 44].includes(result.status ?? -1))
    throw new Error('Keychain lookup failed; fixture ownership is unresolved.');
  return result.status;
}

function cleanupKeyring(item: ReturnType<typeof keyringAccount>) {
  if (inspectKeyring(item) === 44) return;
  const removed = spawnSync(
    'security',
    ['delete-generic-password', '-s', item.service, '-a', item.account],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(
    removed.status,
    0,
    `could not remove exact ${item.service} fixture item`,
  );
  assert.equal(inspectKeyring(item), 44, 'fixture keyring item remained');
}

function proofAccount(clientInstanceId: string) {
  const appHash = createHash('sha256')
    .update(APP_IDENTIFIER)
    .digest('base64url');
  return keyringAccount(
    PROOF_SERVICE,
    `native-proof:v1:dev:${appHash}:${clientInstanceId}`,
  );
}

function trustAccount(stationId: string) {
  const parts = [APP_IDENTIFIER, 'dev', stationId];
  const canonical = `station-connection-trust-account/v1\0${parts
    .map((part) => `${part.length}:${part}:`)
    .join('')}`;
  const hash = createHash('sha256').update(canonical).digest('base64url');
  return keyringAccount(TRUST_SERVICE, `station-connection-trust:v1:${hash}`);
}

async function startBroker() {
  const home = mkdtempSync(join(tmpdir(), 'station-native-operator-'));
  const cleanups: Array<() => void | Promise<void>> = [
    () => rmSync(home, { recursive: true, force: true }),
  ];
  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    let firstError: unknown;
    for (const close of [...cleanups].reverse()) {
      try {
        await close();
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
  };
  try {
    await new EnvironmentSecurityService({ homeDir: home }).initialize();
    const custody = new ConnectionSigningKeyStore(home);
    const trust = await custody.initialize();
    const service = new SelfHostedBrokerService(join(home, 'broker.sqlite'));
    cleanups.push(() => service.close());
    const scope = {
      stationId: trust.stationId,
      enrollmentId: trust.enrollmentId,
      routingGeneration: 1,
      browserOrigin: 'https://station.example',
    };
    const credentials = service.provision(scope, 600_000);
    const app = new Hono().route(
      '/broker/v1',
      createSelfHostedBrokerRoutes(service),
    );
    const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: 0 });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('broker fixture listener unavailable');
    const brokerOrigin = `http://127.0.0.1:${address.port}`;
    const trustOwner = {
      current: () => custody.readDescriptor(),
      isCurrent: (value: typeof trust) =>
        JSON.stringify(value) === JSON.stringify(custody.readDescriptor()),
    };
    const runtime = createSelfHostedBrokerPionRuntime(
      {
        brokerOrigin,
        applicationOrigin: 'https://station.example',
        scope,
        connectorCredential: credentials.connector,
        executable: '/unused',
        certificatePem: 'unused',
        privateKeyPem: 'unused',
        turn: { url: 'turn:unused', username: 'unused', password: 'unused' },
        trust: trustOwner,
        issuer: {
          issue: async () => {
            throw new Error('unexpected application connection offer');
          },
        },
        candidateIssuer: new ConnectionKeyCandidateIssuer(custody),
        heartbeatMs: 30_000,
        renewMs: 10_000,
        pollMs: 1_000,
        maxPeerLifetimeMs: 60_000,
        maxPeers: 1,
      },
      {
        signal: new AbortController().signal,
        fetch: async () => new Response('unexpected application request'),
      },
      {
        startAdapter: async () => {
          throw new Error('unexpected Pion application adapter');
        },
      },
    );
    cleanups.push(() => runtime.shutdown());
    await runtime.start();
    return {
      brokerOrigin,
      trust,
      scope,
      service,
      credentials,
      stop: cleanup,
    };
  } catch (error) {
    await cleanup().catch((cleanupError) => {
      console.error('broker fixture setup cleanup failed:', cleanupError);
      process.exitCode = 1;
    });
    throw error;
  }
}

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('native relay approval shell proof requires macOS');
  const broker = await startBroker();
  const clientInstanceId = randomUUID();
  const proof = proofAccount(clientInstanceId);
  const durableTrust = trustAccount(broker.trust.stationId);
  const route = {
    name: `relay-approval-${clientInstanceId.slice(0, 8)}`,
    endpoint: 'https://station.example',
    brokerOrigin: broker.brokerOrigin,
    stationId: broker.trust.stationId,
    enrollmentId: broker.trust.enrollmentId,
    clientInstanceId,
  };
  let fixture: TauriShellFixture | undefined;
  try {
    fixture = await startTauriShellFixture({
      seedRemoteProfile: false,
      seedRelayRoute: route,
      realCredentialStore: true,
    });
    const driver = fixture.driver;
    const outputDir = resolve(
      import.meta.dirname,
      '../../.kontourai/tauri-shell-e2e',
    );
    mkdirSync(outputDir, { recursive: true });
    await driver.navigate('tauri://localhost/connections/computers');
    let prepare: string | undefined;
    await driver.waitUntil(
      async () => {
        prepare = await driver.findElement(
          '.relay-route-key-approval__prepare button',
        );
        return Boolean(prepare);
      },
      { timeout: 60_000, timeoutMsg: 'native prepare action did not mount' },
    );
    assert.ok(prepare);
    await driver.clickElement(prepare);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.findElement(
            'section[aria-label="Public install proof metadata"]',
          ),
        ),
      { timeout: 30_000, timeoutMsg: 'public native proof did not render' },
    );
    const surface = await driver.execute(() => {
      const section = document.querySelector(
        'section[aria-label="Public install proof metadata"]',
      );
      if (!section) return null;
      return Object.fromEntries(
        Array.from(section.querySelectorAll('dl > div')).map((entry) => [
          entry.querySelector('dt')?.textContent?.trim() ?? '',
          entry.querySelector('dd')?.textContent?.trim() ?? '',
        ]),
      );
    });
    assert.ok(surface);
    assert.equal(surface['Client instance'], clientInstanceId);
    assert.equal(
      inspectKeyring(proof),
      0,
      'native proof key is not in Keychain',
    );
    const invitation = broker.service.issueNativeInvitation({
      scope: broker.scope,
      routingCredential: broker.credentials.routing,
      brokerOrigin: broker.brokerOrigin,
      surface: {
        kind: 'station-native',
        appIdentifier: surface.App,
        channel: surface.Channel as 'dev',
        clientInstanceId,
        keyThumbprint: surface['Key thumbprint'],
      },
      stationSigningKeyId: await stationConnectionSigningKeyId(broker.trust),
      stationSigningGeneration: broker.trust.generation,
    });
    const inviteInput = await driver.findElement(
      'section[aria-label="Public install proof metadata"] textarea',
    );
    assert.ok(inviteInput);
    await driver.typeElement(inviteInput, JSON.stringify(invitation));
    const discover = await driver.findElement(
      'section[aria-label="Public install proof metadata"] > button:last-of-type',
    );
    assert.ok(discover);
    await driver.clickElement(discover);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.findElement(
            'section[aria-label="Candidate from native verification"]',
          ),
        ),
      { timeout: 30_000, timeoutMsg: 'signed candidate did not reach shell' },
    );
    const operatorKeyId = await stationConnectionSigningKeyId(broker.trust);
    const operatorCode = await stationConnectionKeyConfirmationCode(
      broker.trust,
    );
    const candidateValues = await driver.execute(() => {
      const section = document.querySelector(
        'section[aria-label="Candidate from native verification"]',
      );
      if (!section) return null;
      return Object.fromEntries(
        Array.from(section.querySelectorAll('dl > div')).map((entry) => [
          entry.querySelector('dt')?.textContent?.trim() ?? '',
          entry.querySelector('dd')?.textContent?.trim() ?? '',
        ]),
      );
    });
    assert.ok(candidateValues);
    assert.equal(candidateValues['Full key ID'], operatorKeyId);
    assert.equal(
      candidateValues['Comparison code']?.replaceAll('-', ''),
      operatorCode,
    );
    writeFileSync(
      join(outputDir, 'native-relay-candidate.png'),
      await driver.screenshot(),
    );
    const codeInput = await driver.findElement(
      'section[aria-label="Candidate from native verification"] input[id$="-code"]',
    );
    const keyInput = await driver.findElement(
      'section[aria-label="Candidate from native verification"] input[id$="-key-id"]',
    );
    const attestation = await driver.findElement(
      '.relay-route-key-approval__attestation input',
    );
    assert.ok(codeInput && keyInput && attestation);
    await driver.typeElement(
      codeInput,
      formatStationConnectionKeyConfirmationCode(operatorCode).toLowerCase(),
    );
    await driver.typeElement(keyInput, operatorKeyId);
    await driver.clickElement(attestation);
    const approve = await driver.findElement(
      'section[aria-label="Candidate from native verification"] > button:first-of-type',
    );
    assert.ok(approve);
    await driver.clickElement(approve);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.execute(() =>
            document
              .querySelector('.relay-route-key-approval')
              ?.textContent?.includes('Station key approved'),
          ),
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'explicit native approval did not persist',
      },
    );
    assert.equal(
      inspectKeyring(durableTrust),
      0,
      'approved trust not in Keychain',
    );
    writeFileSync(
      join(outputDir, 'native-relay-approved.png'),
      await driver.screenshot(),
    );
    const revokeInput = await driver.findElement(
      '.relay-route-key-approval__revoke input',
    );
    assert.ok(revokeInput);
    await driver.typeElement(revokeInput, operatorKeyId);
    const revoke = await driver.findElement(
      '.relay-route-key-approval__revoke button',
    );
    assert.ok(revoke);
    await driver.clickElement(revoke);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.execute(() =>
            document
              .querySelector('.relay-route-key-approval')
              ?.textContent?.includes('Station key trust revoked'),
          ),
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'native trust revocation did not persist',
      },
    );
    assert.equal(
      inspectKeyring(durableTrust),
      0,
      'revocation tombstone missing',
    );
    writeFileSync(
      join(outputDir, 'native-relay-revoked.png'),
      await driver.screenshot(),
    );
    const routeState = await driver.execute(
      () =>
        document.querySelector(
          'section[aria-label="Saved broker routes"] .connections-computers__state',
        )?.textContent ?? '',
    );
    assert.equal(routeState.trim(), 'Not connected');
    console.log(
      `native relay candidate approval: verified, approved, revoked with real Keychain; Station ${broker.trust.stationId}; source ${process.env.STATION_TAURI_E2E_SOURCE_SHA ?? 'unrecorded'}`,
    );
  } finally {
    for (const [label, close] of [
      ['Tauri shell', () => fixture?.stop()],
      ['broker and connector', () => broker.stop()],
      ['owned proof key', () => cleanupKeyring(proof)],
      ['owned trust record', () => cleanupKeyring(durableTrust)],
    ] as const) {
      try {
        await close();
      } catch (error) {
        console.error(
          `native relay approval cleanup failed for ${label}:`,
          error,
        );
        process.exitCode = 1;
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
