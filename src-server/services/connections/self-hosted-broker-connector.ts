import type { ApprovedStationConnectionTrust } from '@kontourai/station-contracts/connection-proof';
import type { SelfHostedBrokerScopeV1 } from '@kontourai/station-contracts/self-hosted-broker';
import type {
  BrokerOffer,
  SelfHostedBrokerClient,
} from './self-hosted-broker-client.js';

export class SelfHostedBrokerConnector {
  #revision = 0;
  constructor(
    private readonly scope: SelfHostedBrokerScopeV1,
    private readonly client: SelfHostedBrokerClient,
    private readonly trust: {
      current(): ApprovedStationConnectionTrust | null;
      isCurrent(value: ApprovedStationConnectionTrust): boolean;
    },
    private readonly answer: (
      offer: BrokerOffer,
      trust: ApprovedStationConnectionTrust,
      signal: AbortSignal,
    ) => Promise<{ answerSdp: string; stationProof: string }>,
  ) {}
  async register(signal: AbortSignal) {
    await this.client.register(signal);
  }
  async renew(signal: AbortSignal) {
    const result = await this.client.renew(this.#revision, signal);
    this.#revision = result.revision;
    return result;
  }
  async poll(signal: AbortSignal) {
    const descriptor = this.trust.current();
    if (
      !descriptor ||
      descriptor.stationId !== this.scope.stationId ||
      descriptor.enrollmentId !== this.scope.enrollmentId
    )
      throw new Error('broker_connector_trust_unavailable');
    if (!this.trust.isCurrent(descriptor))
      throw new Error('broker_connector_trust_retired');
    const offers = await this.client.offers(signal);
    if (!this.trust.isCurrent(descriptor))
      throw new Error('broker_connector_trust_retired');
    let answered = 0;
    for (const offer of offers) {
      signal.throwIfAborted();
      if (!this.trust.isCurrent(descriptor))
        throw new Error('broker_connector_trust_retired');
      const result = await this.answer(offer, descriptor, signal);
      if (!this.trust.isCurrent(descriptor))
        throw new Error('broker_connector_trust_retired');
      await this.client.answer(
        { clientId: offer.clientId, nonce: offer.nonce, ...result },
        signal,
      );
      answered++;
    }
    return { observed: offers.length, answered };
  }
  async withdraw(signal: AbortSignal) {
    await this.client.withdraw(signal);
  }
}
