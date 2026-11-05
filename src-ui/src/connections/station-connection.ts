import type { AuthorityObservation } from '@kontourai/station-contracts/authority-observation';
import type {
  ApiRequestScope,
  ClientRequestOptions,
  continueExecutionMessage,
  getTurnDelivery,
  inspectAttentionRequest,
  interruptTurn,
  respondToRequest,
  sendExecutionMessageWithInventory,
  steerTurn,
} from '@kontourai/station-sdk/client';

export interface ChatStationBindingV1 {
  version: 1;
  environmentId: string;
  stationName: string;
  affinity:
    | { kind: 'host' }
    | { kind: 'device'; connectionId: string; principalNamespace: string }
    | {
        kind: 'peer';
        sourceEnvironmentId: string;
        sourceConnectionId: string;
        principalNamespace: string;
      };
}

export type ConversationCapabilityReason =
  | 'authority-unavailable'
  | 'permission-required'
  | 'direct-connection-required'
  | 'protocol-unavailable'
  | 'broker-read-only';

export type ConversationCapabilityDecision =
  | { state: 'allowed' }
  | { state: 'denied' | 'unknown'; reason: ConversationCapabilityReason };

export const CONVERSATION_CAPABILITIES = [
  'historyRead',
  'liveEvents',
  'contentRead',
  'attachmentRead',
  'send',
  'startChat',
  'steer',
  'stop',
  'queue',
  'deliveryLookup',
  'approvalAnswer',
  'approvalInspect',
  'approvalTrustTool',
  'approvalTrustServer',
  'inputAnswer',
  'attachments',
  'modelSelect',
  'agentSelect',
  'projectSelect',
  'mentions',
  'skills',
  'folderSelect',
  'fullAccess',
  'checkpointRead',
  'checkpointRestore',
  'continue',
  'fork',
  'childInstruction',
  'sharedHistoryRead',
  'offlineRead',
  'replay',
  'personalDefaults',
  'uiBlockActions',
] as const;

export type ConversationCapabilities = Readonly<
  Record<
    (typeof CONVERSATION_CAPABILITIES)[number],
    ConversationCapabilityDecision
  >
>;

/** A connection ceiling; request-specific permissions may only narrow it. */
export function conversationCapabilitiesFromAuthority(
  observation: AuthorityObservation,
  options: { remote: boolean; mutationAllowed: boolean },
): ConversationCapabilities {
  const scopes =
    observation.grant.kind === 'device'
      ? observation.grant.grantedScopes
      : null;
  const canWrite = !scopes || scopes.includes('orchestration:operate');
  const canRead = canWrite || scopes?.includes('orchestration:read');
  const reads = new Set<string>([
    'historyRead',
    'liveEvents',
    'contentRead',
    'attachmentRead',
    'deliveryLookup',
    'approvalInspect',
    'checkpointRead',
    'sharedHistoryRead',
  ]);
  const localOnly = new Set<string>([
    'mentions',
    'skills',
    'offlineRead',
    'replay',
    'personalDefaults',
  ]);
  const decide = (
    name: keyof ConversationCapabilities,
  ): ConversationCapabilityDecision =>
    name === 'fullAccess' && scopes && !scopes.includes('approval:full-access')
      ? { state: 'denied', reason: 'permission-required' }
      : options.remote && localOnly.has(name)
        ? { state: 'denied', reason: 'protocol-unavailable' }
        : !options.mutationAllowed
          ? {
              state: 'denied',
              reason: reads.has(name)
                ? 'protocol-unavailable'
                : 'broker-read-only',
            }
          : (reads.has(name) ? canRead : canWrite)
            ? { state: 'allowed' }
            : { state: 'denied', reason: 'permission-required' };
  return {
    historyRead: decide('historyRead'),
    liveEvents: decide('liveEvents'),
    contentRead: decide('contentRead'),
    attachmentRead: decide('attachmentRead'),
    send: decide('send'),
    startChat: decide('startChat'),
    steer: decide('steer'),
    stop: decide('stop'),
    queue: decide('queue'),
    deliveryLookup: decide('deliveryLookup'),
    approvalAnswer: decide('approvalAnswer'),
    approvalInspect: decide('approvalInspect'),
    approvalTrustTool: decide('approvalTrustTool'),
    approvalTrustServer: decide('approvalTrustServer'),
    inputAnswer: decide('inputAnswer'),
    attachments: decide('attachments'),
    modelSelect: decide('modelSelect'),
    agentSelect: decide('agentSelect'),
    projectSelect: decide('projectSelect'),
    mentions: decide('mentions'),
    skills: decide('skills'),
    folderSelect: decide('folderSelect'),
    fullAccess: decide('fullAccess'),
    checkpointRead: decide('checkpointRead'),
    checkpointRestore: decide('checkpointRestore'),
    continue: decide('continue'),
    fork: decide('fork'),
    childInstruction: decide('childInstruction'),
    sharedHistoryRead: decide('sharedHistoryRead'),
    offlineRead: decide('offlineRead'),
    replay: decide('replay'),
    personalDefaults: decide('personalDefaults'),
    uiBlockActions: decide('uiBlockActions'),
  };
}

export function effectiveConversationCapability(
  ceiling: ConversationCapabilityDecision,
  request: ConversationCapabilityDecision,
): ConversationCapabilityDecision {
  return ceiling.state === 'allowed' ? request : ceiling;
}

export type ConversationCallOptions = Pick<ClientRequestOptions, 'signal'>;

/** Bound by the shared conversation adapter; callers never provide a base/scope. */
export interface ConversationTransport {
  continue(
    conversationId: string,
    input: Parameters<typeof continueExecutionMessage>[2],
    options?: ConversationCallOptions,
  ): ReturnType<typeof continueExecutionMessage>;
  send(
    input: Parameters<typeof sendExecutionMessageWithInventory>[1],
    inventory: Parameters<typeof sendExecutionMessageWithInventory>[2],
    options?: ConversationCallOptions,
  ): ReturnType<typeof sendExecutionMessageWithInventory>;
  stop(
    input: Parameters<typeof interruptTurn>[1],
    options?: ConversationCallOptions,
  ): ReturnType<typeof interruptTurn>;
  answer(
    input: Parameters<typeof respondToRequest>[1],
    options?: ConversationCallOptions,
  ): ReturnType<typeof respondToRequest>;
  inspectApproval(
    input: Parameters<typeof inspectAttentionRequest>[1],
    options?: ConversationCallOptions,
  ): ReturnType<typeof inspectAttentionRequest>;
  steer(
    input: Parameters<typeof steerTurn>[1],
    options?: ConversationCallOptions,
  ): ReturnType<typeof steerTurn>;
  recheckDelivery(
    conversationId: string,
    clientTurnId: string,
    options?: ConversationCallOptions,
  ): ReturnType<typeof getTurnDelivery>;
}

export interface StationConnection {
  readonly environmentId: string;
  readonly stationName: string;
  readonly stationKey: string;
  readonly routeKind: 'host' | 'direct' | 'relay';
  readonly targetApiBase: string;
  readonly requestScope: Readonly<ApiRequestScope>;
  readonly authorityNamespace: string;
  readonly runtimeKey: string;
  readonly binding: ChatStationBindingV1;
  readonly capabilities: ConversationCapabilities;
  isCurrent(): boolean;
}

export function stationConnectionKey(
  sourceNamespace: string,
  environmentId: string,
): string {
  return JSON.stringify([sourceNamespace, environmentId]);
}

export function stationConnectionRuntimeKey(
  targetApiBase: string,
  authorityKey: string,
  generation: string,
): string {
  return JSON.stringify([targetApiBase, authorityKey, generation]);
}
