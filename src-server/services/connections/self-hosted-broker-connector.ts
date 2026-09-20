import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import type {
  BrokerOffer,
  SelfHostedBrokerClient,
} from './self-hosted-broker-client.js';

type Answer = {
  answerSdp: string;
  stationProof: string;
  dispose?: () => void | Promise<void>;
};
export class SelfHostedBrokerConnector {
  #revision = 0;
  #state: 'new' | 'registered' | 'withdrawn' = 'new';
  #tail: Promise<void> = Promise.resolve();
  readonly #scope: Readonly<SelfHostedBrokerScopeV1>;
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
  ) {
    this.#scope = Object.freeze(structuredClone(scope));
  }
  #run<T>(operation: () => Promise<T>) {
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  #active() {
    if (this.#state !== 'registered')
      throw new Error(
        this.#state === 'withdrawn'
          ? 'broker_connector_withdrawn'
          : 'broker_connector_not_registered',
      );
  }
  async register(signal: AbortSignal) {
    return this.#run(async () => {
      if (this.#state === 'withdrawn')
        throw new Error('broker_connector_withdrawn');
      signal.throwIfAborted();
      const result = await this.client.register(signal);
      signal.throwIfAborted();
      this.#revision = result.revision;
      this.#state = 'registered';
      return result;
    });
  }
  async renew(signal: AbortSignal) {
    return this.#run(async () => {
      this.#active();
      signal.throwIfAborted();
      const result = await this.client.renew(this.#revision, signal);
      signal.throwIfAborted();
      this.#revision = result.revision;
      return result;
    });
  }
  async poll(signal: AbortSignal) {
    return this.#run(async () => {
      this.#active();
      const descriptor = this.trust.current();
      if (
        !descriptor ||
        descriptor.stationId !== this.#scope.stationId ||
        descriptor.enrollmentId !== this.#scope.enrollmentId
      )
        throw new Error('broker_connector_trust_unavailable');
      const current = () => {
        signal.throwIfAborted();
        if (!this.trust.isCurrent(descriptor))
          throw new Error('broker_connector_trust_retired');
      };
      current();
      let observed = 0;
      let answered = 0;
      while (observed < 32) {
        const offers = await this.client.offers(signal);
        current();
        if (offers.length === 0) break;
        const offer = offers[0]!;
        observed++;
        const result = await this.answer(offer, descriptor, signal);
        try {
          current();
          await this.client.answer(
            {
              clientId: offer.clientId,
              nonce: offer.nonce,
              answerSdp: result.answerSdp,
              stationProof: result.stationProof,
            },
            signal,
          );
        } catch (error) {
          await result.dispose?.();
          throw error;
        }
        current();
        answered++;
      }
      return { observed, answered };
    });
  }
  async withdraw(signal: AbortSignal) {
    return this.#run(async () => {
      this.#active();
      signal.throwIfAborted();
      await this.client.withdraw(signal);
      signal.throwIfAborted();
      this.#state = 'withdrawn';
    });
  }
}
