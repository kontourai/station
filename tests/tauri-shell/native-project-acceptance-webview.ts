import { createNativeApplicationTransport } from '@kontourai/station-connect/native-application';
import type { SelfHostedBrokerNativeClientSurfaceV2 } from '@kontourai/station-contracts/self-hosted-broker';
import {
  type NativeAccountExchangePreparation,
  NativeApplicationSessionClient,
  type NativeApplicationSessionProofProvider,
  type NativeApplicationSessionTrustSnapshotV1,
} from '@kontourai/station-sdk/application-session-native';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { createNativeApplicationSignalingBridge } from '../../src-ui/src/platform/native/nativeApplicationSignalingBridge';
import { nativePairingExchangeTransport } from '../../src-ui/src/platform/native/pairingTransport';
import { nativeStationProfileStorage } from '../../src-ui/src/platform/native/stationProfileStorage';
import { invokeTauri } from '../../src-ui/src/platform/native/tauriInvoke';

interface NativePairInput {
  readonly endpoint: string;
  readonly profileName: string;
  readonly clientInstanceId: string;
  readonly expectedStationId: string;
  readonly offerId: string;
  readonly proof: string;
  readonly requestId: string;
}

interface NativeStationProfileStore {
  readonly revision: number;
  readonly profiles: ReadonlyArray<{
    readonly name: string;
    readonly relayRoute?: unknown;
  }>;
}

/** Test-only runner. All credential exchange and persistence stay in the real host adapters. */
export async function pairCurrentTauriDevice(input: NativePairInput) {
  const result = await nativePairingExchangeTransport({
    endpoint: input.endpoint,
    offerId: input.offerId,
    proof: input.proof,
    requestId: input.requestId,
    clientInstanceId: input.clientInstanceId,
    operationId: randomCorrelationId(),
  });
  if (
    result.environmentId !== input.expectedStationId ||
    result.device.kind !== 'device' ||
    !result.credentialHandle ||
    !result.credentialRef
  )
    throw new Error('native_project_pairing_result_invalid');

  const profiles = nativeStationProfileStorage(true);
  await profiles.refresh();
  const connectionId = await profiles.commitVerifiedPairing({
    connectionId: `station-profile:${input.profileName.toLowerCase()}`,
    name: input.profileName,
    endpoint: input.endpoint,
    handshake: {
      environmentId: result.environmentId,
      authentication: { scheme: 'bearer', protocolVersion: 1 },
    },
    clientInstanceId: input.clientInstanceId,
    credentialHandle: result.credentialHandle,
    nextCredentialRef: result.credentialRef,
  });
  const rawStore = await invokeTauri<unknown>('station_profile_store_read');
  const storeValue =
    typeof rawStore === 'string' ? (JSON.parse(rawStore) as unknown) : rawStore;
  if (
    typeof storeValue !== 'object' ||
    storeValue === null ||
    !Number.isSafeInteger((storeValue as NativeStationProfileStore).revision)
  )
    throw new Error('native_project_profile_store_invalid');
  return {
    connectionId,
    stationId: result.environmentId,
    deviceId: result.device.id,
    clientInstanceId: input.clientInstanceId,
    profileRevision: (storeValue as NativeStationProfileStore).revision,
  };
}

export async function cleanupNativeProjectProfiles(input: {
  readonly routeProfileNames: readonly string[];
  readonly deviceProfileName: string;
  readonly stationOrigin: string;
}) {
  const storage = nativeStationProfileStorage(true);
  await storage.refresh();
  const rawStore = await invokeTauri<unknown>('station_profile_store_read');
  const store =
    typeof rawStore === 'string' ? (JSON.parse(rawStore) as unknown) : rawStore;
  if (
    typeof store !== 'object' ||
    store === null ||
    !Array.isArray((store as NativeStationProfileStore).profiles)
  )
    throw new Error('native_project_profile_store_invalid');
  const profiles = (store as NativeStationProfileStore).profiles;
  const direct = profiles.find(
    (profile) =>
      profile.name === input.deviceProfileName && !profile.relayRoute,
  );
  if (direct)
    await storage.removeProfile({
      connectionId: `station-profile:${direct.name.toLowerCase()}`,
      expected: { name: direct.name, url: input.stationOrigin },
    });
  await storage.refresh();
  const relayProfiles = storage.getRelayRouteProfiles();
  for (const name of input.routeProfileNames) {
    const route = relayProfiles.find((profile) => profile.name === name);
    if (!route) continue;
    await storage.removeRelayRouteProfile(
      `station-profile:${route.name.toLowerCase()}`,
      route.updatedAt,
    );
  }
  await storage.refresh();
  const remaining = storage.getRelayRouteProfiles();
  if (
    remaining.some((profile) => input.routeProfileNames.includes(profile.name))
  )
    throw new Error('native_project_relay_profiles_remain');
  return { removed: true };
}

interface AccountContextPrepared {
  readonly version: 'station-native-account-operation/v1';
  readonly accountContextHandle: string;
  readonly contextExpiresAtMs: number;
  readonly publicKey: {
    readonly kty: 'EC';
    readonly crv: 'P-256';
    readonly x: string;
    readonly y: string;
  };
  readonly target: {
    readonly kind: 'station-native';
    readonly stationId: string;
    readonly audience: string;
    readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  };
  readonly deviceId: string;
  readonly body: {
    readonly version: 'station.application-session-native/v1';
    readonly publicKey: AccountContextPrepared['publicKey'];
  };
}

interface SessionRecord {
  readonly appTransport: ReturnType<typeof createNativeApplicationTransport>;
  readonly client: NativeApplicationSessionClient;
  readonly continuation: Awaited<
    ReturnType<NativeApplicationSessionClient['exchange']>
  >;
  readonly controller: AbortController;
  readonly closePeerHandle: (peerHandle: string) => Promise<void>;
  readonly peers: Array<{
    readonly peer: RTCPeerConnection;
    handle?: string;
    offerSdp?: string;
    relayPair?: { local: string; remote: string };
    relayTask?: Promise<void>;
    relayError?: string;
  }>;
  readonly peerHandles: string[];
  directProjectApiAttempts: number;
  lastProjectPeerHandle?: string;
}

const sessions = new Map<string, SessionRecord>();

async function getSelectedRelayPair(peer: RTCPeerConnection) {
  const report = await peer.getStats();
  const transports = [...report.values()].filter(
    (entry) => entry.type === 'transport',
  ) as Array<RTCStats & { selectedCandidatePairId?: string }>;
  const selectedPairId = transports.find(
    (transport) => transport.selectedCandidatePairId,
  )?.selectedCandidatePairId;
  if (!selectedPairId) return undefined;
  const selectedPair = report.get(selectedPairId) as
    | (RTCStats & {
        type: string;
        localCandidateId?: string;
        remoteCandidateId?: string;
        state?: string;
      })
    | undefined;
  if (
    selectedPair?.type !== 'candidate-pair' ||
    selectedPair.state !== 'succeeded' ||
    !selectedPair.localCandidateId ||
    !selectedPair.remoteCandidateId
  )
    return undefined;
  const selectedLocal = report.get(selectedPair.localCandidateId) as
    | (RTCStats & { candidateType?: string })
    | undefined;
  const selectedRemote = report.get(selectedPair.remoteCandidateId) as
    | (RTCStats & { candidateType?: string })
    | undefined;
  if (selectedLocal?.candidateType && selectedRemote?.candidateType)
    return {
      local: selectedLocal.candidateType,
      remote: selectedRemote.candidateType,
    };
  return undefined;
}

async function waitForSelectedRelayPair(
  peer: RTCPeerConnection,
): Promise<{ local: string; remote: string }> {
  for (let attempt = 0; attempt < 30; attempt++) {
    let pair: Awaited<ReturnType<typeof getSelectedRelayPair>>;
    try {
      pair = await getSelectedRelayPair(peer);
    } catch {
      throw new Error('native_project_selected_relay_stats_unavailable');
    }
    if (pair?.local === 'relay' && pair.remote === 'relay') return pair;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('native_project_selected_relay_pair_missing');
}

/** Runs the real native account proof provider over Connect's encrypted Fetch path. */
export async function establishNativeProjectAccountSession(input: {
  readonly routeProfileName: string;
  readonly deviceProfileName: string;
  readonly profileRevision: number;
  readonly stationOrigin: string;
  readonly clientInstanceId: string;
  readonly turnPort: number;
  readonly turnUsername: string;
  readonly turnPassword: string;
  readonly username: string;
  readonly password: string;
  readonly stateKey: string;
}) {
  let operation = 'account_context_prepare';
  let lastHostCommand = 'none';
  const accountChannelObservations: Array<{
    kind: 'challenge' | 'exchange';
    status: number;
    versionValid: boolean;
    closedShapeValid: boolean;
    targetValid: boolean;
    deviceValid: boolean;
    surfaceValid: boolean;
  }> = [];
  const errorTag = (error: unknown) => {
    if (error instanceof Error && /^[a-z0-9_]{1,80}$/i.test(error.message))
      return error.message;
    const code =
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      typeof error.code === 'string' &&
      /^[a-z0-9_]{1,80}$/i.test(error.code)
        ? error.code
        : undefined;
    return (
      code ??
      (error instanceof Error ? error.name : 'unknown')
        .toLowerCase()
        .replace(/[^a-z0-9]+/gu, '_')
    );
  };
  const stagedError = (error: unknown, stage = operation) => {
    const channelState = accountChannelObservations
      .map((item) =>
        [
          item.kind,
          item.status,
          item.versionValid ? 'version_ok' : 'version_invalid',
          item.closedShapeValid ? 'closed_ok' : 'closed_invalid',
          item.targetValid ? 'target_ok' : 'target_invalid',
          item.deviceValid ? 'device_ok' : 'device_invalid',
          item.surfaceValid ? 'surface_ok' : 'surface_invalid',
        ].join('_'),
      )
      .join('_');
    return new Error(
      `native_project_${stage}_${errorTag(error)}_${lastHostCommand}${channelState ? `_${channelState}` : '_no_account_response'}`,
    );
  };
  let prepared: AccountContextPrepared;
  lastHostCommand = 'account_challenge_prepare';
  try {
    prepared = await invokeTauri<AccountContextPrepared>(
      'station_native_account_challenge_prepare',
      {
        profileName: input.routeProfileName,
        expectedProfileRevision: input.profileRevision,
      },
    );
  } catch (error) {
    throw stagedError(error);
  }
  operation = 'account_context_validate';
  if (
    prepared.version !== 'station-native-account-operation/v1' ||
    !prepared.accountContextHandle ||
    !Number.isSafeInteger(prepared.contextExpiresAtMs) ||
    prepared.contextExpiresAtMs <= Date.now() ||
    prepared.target.kind !== 'station-native' ||
    prepared.target.stationId.length === 0 ||
    prepared.target.audience !== input.stationOrigin ||
    prepared.target.surface.clientInstanceId !== input.clientInstanceId ||
    prepared.body.version !== 'station.application-session-native/v1' ||
    JSON.stringify(prepared.body.publicKey) !==
      JSON.stringify(prepared.publicKey)
  )
    throw new Error('native_project_account_context_invalid');

  const peers: SessionRecord['peers'] = [];
  const peerHandles: string[] = [];
  operation = 'peer_bridge_prepare';
  let bridge: Awaited<
    ReturnType<typeof createNativeApplicationSignalingBridge>
  >;
  try {
    bridge = await createNativeApplicationSignalingBridge(
      input.routeProfileName,
      input.profileRevision,
      {
        invoke: async (command, args) => {
          const result = await invokeTauri<unknown>(command, args);
          if (
            command === 'station_native_application_peer_prepare' &&
            typeof result === 'object' &&
            result !== null &&
            typeof (result as { peerHandle?: unknown }).peerHandle === 'string'
          )
            peerHandles.push((result as { peerHandle: string }).peerHandle);
          return result;
        },
      },
    );
  } catch (error) {
    throw stagedError(error);
  }
  operation = 'peer_bridge_validate';
  if (
    bridge.signaling.surface.clientInstanceId !==
    prepared.target.surface.clientInstanceId
  )
    throw new Error('native_project_account_surface_mismatch');
  const trust: NativeApplicationSessionTrustSnapshotV1 = Object.freeze({
    kind: prepared.target.kind,
    stationId: prepared.target.stationId,
    audience: prepared.target.audience,
    deviceId: prepared.deviceId,
    surface: Object.freeze({ ...prepared.target.surface }),
  });
  const proofProvider: NativeApplicationSessionProofProvider = Object.freeze({
    kind: 'station-native-host-proof-provider/v1',
    contextExpiresAtMs: prepared.contextExpiresAtMs,
    publicKey: Object.freeze({ ...prepared.publicKey }),
    async prepareExchange(
      exchange: Parameters<
        NativeApplicationSessionProofProvider['prepareExchange']
      >[0],
    ): Promise<NativeAccountExchangePreparation> {
      operation = 'host_account_exchange_prepare';
      lastHostCommand = 'account_exchange_prepare';
      const result = await invokeTauri<NativeAccountExchangePreparation>(
        'station_native_account_exchange_prepare',
        {
          accountContextHandle: prepared.accountContextHandle,
          challenge: exchange.challenge,
          credentials: exchange.credentials,
        },
      );
      operation = 'sdk_validate_host_exchange_preparation';
      return result;
    },
    async requestHeaders(
      request: Parameters<
        NativeApplicationSessionProofProvider['requestHeaders']
      >[0],
    ): ReturnType<NativeApplicationSessionProofProvider['requestHeaders']> {
      operation = 'host_account_request_headers';
      lastHostCommand = 'account_request_headers';
      const result = await invokeTauri<Record<string, string>>(
        'station_native_account_request_headers',
        {
          accountContextHandle: prepared.accountContextHandle,
          continuation: request.continuation,
          request: request.request,
        },
      );
      operation = 'sdk_validate_host_request_proof';
      return result;
    },
  });

  const controller = new AbortController();
  const signaling = Object.freeze({
    scope: bridge.signaling.scope,
    surface: bridge.signaling.surface,
    async prepare(signal: AbortSignal) {
      operation = 'peer_prepare';
      return await bridge.signaling.prepare(signal);
    },
    async open(peerHandle: string, offerSdp: string, signal: AbortSignal) {
      operation = 'peer_open';
      const peer = [...peers].reverse().find((item) => !item.handle);
      if (!peer) throw new Error('native_project_peer_owner_missing');
      peer.handle = peerHandle;
      peer.offerSdp = offerSdp;
      return await bridge.signaling.open(peerHandle, offerSdp, signal);
    },
    async read(peerHandle: string, signal: AbortSignal) {
      operation = 'peer_read';
      return await bridge.signaling.read(peerHandle, signal);
    },
    async sign(
      peerHandle: string,
      method: string,
      path: string,
      body: Uint8Array,
      signal: AbortSignal,
    ) {
      operation = 'peer_sign';
      return await bridge.signaling.sign(
        peerHandle,
        method,
        path,
        body,
        signal,
      );
    },
    async close(peerHandle: string) {
      return await bridge.signaling.close(peerHandle);
    },
  });
  const appTransport = createNativeApplicationTransport({
    signaling,
    trust: bridge.trust,
    origin: input.stationOrigin,
    signal: controller.signal,
    configuration: {
      iceServers: [
        {
          urls: `turn:127.0.0.1:${input.turnPort}?transport=tcp`,
          username: input.turnUsername,
          credential: input.turnPassword,
        },
      ],
      iceTransportPolicy: 'relay',
    },
    createPeer(configuration) {
      const peer = new RTCPeerConnection(configuration);
      const observation: SessionRecord['peers'][number] = { peer };
      peers.push(observation);
      const createDataChannel = peer.createDataChannel.bind(peer);
      peer.createDataChannel = (label, channelOptions) => {
        const channel = createDataChannel(label, channelOptions);
        channel.addEventListener(
          'open',
          () => {
            observation.relayTask = waitForSelectedRelayPair(peer)
              .then((pair) => {
                observation.relayPair = pair;
              })
              .catch((error: unknown) => {
                observation.relayError =
                  error instanceof Error &&
                  /^[a-z0-9_]{1,100}$/i.test(error.message)
                    ? error.message
                    : 'native_project_selected_relay_pair_missing';
              });
          },
          { once: true },
        );
        return channel;
      };
      return peer;
    },
  });
  const client = new NativeApplicationSessionClient(
    {
      async post(request) {
        const kind = request.path.endsWith('/challenge')
          ? 'challenge'
          : 'exchange';
        operation = `account_transport_${kind}`;
        const response = await appTransport.fetch(
          new URL(request.path, input.stationOrigin),
          {
            method: 'POST',
            headers: request.headers,
            body: JSON.stringify(request.body),
            signal: controller.signal,
          },
        );
        const envelope = await response.json();
        const responseBody =
          typeof envelope === 'object' && envelope !== null
            ? (envelope as Record<string, unknown>)
            : {};
        if (!response.ok) {
          const errorObject =
            typeof responseBody.error === 'object' &&
            responseBody.error !== null
              ? (responseBody.error as Record<string, unknown>)
              : {};
          const errorCode =
            typeof errorObject.code === 'string' &&
            /^[a-z0-9_]{1,80}$/i.test(errorObject.code)
              ? errorObject.code
              : 'refused';
          throw new Error(
            `native_project_account_http_${response.status}_${errorCode}`,
          );
        }
        const value = responseBody.data;
        const body =
          typeof value === 'object' && value !== null && !Array.isArray(value)
            ? (value as Record<string, unknown>)
            : {};
        if (Object.keys(body).length === 0)
          throw new Error('native_project_account_response_data_missing');
        const target =
          typeof body.target === 'object' && body.target !== null
            ? (body.target as Record<string, unknown>)
            : {};
        const surface =
          typeof target.surface === 'object' && target.surface !== null
            ? (target.surface as Record<string, unknown>)
            : {};
        accountChannelObservations.push({
          kind,
          status: response.status,
          versionValid:
            body.version === 'station.application-session-native/v1',
          closedShapeValid:
            Object.keys(body).sort().join(',') ===
            (kind === 'challenge'
              ? 'challengeId,deviceId,expiresAt,keyThumbprint,nonce,target,version'
              : 'authorityKey,credential,deviceId,expiresAt,keyThumbprint,nonce,principal,target,version'),
          targetValid:
            target.kind === 'station-native' &&
            target.stationId === trust.stationId &&
            target.audience === trust.audience,
          deviceValid: body.deviceId === trust.deviceId,
          surfaceValid:
            JSON.stringify(surface) === JSON.stringify(trust.surface),
        });
        operation = `sdk_validate_${kind}`;
        return value;
      },
    },
    () => trust,
    proofProvider,
  );
  const closeUnregisteredSession = async (reason: unknown) => {
    controller.abort(reason);
    for (const observation of peers) observation.peer.close();
    await Promise.allSettled(
      peerHandles.map((handle) => bridge.signaling.close(handle)),
    );
  };
  let continuation: Awaited<
    ReturnType<NativeApplicationSessionClient['exchange']>
  >;
  let accountExchangeRelayPairCount = 0;
  try {
    operation = 'account_sdk_exchange';
    continuation = await client.exchange({
      username: input.username,
      password: input.password,
    });
    console.log(
      `NATIVE_PROJECT_ACCOUNT_CHANNELS ${JSON.stringify(accountChannelObservations)}`,
    );
    operation = 'account_exchange_relay_stats';
    const exchangePeers = [...peers];
    await Promise.all(
      exchangePeers.map(async (peer) => {
        if (peer.relayTask) await peer.relayTask;
        if (peer.relayError) throw new Error(peer.relayError);
      }),
    );
    accountExchangeRelayPairCount = exchangePeers.filter(
      (peer) =>
        peer.relayPair?.local === 'relay' && peer.relayPair.remote === 'relay',
    ).length;
  } catch (error) {
    const failedOperation = operation;
    await closeUnregisteredSession(error);
    throw stagedError(error, failedOperation);
  }
  if (sessions.has(input.stateKey)) {
    await closeUnregisteredSession(
      new Error('duplicate native project session key'),
    );
    throw new Error('native_project_session_key_duplicate');
  }
  sessions.set(input.stateKey, {
    appTransport,
    client,
    continuation,
    controller,
    closePeerHandle: bridge.signaling.close.bind(bridge.signaling),
    peers,
    peerHandles,
    directProjectApiAttempts: 0,
  });
  return {
    stateKey: input.stateKey,
    hostAccountContextReady: true,
    accountExchangePeerCount: peers.length,
    accountExchangeRelayPairCount,
    accountChannelObservations: [...accountChannelObservations],
  };
}

export async function readNativeProject(input: {
  readonly stateKey: string;
  readonly stationOrigin: string;
  readonly slug: string;
}) {
  const session = sessions.get(input.stateKey);
  if (!session) throw new Error('native_project_session_missing');
  const path = `/api/projects/${encodeURIComponent(input.slug)}`;
  const peersBefore = session.peers.length;
  const handlesBefore = session.peerHandles.length;
  const headers = await session.client.headers(session.continuation, {
    method: 'GET',
    path,
  });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((request: RequestInfo | URL, init?: RequestInit) => {
    const address = request instanceof Request ? request.url : String(request);
    const target = new URL(address);
    if (
      target.origin === input.stationOrigin &&
      target.pathname === path &&
      (!init?.method || init.method === 'GET')
    ) {
      session.directProjectApiAttempts++;
      return Promise.reject(new Error('native_project_direct_http_forbidden'));
    }
    return originalFetch(request, init);
  }) as typeof fetch;
  let response: Response;
  let body: unknown;
  try {
    response = await session.appTransport.fetch(
      new URL(path, input.stationOrigin),
      { method: 'GET', headers, signal: session.controller.signal },
    );
    body = await response.json();
  } finally {
    globalThis.fetch = originalFetch;
  }
  const peer = session.peers[peersBefore];
  const peerHandle = session.peerHandles[handlesBefore];
  if (
    !peer?.handle ||
    !peerHandle ||
    peer.handle !== peerHandle ||
    session.peerHandles.length !== handlesBefore + 1
  )
    throw new Error('native_project_request_peer_missing');
  await peer.relayTask;
  if (peer.relayError) throw new Error(peer.relayError);
  const offerUsedRelayCandidate = /^a=candidate:.* typ relay/mu.test(
    peer.offerSdp ?? '',
  );
  const relayedPairObserved =
    peer.relayPair?.local === 'relay' && peer.relayPair.remote === 'relay';
  const freshPeerHandle = peer.handle !== session.lastProjectPeerHandle;
  session.lastProjectPeerHandle = peer.handle;
  const responseObject =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : {};
  const errorObject =
    typeof responseObject.error === 'object' && responseObject.error !== null
      ? (responseObject.error as Record<string, unknown>)
      : {};
  const serverErrorCode =
    typeof errorObject.code === 'string' &&
    /^[a-z0-9_.-]{1,80}$/i.test(errorObject.code)
      ? errorObject.code
      : undefined;
  return {
    status: response.status,
    containsExpectedProject: containsExpectedProject(body, input.slug),
    responseRootKeys: Object.keys(responseObject).sort(),
    serverErrorCode,
    directProjectApiAttempts: session.directProjectApiAttempts,
    relayedPairObserved,
    offerUsedRelayCandidate,
    freshPeerHandle,
  };
}

export async function closeNativeProjectSession(
  stateKey: string,
): Promise<{ closed: true }> {
  const session = sessions.get(stateKey);
  if (!session) return { closed: true };
  sessions.delete(stateKey);
  session.controller.abort(new Error('native_project_acceptance_cleanup'));
  for (const observation of session.peers) observation.peer.close();
  await Promise.allSettled(
    session.peerHandles.map((handle) => session.closePeerHandle(handle)),
  );
  return { closed: true };
}

function containsExpectedProject(value: unknown, slug: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const object = value as Record<string, unknown>;
  if (object.slug === slug) return true;
  if (object.data && typeof object.data === 'object')
    return containsExpectedProject(object.data, slug);
  if (object.project && typeof object.project === 'object')
    return containsExpectedProject(object.project, slug);
  return false;
}
