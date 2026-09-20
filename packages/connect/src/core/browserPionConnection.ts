import type {
  DeviceConnectionTrustRecord,
  StationConnectionProofBinding,
} from '@kontourai/station-contracts/connection-proof';
import {
  connectionDescriptionDigest,
  copyStationConnectionTrust,
  createStationConnectionProofVerifier,
} from '@kontourai/station-shared/connection-proof';
import {
  type ApplicationChannel,
  browserApplicationChannel,
} from './applicationChannel.js';
import {
  delayBrowserTransport,
  waitForBrowserTransport as waitFor,
} from './browserTransportWait.js';
import {
  type BrokerBrowserAnswer,
  SelfHostedBrokerBrowserClient,
} from './selfHostedBrokerBrowserClient.js';

const MAX_OPEN_CHANNELS = 32;
const FINGERPRINT = /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/;

export interface BrowserConnectionTrustStore {
  isCurrent(record: DeviceConnectionTrustRecord): Promise<boolean>;
}
export interface BrowserIceSnapshot {
  readonly configuration: RTCConfiguration;
  isCurrent(): boolean;
}
export interface BrowserIceProvider {
  capture(): BrowserIceSnapshot;
}
export interface BrowserPionConnectionSnapshot {
  readonly generation: number;
  readonly connectionId: string;
  readonly stationId: string;
  readonly applicationOrigin: string;
}

function base64url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
function fingerprints(sdp: string) {
  const values = [...sdp.matchAll(/^a=fingerprint:sha-256 (.+)$/gm)].map(
    (match) => match[1]!.trim(),
  );
  if (
    !values.length ||
    values.some((value) => !FINGERPRINT.test(value)) ||
    values.some((value) => value !== values[0])
  )
    throw new Error('station_fingerprint_invalid');
  return values[0]!;
}
function cloneIce(value: RTCConfiguration): RTCConfiguration {
  return structuredClone(value);
}

export function createBrowserPionConnection(input: {
  broker: SelfHostedBrokerBrowserClient;
  applicationOrigin: string;
  applicationChannelLabel: string;
  trustRecord: DeviceConnectionTrustRecord;
  trustStore: BrowserConnectionTrustStore;
  ice: BrowserIceProvider;
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  now?: () => number;
}) {
  const applicationOrigin = new URL(input.applicationOrigin).origin;
  if (
    applicationOrigin !== input.applicationOrigin ||
    !input.applicationChannelLabel ||
    input.applicationChannelLabel.length > 128
  )
    throw new Error('browser_transport_configuration_invalid');
  const trustRecord = structuredClone(input.trustRecord);
  const trust = copyStationConnectionTrust(trustRecord.trust);
  if (
    trustRecord.status !== 'approved' ||
    trust.stationId !== input.broker.scope.stationId ||
    trust.enrollmentId !== input.broker.scope.enrollmentId
  )
    throw new Error('browser_transport_trust_invalid');
  const createPeer =
    input.createPeer ??
    ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const now = input.now ?? Date.now;
  let generation = 0;
  let current:
    | {
        snapshot: BrowserPionConnectionSnapshot;
        peer: RTCPeerConnection;
        ice: BrowserIceSnapshot;
        alive: boolean;
        openChannels: number;
      }
    | undefined;

  const closeCurrent = () => {
    if (!current) return;
    current.alive = false;
    current.peer.close();
    current = undefined;
  };
  const snapshotCurrent = async (snapshot: BrowserPionConnectionSnapshot) => {
    const owner = current;
    return Boolean(
      owner?.alive &&
        owner.snapshot === snapshot &&
        owner.ice.isCurrent() &&
        owner.peer.connectionState === 'connected' &&
        (await input.trustStore.isCurrent(trustRecord)),
    );
  };

  const connect = async (signal: AbortSignal) => {
    closeCurrent();
    signal.throwIfAborted();
    const ice = input.ice.capture();
    if (!ice.isCurrent()) throw new Error('browser_ice_configuration_stale');
    const peer = createPeer(cloneIce(ice.configuration));
    const attemptGeneration = ++generation;
    let alive = true;
    const retire = () => {
      alive = false;
      peer.close();
    };
    const combined = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
    const bootstrap = peer.createDataChannel(input.applicationChannelLabel, {
      ordered: true,
    });
    try {
      const gathering = waitFor(combined, (finish, fail) => {
        const changed = () => {
          if (peer.iceGatheringState === 'complete') finish();
        };
        peer.addEventListener('icegatheringstatechange', changed);
        peer.addEventListener('connectionstatechange', fail);
        return () => {
          peer.removeEventListener('icegatheringstatechange', changed);
          peer.removeEventListener('connectionstatechange', fail);
        };
      });
      await peer.setLocalDescription(await peer.createOffer());
      if (peer.iceGatheringState !== 'complete') await gathering;
      if (!peer.localDescription || !alive || !ice.isCurrent())
        throw new Error('browser_offer_unavailable');
      const offerSdp = peer.localDescription.sdp;
      const connectionId = crypto.randomUUID();
      const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
      const opened = await input.broker.open(
        { clientId: connectionId, nonce, offerSdp },
        combined,
      );
      let answer:
        | Extract<BrokerBrowserAnswer, { kind: 'answered' }>
        | undefined;
      while (!answer) {
        if (!alive || !ice.isCurrent())
          throw new Error('browser_transport_stale');
        if (!(await input.trustStore.isCurrent(trustRecord)))
          throw new Error('browser_transport_trust_retired');
        const value = await input.broker.read(
          { clientId: connectionId, nonce },
          combined,
        );
        if (value.expiresAt !== opened.expiresAt)
          throw new Error('broker_response_invalid');
        if (value.kind === 'answered') answer = value;
        else {
          if (now() + 100 >= opened.expiresAt)
            throw new Error('broker_answer_expired');
          await delayBrowserTransport(combined, 100);
        }
      }
      const binding: StationConnectionProofBinding = {
        stationId: trust.stationId,
        enrollmentId: trust.enrollmentId,
        generation: trust.generation,
        connectionId,
        clientNonce: nonce,
        clientFingerprint: fingerprints(offerSdp),
        stationFingerprint: fingerprints(answer.answerSdp),
        offerSha256: await connectionDescriptionDigest(offerSdp),
        answerSha256: await connectionDescriptionDigest(answer.answerSdp),
      };
      let proofCurrent = true;
      const verifier = createStationConnectionProofVerifier({
        trust,
        expected: binding,
        isCurrent: () =>
          proofCurrent &&
          alive &&
          ice.isCurrent() &&
          attemptGeneration === generation,
      });
      await verifier.verifyAndConsume(answer.stationProof);
      if (!(await input.trustStore.isCurrent(trustRecord)))
        throw new Error('browser_transport_trust_retired');
      verifier.assertStillCurrent();
      await peer.setRemoteDescription({
        type: 'answer',
        sdp: answer.answerSdp,
      });
      if (!(await input.trustStore.isCurrent(trustRecord)) || !ice.isCurrent())
        throw new Error('browser_transport_authority_retired');
      verifier.assertStillCurrent();
      await waitFor(combined, (finish, fail) => {
        const changed = () => {
          if (peer.connectionState === 'connected') finish();
          else if (['failed', 'closed'].includes(peer.connectionState)) fail();
        };
        peer.addEventListener('connectionstatechange', changed);
        changed();
        return () => peer.removeEventListener('connectionstatechange', changed);
      });
      await waitFor(combined, (finish, fail) => {
        const openedChannel = () => finish();
        bootstrap.addEventListener('open', openedChannel);
        bootstrap.addEventListener('close', fail);
        bootstrap.addEventListener('error', fail);
        if (bootstrap.readyState === 'open') finish();
        return () => {
          bootstrap.removeEventListener('open', openedChannel);
          bootstrap.removeEventListener('close', fail);
          bootstrap.removeEventListener('error', fail);
        };
      });
      bootstrap.close();
      proofCurrent = false;
      const snapshot = Object.freeze({
        generation: attemptGeneration,
        connectionId,
        stationId: trust.stationId,
        applicationOrigin,
      });
      current = { snapshot, peer, ice, alive: true, openChannels: 0 };
      return snapshot;
    } catch (error) {
      retire();
      throw error;
    }
  };

  const openApplicationChannel = async (
    snapshot: BrowserPionConnectionSnapshot,
    signal: AbortSignal,
  ): Promise<ApplicationChannel> => {
    const owner = current;
    if (
      !owner ||
      owner.snapshot !== snapshot ||
      !(await snapshotCurrent(snapshot)) ||
      owner.openChannels >= MAX_OPEN_CHANNELS
    )
      throw new Error('browser_transport_stale');
    const channel = owner.peer.createDataChannel(
      input.applicationChannelLabel,
      {
        ordered: true,
      },
    );
    owner.openChannels += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      owner.openChannels -= 1;
    };
    channel.addEventListener('close', release, { once: true });
    channel.addEventListener('error', release, { once: true });
    try {
      await waitFor(signal, (finish, fail) => {
        const ready = () => finish();
        channel.addEventListener('open', ready);
        channel.addEventListener('close', fail);
        channel.addEventListener('error', fail);
        if (channel.readyState === 'open') finish();
        return () => {
          channel.removeEventListener('open', ready);
          channel.removeEventListener('close', fail);
          channel.removeEventListener('error', fail);
        };
      });
      if (!(await snapshotCurrent(snapshot)))
        throw new Error('browser_transport_stale');
      return browserApplicationChannel(channel);
    } catch (error) {
      release();
      channel.close();
      throw error;
    }
  };

  return Object.freeze({
    connect,
    reconnect: connect,
    close: closeCurrent,
    isCurrent: snapshotCurrent,
    openApplicationChannel,
  });
}
