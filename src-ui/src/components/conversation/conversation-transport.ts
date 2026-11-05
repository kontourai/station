import {
  getTurnDelivery,
  inspectAttentionRequest,
  interruptTurn,
  respondToRequest,
  StationRequestAuthorityError,
  sendExecutionMessageWithInventory,
  steerTurn,
} from '@kontourai/station-sdk/client';
import type {
  ConversationCapabilities,
  ConversationTransport,
  StationConnection,
} from '../../connections/station-connection';

/** Bind route, credentials and currency once; no caller can retarget an action. */
export function createConversationTransport(
  connection: StationConnection,
): ConversationTransport {
  const optionsFor = (
    capability: keyof ConversationCapabilities,
    signal?: AbortSignal,
  ) => {
    if (
      !connection.isCurrent() ||
      connection.capabilities[capability].state !== 'allowed'
    )
      throw new StationRequestAuthorityError();
    return { signal, requestScope: connection.requestScope };
  };
  const base = connection.targetApiBase;
  return {
    send: (input, inventory, options) =>
      sendExecutionMessageWithInventory(
        base,
        input,
        inventory,
        optionsFor('send', options?.signal),
      ),
    stop: (input, options) =>
      interruptTurn(base, input, optionsFor('stop', options?.signal)),
    answer: (input, options) =>
      respondToRequest(
        base,
        input,
        optionsFor('approvalAnswer', options?.signal),
      ),
    inspectApproval: (input, options) =>
      inspectAttentionRequest(
        base,
        input,
        optionsFor('approvalInspect', options?.signal),
      ),
    steer: (input, options) =>
      steerTurn(base, input, optionsFor('steer', options?.signal)),
    recheckDelivery: (conversationId, key, options) =>
      getTurnDelivery(
        base,
        conversationId,
        key,
        optionsFor('deliveryLookup', options?.signal),
      ),
  };
}
