/**
 * Canonical delegation fetchers (#977 Wave 2), inside the #167 DRY client
 * layer. Zero delegation fetchers existed on the portable client before this
 * file — the two already-wired routes (`POST /delegations`,
 * `POST /delegations/options`) had only a UI-facing, React-Query-wrapped
 * caller (`packages/sdk/src/query-domains/chatRuntimeOrchestration.ts`) that
 * hand-rolls its own envelope-unwrap instead of a canonical `client/**`
 * fetcher; the other six routes had no HTTP exposure at all before #977
 * Wave 1.
 *
 * Routes (`src-server/routes/orchestration/orchestration.ts`):
 * - `POST /api/orchestration/delegations` — `delegateTask`
 * - `POST /api/orchestration/delegations/options` — `discoverDelegationOptions`
 *   (already wired before #977; no new server route needed for this one)
 * - `GET /api/orchestration/delegations` — `listDelegatedTasks`
 * - `GET /api/orchestration/delegations/:taskId` — `observeDelegatedTask`
 * - `GET /api/orchestration/delegations/:taskId/events` — `observeDelegatedTaskEvents`
 * - `POST /api/orchestration/delegations/:taskId/continue` — `continueDelegatedTask`
 * - `POST /api/orchestration/delegations/:taskId/respond` — `respondToDelegatedTaskRequest`
 * - `POST /api/orchestration/delegations/:taskId/interrupt` — `interruptDelegatedTask`
 *
 * Every interface below is declared locally rather than imported from
 * `src-server/tools/station-control-delegation.ts` (SDK package boundary) —
 * the same precedent `client/orchestration.ts`'s `SessionFlowRunView` already
 * documents: "Declared locally rather than imported from server-side types
 * (SDK package boundary)".
 *
 * `--after=<cursor>` is the opaque `nextCursor` string a previous
 * `observeDelegatedTaskEvents` page returned (`station-task-events:v1:<n>`),
 * never a raw integer — the server's `parseTaskEventCursor` rejects a bare
 * sequence number.
 *
 * Parses the response body before checking `response.ok` (parse-then-check,
 * the #167 iteration-2 H1 convention documented in `client/runs.ts`'s
 * `unwrapRunsResponse` and mirrored by `client/orchestration.ts`'s
 * `unwrapOrchestrationResponse`), so a non-2xx `{success:false,error}` body's
 * `error` text is preserved. Implemented locally rather than importing
 * `orchestration.ts`'s (unexported) `unwrapOrchestrationResponse` — this
 * file's every fetcher uses the same bare `{success,data,error}` envelope
 * shape, so a local one-function copy keeps this module independently
 * readable without exporting a helper whose only other imaginable caller is
 * this same file.
 */

import type { AgentId } from '@kontourai/station-contracts/agent-identity';
import type {
  ExecutionResolutionReceipt,
  ExecutionTarget,
} from '@kontourai/station-contracts/execution-target';
import { apiErrorMessage } from './api-error-message';
import { type ClientRequestOptions, getJson, mutateJson } from './http';
import type { ApprovalDecision } from './orchestration';

interface DelegationEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  retryable?: boolean;
}

/** A delegated engine-start refusal with a stable machine-readable cause. */
export class DelegationApiError extends Error {
  constructor(
    message: string,
    readonly code?: string,
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = 'DelegationApiError';
  }
}

async function unwrapDelegationResponse<T>(response: Response): Promise<T> {
  let result: DelegationEnvelope<T> | null = null;
  try {
    result = (await response.json()) as DelegationEnvelope<T>;
  } catch {
    throw new Error(`Delegation API error: ${response.status}`);
  }
  if (!response.ok || !result.success) {
    throw new DelegationApiError(
      apiErrorMessage(result, `Delegation API error: ${response.status}`),
      result.code,
      result.retryable,
    );
  }
  return result.data as T;
}

/**
 * Conversation/session identity was added after the original task-shaped
 * delegation API. A controller can still reach an older Station, so normalize
 * at this SDK boundary instead of letting every CLI caller render `undefined`
 * or independently guess how task identity maps to a Conversation.
 */
function normalizeDelegationIdentity<T>(data: T): T {
  const record = data as {
    taskId: string;
    conversationId?: string;
    sessionId?: string;
    currentSessionId?: string;
  };
  // The parsed response is locally owned after unwrap. Mutating its absent
  // additive aliases avoids another response-sized object on every call.
  record.conversationId ||= record.taskId;
  record.currentSessionId ||= record.sessionId ||= record.taskId;
  return data;
}

function delegationQuery(
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}

export type DelegationTargetKind = 'agent';

export type DelegationTarget = { kind: 'agent'; id: AgentId };

export interface DelegatedTaskEnvironment {
  id: string;
  name: string;
  kind: 'current' | 'ssh' | 'peer';
}

export interface DelegateTaskInput {
  /**
   * The entire authored request contract. Conversation/session identifiers
   * are server-produced handle fields, never caller-selected routing input.
   */
  prompt: string;
  target: ExecutionTarget;
  parentTaskId?: string;
}

function delegationRequestProjection(
  input: DelegateTaskInput,
): DelegateTaskInput {
  return {
    prompt: input.prompt,
    target: input.target,
    ...(input.parentTaskId === undefined
      ? {}
      : { parentTaskId: input.parentTaskId }),
  };
}

/**
 * station#1463: how `slug` came to name the project the work lands in.
 * Slugs are locally generated, so a cross-machine name match is a
 * coincidence rather than proof of identity, and it is disclosed rather than
 * assumed correct. #1425's portable manifest `id` retires the whole field.
 *
 * - `local` — the target is this Station, so the slug IS the local identity.
 * - `directory-corroborated` — a REMOTE target whose project working
 *   directory is byte-equal to the operator-verified project path for that
 *   environment. Corroborates the DIRECTORY only: two projects can be
 *   configured on one directory (station#1462), so it is disclosed, not
 *   treated as verification.
 * - `unverified-cross-machine` — a remote target matched by project *name*
 *   only.
 *
 * Absent means the record predates this field, not `local`.
 */
export type DelegationProjectSlugJoin =
  | 'local'
  | 'directory-corroborated'
  | 'unverified-cross-machine';

export interface DelegatedTaskHandle {
  /**
   * Durable identity for follow-up turns. `taskId` remains the legacy alias
   * for callers that already persisted it. Both it and every session field
   * below are produced by the server; callers cannot provide them on create.
   */
  conversationId: string;
  taskId: string;
  /** Active child Session selected for this dispatch. */
  sessionId: string;
  /** Explicit current-child spelling; equal to `sessionId` for 1:1 history. */
  currentSessionId: string;
  status: 'dispatched';
  environment: DelegatedTaskEnvironment;
  project?: {
    slug?: string;
    path: string;
    slugJoin?: DelegationProjectSlugJoin;
  };
  target: DelegationTarget;
  resolution?: ExecutionResolutionReceipt;
  model?: string;
  parentTaskId?: string;
}

/**
 * `POST /api/orchestration/delegations` — dispatch a Task through an exact
 * Agent target. Engine/provider binding is resolved by the selected Station.
 */
export async function delegateTask(
  apiBase: string,
  input: DelegateTaskInput,
  opts?: ClientRequestOptions,
): Promise<DelegatedTaskHandle> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/delegations`,
    'POST',
    opts,
    delegationRequestProjection(input),
  );
  return normalizeDelegationIdentity(
    await unwrapDelegationResponse<DelegatedTaskHandle>(response),
  );
}

export interface DiscoverDelegationOptionsInput {
  environmentId?: string;
  projectSlug?: string;
  projectPath?: string;
}

export interface DelegationTargetOption {
  id: AgentId;
  name: string;
  description?: string;
  kind: 'agent';
  ready: boolean;
  unavailableReason?: string;
  defaultModel?: string;
  models: Array<{ id: string; name: string; originalId: string }>;
  capabilities: {
    resume: boolean;
    interrupt: boolean;
    approvals: boolean;
    modelSelection: boolean;
  };
}

export interface DelegationOptions {
  environment: DelegatedTaskEnvironment;
  project?: { slug?: string; slugJoin?: DelegationProjectSlugJoin };
  targets: DelegationTargetOption[];
}

/**
 * `POST /api/orchestration/delegations/options` — discover ready Station
 * agents and External agents for one environment/project. Already wired
 * before #977 (finding #7); this is the missing SDK client fetcher.
 */
export async function discoverDelegationOptions(
  apiBase: string,
  input: DiscoverDelegationOptionsInput,
  opts?: ClientRequestOptions,
): Promise<DelegationOptions> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/delegations/options`,
    'POST',
    opts,
    input,
  );
  return unwrapDelegationResponse<DelegationOptions>(response);
}

export interface DelegatedTaskReferenceInput {
  environmentId?: string;
}

export interface DelegatedTaskPendingRequest {
  id: string;
  title?: string;
  type?: string;
}

export interface DelegatedTaskSnapshot {
  /** Durable identity accepted by `station delegate --session=<id>`. */
  conversationId: string;
  /** Compatibility alias for legacy task-oriented callers. */
  taskId: string;
  /** Current child Session being supervised. */
  sessionId: string;
  currentSessionId: string;
  status:
    | 'queued'
    | 'running'
    | 'needs_input'
    | 'review_pending'
    | 'blocked'
    | 'completed'
    | 'failed'
    | 'canceled'
    | 'unknown';
  environment: DelegatedTaskEnvironment;
  target: DelegationTarget;
  provider?: string;
  model?: string;
  projectSlug?: string;
  parentTaskId?: string;
  eventCount: number;
  lastEvent?: { method: string; createdAt?: string };
  pendingRequest?: DelegatedTaskPendingRequest;
  canInterrupt: boolean;
  resumable: boolean;
}

/**
 * `GET /api/orchestration/delegations/:taskId` — one secret-minimized
 * delegated task snapshot.
 */
export async function observeDelegatedTask(
  apiBase: string,
  taskId: string,
  input?: DelegatedTaskReferenceInput,
  opts?: ClientRequestOptions,
): Promise<DelegatedTaskSnapshot> {
  const query = delegationQuery({ environmentId: input?.environmentId });
  const response = await getJson(
    `${apiBase}/api/orchestration/delegations/${encodeURIComponent(taskId)}${query}`,
    opts,
  );
  return normalizeDelegationIdentity(
    await unwrapDelegationResponse<DelegatedTaskSnapshot>(response),
  );
}

export interface DelegatedTaskEventsInput {
  environmentId?: string;
  /**
   * The opaque `nextCursor` string returned by a previous page
   * (`station-task-events:v1:<n>`) — never a raw sequence number.
   */
  cursor?: string;
  limit?: number;
}

export interface DelegatedTaskEvent {
  sequence: number;
  eventId?: string;
  method: string;
  kind:
    | 'lifecycle'
    | 'message'
    | 'activity'
    | 'tool'
    | 'request'
    | 'runtime'
    | 'usage'
    | 'gate'
    | 'plan';
  createdAt?: string;
  turnId?: string;
  text?: string;
  truncated?: true;
  toolName?: string;
  status?: string;
  requestId?: string;
  requestType?: string;
  title?: string;
  progress?: number;
  state?: string;
  previousState?: string;
  severity?: 'error' | 'warning';
  retriable?: boolean;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  verdict?: string;
  gateId?: string;
  runId?: string;
  phase?: string;
  counts?: Record<string, number>;
}

export interface DelegatedTaskEventPage {
  conversationId: string;
  taskId: string;
  sessionId: string;
  currentSessionId: string;
  status: DelegatedTaskSnapshot['status'];
  environment: DelegatedTaskEnvironment;
  target: DelegationTarget;
  provider?: string;
  model?: string;
  eventCount: number;
  events: DelegatedTaskEvent[];
  nextCursor: string;
  hasMore: boolean;
  canInterrupt: boolean;
  resumable: boolean;
}

/**
 * `GET /api/orchestration/delegations/:taskId/events` — one bounded page of
 * secret-minimized task activity, resumable via `nextCursor`.
 */
export async function observeDelegatedTaskEvents(
  apiBase: string,
  taskId: string,
  input?: DelegatedTaskEventsInput,
  opts?: ClientRequestOptions,
): Promise<DelegatedTaskEventPage> {
  const query = delegationQuery({
    environmentId: input?.environmentId,
    cursor: input?.cursor,
    limit: input?.limit,
  });
  const response = await getJson(
    `${apiBase}/api/orchestration/delegations/${encodeURIComponent(taskId)}/events${query}`,
    opts,
  );
  return normalizeDelegationIdentity(
    await unwrapDelegationResponse<DelegatedTaskEventPage>(response),
  );
}

export interface ContinueDelegatedTaskInput
  extends DelegatedTaskReferenceInput {
  message: string;
  model?: string;
  /** station#978: per-invocation settings passthrough on a follow-up turn. */
  modelOptions?: Record<string, unknown>;
}

export interface DelegatedTaskFollowUpHandle {
  conversationId: string;
  taskId: string;
  sessionId: string;
  currentSessionId: string;
  status: 'dispatched';
  environment: DelegatedTaskEnvironment;
  target: DelegationTarget;
  model?: string;
}

/**
 * `POST /api/orchestration/delegations/:taskId/continue` — send one
 * follow-up turn through the task's persisted environment/target binding.
 */
export async function continueDelegatedTask(
  apiBase: string,
  taskId: string,
  input: ContinueDelegatedTaskInput,
  opts?: ClientRequestOptions,
): Promise<DelegatedTaskFollowUpHandle> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/delegations/${encodeURIComponent(taskId)}/continue`,
    'POST',
    opts,
    input,
  );
  return normalizeDelegationIdentity(
    await unwrapDelegationResponse<DelegatedTaskFollowUpHandle>(response),
  );
}

export interface RespondToDelegatedTaskRequestInput
  extends DelegatedTaskReferenceInput {
  requestId: string;
  decision: ApprovalDecision;
}

export interface DelegatedTaskRequestResponseHandle {
  conversationId: string;
  taskId: string;
  sessionId: string;
  currentSessionId: string;
  requestId: string;
  status: 'resolved';
  decision: ApprovalDecision;
  environment: DelegatedTaskEnvironment;
  target: DelegationTarget;
}

/**
 * `POST /api/orchestration/delegations/:taskId/respond` — resolve one
 * currently open provider request through the task's binding.
 */
export async function respondToDelegatedTaskRequest(
  apiBase: string,
  taskId: string,
  input: RespondToDelegatedTaskRequestInput,
  opts?: ClientRequestOptions,
): Promise<DelegatedTaskRequestResponseHandle> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/delegations/${encodeURIComponent(taskId)}/respond`,
    'POST',
    opts,
    input,
  );
  return normalizeDelegationIdentity(
    await unwrapDelegationResponse<DelegatedTaskRequestResponseHandle>(
      response,
    ),
  );
}

export interface InterruptDelegatedTaskInput
  extends DelegatedTaskReferenceInput {
  turnId?: string;
}

export type DelegatedTaskInterruptResult = DelegatedTaskSnapshot & {
  interruptRequested: true;
};

/**
 * `POST /api/orchestration/delegations/:taskId/interrupt` — stop the active
 * turn while keeping the task resumable. The server-side handler validates
 * an empty JSON object body, so this always sends `{}` at minimum.
 */
export async function interruptDelegatedTask(
  apiBase: string,
  taskId: string,
  input?: InterruptDelegatedTaskInput,
  opts?: ClientRequestOptions,
): Promise<DelegatedTaskInterruptResult> {
  const response = await mutateJson(
    `${apiBase}/api/orchestration/delegations/${encodeURIComponent(taskId)}/interrupt`,
    'POST',
    opts,
    input ?? {},
  );
  return normalizeDelegationIdentity(
    await unwrapDelegationResponse<DelegatedTaskInterruptResult>(response),
  );
}

export interface DelegatedTaskListInput {
  environmentId?: string;
  limit?: number;
}

export type DelegatedTaskListItem = Omit<
  DelegatedTaskSnapshot,
  'pendingRequest'
>;

export interface DelegatedTaskInventory {
  environment: DelegatedTaskEnvironment;
  tasks: DelegatedTaskListItem[];
  truncated: boolean;
}

/**
 * `GET /api/orchestration/delegations` — recover compact resumable task
 * handles for one environment without replaying task history.
 */
export async function listDelegatedTasks(
  apiBase: string,
  input?: DelegatedTaskListInput,
  opts?: ClientRequestOptions,
): Promise<DelegatedTaskInventory> {
  const query = delegationQuery({
    environmentId: input?.environmentId,
    limit: input?.limit,
  });
  const response = await getJson(
    `${apiBase}/api/orchestration/delegations${query}`,
    opts,
  );
  const inventory =
    await unwrapDelegationResponse<DelegatedTaskInventory>(response);
  inventory.tasks = inventory.tasks.map(normalizeDelegationIdentity);
  return inventory;
}
