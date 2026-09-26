/**
 * Manual macOS acceptance lane for native v2 relay grant custody. It uses a
 * real main Tauri WebView, actual Keychain storage, the real Station broker
 * routes, and a loopback-only broker fixture. It does not open a Pion or
 * application-data route and does not establish Project/account authority.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const APP_IDENTIFIER = 'io.kontourai.station.webdriver.relaygrant';
const CREDENTIAL_SERVICE = 'io.kontourai.station';
const PROOF_SERVICE = 'io.kontourai.station.relay-proof';
const TRUST_SERVICE = 'io.kontourai.station.connection-trust';
const CLEANUP_OWNER_PREFIX = 'relay-native-client-grant:cleanup-owners:v1:dev:';

type KeychainItem = { service: string; account: string };

function keychainStatus(item: KeychainItem) {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', item.service, '-a', item.account],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  if (result.error || ![0, 44].includes(result.status ?? -1))
    throw new Error('Keychain lookup failed; fixture ownership is unresolved.');
  return result.status;
}

function keychainDelete(item: KeychainItem) {
  if (keychainStatus(item) === 44) return;
  const deleted = spawnSync(
    'security',
    ['delete-generic-password', '-s', item.service, '-a', item.account],
    { encoding: 'utf8', windowsHide: true, timeout: 15_000 },
  );
  assert.equal(
    deleted.status,
    0,
    `could not remove exact Keychain item ${item.account}`,
  );
  assert.equal(
    keychainStatus(item),
    44,
    `Keychain item remained: ${item.account}`,
  );
}

function appHash() {
  return createHash('sha256').update(APP_IDENTIFIER).digest('base64url');
}

function proofItem(clientInstanceId: string): KeychainItem {
  return {
    service: PROOF_SERVICE,
    account: `native-proof:v1:dev:${appHash()}:${clientInstanceId}`,
  };
}

function trustItem(stationId: string): KeychainItem {
  const parts = [APP_IDENTIFIER, 'dev', stationId];
  const canonical = `station-connection-trust-account/v1\0${parts
    .map((part) => `${part.length}:${part}:`)
    .join('')}`;
  return {
    service: TRUST_SERVICE,
    account: `station-connection-trust:v1:${createHash('sha256')
      .update(canonical)
      .digest('base64url')}`,
  };
}

function ownerIndexItem(): KeychainItem {
  return {
    service: CREDENTIAL_SERVICE,
    account: `${CLEANUP_OWNER_PREFIX}${appHash()}`,
  };
}

async function startBroker() {
  const home = mkdtempSync(join(tmpdir(), 'station-native-grant-shell-'));
  const cleanups: Array<() => void | Promise<void>> = [
    () => rmSync(home, { recursive: true, force: true }),
  ];
  let cleaned = false;
  const stop = async () => {
    if (cleaned) return;
    cleaned = true;
    let firstError: unknown;
    for (const cleanup of [...cleanups].reverse()) {
      try {
        await cleanup();
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
    let failRetirement = false;
    const server = serve({
      fetch: (request) => {
        if (
          failRetirement &&
          new URL(request.url).pathname === '/broker/v1/native/grants/retire'
        ) {
          return new Response('fixture retirement outage', { status: 503 });
        }
        return app.fetch(request);
      },
      hostname: '127.0.0.1',
      port: 0,
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('loopback broker fixture did not bind a TCP port');
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
            throw new Error(
              'unexpected application offer in grant acceptance lane',
            );
          },
        },
        candidateIssuer: new ConnectionKeyCandidateIssuer(custody),
        heartbeatMs: 30_000,
        renewMs: 10_000,
        pollMs: 1_000,
        maxPeerLifetimeMs: 60_000,
        maxPeers: 1,
        observeStatus: () => undefined,
      },
      {
        signal: new AbortController().signal,
        fetch: async () => new Response('unused'),
      },
      {
        startAdapter: async () => {
          throw new Error('application adapter must remain unused');
        },
      },
    );
    cleanups.push(() => runtime.shutdown());
    await runtime.start();
    return {
      brokerOrigin,
      scope,
      trust,
      custody,
      credentials,
      service,
      issueInvitation: async (surface: {
        kind: 'station-native';
        appIdentifier: string;
        channel: 'dev';
        clientInstanceId: string;
        keyThumbprint: string;
      }) =>
        service.issueNativeInvitation({
          scope,
          routingCredential: credentials.routing,
          brokerOrigin,
          surface,
          stationSigningKeyId: await stationConnectionSigningKeyId(trust),
          stationSigningGeneration: trust.generation,
        }),
      setFailRetirement: (value: boolean) => {
        failRetirement = value;
      },
      stop,
    };
  } catch (error) {
    await stop().catch((cleanupError) => {
      console.error('broker fixture cleanup failed:', cleanupError);
      process.exitCode = 1;
    });
    throw error;
  }
}

type IpcResult<T> = { ipcResult?: T; ipcError?: string };

async function invoke<T>(
  fixture: TauriShellFixture,
  command: string,
  args: Record<string, unknown> = {},
): Promise<IpcResult<T>> {
  return fixture.driver.executeAsync<
    IpcResult<T>,
    [string, Record<string, unknown>]
  >(
    (commandName, commandArgs, done) => {
      const internals = (
        window as unknown as {
          __TAURI_INTERNALS__?: {
            invoke?: (
              name: string,
              payload: Record<string, unknown>,
            ) => Promise<unknown>;
          };
        }
      ).__TAURI_INTERNALS__;
      if (!internals?.invoke) {
        done({ ipcError: 'main WebView Tauri IPC bridge is missing' });
        return;
      }
      void internals
        .invoke(commandName, commandArgs)
        .then((ipcResult) => done({ ipcResult: ipcResult as T }))
        .catch((error: unknown) => done({ ipcError: String(error) }));
    },
    command,
    args,
  );
}

async function main() {
  if (process.platform !== 'darwin')
    throw new Error('native relay grant lifecycle shell proof requires macOS');
  const clientInstanceId = randomUUID();
  const ownerIndex = ownerIndexItem();
  assert.equal(
    keychainStatus(ownerIndex),
    44,
    'dedicated native grant shell owner index already exists; refusing to overwrite it',
  );
  const broker = await startBroker();
  const proof = proofItem(clientInstanceId);
  const trust = trustItem(broker.trust.stationId);
  const route = {
    name: `relay-grant-${clientInstanceId.slice(0, 8)}`,
    endpoint: 'https://station.example',
    brokerOrigin: broker.brokerOrigin,
    stationId: broker.trust.stationId,
    enrollmentId: broker.trust.enrollmentId,
    clientInstanceId,
  };
  let fixture: TauriShellFixture | undefined;
  let grantId: string | undefined;
  let cleanupId: string | undefined;
  let expectedProfileRevision = 0;
  const ownedItems: KeychainItem[] = [proof, trust];
  try {
    fixture = await startTauriShellFixture({
      seedRemoteProfile: false,
      seedRelayRoute: route,
      realCredentialStore: true,
    });
    const driver = fixture.driver;
    await driver.navigate('tauri://localhost/connections/computers');
    let prepare: string | undefined;
    await driver.waitUntil(
      async () => {
        prepare = await driver.findElement(
          '.relay-route-key-approval__prepare button',
        );
        return Boolean(prepare);
      },
      {
        timeout: 60_000,
        timeoutMsg: 'saved relay route did not expose native proof preparation',
      },
    );
    assert.ok(prepare, 'saved route did not expose native proof preparation');
    await driver.clickElement(prepare);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.findElement(
            'section[aria-label="Public install proof metadata"]',
          ),
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'proof key metadata did not reach the WebView',
      },
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
    assert.equal(surface.App, APP_IDENTIFIER);
    assert.equal(surface.Channel, 'dev');
    assert.equal(surface['Client instance'], clientInstanceId);
    assert.equal(
      keychainStatus(proof),
      0,
      'proof private key is not in Keychain',
    );
    const invitation = await broker.issueInvitation({
      kind: 'station-native',
      appIdentifier: surface.App,
      channel: 'dev',
      clientInstanceId,
      keyThumbprint: surface['Key thumbprint'],
    });
    const invitationInput = await driver.findElement(
      'section[aria-label="Public install proof metadata"] textarea',
    );
    const discover = await driver.findElement(
      'section[aria-label="Public install proof metadata"] > button:nth-of-type(2)',
    );
    assert.ok(invitationInput && discover);
    await driver.typeElement(invitationInput, JSON.stringify(invitation));
    await driver.clickElement(discover);
    await driver.waitUntil(
      async () =>
        Boolean(
          await driver.findElement(
            'section[aria-label="Candidate from native verification"]',
          ),
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'signed Station candidate did not reach the WebView',
      },
    );
    const keyId = await stationConnectionSigningKeyId(broker.trust);
    const confirmation = await stationConnectionKeyConfirmationCode(
      broker.trust,
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
      formatStationConnectionKeyConfirmationCode(confirmation).toLowerCase(),
    );
    await driver.typeElement(keyInput, keyId);
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
        timeoutMsg: 'operator-approved trust was not committed',
      },
    );
    assert.equal(
      keychainStatus(trust),
      0,
      'approved Station trust is not in Keychain',
    );
    const savedProfiles = JSON.parse(
      readFileSync(
        join(fixture.stationRoot, 'config', 'profiles.json'),
        'utf8',
      ),
    ) as { revision?: number; profiles?: Array<{ name?: string }> };
    assert.ok(
      Number.isSafeInteger(savedProfiles.revision),
      'isolated saved Station profile store has no valid revision',
    );
    assert.ok(
      savedProfiles.profiles?.some((profile) => profile.name === route.name),
      'isolated saved Station profile disappeared before grant redemption',
    );
    expectedProfileRevision = savedProfiles.revision as number;
    console.log(
      `native relay grant fixture profile revision: ${expectedProfileRevision}`,
    );

    const initialStatus = await invoke<{
      grants?: unknown[];
      cleanups?: unknown[];
    }>(fixture, 'station_native_relay_grant_status', {
      profileName: route.name,
    });
    assert.ok(
      initialStatus.ipcResult,
      initialStatus.ipcError ?? 'grant status IPC failed',
    );
    assert.deepEqual(initialStatus.ipcResult.grants, []);

    const redemption = await invoke<{
      status?: string;
      grant?: { route?: { grantId?: string } };
      failure?: { primary?: string; cleanup?: unknown; recovery?: unknown };
    }>(fixture, 'station_native_relay_grant_redeem', {
      profileName: route.name,
      expectedProfileRevision,
      invitation,
    });
    assert.ok(
      redemption.ipcResult,
      redemption.ipcError ?? 'grant redemption IPC failed',
    );
    assert.equal(
      redemption.ipcResult.status,
      'redeemed',
      `secret-free redemption failure: ${JSON.stringify(redemption.ipcResult.failure)}`,
    );
    grantId = redemption.ipcResult.grant?.route?.grantId;
    assert.ok(grantId, 'redemption did not return secret-free grant metadata');
    const grantAccount = [
      APP_IDENTIFIER,
      'dev',
      clientInstanceId,
      broker.brokerOrigin,
      broker.trust.stationId,
      broker.trust.enrollmentId,
      '1',
      grantId,
    ]
      .map((part) => `${part.length}:${part}:`)
      .join('');
    ownedItems.push({
      service: CREDENTIAL_SERVICE,
      account: `relay-native-client-grant:v2:${grantAccount}`,
    });
    ownedItems.push({
      service: CREDENTIAL_SERVICE,
      account: `relay-native-client-grant:index:v2:dev:${appHash()}:${clientInstanceId}`,
    });

    const afterRedeem = await invoke<{
      grants?: Array<{ metadata?: { route?: { grantId?: string } } }>;
    }>(fixture, 'station_native_relay_grant_status', {
      profileName: route.name,
    });
    assert.ok(
      afterRedeem.ipcResult,
      afterRedeem.ipcError ?? 'post-redemption status IPC failed',
    );
    assert.equal(afterRedeem.ipcResult.grants?.length, 1);
    assert.equal(
      afterRedeem.ipcResult.grants?.[0]?.metadata?.route?.grantId,
      grantId,
    );

    broker.setFailRetirement(true);
    const revoke = await invoke<{
      grants?: unknown[];
      cleanups?: Array<{ cleanupId?: string }>;
    }>(fixture, 'station_native_relay_grant_revoke', {
      profileName: route.name,
      expectedProfileRevision,
    });
    assert.ok(revoke.ipcResult, revoke.ipcError ?? 'grant revoke IPC failed');
    assert.deepEqual(revoke.ipcResult.grants, []);
    cleanupId = revoke.ipcResult.cleanups?.[0]?.cleanupId;
    assert.ok(
      cleanupId,
      'broker failure did not remain in durable cleanup status',
    );
    const pending = await invoke<Array<{ cleanupId?: string }>>(
      fixture,
      'station_native_relay_grant_cleanup_pending',
    );
    assert.ok(
      pending.ipcResult,
      pending.ipcError ?? 'pending cleanup IPC failed',
    );
    assert.ok(pending.ipcResult.some((item) => item.cleanupId === cleanupId));

    broker.setFailRetirement(false);
    const retried = await invoke<Array<{ cleanupId?: string }>>(
      fixture,
      'station_native_relay_grant_cleanup_retry',
      { cleanupId },
    );
    assert.ok(
      retried.ipcResult,
      retried.ipcError ?? 'cleanup retry IPC failed',
    );
    assert.ok(!retried.ipcResult.some((item) => item.cleanupId === cleanupId));
    const finalStatus = await invoke<{
      grants?: unknown[];
      cleanups?: unknown[];
    }>(fixture, 'station_native_relay_grant_status', {
      profileName: route.name,
    });
    assert.ok(
      finalStatus.ipcResult,
      finalStatus.ipcError ?? 'final grant status IPC failed',
    );
    assert.deepEqual(finalStatus.ipcResult.grants, []);
    assert.deepEqual(finalStatus.ipcResult.cleanups, []);
    assert.equal(
      keychainStatus(proof),
      0,
      'proof key unexpectedly disappeared before cleanup',
    );
    assert.equal(
      keychainStatus(trust),
      0,
      'approved trust unexpectedly disappeared before cleanup',
    );

    const outputDir = resolve(
      import.meta.dirname,
      '../../.kontourai/tauri-shell-e2e',
    );
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(
      join(outputDir, 'native-relay-grant-lifecycle.png'),
      await driver.screenshot(),
    );
    console.log(
      `native relay grant lifecycle: main WebView IPC redeemed ${grantId}, persisted status, staged retirement failure ${cleanupId}, then retried cleanup; source ${process.env.STATION_TAURI_E2E_SOURCE_SHA ?? 'unrecorded'}`,
    );
  } finally {
    try {
      if (fixture) {
        try {
          // Also cover assertion/driver failures after a broker grant was
          // returned but before its ID could be added to the local cleanup
          // ledger. Route revoke discovers only this saved profile's grants.
          broker.setFailRetirement(false);
          const recovered = await invoke<{
            grants?: unknown[];
            cleanups?: Array<{ cleanupId?: string }>;
          }>(fixture, 'station_native_relay_grant_revoke', {
            profileName: route.name,
            expectedProfileRevision,
          });
          if (!recovered.ipcResult) {
            console.error(
              'fixture route cleanup did not complete:',
              recovered.ipcError,
            );
            process.exitCode = 1;
          } else {
            for (const cleanup of recovered.ipcResult.cleanups ?? []) {
              if (!cleanup.cleanupId) continue;
              const retried = await invoke<Array<{ cleanupId?: string }>>(
                fixture,
                'station_native_relay_grant_cleanup_retry',
                { cleanupId: cleanup.cleanupId },
              );
              if (
                !retried.ipcResult ||
                retried.ipcResult.some(
                  (item) => item.cleanupId === cleanup.cleanupId,
                )
              ) {
                console.error(
                  'fixture cleanup remains pending:',
                  cleanup.cleanupId,
                  retried.ipcError,
                );
                process.exitCode = 1;
              }
            }
          }
        } catch (error) {
          console.error(
            'fixture route cleanup invocation failed:',
            String(error),
          );
          process.exitCode = 1;
        }
      }
    } finally {
      try {
        await fixture?.stop();
      } finally {
        try {
          await broker.stop();
        } finally {
          const cleanupIndex = {
            service: CREDENTIAL_SERVICE,
            account: `relay-native-client-grant:cleanup-index:v2:dev:${appHash()}:${clientInstanceId}`,
          };
          ownedItems.push(cleanupIndex);
          for (const item of ownedItems) keychainDelete(item);
          keychainDelete(ownerIndex);
        }
      }
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
