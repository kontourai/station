import {
  type ClientRequestOptions,
  continueExecutionMessage,
  getConversationHandoffStatus,
  getTurnDelivery,
  handoffExecutionMessage,
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
import type { ConversationConnection } from './ConversationConnectionContext';

/** The explicit host adapter also supports readers mounted outside the dock. */
export function createRecordConversationTransport(
  target: ConversationConnection,
) {
  if (target.station) return createConversationTransport(target.station);
  const options = () => {
    if (target.requestScope?.isCurrent?.() === false)
      throw new StationRequestAuthorityError();
    return { requestScope: target.requestScope };
  };
  return {
    continue: (
      id: string,
      input: Parameters<typeof continueExecutionMessage>[2],
    ) => continueExecutionMessage(target.apiBase, id, input, options()),
    stop: (input: Parameters<typeof interruptTurn>[1]) =>
      interruptTurn(target.apiBase, input, options()),
    recheckDelivery: (id: string, key: string) =>
      getTurnDelivery(target.apiBase, id, key, options()),
  };
}

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
    continue: (conversationId, input, options) =>
      continueExecutionMessage(
        base,
        conversationId,
        input,
        optionsFor('send', options?.signal),
      ),
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

/** The local handoff route is addressed by its original Station authority. */
export function createStagedHandoffTransport(
  apiBase: string,
  requestScope: NonNullable<ClientRequestOptions['requestScope']>,
  isCurrent: () => boolean,
) {
  const options = () => {
    if (!isCurrent() || requestScope.apiBase !== apiBase)
      throw new StationRequestAuthorityError();
    return { requestScope };
  };
  return {
    send: (
      conversationId: string,
      input: Parameters<typeof handoffExecutionMessage>[2],
    ) => handoffExecutionMessage(apiBase, conversationId, input, options()),
    read: (conversationId: string, idempotencyKey: string) =>
      getConversationHandoffStatus(
        apiBase,
        conversationId,
        idempotencyKey,
        options(),
      ),
  };
}
