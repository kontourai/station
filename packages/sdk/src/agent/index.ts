/**
 * Headless Agent authoring and execution. Operations retain their canonical
 * client implementation, explicit apiBase, and per-call authority options.
 * Plug-in UI stays on the SDK root and owning UI subpaths; see ADR 0021.
 */
export type {
  AgentExecutionConfig,
  AgentSpec,
} from '@kontourai/station-contracts/agent';
export {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';
export type { EnrichedAgentProjection } from '@kontourai/station-contracts/enriched-agent';
export {
  type EnvironmentId,
  type EnvironmentRef,
  type ExecutionModelRequest,
  type ExecutionResolutionReceipt,
  type ExecutionTarget,
  environmentId,
  type WorkspaceTarget,
} from '@kontourai/station-contracts/execution-target';
export type {
  SessionOutputInspection,
  SessionOutputItem,
  SessionOutputsPage,
} from '@kontourai/station-contracts/session-outputs';
export {
  type AgentCatalogProjection,
  type AgentCreateResult,
  type AgentResponseError,
  createAgentDetailed,
  deleteAgentRaw,
  fetchAgentCatalog,
  getAgent,
  updateAgentRaw,
} from '../client/agents';
export { ChatHttpError } from '../client/chatHttpError';
export {
  type ContinueDelegatedTaskInput,
  continueDelegatedTask,
  type DelegatedCapabilityDelivery,
  type DelegatedTaskDecision,
  type DelegatedTaskEnvironment,
  type DelegatedTaskEvent,
  type DelegatedTaskEventPage,
  type DelegatedTaskEventsInput,
  type DelegatedTaskFollowUpHandle,
  type DelegatedTaskHandle,
  type DelegatedTaskInterruptResult,
  type DelegatedTaskInventory,
  type DelegatedTaskListInput,
  type DelegatedTaskPendingRequest,
  type DelegatedTaskReferenceInput,
  type DelegatedTaskRequestResponseHandle,
  type DelegatedTaskSnapshot,
  type DelegateTaskInput,
  DelegationApiError,
  type DelegationAttemptView,
  type DelegationOptions,
  type DelegationTargetOption,
  type DiscoverDelegationOptionsInput,
  delegateTask,
  discoverDelegationOptions,
  type InterruptDelegatedTaskInput,
  interruptDelegatedTask,
  listDelegatedTasks,
  lookupDelegationAttempt,
  observeDelegatedTask,
  observeDelegatedTaskEvents,
  type RespondToDelegatedTaskRequestInput,
  respondToDelegatedTaskRequest,
} from '../client/delegations';
export {
  type ContinueForegroundMessageInput,
  type ConversationHandoffReceipt,
  continueExecutionMessage,
  ForegroundMessageIndeterminateError,
  type ForegroundMessageInput,
  type ForegroundMessageReceipt,
  getConversationHandoffStatus,
  handoffExecutionMessage,
} from '../client/execution';
export {
  type ApiRequestScope,
  type ClientRequestOptions,
  StationCredentialConflictError,
  StationHttpError,
  StationReadOnlyError,
  StationRequestAuthorityError,
  StationRequestTimeoutError,
} from '../client/http';
export {
  type ApprovalDecision,
  getOrchestrationConversationEventWindow,
  getOrchestrationSession,
  getOrchestrationSessionEventPage,
  getOrchestrationSessionEventWindow,
  interruptTurn,
  type RespondToRequestInput,
  type RespondToRequestResult,
  respondToRequest,
} from '../client/orchestration';
export { sendExecutionMessage } from '../client/send-execution-message';
export {
  inspectSessionOutput,
  listSessionOutputs,
  SessionOutputsRequestError,
} from '../client/session-outputs';
