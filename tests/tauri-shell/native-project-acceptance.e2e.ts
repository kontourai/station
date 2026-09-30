/**
 * Opt-in native application acceptance. This composes a real local-account
 * StationRuntime/Pion connector, a real main Tauri WebView/IPC host, Keychain
 * pairing custody, and the protected Project/account path over TURN.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import {
  formatStationConnectionKeyConfirmationCode,
  stationConnectionKeyConfirmationCode,
  stationConnectionSigningKeyId,
} from '@kontourai/station-shared/connection-proof';
import { build } from 'esbuild';
import type { ConnectionSigningKeyStore } from '../../src-server/services/ssh/connection-signing-key-store.js';
import {
  startTauriShellFixture,
  type TauriShellFixture,
} from './direct-webdriver.js';
import { startNativeProjectRuntimeFixture } from './native-project-runtime-fixture.js';

const APP_IDENTIFIER = 'io.kontourai.station.webdriver.relaygrant';
const CREDENTIAL_SERVICE = 'io.kontourai.station';
const PROOF_SERVICE = 'io.kontourai.station.relay-proof';
const TRUST_SERVICE = 'io.kontourai.station.connection-trust';
const CANDIDATE_SERVICE = 'io.kontourai.station.device-binding-candidate';
const DEVICE_PROOF_SERVICE = 'io.kontourai.station.device-proof';
const ACCOUNT_PROOF_SERVICE = 'io.kontourai.station.account-proof';
const CUSTODY_METADATA_SERVICE = 'io.kontourai.station.credential-metadata';
const OWNER_INDEX_PREFIX = 'relay-native-client-grant:cleanup-owners:v1:dev:';
const NATIVE_CHANNEL = 'dev';

type KeychainItem = { service: string; account: string };
type IpcResult<T> = { ipcResult?: T; ipcError?: string };
type PublicInstallSurface = Record<string, string>;
type NativeCandidate = {
  version: 'station-native-device-binding-candidate/v1';
  stationId: string;
  deviceId: string;
  bindingId: string;
  surface: SelfHostedBrokerNativeClientSurfaceV2;
  deviceProofJwk: { kty: 'EC'; crv: 'P-256'; x: string; y: string };
  deviceProofKeyThumbprint: string;
};
type NativeProjectReadResult = {
  status: number;
  containsExpectedProject: boolean;
  responseRootKeys: string[];
  serverErrorCode?: string;
  directProjectApiAttempts: number;
  relayedPairObserved: boolean;
  offerUsedRelayCandidate: boolean;
  freshPeerHandle: boolean;
};

function appHash(appIdentifier: string) {
  return createHash('sha256').update(appIdentifier).digest('base64url');
}

function keychainStatus(item: KeychainItem): number {
  const result = spawnSync(
    'security',
    ['find-generic-password', '-s', item.service, '-a', item.account],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  return result.status ?? -1;
}

function removeOwnedKeychainItem(item: KeychainItem) {
  const status = keychainStatus(item);
  if (status === 44) return;
  if (status !== 0)
    throw new Error(`fixture Keychain ownership unresolved: ${item.service}`);
  const result = spawnSync(
    'security',
    ['delete-generic-password', '-s', item.service, '-a', item.account],
    { encoding: 'utf8', windowsHide: true },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`fixture Keychain removal failed: ${item.service}`);
  assert.equal(keychainStatus(item), 44);
}

function relayProofItem(appIdentifier: string, clientInstanceId: string) {
  return {
    service: PROOF_SERVICE,
    account: `native-proof:v1:${NATIVE_CHANNEL}:${appHash(appIdentifier)}:${clientInstanceId}`,
  };
}

function trustItem(stationId: string): KeychainItem {
  const parts = [APP_IDENTIFIER, NATIVE_CHANNEL, stationId];
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
    account: `${OWNER_INDEX_PREFIX}${appHash(APP_IDENTIFIER)}`,
  };
}

function grantIndexItem(clientInstanceId: string): KeychainItem {
  return {
    service: CREDENTIAL_SERVICE,
    account: `relay-native-client-grant:index:v2:dev:${appHash(APP_IDENTIFIER)}:${clientInstanceId}`,
  };
}

function grantCleanupIndexItem(clientInstanceId: string): KeychainItem {
  return {
    service: CREDENTIAL_SERVICE,
    account: `relay-native-client-grant:cleanup-index:v2:dev:${appHash(APP_IDENTIFIER)}:${clientInstanceId}`,
  };
}

function grantItem(
  clientInstanceId: string,
  route: {
    brokerOrigin: string;
    stationId: string;
    enrollmentId: string;
    routingGeneration: number;
    grantId: string;
  },
): KeychainItem {
  const account = [
    APP_IDENTIFIER,
    NATIVE_CHANNEL,
    clientInstanceId,
    route.brokerOrigin,
    route.stationId,
    route.enrollmentId,
    String(route.routingGeneration),
    route.grantId,
  ]
    .map((part) => `${part.length}:${part}:`)
    .join('');
  return {
    service: CREDENTIAL_SERVICE,
    account: `relay-native-client-grant:v2:${account}`,
  };
}

function uuidBytes(value: string): Buffer {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value,
    )
  )
    throw new Error('native_project_key_owner_uuid_invalid');
  return Buffer.from(value.replaceAll('-', ''), 'hex');
}

function keychainAccount(
  prefix: string,
  parts: readonly (string | Uint8Array)[],
): string {
  const canonical: Buffer[] = [Buffer.from(`${prefix}\0`, 'utf8')];
  for (const part of parts) {
    const bytes =
      typeof part === 'string' ? Buffer.from(part, 'utf8') : Buffer.from(part);
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.byteLength));
    canonical.push(length, bytes);
  }
  return `${prefix}:${createHash('sha256')
    .update(Buffer.concat(canonical))
    .digest('base64url')}`;
}

function candidateKeychainItems(
  routeProfileName: string,
  candidate: NativeCandidate,
): KeychainItem[] {
  const { appIdentifier, channel, clientInstanceId } = candidate.surface;
  return [
    {
      service: CANDIDATE_SERVICE,
      account: keychainAccount('native-device-binding-candidate:v1', [
        routeProfileName,
        appIdentifier,
        channel,
        clientInstanceId,
      ]),
    },
    {
      service: DEVICE_PROOF_SERVICE,
      account: keychainAccount('native-device-proof:v1', [
        appIdentifier,
        channel,
        uuidBytes(clientInstanceId),
        uuidBytes(candidate.stationId),
        uuidBytes(candidate.deviceId),
        uuidBytes(candidate.bindingId),
      ]),
    },
  ];
}

function accountProofItem(candidate: NativeCandidate): KeychainItem {
  const { appIdentifier, channel, clientInstanceId } = candidate.surface;
  return {
    service: ACCOUNT_PROOF_SERVICE,
    account: keychainAccount('native-account-proof:v1', [
      appIdentifier,
      channel,
      uuidBytes(clientInstanceId),
      uuidBytes(candidate.stationId),
      uuidBytes(candidate.deviceId),
    ]),
  };
}

function custodyMetadataItem(referenceId: string): KeychainItem {
  const reference = `station-bearer:${referenceId}`;
  return {
    service: CUSTODY_METADATA_SERVICE,
    account: keychainAccount('credential-custody:v2', [
      APP_IDENTIFIER,
      NATIVE_CHANNEL,
      reference,
    ]),
  };
}

function pairingCustodyItems(stationRoot: string): KeychainItem[] {
  const profilePath = join(stationRoot, 'config', 'profiles.json');
  if (!existsSync(profilePath)) return [];
  const store = JSON.parse(readFileSync(profilePath, 'utf8')) as {
    profiles?: Array<{
      relayRoute?: unknown;
      credentialRef?: { kind?: string; id?: string };
    }>;
  };
  const references = (store.profiles ?? [])
    .filter((profile) => profile.relayRoute === undefined)
    .map((profile) => profile.credentialRef)
    .filter(
      (reference): reference is { kind: string; id: string } =>
        reference?.kind === 'station-bearer' &&
        typeof reference.id === 'string' &&
        reference.id.startsWith('pairing:'),
    );
  return references.flatMap((reference) => [
    {
      service: CREDENTIAL_SERVICE,
      account: `profile:station-bearer:${reference.id}`,
    },
    custodyMetadataItem(reference.id),
  ]);
}

function profileStoreRevision(stationRoot: string): number {
  const value = JSON.parse(
    readFileSync(join(stationRoot, 'config', 'profiles.json'), 'utf8'),
  ) as { revision?: unknown };
  assert(Number.isSafeInteger(value.revision));
  return value.revision as number;
}

async function callInMainWebView<TInput, TResult>(
  fixture: TauriShellFixture,
  _bundle: string,
  operation: string,
  input: TInput,
  onPhase?: (phase: string) => void,
): Promise<TResult> {
  const stateKey = '__stationNativeProjectAcceptance';
  const script = `
    const done = arguments[arguments.length - 1];
    const input = arguments[0];
    const operation = arguments[1];
    const stateKey = arguments[2];
    const state = window[stateKey];
    if (!window.__TAURI_INTERNALS__?.invoke || !state || state.status !== 'ready' || !state.runner) {
      done({ started: false, error: 'native_project_webview_not_ready' });
      return;
    }
    state.status = 'running';
    Promise.resolve(
      state.runner[operation](input),
    ).then(
      (value) => { state.status = 'complete'; state.value = value; },
      (error) => {
        const code = error && typeof error === 'object' && 'code' in error &&
          typeof error.code === 'string' && /^[a-z0-9_]{1,80}$/i.test(error.code)
          ? error.code
          : error instanceof Error && /^[a-z0-9_]{1,80}$/i.test(error.message)
            ? error.message
            : 'native_project_operation_failed';
        state.status = 'complete'; state.value = { ok: false, code };
      },
    );
    done({ started: true });
  `;
  onPhase?.(`${operation}_execute`);
  const started = await fixture.driver.executeAsyncSource<
    { started: boolean; error?: string },
    [TInput, string, string]
  >(script, input, operation, stateKey);
  assert.equal(
    started.started,
    true,
    started.error ?? 'main WebView native operation did not start',
  );
  onPhase?.(`${operation}_wait`);
  let completed: { status?: string; value?: TResult } | undefined;
  await fixture.driver.waitUntil(
    async () => {
      completed = await fixture.driver.execute((key) => {
        const value = (window as unknown as Record<string, unknown>)[key];
        if (!value || typeof value !== 'object') return undefined;
        return value as { status?: string; value?: TResult };
      }, stateKey);
      return completed?.status === 'complete';
    },
    {
      timeout: 45_000,
      interval: 100,
      timeoutMsg: `native WebView operation ${operation} did not settle`,
    },
  );
  const value = completed?.value;
  onPhase?.(`${operation}_result`);
  await fixture.driver.execute((key) => {
    const state = (window as unknown as Record<string, unknown>)[key];
    if (state && typeof state === 'object')
      (state as { status?: string; value?: unknown }).status = 'ready';
  }, stateKey);
  assert(value !== undefined);
  const operationResult = value as unknown as {
    ok?: unknown;
    code?: unknown;
  };
  if (
    typeof value === 'object' &&
    value !== null &&
    operationResult.ok === false &&
    typeof operationResult.code === 'string' &&
    /^[a-z0-9_]{1,100}$/i.test(operationResult.code)
  )
    throw new Error(operationResult.code);
  return value;
}

async function installMainWebViewBundle(
  fixture: TauriShellFixture,
  bundle: string,
) {
  const stateKey = '__stationNativeProjectAcceptance';
  const script = `
    const done = arguments[arguments.length - 1];
    const stateKey = arguments[0];
    if (!window.__TAURI_INTERNALS__?.invoke) {
      done({ installed: false, error: 'main_webview_tauri_ipc_missing' });
      return;
    }
    if (window[stateKey]) {
      done({ installed: false, error: 'native_project_runner_already_installed' });
      return;
    }
    ${bundle}
    Object.defineProperty(window, stateKey, {
      value: {
        status: 'ready',
        value: null,
        runner: StationNativeProjectAcceptance,
      },
      enumerable: false,
      configurable: true,
    });
    done({ installed: true });
  `;
  const result = await fixture.driver.executeAsyncSource<
    { installed: boolean; error?: string },
    [string]
  >(script, stateKey);
  assert.equal(result.installed, true, result.error ?? 'runner install failed');
}

async function installTauriRelayProofSurface(
  fixture: TauriShellFixture,
  onPhase: (phase: string) => void,
): Promise<PublicInstallSurface> {
  const url = 'tauri://localhost/connections/computers';
  onPhase('navigate_surface_page');
  await fixture.driver.navigate(url);
  onPhase('find_surface_prepare_control');
  let prepare: string | undefined;
  await fixture.driver.waitUntil(
    async () => {
      prepare = await fixture.driver.findElement(
        '.relay-route-key-approval__prepare button',
      );
      return Boolean(prepare);
    },
    {
      timeout: 60_000,
      timeoutMsg: 'saved relay route did not expose native proof preparation',
    },
  );
  assert.ok(prepare, 'relay route does not expose native proof preparation');
  onPhase('click_surface_prepare');
  await fixture.driver.clickElement(prepare);
  onPhase('wait_surface_metadata');
  await fixture.driver.waitUntil(
    async () =>
      Boolean(
        await fixture.driver.findElement(
          'section[aria-label="Public install proof metadata"]',
        ),
      ),
    { timeout: 30_000, timeoutMsg: 'native relay surface was not prepared' },
  );
  onPhase('read_surface_metadata');
  const surface = await fixture.driver.execute(() => {
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
  assert.equal(surface.Channel, NATIVE_CHANNEL);
  assert.match(surface['Client instance'] ?? '', /^[0-9a-f-]{36}$/i);
  return surface;
}

async function approveStationConnectionKey(
  fixture: TauriShellFixture,
  invitation: unknown,
  trust: Awaited<ReturnType<ConnectionSigningKeyStore['initialize']>>,
) {
  const textarea = await fixture.driver.findElement(
    'section[aria-label="Public install proof metadata"] textarea',
  );
  const discover = await fixture.driver.findElement(
    'section[aria-label="Public install proof metadata"] > button:nth-of-type(2)',
  );
  assert.ok(textarea && discover);
  await fixture.driver.typeElement(textarea, JSON.stringify(invitation));
  await fixture.driver.clickElement(discover);
  await fixture.driver.waitUntil(
    async () =>
      Boolean(
        await fixture.driver.findElement(
          'section[aria-label="Candidate from native verification"]',
        ),
      ),
    { timeout: 30_000, timeoutMsg: 'native Station key candidate missing' },
  );
  const codeInput = await fixture.driver.findElement(
    'section[aria-label="Candidate from native verification"] input[id$="-code"]',
  );
  const keyInput = await fixture.driver.findElement(
    'section[aria-label="Candidate from native verification"] input[id$="-key-id"]',
  );
  const attestation = await fixture.driver.findElement(
    '.relay-route-key-approval__attestation input',
  );
  assert.ok(codeInput && keyInput && attestation);
  await fixture.driver.typeElement(
    codeInput,
    formatStationConnectionKeyConfirmationCode(
      await stationConnectionKeyConfirmationCode(trust),
    ).toLowerCase(),
  );
  await fixture.driver.typeElement(
    keyInput,
    await stationConnectionSigningKeyId(trust),
  );
  await fixture.driver.clickElement(attestation);
  const approve = await fixture.driver.findElement(
    'section[aria-label="Candidate from native verification"] > button:first-of-type',
  );
  assert.ok(approve);
  await fixture.driver.clickElement(approve);
  await fixture.driver.waitUntil(
    async () =>
      Boolean(
        await fixture.driver.execute(() =>
          document
            .querySelector('.relay-route-key-approval')
            ?.textContent?.includes('Station key approved'),
        ),
      ),
    { timeout: 30_000, timeoutMsg: 'Station connection key was not approved' },
  );
}

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
        done({ ipcError: 'main_webview_tauri_ipc_missing' });
        return;
      }
      void internals
        .invoke(commandName, commandArgs)
        .then((ipcResult) => done({ ipcResult: ipcResult as T }))
        .catch((error: unknown) => {
          let ipcError = 'native_project_ipc_refused';
          if (error instanceof Error) {
            if (
              error.message ===
              'Station could not confirm the Device binding receipt'
            )
              ipcError = 'native_device_receipt_unavailable';
            else if (
              error.message ===
              'Station returned an invalid Device binding receipt'
            )
              ipcError = 'native_device_receipt_invalid';
            else if (
              error.message ===
              'The current Device candidate owner changed during receipt lookup'
            )
              ipcError = 'native_device_receipt_owner_changed';
            else if (/^[a-z0-9_]{1,100}$/i.test(error.message))
              ipcError = error.message;
          }
          done({ ipcError });
        });
    },
    command,
    args,
  );
}

async function runNativeProjectAcceptance() {
  if (process.platform !== 'darwin')
    throw new Error(
      'native Project acceptance requires the macOS Keychain Tauri shell',
    );
  const clientInstanceId = randomUUID();
  const routeName = `native-project-${clientInstanceId.slice(0, 8)}`;
  const deviceProfileName = `${routeName}-device`;
  const root = mkdtempSync(join(tmpdir(), 'station-native-project-proof-'));
  chmodSync(root, 0o700);
  const controller = new AbortController();
  let runtime:
    | Awaited<ReturnType<typeof startNativeProjectRuntimeFixture>>
    | undefined;
  let fixture: TauriShellFixture | undefined;
  let candidate: NativeCandidate | undefined;
  let grantRedeemed = false;
  let grantCustodyStatusVerified = true;
  let accountSessionRequested = false;
  let stationOrigin = '';
  let projectSlug = '';
  let stationTrust:
    | Awaited<ReturnType<ConnectionSigningKeyStore['initialize']>>
    | undefined;
  let turn:
    | { tcp: number; udp: number; username: string; password: string }
    | undefined;
  const accountSessionStateKey = `native-account-${randomUUID()}`;
  const accountSessionStateKeys = [accountSessionStateKey];
  const routeProfileNames = [routeName];
  let webViewBundle = '';
  let webViewRunnerInstalled = false;
  let phase = 'runtime_bootstrap';
  let failure: unknown;
  const cleanupErrors: unknown[] = [];
  const ownedItems: KeychainItem[] = [];
  const surfaceProofItem = relayProofItem(APP_IDENTIFIER, clientInstanceId);
  const ownerIndex = ownerIndexItem();
  const grantIndex = grantIndexItem(clientInstanceId);
  const grantCleanupIndex = grantCleanupIndexItem(clientInstanceId);
  for (const item of [
    ownerIndex,
    surfaceProofItem,
    grantIndex,
    grantCleanupIndex,
  ])
    assert.equal(
      keychainStatus(item),
      44,
      `fixture Keychain owner already exists: ${item.service}`,
    );
  ownedItems.push(surfaceProofItem, grantIndex, grantCleanupIndex, ownerIndex);

  try {
    phase = 'runtime_bootstrap';
    runtime = await startNativeProjectRuntimeFixture({
      directory: join(root, 'runtime'),
      signal: controller.signal,
    });
    stationOrigin = runtime.stationBase;
    projectSlug = runtime.projectSlug;
    stationTrust = runtime.stationTrust;

    phase = 'tauri_shell_start';
    fixture = await startTauriShellFixture({
      seedRemoteProfile: false,
      seedRelayRoute: {
        name: routeName,
        endpoint: stationOrigin,
        brokerOrigin: runtime.brokerOrigin,
        stationId: runtime.stationId,
        enrollmentId: runtime.scope.enrollmentId,
        clientInstanceId,
      },
      realCredentialStore: true,
    });
    phase = 'webview_runner_bundle';
    const bundleResult = await build({
      entryPoints: [
        resolve(import.meta.dirname, 'native-project-acceptance-webview.ts'),
      ],
      bundle: true,
      format: 'iife',
      globalName: 'StationNativeProjectAcceptance',
      platform: 'browser',
      target: 'safari17',
      write: false,
      sourcemap: false,
      loader: { '.css': 'empty' },
    });
    webViewBundle = bundleResult.outputFiles?.[0]?.text ?? '';
    assert(webViewBundle, 'Native Project WebView runner did not bundle.');
    phase = 'prepare_native_surface';
    const surface = await installTauriRelayProofSurface(
      fixture,
      (nextPhase) => {
        phase = nextPhase;
      },
    );
    assert.equal(surface['Client instance'], clientInstanceId);
    assert.equal(keychainStatus(surfaceProofItem), 0);
    phase = 'install_webview_runner';
    await installMainWebViewBundle(fixture, webViewBundle);
    webViewRunnerInstalled = true;

    const nativeSurface: SelfHostedBrokerNativeClientSurfaceV2 = {
      kind: 'station-native',
      appIdentifier: surface.App!,
      channel: NATIVE_CHANNEL,
      clientInstanceId,
      keyThumbprint: surface['Key thumbprint']!,
    };
    phase = 'enable_native_runtime';
    const nativeRuntime = await runtime.enableNativeClient(nativeSurface);
    phase = 'validate_native_runtime';
    assert.equal(nativeRuntime.stationBase, stationOrigin);
    assert.equal(nativeRuntime.stationId, runtime.stationId);
    stationTrust = nativeRuntime.stationTrust;
    turn = nativeRuntime.turn;

    const trustProofItem = trustItem(runtime.stationId);
    assert.equal(keychainStatus(trustProofItem), 44);
    ownedItems.push(trustProofItem);
    phase = 'issue_native_invitation';
    const invitation = await runtime.issueNativeInvitation(nativeSurface);
    phase = 'approve_station_trust';
    await approveStationConnectionKey(fixture, invitation, stationTrust);
    assert.equal(keychainStatus(trustProofItem), 0);
    const profileRevision = profileStoreRevision(fixture.stationRoot);
    phase = 'redeem_native_route';
    const redemption = await invoke<{
      status?: string;
      grant?: { route?: Record<string, unknown> & { grantId?: string } };
      failure?: unknown;
    }>(fixture, 'station_native_relay_grant_redeem', {
      profileName: routeName,
      expectedProfileRevision: profileRevision,
      invitation,
    });
    assert.ok(
      redemption.ipcResult,
      redemption.ipcError ?? 'grant redemption IPC failed',
    );
    assert.equal(redemption.ipcResult.status, 'redeemed');
    assert(redemption.ipcResult.grant?.route?.grantId);
    grantRedeemed = true;
    grantCustodyStatusVerified = false;
    const grantRoute = redemption.ipcResult.grant.route;
    const grantKeychainItem = grantItem(clientInstanceId, {
      brokerOrigin: String(grantRoute.brokerOrigin ?? runtime.brokerOrigin),
      stationId: String(grantRoute.stationId ?? runtime.stationId),
      enrollmentId: String(
        grantRoute.enrollmentId ?? runtime.scope.enrollmentId,
      ),
      routingGeneration: Number(
        grantRoute.routingGeneration ?? runtime.scope.routingGeneration,
      ),
      grantId: String(grantRoute.grantId),
    });
    assert.equal(keychainStatus(grantKeychainItem), 0);
    ownedItems.push(grantKeychainItem);

    phase = 'begin_account_bound_device_pairing';
    const pairing = await runtime.beginNativePairing(clientInstanceId);
    phase = 'inspect_pairing_webview';
    const pairingWebView = await fixture.driver.execute(() => {
      const page = window as unknown as Record<string, unknown>;
      const state = page.__stationNativeProjectAcceptance as
        | {
            status?: unknown;
            runner?: { pairCurrentTauriDevice?: unknown };
          }
        | undefined;
      const internals = page.__TAURI_INTERNALS__ as
        | { invoke?: unknown }
        | undefined;
      return {
        tauriInvokeReady: typeof internals?.invoke === 'function',
        runnerReady:
          typeof state?.runner?.pairCurrentTauriDevice === 'function',
        runnerState: state?.status,
      };
    });
    console.log(
      `NATIVE_PROJECT_PAIRING_WEBVIEW ${JSON.stringify(pairingWebView)}`,
    );
    assert.equal(pairingWebView.tauriInvokeReady, true);
    assert.equal(pairingWebView.runnerReady, true);
    assert.equal(pairingWebView.runnerState, 'ready');
    phase = 'exchange_native_device_pairing';
    const paired = await callInMainWebView<
      {
        endpoint: string;
        profileName: string;
        clientInstanceId: string;
        expectedStationId: string;
        offerId: string;
        proof: string;
        requestId: string;
      },
      {
        connectionId: string;
        stationId: string;
        deviceId: string;
        clientInstanceId: string;
        profileRevision: number;
      }
    >(
      fixture,
      webViewBundle,
      'pairCurrentTauriDevice',
      {
        ...pairing,
        profileName: deviceProfileName,
        clientInstanceId,
      },
      (nextPhase) => {
        phase = nextPhase;
      },
    );
    assert.equal(paired.stationId, runtime.stationId);
    assert.equal(paired.clientInstanceId, clientInstanceId);
    ownedItems.push(...pairingCustodyItems(fixture.stationRoot));

    phase = 'prepare_host_device_candidate';
    const currentProfileRevision = profileStoreRevision(fixture.stationRoot);
    const candidateResult = await invoke<NativeCandidate>(
      fixture,
      'station_native_device_binding_candidate',
      {
        profileName: routeName,
        expectedProfileRevision: currentProfileRevision,
      },
    );
    if (!candidateResult.ipcResult)
      throw new Error(
        candidateResult.ipcError ?? 'native_project_candidate_ipc_missing',
      );
    candidate = candidateResult.ipcResult;
    if (candidate.deviceId !== paired.deviceId)
      throw new Error('native_project_candidate_device_mismatch');
    if (candidate.stationId !== runtime.stationId)
      throw new Error('native_project_candidate_station_mismatch');
    const candidateItems = candidateKeychainItems(routeName, candidate);
    ownedItems.push(...candidateItems);
    console.log(
      `NATIVE_PROJECT_CANDIDATE_TUPLE ${JSON.stringify({
        stationId: candidate.stationId,
        deviceId: candidate.deviceId,
        bindingId: candidate.bindingId,
        appIdentifier: candidate.surface.appIdentifier,
        channel: candidate.surface.channel,
        clientInstanceId: candidate.surface.clientInstanceId,
        deviceProofKeyThumbprint: candidate.deviceProofKeyThumbprint,
      })}`,
    );
    const candidateRecordStatus = keychainStatus(candidateItems[0]!);
    const deviceProofStatus = keychainStatus(candidateItems[1]!);
    console.log(
      `NATIVE_PROJECT_CANDIDATE_KEYCHAIN ${JSON.stringify({
        candidateRecordStatus,
        deviceProofStatus,
        deviceProofAccountHash: candidateItems[1]!.account.split(':').at(-1),
        hostCandidateReturnedDeviceKey: Boolean(
          candidate.deviceProofJwk.x && candidate.deviceProofJwk.y,
        ),
      })}`,
    );
    if (candidateRecordStatus !== 0)
      throw new Error('native_project_candidate_record_not_persisted');

    phase = 'approve_device_binding';
    const bindingReadback = await runtime.approveDeviceCandidate(candidate);
    assert.equal(
      bindingReadback.version,
      'station-native-device-proof-binding-readback/v1',
    );
    assert.equal(bindingReadback.binding.bindingId, candidate.bindingId);
    assert.equal(bindingReadback.binding.state, 'active');
    assert.equal(bindingReadback.currentDeviceBinding, true);

    phase = 'read_host_self_receipt';
    const receipt = await invoke<{
      version?: string;
      status?: string;
      source?: string;
      receipt?: unknown;
    }>(fixture, 'station_native_device_binding_self_receipt', {
      profileName: routeName,
      expectedProfileRevision: currentProfileRevision,
    });
    if (!receipt.ipcResult)
      throw new Error(
        receipt.ipcError ?? 'native_project_self_receipt_missing',
      );
    console.log(
      `NATIVE_PROJECT_SELF_RECEIPT ${JSON.stringify({
        version: receipt.ipcResult.version,
        status: receipt.ipcResult.status,
        source: receipt.ipcResult.source,
        receiptPresent: Boolean(receipt.ipcResult.receipt),
      })}`,
    );
    if (
      receipt.ipcResult.version !==
      'station-native-device-binding-self-receipt-status/v1'
    )
      throw new Error('native_project_self_receipt_version_mismatch');
    if (receipt.ipcResult.status !== 'current')
      throw new Error(
        `native_project_self_receipt_${String(receipt.ipcResult.status ?? 'missing')}`,
      );
    if (receipt.ipcResult.source !== 'station-receipt')
      throw new Error('native_project_self_receipt_source_mismatch');
    if (!receipt.ipcResult.receipt)
      throw new Error('native_project_self_receipt_body_missing');

    const accountKeyItem = accountProofItem(candidate);
    assert.equal(keychainStatus(accountKeyItem), 44);
    ownedItems.push(accountKeyItem);
    console.log(
      `NATIVE_PROJECT_VIEWER_MEMBERSHIP ${JSON.stringify({ accepted: true, grantsDeviceAccess: false })}`,
    );
    const accountFixture = fixture;
    const accountRuntime = runtime;
    if (!accountFixture || !accountRuntime)
      throw new Error('native_project_account_fixture_missing');
    const turnConfig = turn;
    assert(turnConfig, 'native runtime did not return TURN credentials');
    const establishAccountSession = async (stateKey: string) => {
      phase = 'prepare_account_session';
      return await callInMainWebView<
        {
          routeProfileName: string;
          deviceProfileName: string;
          profileRevision: number;
          stationOrigin: string;
          clientInstanceId: string;
          turnPort: number;
          turnUsername: string;
          turnPassword: string;
          username: string;
          password: string;
          stateKey: string;
        },
        {
          stateKey: string;
          hostAccountContextReady: boolean;
          accountExchangePeerCount: number;
          accountExchangeRelayPairCount: number;
          accountChannelObservations: Array<{
            kind: 'challenge' | 'exchange';
            status: number;
            versionValid: boolean;
            closedShapeValid: boolean;
            targetValid: boolean;
            deviceValid: boolean;
            surfaceValid: boolean;
          }>;
        }
      >(accountFixture, webViewBundle, 'establishNativeProjectAccountSession', {
        routeProfileName: routeName,
        deviceProfileName,
        profileRevision: profileStoreRevision(accountFixture.stationRoot),
        stationOrigin,
        clientInstanceId,
        turnPort: turnConfig.tcp,
        turnUsername: turnConfig.username,
        turnPassword: turnConfig.password,
        username: accountRuntime.account.username,
        password: accountRuntime.account.password,
        stateKey,
      });
    };
    accountSessionRequested = true;
    const accountSession = await establishAccountSession(
      accountSessionStateKey,
    );
    assert.equal(accountSession.hostAccountContextReady, true);
    assert.equal(accountSession.accountExchangePeerCount, 2);
    assert.equal(accountSession.accountExchangeRelayPairCount, 2);
    console.log(
      `NATIVE_PROJECT_ACCOUNT_CHANNELS ${JSON.stringify(accountSession.accountChannelObservations)}`,
    );
    assert.equal(
      keychainStatus(accountKeyItem),
      0,
      'host account proof key was not persisted',
    );

    const readProject = (stateKey: string) =>
      callInMainWebView<
        { stateKey: string; stationOrigin: string; slug: string },
        NativeProjectReadResult
      >(accountFixture, webViewBundle, 'readNativeProject', {
        stateKey,
        stationOrigin,
        slug: projectSlug,
      });
    const logProjectOutcome = (
      label: string,
      result: NativeProjectReadResult,
    ) =>
      console.log(
        `NATIVE_PROJECT_READ_OUTCOME ${JSON.stringify({
          label,
          status: result.status,
          containsExpectedProject: result.containsExpectedProject,
          responseRootKeys: result.responseRootKeys,
          serverErrorCode: result.serverErrorCode,
          directProjectApiAttempts: result.directProjectApiAttempts,
          relayedPairObserved: result.relayedPairObserved,
          offerUsedRelayCandidate: result.offerUsedRelayCandidate,
          freshPeerHandle: result.freshPeerHandle,
        })}`,
      );
    const assertSuccessfulProjectRead = (
      result: NativeProjectReadResult,
      label: string,
    ) => {
      if (result.status !== 200)
        throw new Error(`native_project_${label}_http_${result.status}`);
      if (!result.containsExpectedProject)
        throw new Error(`native_project_${label}_payload_missing`);
      if (result.directProjectApiAttempts !== 0)
        throw new Error(`native_project_${label}_direct_api_attempted`);
      if (!result.relayedPairObserved || !result.offerUsedRelayCandidate)
        throw new Error(`native_project_${label}_relay_unverified`);
      if (!result.freshPeerHandle)
        throw new Error(`native_project_${label}_peer_handle_reused`);
    };
    const assertRefusedProjectRead = (
      result: NativeProjectReadResult,
      label: string,
    ) => {
      if (![401, 403, 404].includes(result.status))
        throw new Error(
          `native_project_${label}_unexpected_http_${result.status}`,
        );
      if (result.containsExpectedProject)
        throw new Error(`native_project_${label}_returned_project`);
    };

    phase = 'protected_project_read';
    const project = await readProject(accountSessionStateKey);
    logProjectOutcome('initial', project);
    assertSuccessfulProjectRead(project, 'initial_read');

    phase = 'reconnect_project_read';
    const repeatedProject = await readProject(accountSessionStateKey);
    logProjectOutcome('reconnect', repeatedProject);
    assertSuccessfulProjectRead(repeatedProject, 'reconnect_read');

    phase = 'revoke_account_session';
    await runtime.fixture.revokeAccount();
    phase = 'verify_revoked_account_read';
    const revokedAccountRead = await readProject(accountSessionStateKey);
    logProjectOutcome('account_revoked', revokedAccountRead);
    assertRefusedProjectRead(revokedAccountRead, 'account_revoked');

    const reauthenticatedStateKey = `native-account-${randomUUID()}`;
    accountSessionStateKeys.push(reauthenticatedStateKey);
    phase = 'reauthenticate_account';
    const reauthenticated = await establishAccountSession(
      reauthenticatedStateKey,
    );
    if (
      !reauthenticated.hostAccountContextReady ||
      reauthenticated.accountExchangePeerCount !== 2 ||
      reauthenticated.accountExchangeRelayPairCount !== 2
    )
      throw new Error('native_project_account_reauthentication_invalid');
    console.log(
      `NATIVE_PROJECT_REAUTH_CHANNELS ${JSON.stringify(reauthenticated.accountChannelObservations)}`,
    );

    phase = 'project_read_after_reauthentication';
    const reauthenticatedProject = await readProject(reauthenticatedStateKey);
    logProjectOutcome('reauthenticated', reauthenticatedProject);
    assertSuccessfulProjectRead(reauthenticatedProject, 'reauthenticated_read');

    phase = 'revoke_paired_device';
    await runtime.revokeDevice(paired.deviceId);
    phase = 'verify_revoked_device_read';
    const revokedDeviceRead = await readProject(reauthenticatedStateKey);
    logProjectOutcome('device_revoked', revokedDeviceRead);
    assertRefusedProjectRead(revokedDeviceRead, 'device_revoked');

    const successfulReads = [project, repeatedProject, reauthenticatedProject];
    const allReads = [
      ...successfulReads,
      revokedAccountRead,
      revokedDeviceRead,
    ];
    console.log(
      `NATIVE_PROJECT_PROOF_ACCEPTED ${JSON.stringify({
        stationId: runtime.stationId,
        deviceId: paired.deviceId,
        bindingId: candidate.bindingId,
        projectSlug,
        sourceSha: process.env.STATION_TAURI_E2E_SOURCE_SHA ?? 'unrecorded',
        selectedBrowserRelayPairs:
          accountSession.accountExchangeRelayPairCount +
          reauthenticated.accountExchangeRelayPairCount +
          allReads.filter((result) => result.relayedPairObserved).length,
        directProjectApiAttempts: allReads.reduce(
          (total, result) => total + result.directProjectApiAttempts,
          0,
        ),
        accountRevocationRefused: [401, 403, 404].includes(
          revokedAccountRead.status,
        ),
        deviceRevocationRefused: [401, 403, 404].includes(
          revokedDeviceRead.status,
        ),
      })}`,
    );
  } catch (error) {
    const errorKind =
      error instanceof Error
        ? error.name.toLowerCase().replace(/[^a-z0-9]+/gu, '_')
        : 'unknown';
    const webDriverCode =
      typeof error === 'object' &&
      error !== null &&
      'webDriverError' in error &&
      typeof error.webDriverError === 'string'
        ? `_${error.webDriverError.toLowerCase().replace(/[^a-z0-9]+/gu, '_')}`
        : '';
    const safeMessage =
      error instanceof Error && /^[a-z0-9_]{1,100}$/i.test(error.message)
        ? `_${error.message}`
        : webDriverCode;
    const sourceLine =
      error instanceof Error
        ? error.stack?.match(
            /native-project-acceptance\.e2e\.ts:(\d+):\d+/u,
          )?.[1]
        : undefined;
    failure = new Error(
      `native_project_phase_${phase}_${errorKind}${safeMessage}${sourceLine ? `_line_${sourceLine}` : ''}`,
    );
  } finally {
    const deferredWebViewCleanupFailures: string[] = [];
    const recordCleanupFailure = (stage: string, error: unknown) => {
      const kind =
        error instanceof Error
          ? error.name.toLowerCase().replace(/[^a-z0-9]+/gu, '_')
          : 'unknown';
      cleanupErrors.push(new Error(`cleanup_${stage}_${kind}`));
    };
    const invokeCleanup = async <T = unknown>(
      command: string,
      args: Record<string, unknown> = {},
    ): Promise<IpcResult<T> | undefined> => {
      if (!fixture) return;
      try {
        const result = await invoke<T>(fixture, command, args);
        if (result.ipcError) throw new Error(result.ipcError);
        return result;
      } catch (error) {
        recordCleanupFailure(`ipc_${command}`, error);
      }
    };
    if (fixture && webViewRunnerInstalled && accountSessionRequested) {
      try {
        for (const stateKey of accountSessionStateKeys)
          await callInMainWebView(
            fixture,
            webViewBundle,
            'closeNativeProjectSession',
            stateKey,
          );
      } catch (error) {
        const kind =
          error instanceof Error
            ? error.name.toLowerCase().replace(/[^a-z0-9]+/gu, '_')
            : 'unknown';
        deferredWebViewCleanupFailures.push(`close_session_${kind}`);
      }
    }
    if (fixture && grantRedeemed) {
      const revision = profileStoreRevision(fixture.stationRoot);
      await invokeCleanup('station_native_relay_grant_revoke', {
        profileName: routeName,
        expectedProfileRevision: revision,
      });
      const pending = await invokeCleanup<unknown>(
        'station_native_relay_grant_cleanup_pending',
      );
      if (!pending || !Array.isArray(pending.ipcResult)) {
        cleanupErrors.push(
          new Error('Native relay cleanup status was unavailable.'),
        );
      }
      for (const item of Array.isArray(pending?.ipcResult)
        ? (pending.ipcResult as Array<{ cleanupId?: string }>)
        : []) {
        if (!item.cleanupId) continue;
        const retried = await invokeCleanup(
          'station_native_relay_grant_cleanup_retry',
          { cleanupId: item.cleanupId },
        );
        if (retried?.ipcError) cleanupErrors.push(new Error(retried.ipcError));
      }
      const remaining = await invokeCleanup<unknown>(
        'station_native_relay_grant_cleanup_pending',
      );
      if (!remaining || !Array.isArray(remaining.ipcResult))
        cleanupErrors.push(
          new Error('Native relay cleanup status was unavailable.'),
        );
      else if (remaining.ipcResult.length)
        cleanupErrors.push(new Error('Native relay cleanup remained pending.'));
      const grantStatus = await invokeCleanup<{
        grants?: unknown[];
        cleanups?: unknown[];
      }>('station_native_relay_grant_status', { profileName: routeName });
      const pendingCleanupRecords = await invokeCleanup<unknown[]>(
        'station_native_relay_grant_cleanup_pending',
      );
      grantCustodyStatusVerified =
        !!grantStatus &&
        Array.isArray(grantStatus.ipcResult?.grants) &&
        grantStatus.ipcResult.grants.length === 0 &&
        Array.isArray(grantStatus.ipcResult.cleanups) &&
        grantStatus.ipcResult.cleanups.length === 0 &&
        !!pendingCleanupRecords &&
        Array.isArray(pendingCleanupRecords.ipcResult) &&
        pendingCleanupRecords.ipcResult.length === 0;
      console.log(
        `NATIVE_PROJECT_GRANT_CUSTODY_CLEANUP ${JSON.stringify({
          verified: grantCustodyStatusVerified,
          grants: grantStatus?.ipcResult?.grants?.length ?? null,
          cleanups: grantStatus?.ipcResult?.cleanups?.length ?? null,
          pendingCleanupRecords:
            pendingCleanupRecords?.ipcResult?.length ?? null,
        })}`,
      );
      if (!grantCustodyStatusVerified)
        cleanupErrors.push(
          new Error('Native relay grant custody was not verified empty.'),
        );
    }
    if (fixture && webViewRunnerInstalled) {
      try {
        const cleanupProfiles = await callInMainWebView<
          {
            routeProfileNames: readonly string[];
            deviceProfileName: string;
            stationOrigin: string;
          },
          { removed: boolean }
        >(fixture, webViewBundle, 'cleanupNativeProjectProfiles', {
          routeProfileNames,
          deviceProfileName,
          stationOrigin,
        });
        if (!cleanupProfiles.removed)
          cleanupErrors.push(
            new Error('Native Project fixture profiles remained.'),
          );
      } catch (error) {
        const kind =
          error instanceof Error
            ? error.name.toLowerCase().replace(/[^a-z0-9]+/gu, '_')
            : 'unknown';
        deferredWebViewCleanupFailures.push(`remove_profiles_${kind}`);
      }
    }
    let tauriProcessGroupSettled = false;
    let tauriFixtureRootRemoved = false;
    try {
      await fixture?.stop();
      tauriProcessGroupSettled =
        fixture?.cleanupReceipt?.processGroupSettled === true;
      tauriFixtureRootRemoved =
        fixture?.cleanupReceipt?.fixtureRootRemoved === true;
    } catch (error) {
      recordCleanupFailure('stop_tauri_shell', error);
    }
    if (deferredWebViewCleanupFailures.length > 0) {
      if (tauriProcessGroupSettled && tauriFixtureRootRemoved) {
        console.log(
          `NATIVE_PROJECT_WEBVIEW_CLEANUP_REAPED ${JSON.stringify({
            failedExplicitCleanup: deferredWebViewCleanupFailures,
            processGroupSettled: tauriProcessGroupSettled,
            fixtureRootRemoved: tauriFixtureRootRemoved,
          })}`,
        );
      } else {
        cleanupErrors.push(
          new Error('Native WebView cleanup failed and shell was not reaped.'),
        );
      }
    }
    let runtimeStopped = false;
    try {
      await runtime?.stop();
      runtimeStopped = true;
    } catch (error) {
      recordCleanupFailure('stop_station_runtime', error);
    }
    controller.abort(new Error('native_project_acceptance_cleanup'));
    const hostAndRuntimeCleanupVerified =
      grantCustodyStatusVerified &&
      tauriProcessGroupSettled &&
      tauriFixtureRootRemoved &&
      runtimeStopped;
    if (hostAndRuntimeCleanupVerified) {
      for (const item of ownedItems) {
        try {
          removeOwnedKeychainItem(item);
        } catch (error) {
          recordCleanupFailure('remove_owned_keychain_item', error);
        }
      }
    }
    if (hostAndRuntimeCleanupVerified && cleanupErrors.length === 0) {
      try {
        rmSync(root, { recursive: true, force: true });
      } catch (error) {
        recordCleanupFailure('remove_fixture_root', error);
      }
    }
  }
  const cleanupKinds = cleanupErrors
    .map((error) =>
      error instanceof Error
        ? /^[a-z0-9_]{1,100}$/i.test(error.message)
          ? error.message
          : error.name.toLowerCase().replace(/[^a-z0-9]+/gu, '_')
        : 'unknown',
    )
    .join('_');
  const cleanupSummary = [...new Set(cleanupKinds.split('_'))]
    .join('_')
    .slice(0, 45);
  if (failure && cleanupErrors.length)
    throw new Error(
      `${exactCommandError(failure).slice(0, 40)}_cleanup_${cleanupErrors.length}_${cleanupSummary}`,
    );
  if (cleanupErrors.length)
    throw new Error(
      `native_project_cleanup_${cleanupErrors.length}_${cleanupSummary}`,
    );
  if (failure) throw failure;
}

function exactCommandError(error: unknown) {
  return error instanceof Error && /^[a-z0-9_]{1,180}$/i.test(error.message)
    ? error.message.slice(0, 180)
    : 'native_project_ipc_refused';
}

async function main() {
  if (process.env.STATION_TAURI_E2E_SOURCE_SHA === undefined)
    throw new Error('run-tauri-shell-e2e must set the exact source SHA');
  await runNativeProjectAcceptance();
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  void main().catch((error) => {
    console.error(
      `native Project acceptance failed: ${exactCommandError(error)}`,
    );
    process.exitCode = 1;
  });
}
