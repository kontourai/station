import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type {
  SelfHostedBrokerNativeClientSurfaceV2,
  SelfHostedBrokerScopeV1,
} from '@kontourai/station-contracts/self-hosted-broker';
import { stationConnectionSigningKeyId } from '@kontourai/station-shared/connection-proof';
import type {
  BrokerNativeOffer,
  BrokerOffer,
  SelfHostedBrokerClient,
} from './self-hosted-broker-client.js';
import { BrokerTransientRequestError } from './self-hosted-broker-client.js';

/** Only the read-only offer fetch may be replayed after an uncertain result. */
export class BrokerOfferReadTransientError extends Error {
  constructor(cause: unknown) {
    super('broker_offer_read_transient', { cause });
  }
}

type Answer = {
  answerSdp: string;
  stationProof: string;
  dispose: () => void | Promise<void>;
};
export interface BrokerNativeOfferAdapter {
  readonly surface: SelfHostedBrokerNativeClientSurfaceV2;
  readonly answer: (
    offer: BrokerNativeOffer,
    trust: ApprovedStationConnectionTrust,
    signal: AbortSignal,
  ) => Promise<Answer>;
}

function sameNativeSurface(
  left: SelfHostedBrokerNativeClientSurfaceV2,
  right: SelfHostedBrokerNativeClientSurfaceV2,
) {
  return (
    left.kind === right.kind &&
    left.appIdentifier === right.appIdentifier &&
    left.channel === right.channel &&
    left.clientInstanceId === right.clientInstanceId &&
    left.keyThumbprint === right.keyThumbprint
  );
}
export class SelfHostedBrokerConnector {
  #revision = 0;
  #state: 'new' | 'registered' | 'withdrawn' = 'new';
  // CONTROL lane serializes register+renew (CAS-safe); ADMISSION lane bounds
  // one poll at a time so a 32-answer poll never starves the 30s presence.
  #controlBusy = false;
  #admissionBusy = false;
  readonly #lifetime = new AbortController();
  readonly #scope: Readonly<SelfHostedBrokerScopeV1>;
  readonly #native: BrokerNativeOfferAdapter | undefined;
  constructor(
    scope: SelfHostedBrokerScopeV1,
    private readonly client: SelfHostedBrokerClient,
    private readonly trust: {
      current(): ApprovedStationConnectionTrust | null;
      isCurrent(value: ApprovedStationConnectionTrust): boolean;
    },
    private readonly answer: (
      offer: BrokerOffer,
      trust: ApprovedStationConnectionTrust,
      signal: AbortSignal,
    ) => Promise<Answer>,
    nativeOfferAdapter?: BrokerNativeOfferAdapter,
  ) {
    this.#scope = Object.freeze(structuredClone(scope));
    this.#native = nativeOfferAdapter
      ? Object.freeze({
          surface: Object.freeze(structuredClone(nativeOfferAdapter.surface)),
          answer: nativeOfferAdapter.answer,
        })
      : undefined;
  }
  #notWithdrawn() {
    if (this.#state === 'withdrawn')
      throw new Error('broker_connector_withdrawn');
  }
  #active() {
    if (this.#state !== 'registered')
      throw new Error(
        this.#state === 'withdrawn'
          ? 'broker_connector_withdrawn'
          : 'broker_connector_not_registered',
      );
  }
  async #runControl<T>(
    caller: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    this.#notWithdrawn();
    if (this.#controlBusy) throw new Error('broker_connector_busy');
    this.#controlBusy = true;
    try {
      return await operation(AbortSignal.any([caller, this.#lifetime.signal]));
    } finally {
      this.#controlBusy = false;
    }
  }
  async #runAdmission<T>(
    caller: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    this.#notWithdrawn();
    if (this.#admissionBusy) throw new Error('broker_connector_busy');
    this.#admissionBusy = true;
    try {
      return await operation(AbortSignal.any([caller, this.#lifetime.signal]));
    } finally {
      this.#admissionBusy = false;
    }
  }
  async register(signal: AbortSignal) {
    return this.#runControl(signal, async (current) => {
      current.throwIfAborted();
      const result = await this.client.register(current);
      current.throwIfAborted();
      this.#revision = result.revision;
      this.#state = 'registered';
      return result;
    });
  }
  async renew(signal: AbortSignal) {
    return this.#runControl(signal, async (current) => {
      this.#active();
      const result = await this.client.renew(this.#revision, current);
      current.throwIfAborted();
      this.#revision = result.revision;
      return result;
    });
  }
  async #dispose(result: Answer) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(() => result.dispose()),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('broker_connector_cleanup_timeout')),
            2_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async poll(signal: AbortSignal) {
    return this.#runAdmission(signal, async (currentSignal) => {
      this.#active();
      const descriptor = this.trust.current();
      if (
        !descriptor ||
        descriptor.stationId !== this.#scope.stationId ||
        descriptor.enrollmentId !== this.#scope.enrollmentId
      )
        throw new Error('broker_connector_trust_unavailable');
      const current = () => {
        currentSignal.throwIfAborted();
        if (!this.trust.isCurrent(descriptor))
          throw new Error('broker_connector_trust_retired');
      };
      current();
      let observed = 0,
        answered = 0;
      while (observed < 32) {
        let offers: BrokerOffer[];
        try {
          offers = await this.client.offers(currentSignal);
        } catch (error) {
          if (error instanceof BrokerTransientRequestError)
            throw new BrokerOfferReadTransientError(error);
          throw error;
        }
        current();
        if (!offers.length) break;
        const offer = offers[0]!;
        observed++;
        const result = await this.answer(offer, descriptor, currentSignal);
        try {
          current();
          await this.client.answer(
            {
              clientId: offer.clientId,
              nonce: offer.nonce,
              answerSdp: result.answerSdp,
              stationProof: result.stationProof,
            },
            currentSignal,
          );
          current();
        } catch (error) {
          await this.#dispose(result);
          throw error;
        }
        answered++;
      }
      return { observed, answered };
    });
  }
  /** Explicit native-v2 lane; the legacy `poll()` callback never sees it. */
  async pollNative(signal: AbortSignal) {
    const native = this.#native;
    if (!native)
      throw new Error('broker_connector_native_offer_opt_in_required');
    return this.#runAdmission(signal, async (currentSignal) => {
      this.#active();
      const descriptor = this.trust.current();
      if (
        !descriptor ||
        descriptor.stationId !== this.#scope.stationId ||
        descriptor.enrollmentId !== this.#scope.enrollmentId
      )
        throw new Error('broker_connector_trust_unavailable');
      const current = () => {
        currentSignal.throwIfAborted();
        if (!this.trust.isCurrent(descriptor))
          throw new Error('broker_connector_trust_retired');
      };
      current();
      let observed = 0;
      let answered = 0;
      while (observed < 32) {
        let offers: BrokerNativeOffer[];
        try {
          offers = await this.client.nativeOffers(
            native.surface,
            currentSignal,
          );
        } catch (error) {
          if (error instanceof BrokerTransientRequestError)
            throw new BrokerOfferReadTransientError(error);
          throw error;
        }
        current();
        if (offers.length === 0) break;
        const offer = offers[0]!;
        observed++;
        if (
          offer.version !== 'station-broker-native-connection-offer/v2' ||
          offer.scope.stationId !== this.#scope.stationId ||
          offer.scope.enrollmentId !== this.#scope.enrollmentId ||
          offer.scope.routingGeneration !== this.#scope.routingGeneration ||
          !sameNativeSurface(offer.surface, native.surface) ||
          offer.clientId !== native.surface.clientInstanceId
        )
          throw new Error('broker_connector_native_surface_mismatch');
        const stationSigningKeyId =
          await stationConnectionSigningKeyId(descriptor);
        current();
        if (
          offer.stationSigningKeyId !== stationSigningKeyId ||
          offer.stationSigningGeneration !== descriptor.generation
        )
          throw new Error('broker_connector_native_station_binding_mismatch');
        const result = await native.answer(offer, descriptor, currentSignal);
        try {
          current();
          await this.client.answerNative(
            {
              surface: native.surface,
              clientId: offer.clientId,
              nonce: offer.nonce,
              stationSigningKeyId: offer.stationSigningKeyId,
              stationSigningGeneration: offer.stationSigningGeneration,
              answerSdp: result.answerSdp,
              stationProof: result.stationProof,
            },
            currentSignal,
          );
          current();
        } catch (error) {
          await this.#dispose(result);
          throw error;
        }
        answered++;
      }
      return { observed, answered };
    });
  }
  async withdraw(signal: AbortSignal) {
    // Idempotent compensating withdrawal: allowed from new (lost register
    // reply) or registered; retires local admission immediately so late
    // results cannot revive state. Never queues behind lane flags.
    if (this.#state === 'withdrawn') {
      signal.throwIfAborted();
      await this.client.withdraw(signal);
      signal.throwIfAborted();
      return;
    }
    if (this.#state !== 'registered') {
      // Compensating withdrawal after a lost register reply: still attempt
      // the remote withdraw, then retire locally even if it fails (the
      // caller preserves the cleanup failure).
      this.#state = 'withdrawn';
      this.#lifetime.abort(new Error('broker_connector_withdrawn'));
      signal.throwIfAborted();
      try {
        await this.client.withdraw(signal);
        signal.throwIfAborted();
      } catch (error) {
        signal.throwIfAborted();
        throw error;
      }
      return;
    }
    this.#state = 'withdrawn';
    this.#lifetime.abort(new Error('broker_connector_withdrawn'));
    signal.throwIfAborted();
    await this.client.withdraw(signal);
    signal.throwIfAborted();
  }
}
