import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import type {
  BrokerOffer,
  SelfHostedBrokerClient,
} from './self-hosted-broker-client.js';

type Answer = {
  answerSdp: string;
  stationProof: string;
  dispose: () => void | Promise<void>;
};
export class SelfHostedBrokerConnector {
  #revision = 0;
  #state: 'new' | 'registered' | 'withdrawn' = 'new';
  #busy = false;
  readonly #lifetime = new AbortController();
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
  async #run<T>(
    caller: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ) {
    this.#notWithdrawn();
    if (this.#busy) throw new Error('broker_connector_busy');
    this.#busy = true;
    try {
      return await operation(AbortSignal.any([caller, this.#lifetime.signal]));
    } finally {
      this.#busy = false;
    }
  }
  async register(signal: AbortSignal) {
    return this.#run(signal, async (current) => {
      current.throwIfAborted();
      const result = await this.client.register(current);
      current.throwIfAborted();
      this.#revision = result.revision;
      this.#state = 'registered';
      return result;
    });
  }
  async renew(signal: AbortSignal) {
    return this.#run(signal, async (current) => {
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
    return this.#run(signal, async (currentSignal) => {
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
        const offers = await this.client.offers(currentSignal);
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
  async withdraw(signal: AbortSignal) {
    this.#active();
    this.#state = 'withdrawn';
    this.#lifetime.abort(new Error('broker_connector_withdrawn'));
    signal.throwIfAborted();
    await this.client.withdraw(signal);
    signal.throwIfAborted();
  }
}
