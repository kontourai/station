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
  composeOwnedSignal,
  delayBrowserTransport,
  raceOwnedLifetime,
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
  applicationChannelLabel?: string;
  trustRecord: DeviceConnectionTrustRecord;
  trustStore: BrowserConnectionTrustStore;
  ice: BrowserIceProvider;
  createPeer?: (configuration: RTCConfiguration) => RTCPeerConnection;
  now?: () => number;
}) {
  const applicationOrigin = new URL(input.applicationOrigin).origin;
  const channelLabel =
    input.applicationChannelLabel ?? 'station-application-v1';
  if (
    applicationOrigin !== input.applicationOrigin ||
    !channelLabel ||
    channelLabel.length > 128
  )
    throw new Error('browser_transport_configuration_invalid');
  // Freeze scalar/provider references and credential snapshots at construction.
  const broker = input.broker;
  const trustStore = input.trustStore;
  const iceProvider = input.ice;
  const trustRecord = structuredClone(input.trustRecord);
  const trust = copyStationConnectionTrust(trustRecord.trust);
  const brokerStationId = broker.scope.stationId;
  const brokerEnrollmentId = broker.scope.enrollmentId;
  if (
    trustRecord.status !== 'approved' ||
    trust.stationId !== brokerStationId ||
    trust.enrollmentId !== brokerEnrollmentId
  )
    throw new Error('browser_transport_trust_invalid');
  const createPeer =
    input.createPeer ??
    ((configuration: RTCConfiguration) => new RTCPeerConnection(configuration));
  const now = input.now ?? Date.now;
  let generation = 0;
  let attemptController: AbortController | null = null;
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
    generation += 1;
    // Abort the owned per-attempt lifetime: pending offer/digest/trust/broker
    // waits race this signal and the caller returns promptly.
    attemptController?.abort(new Error('browser_transport_stale'));
    attemptController = null;
    if (!current) return;
    current.alive = false;
    try {
      current.peer.close();
    } catch {
      /* already closed */
    }
    current = undefined;
  };
  const snapshotCurrent = async (snapshot: BrowserPionConnectionSnapshot) => {
    const owner = current;
    if (
      !owner?.alive ||
      owner.snapshot !== snapshot ||
      !owner.ice.isCurrent() ||
      owner.peer.connectionState !== 'connected'
    )
      return false;
    const trusted = await trustStore.isCurrent(trustRecord);
    // Recheck ICE + peer state AFTER the async trust hop too.
    if (
      !trusted ||
      current !== owner ||
      !owner.alive ||
      owner.snapshot !== snapshot ||
      !owner.ice.isCurrent() ||
      owner.peer.connectionState !== 'connected'
    )
      return false;
    return true;
  };

  const connect = async (signal: AbortSignal) => {
    closeCurrent();
    signal.throwIfAborted();
    // Per-attempt owned lifetime linked with caller + 30s deadline.
    const owned = new AbortController();
    attemptController = owned;
    const onCaller = () => owned.abort(signal.reason ?? new Error('cancelled'));
    signal.addEventListener('abort', onCaller, { once: true });
    const deadline = setTimeout(
      () => owned.abort(new Error('browser_transport_timeout')),
      30_000,
    );
    const lifetime = owned.signal;
    const disposeAttempt = (stale: boolean) => {
      clearTimeout(deadline);
      signal.removeEventListener('abort', onCaller);
      if (!stale && attemptController === owned) attemptController = null;
    };
    const attemptGeneration = ++generation;
    const isOwned = () =>
      attemptController === owned && attemptGeneration === generation;
    const assertGrantBinding = () => {
      const assertion = broker.assertCredentialBoundToTrust;
      // Direct broker stubs are the legacy fixture/lab path. Production
      // routing grants always expose the binding guard through the client.
      return typeof assertion === 'function'
        ? assertion.call(broker, trustRecord)
        : Promise.resolve(undefined);
    };
    let peer: RTCPeerConnection | undefined;
    try {
      const trustedAtStart = await raceOwnedLifetime(
        trustStore.isCurrent(trustRecord),
        lifetime,
      );
      if (!trustedAtStart) throw new Error('browser_transport_trust_retired');
      const grantBoundAtStart = await raceOwnedLifetime(
        assertGrantBinding(),
        lifetime,
      );
      if (grantBoundAtStart === false)
        throw new Error('browser_transport_grant_trust_retired');
      const ice = iceProvider.capture();
      if (!ice.isCurrent()) throw new Error('browser_ice_configuration_stale');
      const iceAtCapture = ice;
      const created = createPeer(cloneIce(ice.configuration));
      peer = created;
      const retire = () => {
        try {
          created.close();
        } catch {
          /* already closed */
        }
      };
      const onRetire = () => retire();
      lifetime.addEventListener('abort', onRetire, { once: true });
      try {
        const bootstrap = created.createDataChannel(channelLabel, {
          ordered: true,
        });
        try {
          // Offer first; gathering wait is owned by this attempt.
          const offer = await raceOwnedLifetime(
            created.createOffer(),
            lifetime,
          );
          await raceOwnedLifetime(created.setLocalDescription(offer), lifetime);
          if (!isOwned()) throw new Error('browser_transport_stale');
          // Always await the owned wait; gathering handler only finishes on
          // complete. connectionstatechange never fails on connecting/connected.
          const gathering = waitFor(lifetime, (finish, fail) => {
            const onGathering = () => {
              if (created.iceGatheringState === 'complete') finish();
            };
            const onState = () => {
              if (created.connectionState === 'failed') fail();
            };
            created.addEventListener('icegatheringstatechange', onGathering);
            created.addEventListener('connectionstatechange', onState);
            onGathering();
            onState();
            return () => {
              created.removeEventListener(
                'icegatheringstatechange',
                onGathering,
              );
              created.removeEventListener('connectionstatechange', onState);
            };
          });
          await gathering;
          if (!created.localDescription || !isOwned() || !ice.isCurrent())
            throw new Error('browser_offer_unavailable');
          const offerSdp = created.localDescription.sdp;
          // Connection proof nonces require secure-context Web Crypto.
          // Refuse unsupported clients before submitting an offer.
          const connectionId = globalThis.crypto?.randomUUID?.();
          if (!connectionId)
            throw new Error('browser_relay_secure_context_required');
          const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
          // A grant is bound to the Station's independently approved signing
          // key and generation. Re-read trust immediately before spending the
          // routing credential, then compare the grant after that async hop.
          if (
            !(await raceOwnedLifetime(
              trustStore.isCurrent(trustRecord),
              lifetime,
            ))
          )
            throw new Error('browser_transport_trust_retired');
          const grantBound = await raceOwnedLifetime(
            assertGrantBinding(),
            lifetime,
          );
          if (grantBound === false)
            throw new Error('browser_transport_grant_trust_retired');
          const opened = await raceOwnedLifetime(
            broker.open({ clientId: connectionId, nonce, offerSdp }, lifetime),
            lifetime,
          );
          let answer:
            | Extract<BrokerBrowserAnswer, { kind: 'answered' }>
            | undefined;
          while (!answer) {
            if (!isOwned() || !ice.isCurrent())
              throw new Error('browser_transport_stale');
            if (
              !(await raceOwnedLifetime(
                trustStore.isCurrent(trustRecord),
                lifetime,
              ))
            )
              throw new Error('browser_transport_trust_retired');
            if (!isOwned()) throw new Error('browser_transport_stale');
            const grantStillBound = await raceOwnedLifetime(
              assertGrantBinding(),
              lifetime,
            );
            if (grantStillBound === false)
              throw new Error('browser_transport_grant_trust_retired');
            const value = await raceOwnedLifetime(
              broker.read({ clientId: connectionId, nonce }, lifetime),
              lifetime,
            );
            if (value.expiresAt !== opened.expiresAt)
              throw new Error('broker_response_invalid');
            if (value.kind === 'answered') answer = value;
            else {
              if (now() + 100 >= opened.expiresAt)
                throw new Error('broker_answer_expired');
              const composed = composeOwnedSignal(lifetime, 5_000);
              try {
                await delayBrowserTransport(composed.signal, 100);
              } finally {
                composed.dispose();
              }
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
            offerSha256: await raceOwnedLifetime(
              connectionDescriptionDigest(offerSdp),
              lifetime,
            ),
            answerSha256: await raceOwnedLifetime(
              connectionDescriptionDigest(answer.answerSdp),
              lifetime,
            ),
          };
          if (!isOwned() || !ice.isCurrent())
            throw new Error('browser_transport_stale');
          if (
            !(await raceOwnedLifetime(
              trustStore.isCurrent(trustRecord),
              lifetime,
            ))
          )
            throw new Error('browser_transport_trust_retired');
          let proofCurrent = true;
          const verifier = createStationConnectionProofVerifier({
            trust,
            expected: binding,
            isCurrent: () => proofCurrent && isOwned() && ice.isCurrent(),
          });
          await raceOwnedLifetime(
            verifier.verifyAndConsume(answer.stationProof),
            lifetime,
          );
          if (
            !(await raceOwnedLifetime(
              trustStore.isCurrent(trustRecord),
              lifetime,
            ))
          )
            throw new Error('browser_transport_trust_retired');
          verifier.assertStillCurrent();
          if (!isOwned() || !ice.isCurrent())
            throw new Error('browser_transport_stale');
          await raceOwnedLifetime(
            created.setRemoteDescription({
              type: 'answer',
              sdp: answer.answerSdp,
            }),
            lifetime,
          );
          if (
            !(await raceOwnedLifetime(
              trustStore.isCurrent(trustRecord),
              lifetime,
            )) ||
            !ice.isCurrent()
          )
            throw new Error('browser_transport_authority_retired');
          verifier.assertStillCurrent();
          if (!isOwned()) throw new Error('browser_transport_stale');
          await waitFor(lifetime, (finish, fail) => {
            const changed = () => {
              if (created.connectionState === 'connected') finish();
              else if (['failed', 'closed'].includes(created.connectionState))
                fail();
            };
            created.addEventListener('connectionstatechange', changed);
            changed();
            return () =>
              created.removeEventListener('connectionstatechange', changed);
          });
          await waitFor(lifetime, (finish, fail) => {
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
          if (!isOwned() || !iceAtCapture.isCurrent())
            throw new Error('browser_transport_stale');
          if (
            !(await raceOwnedLifetime(
              trustStore.isCurrent(trustRecord),
              lifetime,
            ))
          )
            throw new Error('browser_transport_trust_retired');
          const snapshot = Object.freeze({
            generation: attemptGeneration,
            connectionId,
            stationId: trust.stationId,
            applicationOrigin,
          });
          if (!isOwned()) {
            retire();
            throw new Error('browser_transport_stale');
          }
          current = {
            snapshot,
            peer: created,
            ice,
            alive: true,
            openChannels: 0,
          };
          peer = undefined;
          disposeAttempt(false);
          return snapshot;
        } catch (error) {
          try {
            bootstrap.close();
          } catch {
            /* already closed */
          }
          throw error;
        }
      } finally {
        lifetime.removeEventListener('abort', onRetire);
      }
    } catch (error) {
      if (peer) {
        try {
          peer.close();
        } catch {
          /* already closed */
        }
      }
      disposeAttempt(true);
      throw error;
    }
  };

  const openApplicationChannel = async (
    snapshot: BrowserPionConnectionSnapshot,
    signal: AbortSignal,
  ): Promise<ApplicationChannel> => {
    const owner = current;
    if (!owner || owner.snapshot !== snapshot || !owner.alive)
      throw new Error('browser_transport_stale');
    if (owner.openChannels >= MAX_OPEN_CHANNELS)
      throw new Error('browser_transport_channel_cap');
    // Whole reservation-through-open wrapped in try/finally; release once only.
    owner.openChannels += 1;
    let reserved = true;
    const release = () => {
      if (!reserved) return;
      reserved = false;
      owner.openChannels -= 1;
    };
    let channel: RTCDataChannel | undefined;
    let published = false;
    try {
      if (!(await snapshotCurrent(snapshot)))
        throw new Error('browser_transport_stale');
      const ownerNow = current;
      if (ownerNow !== owner || !owner.alive)
        throw new Error('browser_transport_stale');
      // createDataChannel itself can throw — still inside try so the
      // reservation is released and no channel leaks.
      channel = owner.peer.createDataChannel(channelLabel, {
        ordered: true,
      });
      channel.addEventListener('close', release, { once: true });
      channel.addEventListener('error', release, { once: true });
      await waitFor(signal, (finish, fail) => {
        const ready = () => finish();
        channel!.addEventListener('open', ready);
        channel!.addEventListener('close', fail);
        channel!.addEventListener('error', fail);
        if (channel!.readyState === 'open') finish();
        return () => {
          channel!.removeEventListener('open', ready);
          channel!.removeEventListener('close', fail);
          channel!.removeEventListener('error', fail);
        };
      });
      if (!(await snapshotCurrent(snapshot)))
        throw new Error('browser_transport_stale');
      const leased = channel;
      // Reservation converts to an open lease: the close/error listeners own
      // the single release from here on; finally must not double-release.
      published = true;
      return browserApplicationChannel(leased as unknown as RTCDataChannel);
    } catch (error) {
      if (channel) {
        try {
          channel.close();
        } catch {
          /* already closed */
        }
      }
      throw error;
    } finally {
      if (!published) release();
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
