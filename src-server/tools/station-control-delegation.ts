import { randomUUID } from 'node:crypto';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import {
  type AgentId,
  agentId,
} from '@kontourai/station-contracts/agent-identity';
import type {
  EnvironmentRef,
  ExecutionModelRequest,
  ExecutionResolutionReceipt,
  ExecutionTarget,
  WorkspaceTarget,
} from '@kontourai/station-contracts/execution-target';
import { environmentId } from '@kontourai/station-contracts/execution-target';
import {
  FOREGROUND_MESSAGE_INDETERMINATE_CODE,
  type ForegroundMessageIndeterminate,
  normalizeRequestAnswerability,
  type RequestAnswerability,
} from '@kontourai/station-contracts/orchestration';
import type { PrincipalRef } from '@kontourai/station-contracts/principal';
import {
  type ProviderKind,
  SESSION_VISIBILITY_METADATA_KEY,
} from '@kontourai/station-contracts/provider';
import {
  isSessionLifecycleState,
  isSessionLifecycleStateStopped,
} from '@kontourai/station-contracts/session-lifecycle';
import {
  type SessionReadAuthority,
  sessionReadAuthorityFromRequest,
} from '@kontourai/station-contracts/tenancy';
import type {
  AgentConnectionView,
  ConnectionConfig,
  ModelOption,
} from '@kontourai/station-contracts/tool';
import {
  type ApprovalDecision,
  getAgent,
  getOrchestrationSession,
  getOrchestrationSessionEventPage,
  getProject,
  interruptTurn,
  listOrchestrationSessions,
  respondToRequest,
} from '@kontourai/station-sdk/client';
import { isHostedTenantExecutionRequired } from '../runtime/bootstrap/runtime-tenant-context.js';
import {
  createConversationHandoffIntent,
  executeForegroundMessage as executeResolvedForegroundMessage,
  type ForegroundMessageHandle,
  ForegroundMessageIndeterminateError,
  type ForegroundMessageInput,
  ForegroundMessageTurnIdentityUnavailableError,
} from '../services/execution-target/execution-target-execution.js';
import {
  type EnvironmentAccess,
  type ExecutionTargetAgentView,
  matchVerifiedRemoteProjectPath,
  resolveExecutionTarget,
} from '../services/execution-target/execution-target-resolver.js';
import type { OrchestrationService } from '../services/orchestration/orchestration-service.js';
import {
  delegatedTaskFollowUps,
  delegatedTaskInterrupts,
  delegatedTaskRequestResponses,
  delegatedTasks,
} from '../telemetry/metrics.js';
import {
  controlRequestOptions,
  resolveControlApiBase,
} from './station-control-shared.js';

interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: string;
  code?: string;
  outcome?: unknown;
  receipt?: unknown;
  receiptStatus?: unknown;
  session?: unknown;
}

interface StationHandshake {
  environmentId: string;
}

interface SshEnvironmentView {
  profile: {
    id: string;
    name: string;
    environmentId: string | null;
    remoteHome: string | null;
    verifiedProjectPath: string | null;
  };
  state: {
    phase: string;
    localUrl?: string;
    action?: string;
  };
}

/**
 * station#1123 slice 2: `'peer'` is a directly-reachable Station this
 * process has an outbound bearer credential for (`PeerCredentialStore`),
 * resolved alongside — never in place of — the SSH tunnel path. A `'peer'`
 * target's `requestOptions` always carries an `Authorization: Bearer`
 * header — that is the entire point of this kind existing.
 *
 * station#1123 slice 3: a `'ssh'` target's `requestOptions` now ALSO carries
 * that same `Authorization: Bearer` header when a peer credential happens to
 * be provisioned for the same `environmentId` — see `connectSshTarget`. This
 * is what lets SSH-tunneled peers satisfy the credential requirement in
 * `runtime-http.ts`. `requestOptions` stays unset for an `'ssh'` target with
 * no peer credential provisioned, so protected requests fail loudly with the
 * remote runtime's `401 authentication_required` rather than receiving an
 * address-derived exception.
 */
interface DelegationTarget {
  apiBase: string;
  environmentId: string;
  environmentName: string;
  kind: 'current' | 'ssh' | 'peer';
  projectPath?: string;
  remoteHome?: string;
  /**
   * Widened from `ReturnType<typeof controlRequestOptions>` (which is only
   * the internal-token header pair) so a `'peer'` target can carry an
   * `Authorization: Bearer` header instead — every caller already treats
   * this as an opaque `{ headers }` bag passed straight to
   * `@kontourai/station-sdk/client` fetchers.
   */
  requestOptions?: { headers: Record<string, string> };
}

interface DelegationEnvironmentSelection {
  environmentId?: string;
  projectSlug?: string;
  projectPath?: string;
}

export interface DelegateTaskInput {
  prompt: string;
  target: ExecutionTarget;
  sessionId?: string;
  parentTaskId?: string;
  delegation?: AgentDelegationContext;
  userId?: string;
  /** Trusted request authority supplied only by runtime composition. */
  readAuthority?: SessionReadAuthority;
}

type AuthorityBearingForegroundMessageInput = ForegroundMessageInput & {
  /** Trusted request authority supplied only by runtime composition. */
  readAuthority?: SessionReadAuthority;
};

/**
 * How a `projectSlug` came to name the project the work lands in
 * (station#1463 — see `resolveProject`'s docblock for the full reasoning).
 *
 * - `local` — the target is this Station, so the slug IS the local identity.
 * - `directory-corroborated` — a remote target whose project working
 *   directory is BYTE-EQUAL to the operator-verified project path for that
 *   environment.
 * - `unverified-cross-machine` — a remote target matched by project *name*
 *   only. Slugs are locally generated, so this is a name collision away from
 *   landing the work in a different project than the caller meant. It is
 *   recorded rather than assumed correct, and it is not identity.
 *
 * station#1463 fix round — two corrections to the first cut, which called
 * this `path-verified` and treated it as reason to record NOTHING:
 *
 * 1. `connectSshTarget` throws unless `profile.verifiedProjectPath` exists,
 *    so every SSH delegation arrived here with a `projectPath` and every SSH
 *    delegation was therefore "verified". The disclosure #1463 exists to
 *    make only ever fired for peer targets — the entire SSH population, the
 *    one that is cross-machine by construction, was exempted from it.
 * 2. The corroboration is weaker than "verified" claims. It proves a
 *    DIRECTORY, not a project: #1462 is the standing proof that two projects
 *    can be configured on one directory, so the remote `getProject(slug)`
 *    may have returned either of them, and the session then runs under a
 *    project scope the caller could not verify. The project paths are remote
 *    values, so local realpath, filesystem probes, and case-folding cannot
 *    establish their identity. Instead, SSH verification captures the remote
 *    home and the shared comparator expands `~/` there before comparing
 *    normalized POSIX strings exactly. A missing legacy `remoteHome` fails
 *    closed; reported symlink aliases intentionally remain mismatches.
 *
 * So: corroboration is now byte-equality only, it is named for what it
 * proves, and it is RECORDED rather than treated as silence. All three
 * values are stamped (#189 slice 4's idiom), so an absent value means
 * "recorded before this branch" and nothing else.
 */
export type DelegationProjectSlugJoin =
  | 'local'
  | 'directory-corroborated'
  | 'unverified-cross-machine';

interface ResolvedDelegationProject {
  slug?: string;
  path: string;
  slugJoin?: DelegationProjectSlugJoin;
}

export interface DelegatedTaskHandle {
  /** Durable conversation identity; `taskId` is the legacy compatibility alias. */
  conversationId: string;
  taskId: string;
  /** The child Session started for this dispatch. */
  sessionId: string;
  /** Explicit name for the Session currently selected by this Conversation. */
  currentSessionId: string;
  status: 'dispatched';
  environment: {
    id: string;
    name: string;
    kind: 'current' | 'ssh' | 'peer';
  };
  project?: {
    slug?: string;
    path: string;
    slugJoin?: DelegationProjectSlugJoin;
  };
  target: { kind: 'agent'; id: AgentId };
  resolution: ExecutionResolutionReceipt;
  model?: string;
  parentTaskId?: string;
}

export interface DelegationTargetOption {
  id: string;
  name: string;
  description?: string;
  kind: 'agent';
  ready: boolean;
  unavailableReason?: string;
  defaultModel?: string;
  models: ModelOption[];
  capabilities: {
    resume: boolean;
    interrupt: boolean;
    approvals: boolean;
    modelSelection: boolean;
  };
}

export interface DelegationOptions {
  environment: {
    id: string;
    name: string;
    kind: 'current' | 'ssh' | 'peer';
  };
  project?: { slug?: string; slugJoin?: DelegationProjectSlugJoin };
  targets: DelegationTargetOption[];
}

export interface DelegationEnvironmentOption {
  id: string;
  name: string;
  kind: 'current' | 'ssh' | 'peer';
  ready: boolean;
  connected: boolean;
  unavailableReason?: string;
}

export interface DelegationEnvironments {
  environments: DelegationEnvironmentOption[];
}

interface DelegationAgentView {
  slug: string;
  name: string;
  description?: string;
  model?: string;
  execution?: {
    agentConnectionId?: string;
    modelId?: string | null;
    runtimeOptions?: Record<string, unknown>;
  };
  modelOptions?: ModelOption[] | null;
  available?: boolean;
  unavailableReason?: string;
}

export interface DelegatedTaskReferenceInput {
  taskId: string;
  environmentId?: string;
  userId?: string;
  /** Trusted request authority supplied only by runtime composition. */
  readAuthority?: SessionReadAuthority;
}

export interface DelegatedTaskEventsInput extends DelegatedTaskReferenceInput {
  cursor?: string;
  limit?: number;
}

export interface ContinueDelegatedTaskInput
  extends DelegatedTaskReferenceInput {
  message: string;
  model?: string;
  /** station#978: per-invocation settings passthrough on a follow-up turn. */
  modelOptions?: Record<string, unknown>;
}

export interface RespondToDelegatedTaskRequestInput
  extends DelegatedTaskReferenceInput {
  requestId: string;
  decision: ApprovalDecision;
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
  environment: DelegatedTaskSnapshot['environment'];
  target: DelegatedTaskSnapshot['target'];
  provider?: string;
  model?: string;
  eventCount: number;
  events: DelegatedTaskEvent[];
  nextCursor: string;
  hasMore: boolean;
  canInterrupt: boolean;
  /** Derived from `status`, exactly as on `DelegatedTaskSnapshot`. */
  resumable: boolean;
}

/**
 * station#3409: no `resumable` here, and none on the dispatch or
 * request-response handles either. These describe an accepted WRITE at the
 * instant it was accepted; none of them reads back a lifecycle state, so
 * none of them can derive whether a LATER turn would be accepted. The three
 * carried a literal `true` that outlived the window it described. A caller
 * that needs the answer reads it off `observeDelegatedTask`, where it is
 * computed.
 */
export interface DelegatedTaskFollowUpHandle {
  conversationId: string;
  taskId: string;
  sessionId: string;
  currentSessionId: string;
  status: 'dispatched';
  environment: DelegatedTaskSnapshot['environment'];
  target: DelegatedTaskSnapshot['target'];
  model?: string;
}

export interface DelegatedTaskRequestResponseHandle {
  conversationId: string;
  taskId: string;
  sessionId: string;
  currentSessionId: string;
  requestId: string;
  status: 'resolved';
  decision: ApprovalDecision;
  environment: DelegatedTaskSnapshot['environment'];
  target: DelegatedTaskSnapshot['target'];
}

export interface DelegatedTaskSnapshot {
  /** Durable selector for continuation; `taskId` is retained for compatibility. */
  conversationId: string;
  taskId: string;
  /** The current child Session. */
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
  environment: {
    id: string;
    name: string;
    kind: 'current' | 'ssh' | 'peer';
  };
  target: { kind: 'agent'; id: string };
  provider?: string;
  model?: string;
  projectSlug?: string;
  parentTaskId?: string;
  eventCount: number;
  lastEvent?: { method: string; createdAt?: string };
  pendingRequest?: {
    id: string;
    title?: string;
    type?: string;
    /**
     * station#1783 (ADR 0012 residual). This tool is an HTTP client to a
     * TARGET environment's Station, and the delegating agent reads this
     * snapshot as a statement about that Station. Reporting an open request
     * with no qualification told the agent to wait on an answer that
     * environment can no longer produce — the same defect the UI surfaces
     * had, arriving through a tool result instead of a screen.
     *
     * Structured passthrough, not prose: the consumer here is an agent, so
     * it gets the observation object (`qualification`/`observedBy`/
     * `observedAt`) verbatim off the target's own response, normalized at
     * this boundary because the response is parsed, not validated. Absent
     * only when the target returned no session for the task.
     */
    answerability?: RequestAnswerability;
  };
  canInterrupt: boolean;
  /**
   * Whether another turn would be ACCEPTED for this task right now — derived
   * from `status`, never asserted (station#3409).
   *
   * It was the literal `true` on every handle this module returns, including
   * a `canceled` task whose `delegate continue` refuses. An agent reading the
   * JSON saw `status: "canceled", resumable: true` and branched on it; the
   * field beside it, `canInterrupt`, had been derived from `status` all
   * along, so the two answered the same question from different authorities.
   */
  resumable: boolean;
}

export interface DelegatedTaskListInput {
  environmentId?: string;
  limit?: number;
  userId?: string;
  /** Trusted request authority supplied only by runtime composition. */
  readAuthority?: SessionReadAuthority;
}

export type DelegatedTaskListItem = Omit<
  DelegatedTaskSnapshot,
  'pendingRequest'
>;

export interface DelegatedTaskInventory {
  environment: DelegatedTaskSnapshot['environment'];
  tasks: DelegatedTaskListItem[];
  truncated: boolean;
}

function currentControlApiBase(): string {
  return resolveControlApiBase();
}

/**
 * Local delegation reads are externally initiated even when the selected
 * environment is this process.  Personal mode retains its established
 * single-user authority; hosted mode accepts only the request authority the
 * HTTP runtime supplied.  In particular, a tool/CLI invocation cannot turn
 * an omitted authority into an internal aggregate read.
 */
function readAuthorityForInput(input: {
  userId?: string;
  readAuthority?: SessionReadAuthority;
}): SessionReadAuthority {
  if (input.readAuthority) {
    if (
      (isHostedTenantExecutionRequired() ||
        input.readAuthority.mode === 'hosted') &&
      !input.readAuthority.tenantExecutionContext
    ) {
      throw new Error('Delegation requires trusted hosted request authority');
    }
    return input.readAuthority;
  }
  if (isHostedTenantExecutionRequired()) {
    throw new Error('Delegation requires trusted hosted request authority');
  }
  return sessionReadAuthorityFromRequest(
    input.userId ?? '',
    undefined,
    undefined,
  );
}

/**
 * Dispatch authority is derived from the opaque request authority, never from
 * tool input. This keeps local service calls on the same user-plus-tenant
 * policy path as the HTTP route that admitted the request.
 */
function dispatchContextForAuthority(
  authority: SessionReadAuthority,
  clientOrigin?: import('@kontourai/station-contracts/client-origin').ClientOrigin,
  // station#4075 stage 2: additive alongside `clientOrigin` — the caller's
  // resolved principal, threaded through to `OrchestrationService.dispatch`
  // so the ONE `sendTurn` production implementation below stamps it onto
  // the dispatch context. Never derived from `authority` itself: unlike
  // `userId` (which the pre-stage-2 code already threaded through
  // `SessionReadAuthority`), a `PrincipalRef` is resolved independently at
  // the HTTP seam (`orchestration.ts`'s `resolveActorPrincipal`) and passed
  // in by callers that have one.
  principal?: PrincipalRef,
): {
  userId: string;
  tenantExecutionContext?: SessionReadAuthority['tenantExecutionContext'];
  clientOrigin?: import('@kontourai/station-contracts/client-origin').ClientOrigin;
  principal?: PrincipalRef;
} {
  return {
    userId: authority.userId,
    ...(authority.tenantExecutionContext
      ? { tenantExecutionContext: authority.tenantExecutionContext }
      : {}),
    ...(clientOrigin ? { clientOrigin } : {}),
    ...(principal ? { principal } : {}),
  };
}

function localServiceRequiredInHostedMode(
  target: DelegationTarget,
  authority: SessionReadAuthority,
  orchestrationService: OrchestrationService | undefined,
): void {
  if (
    target.kind === 'current' &&
    authority.mode === 'hosted' &&
    !orchestrationService
  ) {
    throw new Error(
      'Local delegated task operations require the injected orchestration service in hosted mode',
    );
  }
}
/**
 * station#4543 LOW-2: the exact shape `delegateTask` itself mints
 * (`task:${randomUUID()}`) — and the only shape `metadata.conversationId`/
 * `metadata.environmentId` may be re-stamped from via the
 * `conversationIdentity` internal escape hatch (see `delegateTask`'s
 * `sessionId` validation below). `environmentId` is always server-resolved
 * (`target.environmentId`), but `conversationId` is stamped from
 * `sessionId`, and an MCP tool caller MAY supply a custom `sessionId`
 * (`station-control-operations-tools.ts`'s `sessionId` param) — an
 * unvalidated arbitrary string would otherwise get laundered through a
 * RESERVED_ORCHESTRATION_METADATA_KEYS key whose contract
 * (`provider.ts`'s `CONVERSATION_ID_RESERVED_METADATA_KEY` docblock) is
 * "always resolved by Station", not caller-supplied.
 */
const TASK_SESSION_ID_PATTERN =
  /^task:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TASK_EVENT_CURSOR_PREFIX = 'station-task-events:v1:';
const DEFAULT_TASK_EVENT_LIMIT = 50;
const MAX_TASK_EVENT_LIMIT = 100;
const MAX_TASK_EVENT_TEXT = 8_192;
const DEFAULT_TASK_LIST_LIMIT = 50;
const MAX_TASK_LIST_LIMIT = 100;
const MAX_TASK_LIST_SCAN = 200;
const TASK_BINDING_EVENT_LIMIT = 10;
const TASK_LIST_VERIFY_BATCH = 8;

async function readJson<T>(
  url: string,
  init?: RequestInit,
  unavailableMessage = 'Station request failed',
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, init);
  } catch {
    throw new Error(unavailableMessage);
  }
  let payload: T & { error?: string };
  try {
    payload = (await response.json()) as T & { error?: string };
  } catch {
    throw new Error(unavailableMessage);
  }
  if (!response.ok) {
    throw new Error(payload.error || unavailableMessage);
  }
  return payload;
}

async function postCanonical<T>(
  target: Pick<DelegationTarget, 'apiBase' | 'requestOptions'>,
  path: string,
  body: unknown,
  unavailableMessage: string,
): Promise<T> {
  const payload = await readJson<ApiEnvelope<T>>(
    `${target.apiBase}${path}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(target.requestOptions?.headers ?? {}),
      },
      body: JSON.stringify(body),
    },
    unavailableMessage,
  );
  if (!payload.success || payload.data === undefined) {
    throw new Error(payload.error || unavailableMessage);
  }
  return payload.data;
}

async function getCanonical<T>(
  target: Pick<DelegationTarget, 'apiBase' | 'requestOptions'>,
  path: string,
  unavailableMessage: string,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${target.apiBase}${path}`, {
      method: 'GET',
      headers: target.requestOptions?.headers,
    });
  } catch (cause) {
    throw new CanonicalDelegationReadError(
      'transport',
      unavailableMessage,
      undefined,
      cause,
    );
  }
  let payload: ApiEnvelope<T>;
  try {
    payload = (await response.json()) as ApiEnvelope<T>;
  } catch (cause) {
    throw new CanonicalDelegationReadError(
      'malformed',
      unavailableMessage,
      response.status,
      cause,
    );
  }
  if (!response.ok || !payload.success || payload.data === undefined) {
    throw new CanonicalDelegationReadError(
      'http',
      payload.error || unavailableMessage,
      response.status,
    );
  }
  return payload.data;
}

export class CanonicalDelegationReadError extends Error {
  constructor(
    readonly kind: 'http' | 'transport' | 'malformed',
    message: string,
    readonly status?: number,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'CanonicalDelegationReadError';
  }
}

/** Older Stations predate explicit conversation/current-child fields. */
function normalizeDelegatedIdentity<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const recordValue = value as Record<string, unknown>;
  const taskId = optionalString(recordValue.taskId);
  const sessionId = optionalString(recordValue.sessionId) ?? taskId;
  if (!taskId || !sessionId) return value;
  return {
    ...recordValue,
    conversationId: optionalString(recordValue.conversationId) ?? taskId,
    sessionId,
    currentSessionId: optionalString(recordValue.currentSessionId) ?? sessionId,
  } as T;
}

function foregroundIndeterminateDetail(
  payload: ApiEnvelope<unknown>,
): ForegroundMessageIndeterminate | null {
  if (
    payload.code !== FOREGROUND_MESSAGE_INDETERMINATE_CODE ||
    payload.outcome !== 'indeterminate' ||
    payload.receiptStatus !== 'unavailable' ||
    typeof payload.receipt !== 'object' ||
    payload.receipt === null ||
    typeof payload.session !== 'object' ||
    payload.session === null
  ) {
    return null;
  }
  return {
    code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
    outcome: 'indeterminate',
    receipt: payload.receipt as ForegroundMessageIndeterminate['receipt'],
    receiptStatus: 'unavailable',
    session: payload.session as ForegroundMessageIndeterminate['session'],
  };
}

/** Preserve no-retry foreground evidence when a remote Station returns it. */
async function postForegroundMessage(
  target: Pick<DelegationTarget, 'apiBase' | 'requestOptions'>,
  path: string,
  body: unknown,
  unavailableMessage: string,
): Promise<ForegroundMessageHandle> {
  let response: Response;
  try {
    response = await fetch(`${target.apiBase}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(target.requestOptions?.headers ?? {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    // POST may have reached the peer before its response became unavailable.
    // Preserve no-retry evidence rather than treating this as a safe retry.
    throw new ForegroundMessageTurnIdentityUnavailableError(unavailableMessage);
  }
  let payload: ApiEnvelope<ForegroundMessageHandle>;
  try {
    payload = (await response.json()) as ApiEnvelope<ForegroundMessageHandle>;
  } catch {
    throw new ForegroundMessageTurnIdentityUnavailableError(unavailableMessage);
  }
  const indeterminate = foregroundIndeterminateDetail(payload);
  if (indeterminate) {
    throw new ForegroundMessageIndeterminateError(
      indeterminate,
      payload.error || 'Foreground session start is indeterminate.',
    );
  }
  if (
    payload.code === FOREGROUND_MESSAGE_INDETERMINATE_CODE &&
    payload.outcome === 'indeterminate'
  ) {
    // Peers predating receipt projection still return the stable detail-less
    // 409 contract. Keep it typed all the way to the controlling UI.
    throw new ForegroundMessageTurnIdentityUnavailableError(
      payload.error || 'Foreground session start is indeterminate.',
    );
  }
  if (!response.ok || !payload.success || payload.data === undefined) {
    throw new Error(payload.error || unavailableMessage);
  }
  if (
    typeof payload.data.providerTurnId !== 'string' ||
    !payload.data.providerTurnId
  ) {
    throw new ForegroundMessageTurnIdentityUnavailableError(
      'Foreground message may have started but the target Station did not return a provider turn id',
    );
  }
  return payload.data;
}

async function readSanitizedJson<T>(
  url: string,
  init: RequestInit | undefined,
  unavailableMessage: string,
): Promise<T> {
  try {
    return await readJson<T>(url, init, unavailableMessage);
  } catch {
    throw new Error(unavailableMessage);
  }
}

function trustedRequest(init?: RequestInit): RequestInit {
  const request = controlRequestOptions();
  return {
    ...init,
    headers: {
      ...request.headers,
      ...(init?.headers ?? {}),
    },
  };
}

async function currentHandshake(): Promise<StationHandshake> {
  const handshake = await readJson<StationHandshake>(
    `${currentControlApiBase()}/.well-known/station/v1`,
    undefined,
    'Current Station environment is unavailable',
  );
  if (!handshake.environmentId) {
    throw new Error('Current Station environment identity is unavailable');
  }
  return handshake;
}

function requireLoopbackTunnel(value: string | undefined): string {
  if (!value) {
    throw new Error('SSH environment did not provide a verified tunnel');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('SSH environment returned an invalid tunnel');
  }
  if (
    parsed.protocol !== 'http:' ||
    !['127.0.0.1', '::1', '[::1]'].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== '/' ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error('SSH environment returned a non-loopback tunnel');
  }
  return parsed.origin;
}

/**
 * station#1123 slice 2: distinguishes "no SSH profile matches this
 * environmentId at all" from every other SSH failure (unavailable list,
 * connect failure, binding mismatch, not-ready, OR a matching profile that
 * exists but is not yet verified) — `resolveTarget` falls back to the
 * peer-credential store ONLY on this exact, narrow case. An environment
 * that genuinely HAS an SSH profile — verified or not — keeps reporting
 * its own SSH-specific failure instead of masking it behind an unrelated
 * "no peer either" error. Review fix (LOW, station#1123 PR #1178): this
 * used to also cover "profile found but unverified", silently falling
 * through to peer resolution for that case despite this docblock's claim
 * that only true not-found does — narrowed to match the documented intent
 * rather than the other way around, since a present-but-unverified profile
 * is exactly the kind of "genuinely a broken/misconfigured SSH profile"
 * case this distinction exists to protect.
 */
const SSH_ENVIRONMENT_NOT_FOUND_MESSAGE =
  'The selected environment is not a saved, verified SSH environment';

async function connectSshTarget(
  environmentId: string,
  requestedProjectPath?: string,
): Promise<DelegationTarget> {
  const list = await readJson<ApiEnvelope<SshEnvironmentView[]>>(
    `${currentControlApiBase()}/api/environments/ssh`,
    trustedRequest(),
    'Saved SSH environments are unavailable',
  );
  if (!list.success || !Array.isArray(list.data)) {
    throw new Error(list.error || 'Saved SSH environments are unavailable');
  }
  const saved = list.data.find(
    (environment) => environment.profile.environmentId === environmentId,
  );
  if (!saved) {
    throw new Error(SSH_ENVIRONMENT_NOT_FOUND_MESSAGE);
  }
  if (!saved.profile.verifiedProjectPath) {
    // Deliberately a DIFFERENT message from SSH_ENVIRONMENT_NOT_FOUND_MESSAGE
    // — resolveTarget's peer-store fallback matches on that exact string, so
    // a present-but-unverified profile never falls through to the peer
    // store; it reports its own failure instead (see this function's
    // docblock).
    throw new Error(
      'The selected SSH environment is not yet verified; verify it before delegating work',
    );
  }
  if (
    requestedProjectPath &&
    requestedProjectPath !== saved.profile.verifiedProjectPath
  ) {
    throw new Error(
      'The requested project path does not match the verified SSH environment binding',
    );
  }

  const connected = await readJson<ApiEnvelope<SshEnvironmentView>>(
    `${currentControlApiBase()}/api/environments/ssh/${encodeURIComponent(saved.profile.id)}/connect`,
    trustedRequest({ method: 'POST' }),
    'The selected SSH environment could not be connected',
  );
  const view = connected.data;
  if (!connected.success || !view) {
    throw new Error(
      connected.error || 'The selected SSH environment could not be connected',
    );
  }
  if (
    view.profile.environmentId !== environmentId ||
    view.profile.verifiedProjectPath !== saved.profile.verifiedProjectPath
  ) {
    throw new Error(
      'The SSH environment binding changed while connecting; select it again',
    );
  }
  if (view.state.phase !== 'connected') {
    throw new Error(
      view.state.action ||
        `The selected SSH environment is not ready (${view.state.phase})`,
    );
  }

  // station#1123 slice 3: attach an outbound peer credential to the SSH
  // tunnel too, when one is provisioned for this environmentId, so protected
  // calls satisfy runtime authentication. SSH profile resolution/connection
  // above is unaffected either way — this only decides whether the returned
  // target also carries an `Authorization` header. If no credential is
  // provisioned, the connection remains usable but protected API calls fail
  // loudly with `401 authentication_required`.
  //
  // Security-review follow-up (station#1123 slice 3): fail-open stays, but
  // silently — `fetchPeerCredential` only returns `null` for a clean 404
  // ("no credential provisioned"); every other failure (network error,
  // non-2xx, malformed JSON) throws. Conflating those two outcomes in a bare
  // `catch {}` means a corrupted credential store or a post-upgrade
  // permissions problem silently makes protected SSH calls fail with 401,
  // indefinitely, with no operator-visible signal that credential delivery
  // has stopped. Log a
  // warning on the genuine-failure path so that regression is observable;
  // stay silent on the expected `null` (nothing went wrong).
  let requestOptions: DelegationTarget['requestOptions'];
  try {
    const peer = await fetchPeerCredential(environmentId);
    if (peer) {
      requestOptions = {
        headers: { Authorization: `Bearer ${peer.credential}` },
      };
    }
  } catch (error) {
    console.warn(
      `[station-control-delegation] peer credential lookup failed for environmentId=${environmentId}; ` +
        'falling through to the unauthenticated SSH tunnel target (station#1123 slice 3 fail-open). ' +
        'This is expected if the credential store is briefly unavailable, but if it persists, scope ' +
        'enforcement has stopped for this SSH-tunneled environment.',
      error instanceof Error ? error.message : error,
    );
  }

  return {
    apiBase: requireLoopbackTunnel(view.state.localUrl),
    environmentId,
    environmentName: view.profile.name,
    kind: 'ssh',
    projectPath: view.profile.verifiedProjectPath,
    ...(view.profile.remoteHome ? { remoteHome: view.profile.remoteHome } : {}),
    ...(requestOptions ? { requestOptions } : {}),
  };
}

interface PeerCredentialView {
  environmentId: string;
  apiBase: string;
  scope: string;
  credential: string;
  label: string | null;
}

/**
 * station#1123 slice 2: fetches the outbound peer credential provisioned for
 * `environmentId` from `PeerCredentialStore` (via the internal-only
 * `GET /api/environments/peers/:environmentId/credential` leaf). `null`
 * (never a throw) only for "no credential provisioned" (404) — every other
 * failure (network error, non-2xx, invalid body) throws, matching this
 * route's own internal-only trust posture. Shared by `connectPeerTarget`
 * (slice 2, a directly-reachable peer with no SSH profile) and
 * `connectSshTarget` (slice 3, attaching the same credential to an
 * SSH-tunneled target when one exists) — callers decide for themselves
 * whether a failure here should be fatal or best-effort.
 */
async function fetchPeerCredential(
  environmentId: string,
): Promise<PeerCredentialView | null> {
  let response: Response;
  try {
    response = await fetch(
      `${currentControlApiBase()}/api/environments/peers/${encodeURIComponent(environmentId)}/credential`,
      trustedRequest(),
    );
  } catch {
    throw new Error('The selected peer environment is unavailable');
  }
  if (response.status === 404) return null;
  let payload: ApiEnvelope<PeerCredentialView>;
  try {
    payload = (await response.json()) as ApiEnvelope<PeerCredentialView>;
  } catch {
    throw new Error(
      'The selected peer environment returned an invalid response',
    );
  }
  if (!response.ok || !payload.success || !payload.data) {
    throw new Error(
      payload.error || 'The selected peer environment is unavailable',
    );
  }
  return payload.data;
}

/**
 * station#1123 slice 2: resolves a directly-reachable peer target from the
 * outbound `PeerCredentialStore`, attaching the stored bearer credential as
 * an `Authorization` header — the whole point of this kind existing (see
 * `docs/design/station-peer-pairing.md` §4's "why this is not cosmetic").
 * `null` (never a throw) when no peer credential is provisioned for this
 * `environmentId`, so `resolveTarget` can fall back to SSH resolution
 * exactly as it did before this slice.
 *
 * `requestedProjectPath` is accepted for signature symmetry with
 * `connectSshTarget` but intentionally unused: a peer target has no single
 * verified project-path binding (unlike an SSH profile) — `resolveProject`
 * resolves a project against `target.apiBase` the same way it already does
 * for `kind: 'current'`.
 */
async function connectPeerTarget(
  environmentId: string,
  _requestedProjectPath?: string,
): Promise<DelegationTarget | null> {
  const peer = await fetchPeerCredential(environmentId);
  if (!peer) return null;
  return {
    apiBase: peer.apiBase,
    environmentId,
    environmentName: peer.label || peer.apiBase,
    kind: 'peer',
    requestOptions: { headers: { Authorization: `Bearer ${peer.credential}` } },
  };
}

async function resolveTarget(
  input: Pick<DelegationEnvironmentSelection, 'environmentId' | 'projectPath'>,
): Promise<DelegationTarget> {
  const current = await currentHandshake();
  if (!input.environmentId || input.environmentId === current.environmentId) {
    return {
      apiBase: currentControlApiBase(),
      environmentId: current.environmentId,
      environmentName: 'Current environment',
      kind: 'current',
      projectPath: input.projectPath,
      requestOptions: controlRequestOptions(),
    };
  }
  try {
    return await connectSshTarget(input.environmentId, input.projectPath);
  } catch (error) {
    // station#1123 slice 2: fall back to a directly-reachable peer ONLY
    // when SSH genuinely has no matching profile — every other SSH error
    // (unavailable list, connect failure, binding mismatch, not-ready) is
    // reported as-is, and every environmentId with an existing SSH profile
    // resolves through the byte-identical path it always has (§7's
    // coexistence guarantee — nothing here changes SSH delegation
    // behavior).
    if (
      error instanceof Error &&
      error.message === SSH_ENVIRONMENT_NOT_FOUND_MESSAGE
    ) {
      const peer = await connectPeerTarget(
        input.environmentId,
        input.projectPath,
      );
      if (peer) return peer;
    }
    throw error;
  }
}

function assertVerifiedSshWorkspace(
  target: DelegationTarget,
  cwd: string,
  subject: string,
): void {
  if (!target.projectPath) {
    throw new Error(
      'The selected SSH environment has no verified workspace binding',
    );
  }
  const match = matchVerifiedRemoteProjectPath(
    cwd,
    target.projectPath,
    target.remoteHome,
  );
  if (!match.matches) {
    throw new Error(
      `${subject} does not match the verified SSH environment workspace: ${match.reason}`,
    );
  }
}

/**
 * A saved SSH Environment is authenticated only at this controlling Station:
 * the loopback tunnel is indistinguishable from a local remote caller. Check
 * the selected remote project here, then pin the forwarded workspace so both
 * current and older target Stations execute exactly the verified directory.
 */
async function pinSshDispatchWorkspace(
  target: DelegationTarget,
  executionTarget: ExecutionTarget,
): Promise<ExecutionTarget> {
  if (target.kind !== 'ssh') return executionTarget;
  if (!target.projectPath) {
    throw new Error(
      'The selected SSH environment has no verified workspace binding',
    );
  }
  const workspace = executionTarget.workspace;
  if (!workspace) {
    return {
      ...executionTarget,
      workspace: { kind: 'directory', cwd: target.projectPath },
    };
  }
  if (workspace.kind === 'directory') {
    assertVerifiedSshWorkspace(
      target,
      workspace.cwd,
      'Execution workspace directory',
    );
    return {
      ...executionTarget,
      workspace: { kind: 'directory', cwd: target.projectPath },
    };
  }

  const slug = workspace.projectSlug.trim();
  if (!slug) throw new Error('Execution workspace project must not be empty');
  const project = (await getProject(
    target.apiBase,
    slug,
    target.requestOptions,
  )) as { workingDirectory?: string } | undefined;
  if (!project?.workingDirectory) {
    throw new Error(`Project '${slug}' has no working directory configured`);
  }
  assertVerifiedSshWorkspace(
    target,
    project.workingDirectory,
    `Project '${slug}'`,
  );
  if (workspace.cwd?.trim()) {
    assertVerifiedSshWorkspace(
      target,
      workspace.cwd.trim(),
      'Execution workspace cwd',
    );
  }
  return {
    ...executionTarget,
    workspace: { kind: 'project', projectSlug: slug, cwd: target.projectPath },
  };
}

/**
 * station#1463: a `projectSlug` names a project in ONE Station's local
 * namespace. Slugs are generated locally, with local dedupe suffixes
 * (`project-service.ts`), so two Stations holding the same slug for the same
 * project is a coincidence — and two *different* projects can hold the same
 * slug on two machines. Resolving `input.projectSlug` against a remote
 * `target.apiBase` therefore proves only that a project by that name exists
 * there, never that it is the project the caller meant.
 *
 * The durable fix is #1425's portable manifest `id` as the cross-machine join
 * key; this is the honest interim. Of the two options the issue names —
 * require confirmation, or record the join as unverified — this takes the
 * second, deliberately:
 *
 * - Requiring confirmation would reject delegations that work today (every
 *   existing remote `projectSlug` caller, including agents with no operator
 *   in the loop), trading a silent wrong answer for a hard stop on the right
 *   ones. That is a bigger behavior change than the defect warrants for an
 *   interim that a later slice deletes.
 * - Recording it is the smaller change and is sufficient for the stated
 *   goal: nothing claims an identity it has not proven. The unverified join
 *   travels in the returned handle, in the discovery options, and in the
 *   started session's own metadata, so the delegation record itself carries
 *   the disclosure rather than the caller having to remember it.
 *
 * A remote match IS corroborated — and so not flagged — when the resolved
 * project's working directory matches the operator-verified project path for
 * that environment: that is a local proof, on the target machine, of which
 * directory the work lands in.
 */
async function resolveProject(
  target: DelegationTarget,
  input: Pick<DelegationEnvironmentSelection, 'projectSlug' | 'projectPath'>,
): Promise<ResolvedDelegationProject | undefined> {
  let projectPath = target.projectPath;
  let slugJoin: ResolvedDelegationProject['slugJoin'];
  if (input.projectSlug) {
    const project = (await getProject(
      target.apiBase,
      input.projectSlug,
      target.requestOptions,
    )) as { workingDirectory?: string } | undefined;
    if (!project?.workingDirectory) {
      throw new Error(
        `Project '${input.projectSlug}' has no working directory configured`,
      );
    }
    const verifiedPathMatch = projectPath
      ? matchVerifiedRemoteProjectPath(
          project.workingDirectory,
          projectPath,
          target.remoteHome,
        )
      : undefined;
    if (verifiedPathMatch && !verifiedPathMatch.matches) {
      throw new Error(
        `Project '${input.projectSlug}' does not match the verified environment project path: ${verifiedPathMatch.reason}`,
      );
    }
    slugJoin =
      target.kind === 'current'
        ? 'local'
        : // Keep corroboration stricter than the gate: the latter can accept
          // normalized tilde expansion, while this label records raw byte
          // equality and is never emitted for a rejected pair.
          projectPath &&
            verifiedPathMatch?.matches === true &&
            project.workingDirectory === projectPath
          ? 'directory-corroborated'
          : 'unverified-cross-machine';
    projectPath ??= project.workingDirectory;
  }
  if (!projectPath) return undefined;
  // Deliberately NOT the existence check the orchestration path gained in #791.
  // That issue asked for the same choice in both places, but the two are not
  // symmetric: this resolves a project belonging to `target.apiBase`, which is
  // routinely a *remote* Station reached over SSH or a tunnel. Its working
  // directory lives on that host, so an `existsSync` here would test the wrong
  // filesystem — rejecting valid remote projects whenever the path happens not
  // to exist locally, and passing invalid ones whenever it coincidentally does.
  // The remote Station applies its own check when it starts the session.
  return {
    ...(input.projectSlug ? { slug: input.projectSlug } : {}),
    path: projectPath,
    ...(slugJoin ? { slugJoin } : {}),
  };
}

async function readConnection(
  target: DelegationTarget,
  id: string,
): Promise<ConnectionConfig> {
  const response = await readJson<ApiEnvelope<ConnectionConfig>>(
    `${target.apiBase}/api/connections/${encodeURIComponent(id)}`,
    target.requestOptions,
    `Engine connection '${id}' is unavailable`,
  );
  if (!response.success || !response.data) {
    throw new Error(
      response.error || `Engine connection '${id}' is unavailable`,
    );
  }
  const connection = response.data;
  if (connection.kind !== 'agent') {
    throw new Error(`Connection '${id}' is not an engine connection`);
  }
  if (!connection.enabled || connection.status === 'disabled') {
    throw new Error(`Engine connection '${id}' is disabled`);
  }
  if (
    connection.status === 'missing_prerequisites' ||
    connection.status === 'error' ||
    !connection.capabilities.includes('agent-runtime')
  ) {
    throw new Error(
      `Engine connection '${id}' is not ready for delegated work`,
    );
  }
  return connection;
}

function connectionUnavailableReason(connection: AgentConnectionView): string {
  if (!connection.enabled || connection.status === 'disabled') {
    return 'Enable this engine connection in Connections before delegating work.';
  }
  if (!connection.capabilities.includes('agent-runtime')) {
    return 'This connection does not provide an agent runtime.';
  }
  if (connection.status === 'missing_prerequisites') {
    return 'Install the required runtime and finish its setup first.';
  }
  if (connection.status === 'error') {
    return 'Review this engine connection in Connections and resolve its error first.';
  }
  return 'Finish setting up this engine connection before delegating work.';
}

const MAX_DISCOVERED_TARGETS = 200;
const MAX_DISCOVERED_MODELS = 200;
const MAX_DISCOVERED_ID_LENGTH = 512;

function safeIdentifier(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_DISCOVERED_ID_LENGTH) return undefined;
  return trimmed;
}

function safeLabel(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : fallback;
}

function safeDescription(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : undefined;
}

function safeModels(value: unknown): ModelOption[] {
  if (!Array.isArray(value)) return [];
  const models: ModelOption[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      models.length >= MAX_DISCOVERED_MODELS
    )
      continue;
    const record = candidate as Record<string, unknown>;
    const id = safeIdentifier(record.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      id,
      name: safeLabel(record.name, id),
      originalId: safeIdentifier(record.originalId) ?? id,
    });
  }
  return models;
}

function connectionModels(connection: AgentConnectionView): ModelOption[] {
  return safeModels(connection.runtimeCatalog?.models);
}

/**
 * List only stable, secret-free environment selection state. Unlike target
 * discovery, this never connects an SSH profile or returns its transport and
 * verified filesystem binding.
 */
export async function discoverDelegationEnvironments(): Promise<DelegationEnvironments> {
  const [current, saved] = await Promise.all([
    currentHandshake(),
    readSanitizedJson<ApiEnvelope<SshEnvironmentView[]>>(
      `${currentControlApiBase()}/api/environments/ssh`,
      trustedRequest(),
      'Saved SSH environments are unavailable',
    ),
  ]);
  if (!saved.success || !Array.isArray(saved.data)) {
    throw new Error('Saved SSH environments are unavailable');
  }

  const environments: DelegationEnvironmentOption[] = [
    {
      id: current.environmentId,
      name: 'Current environment',
      kind: 'current',
      ready: true,
      connected: true,
    },
  ];
  const seen = new Set([current.environmentId]);
  for (const environment of saved.data) {
    if (environments.length >= MAX_DISCOVERED_TARGETS) break;
    const id = safeIdentifier(environment.profile.environmentId);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ready = Boolean(environment.profile.verifiedProjectPath);
    environments.push({
      id,
      name: safeLabel(environment.profile.name, 'Saved SSH environment'),
      kind: 'ssh',
      ready,
      connected: environment.state.phase === 'connected',
      ...(!ready
        ? {
            unavailableReason:
              'Verify this SSH environment before delegating work.',
          }
        : {}),
    });
  }
  return { environments };
}

/**
 * Discover a secret-free capability catalog from the exact Station selected
 * for launch. SSH remains an access adapter: its tunnel and credentials never
 * leave this server-side boundary.
 */
export async function discoverDelegationOptions(
  input: DelegationEnvironmentSelection,
): Promise<DelegationOptions> {
  const target = await resolveTarget(input);
  const project = await resolveProject(target, input);
  const [connectionEnvelope, agentEnvelope] = await Promise.all([
    readSanitizedJson<ApiEnvelope<AgentConnectionView[]>>(
      `${target.apiBase}/api/connections/agents`,
      target.requestOptions,
      'Engine connections are unavailable on the selected Station',
    ),
    readSanitizedJson<ApiEnvelope<DelegationAgentView[]>>(
      `${target.apiBase}/api/agents`,
      target.requestOptions,
      'Agents are unavailable on the selected Station',
    ),
  ]);
  if (!connectionEnvelope.success || !Array.isArray(connectionEnvelope.data)) {
    throw new Error(
      'Engine connections are unavailable on the selected Station',
    );
  }
  if (!agentEnvelope.success || !Array.isArray(agentEnvelope.data)) {
    throw new Error('Agents are unavailable on the selected Station');
  }

  const connections = new Map(
    connectionEnvelope.data.flatMap((connection) => {
      const id = safeIdentifier(connection.id);
      return id ? [[id, connection] as const] : [];
    }),
  );
  const agents: DelegationTargetOption[] = agentEnvelope.data
    .flatMap((agent) => {
      const id = safeIdentifier(agent.slug);
      if (!id || id.startsWith('__')) return [];
      const connectionId = safeIdentifier(agent.execution?.agentConnectionId);
      const connection = connectionId
        ? connections.get(connectionId)
        : undefined;
      const models = connection
        ? connectionModels(connection)
        : safeModels(agent.modelOptions);
      const defaultModel = safeIdentifier(
        agent.execution?.modelId ||
          agent.model ||
          connection?.config.defaultModel,
      );
      const description = safeDescription(agent.description);
      const connectionReady = connection
        ? connection.enabled &&
          connection.status === 'ready' &&
          connection.capabilities.includes('agent-runtime')
        : true;
      const ready = agent.available !== false && connectionReady;
      const unavailableReason =
        safeDescription(agent.unavailableReason) ||
        (connection && !connectionReady
          ? connectionUnavailableReason(connection)
          : undefined);
      return [
        {
          id,
          name: safeLabel(agent.name, id),
          ...(description ? { description } : {}),
          kind: 'agent' as const,
          ready,
          ...(!ready && unavailableReason ? { unavailableReason } : {}),
          ...(defaultModel ? { defaultModel } : {}),
          models,
          capabilities: {
            resume: connection
              ? connection.capabilities.includes('resume')
              : true,
            interrupt: connection
              ? connection.capabilities.includes('interrupt')
              : true,
            approvals: connection
              ? connection.capabilities.includes('approvals')
              : true,
            modelSelection: models.length > 0,
          },
        },
      ];
    })
    .slice(0, MAX_DISCOVERED_TARGETS);

  return {
    environment: {
      id: target.environmentId,
      name: safeLabel(target.environmentName, 'Selected Station'),
      kind: target.kind,
    },
    ...(project
      ? {
          project: {
            ...(project.slug ? { slug: project.slug } : {}),
            ...(project.slugJoin ? { slugJoin: project.slugJoin } : {}),
          },
        }
      : {}),
    targets: agents,
  };
}

function handleFor(
  input: DelegateTaskInput,
  target: DelegationTarget,
  project: ResolvedDelegationProject | undefined,
  sessionId: string,
): Omit<DelegatedTaskHandle, 'target' | 'resolution'> {
  return {
    conversationId: sessionId,
    taskId: sessionId,
    sessionId,
    currentSessionId: sessionId,
    status: 'dispatched',
    environment: {
      id: target.environmentId,
      name: target.environmentName,
      kind: target.kind,
    },
    ...(project ? { project } : {}),
    ...(input.target.model?.override
      ? { model: input.target.model.override }
      : {}),
    ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
  };
}

async function existingSession(
  target: DelegationTarget,
  sessionId: string,
  orchestrationService?: OrchestrationService,
  readAuthority?: SessionReadAuthority,
): Promise<{
  session?: Record<string, unknown>;
  events?: Array<Record<string, unknown>>;
} | null> {
  if (target.kind === 'current' && orchestrationService && readAuthority) {
    return (await orchestrationService.readSession(
      sessionId,
      readAuthority,
    )) as unknown as {
      session?: Record<string, unknown>;
      events?: Array<Record<string, unknown>>;
    } | null;
  }
  try {
    return await getOrchestrationSession<{
      session?: Record<string, unknown>;
      events?: Array<Record<string, unknown>>;
    }>(target.apiBase, sessionId, target.requestOptions);
  } catch (error) {
    if (error instanceof Error && error.message === 'Session not found') {
      return null;
    }
    throw error;
  }
}

function assertSessionBinding(
  detail: {
    session?: unknown;
    events?: unknown[];
  },
  target: DelegationTarget,
  expectedTarget: { kind: 'agent'; id: string },
  userId?: string,
): void {
  const metadata = sessionBinding(detail);
  const boundTarget = delegationTargetBinding(metadata);
  if (
    metadata?.environmentId !== target.environmentId ||
    boundTarget?.kind !== expectedTarget.kind ||
    boundTarget.id !== expectedTarget.id ||
    (userId !== undefined && metadata?.userId !== userId)
  ) {
    throw new Error(
      'The requested session belongs to a different environment, user, or delegation target',
    );
  }
}

function delegationTargetBinding(
  metadata: Record<string, unknown> | undefined,
): { kind: 'agent'; id: string } | undefined {
  const targetKind = metadata?.targetKind;
  const targetId = metadata?.targetId;
  if (targetKind === 'agent' && typeof targetId === 'string') {
    return { kind: 'agent', id: targetId };
  }
  return undefined;
}

function sessionBinding(detail: {
  events?: unknown[];
}): Record<string, unknown> | undefined {
  const bindingEvent = [...(detail.events ?? [])].reverse().find((value) => {
    const event = record(value);
    if (
      event.method !== 'session.configured' &&
      event.method !== 'session.started'
    ) {
      return false;
    }
    const metadata = event.metadata;
    if (!metadata || typeof metadata !== 'object') return false;
    const binding = metadata as Record<string, unknown>;
    return (
      typeof binding.environmentId === 'string' &&
      delegationTargetBinding(binding) !== undefined
    );
  });
  return record(bindingEvent).metadata as Record<string, unknown> | undefined;
}

function taskStatus(
  session: Record<string, unknown>,
): DelegatedTaskSnapshot['status'] {
  const lifecycle = session.lifecycleState;
  if (
    lifecycle === 'queued' ||
    lifecycle === 'running' ||
    lifecycle === 'needs_input' ||
    lifecycle === 'review_pending' ||
    lifecycle === 'blocked' ||
    lifecycle === 'completed' ||
    lifecycle === 'failed' ||
    lifecycle === 'canceled'
  ) {
    return lifecycle;
  }
  if (session.status === 'connecting') return 'queued';
  if (session.status === 'running' || session.status === 'ready') {
    return 'running';
  }
  if (session.status === 'error') return 'failed';
  // station#1827: a `dead` engine binding (untyped session record, hence
  // the string literal) is a terminal failure exactly like `error` — this
  // fallback only runs when `lifecycleState` is absent, and mirrors
  // `providerStatusToLifecycleState`'s equivalent branch.
  if (session.status === 'dead') return 'failed';
  if (session.status === 'closed') return 'canceled';
  return 'unknown';
}

async function loadDelegatedTask(
  input: DelegatedTaskReferenceInput,
  orchestrationService?: OrchestrationService,
): Promise<{
  target: DelegationTarget;
  detail: {
    session?: Record<string, unknown>;
    events?: Array<Record<string, unknown>>;
  };
  metadata: Record<string, unknown>;
}> {
  const readAuthority = readAuthorityForInput(input);
  const target = await resolveTarget({ environmentId: input.environmentId });
  localServiceRequiredInHostedMode(target, readAuthority, orchestrationService);
  let detail = await existingSession(
    target,
    input.taskId,
    orchestrationService,
    readAuthority,
  );
  // station#4543 MED-1 (issue-author ruling): a delegated task's real
  // session id always carries the `task:` prefix (`delegateTask` mints
  // `task:${randomUUID()}`). A bare uuid is not a separate identity — it is
  // the same task missing its prefix — so a primary-lookup miss retries
  // once under the prefixed form and, on a hit, resolves through it exactly
  // as the prefixed call would have. `resolvedTaskId` (not `input.taskId`)
  // is what the binding check below and every downstream read must agree
  // with: `metadata.taskId` was stamped as the canonical prefixed form at
  // create time, so comparing it against the still-bare `input.taskId`
  // would immediately fail the binding check this retry just satisfied.
  let resolvedTaskId = input.taskId;
  if (!detail?.session && !input.taskId.startsWith('task:')) {
    const prefixedId = `task:${input.taskId}`;
    const prefixedDetail = await existingSession(
      target,
      prefixedId,
      orchestrationService,
      readAuthority,
    );
    if (prefixedDetail?.session) {
      detail = prefixedDetail;
      resolvedTaskId = prefixedId;
    }
  }
  if (!detail?.session) {
    throw new Error('Delegated task not found');
  }
  const metadata = sessionBinding(detail);
  const boundUserId = metadata?.userId;
  const boundTarget = delegationTargetBinding(metadata);
  if (
    metadata?.taskId !== resolvedTaskId ||
    metadata?.environmentId !== target.environmentId ||
    !boundTarget ||
    (typeof boundUserId === 'string' && boundUserId !== readAuthority.userId)
  ) {
    throw new Error(
      'The requested task does not match a delegated-task binding in the selected environment',
    );
  }
  const conversationId = delegatedConversationId(metadata, resolvedTaskId);
  if (
    target.kind === 'current' &&
    orchestrationService &&
    typeof orchestrationService.readCurrentConversationSession === 'function'
  ) {
    const current = await orchestrationService.readCurrentConversationSession(
      conversationId,
      readAuthority,
    );
    if (!current?.session) {
      throw new Error('Delegated task current session not found');
    }
    return {
      target,
      detail: {
        session: current.session as unknown as Record<string, unknown>,
        events: current.events as unknown as Array<Record<string, unknown>>,
      },
      // The binding belongs to the durable Conversation. A child Session is
      // intentionally not required to repeat legacy task metadata.
      metadata,
    };
  }
  return { target, detail, metadata };
}

/** Whether this Conversation can accept a follow-up without competing work. */
function conversationCanAcceptFollowUp(
  status: DelegatedTaskSnapshot['status'],
): boolean {
  // A stopped child is replaced by continuation; a queued child can accept
  // its next turn. A running/approval/blocked child is deliberately busy and
  // must be supervised rather than given a concurrent turn.
  //
  // "Stopped" is asked of the lifecycle contract rather than spelled out as
  // `completed || failed || canceled` here. The contract DERIVES it from the
  // transition map — a state is stopped when every transition it permits
  // re-enters the active lifecycle — and its docblock names this exact use:
  // "a stopped state records a run outcome". A hand-listed set can only
  // answer for the states it was written beside: add one to the contract and
  // this reports it as unable to continue, silently, which for a CAPABILITY
  // is the quiet direction to be wrong in. `queued` is named separately
  // because it is deliberately NOT stopped — nothing has run yet — and is the
  // one active state that can still take the next turn.
  //
  // `unknown` is not a lifecycle state and falls out as `false`: the claim is
  // made only for a state the contract recognizes.
  return (
    isSessionLifecycleState(status) &&
    (status === 'queued' || isSessionLifecycleStateStopped(status))
  );
}

/**
 * The delegation API keeps `taskId` only as a read-compatible alias. Child
 * Session lineage may be introduced independently, so every projection first
 * prefers the durable Conversation identity stamped by the owning service.
 */
function delegatedConversationId(
  metadata: Record<string, unknown>,
  fallback: string,
): string {
  return (
    safeIdentifier(metadata.conversationId) ??
    safeIdentifier(metadata.taskId) ??
    fallback
  );
}

function snapshotFor(options: {
  target: DelegationTarget;
  detail: {
    session?: Record<string, unknown>;
    events?: Array<Record<string, unknown>>;
  };
  metadata: Record<string, unknown>;
}): DelegatedTaskSnapshot {
  const session = options.detail.session!;
  const events = options.detail.events ?? [];
  const resolvedRequests = new Set(
    events
      .filter((event) => event.method === 'request.resolved')
      .map((event) => event.requestId),
  );
  const pendingRequest = [...events]
    .reverse()
    .find(
      (event) =>
        event.method === 'request.opened' &&
        typeof event.requestId === 'string' &&
        !resolvedRequests.has(event.requestId),
    );
  const lastEvent = events.at(-1);
  const status = taskStatus(session);
  const sessionId = String(session.threadId ?? options.metadata.taskId);
  const conversationId = delegatedConversationId(options.metadata, sessionId);
  return {
    conversationId,
    taskId: String(options.metadata.taskId),
    sessionId,
    currentSessionId: sessionId,
    status,
    environment: {
      id: options.target.environmentId,
      name:
        typeof options.metadata.environmentName === 'string'
          ? options.metadata.environmentName
          : options.target.environmentName,
      kind: options.target.kind,
    },
    target: delegationTargetBinding(options.metadata)!,
    ...(typeof session.provider === 'string'
      ? { provider: session.provider }
      : {}),
    ...(typeof session.model === 'string' ? { model: session.model } : {}),
    ...(typeof options.metadata.projectSlug === 'string'
      ? { projectSlug: options.metadata.projectSlug }
      : {}),
    ...(typeof options.metadata.parentTaskId === 'string'
      ? { parentTaskId: options.metadata.parentTaskId }
      : {}),
    eventCount: events.length,
    ...(lastEvent && typeof lastEvent.method === 'string'
      ? {
          lastEvent: {
            method: lastEvent.method,
            ...(typeof lastEvent.createdAt === 'string'
              ? { createdAt: lastEvent.createdAt }
              : {}),
          },
        }
      : {}),
    ...(pendingRequest
      ? {
          pendingRequest: {
            id: String(pendingRequest.requestId),
            ...(typeof pendingRequest.title === 'string'
              ? { title: pendingRequest.title }
              : {}),
            ...(typeof pendingRequest.requestType === 'string'
              ? { type: pendingRequest.requestType }
              : {}),
            // The TARGET Station's own observation, forwarded as-is. Never
            // re-derived here: this process holds neither that environment's
            // adapter registry nor its thread attachments (ADR 0012).
            answerability: normalizeRequestAnswerability(session.answerability),
          },
        }
      : {}),
    canInterrupt: status === 'queued' || status === 'running',
    resumable: conversationCanAcceptFollowUp(status),
  };
}

function parseTaskEventCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  if (!cursor.startsWith(TASK_EVENT_CURSOR_PREFIX)) {
    throw new Error('Invalid task event cursor');
  }
  const value = cursor.slice(TASK_EVENT_CURSOR_PREFIX.length);
  if (!/^(0|[1-9]\d*)$/.test(value)) {
    throw new Error('Invalid task event cursor');
  }
  const sequence = Number(value);
  if (!Number.isSafeInteger(sequence)) {
    throw new Error('Invalid task event cursor');
  }
  return sequence;
}

function taskEventCursor(sequence: number): string {
  return `${TASK_EVENT_CURSOR_PREFIX}${sequence}`;
}

function taskEventLimit(limit: number | undefined): number {
  const resolved = limit ?? DEFAULT_TASK_EVENT_LIMIT;
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < 1 ||
    resolved > MAX_TASK_EVENT_LIMIT
  ) {
    throw new Error(
      `Task event limit must be between 1 and ${MAX_TASK_EVENT_LIMIT}`,
    );
  }
  return resolved;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : {};
}

function optionalString(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function optionalCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function visibleText(value: unknown): { text?: string; truncated?: true } {
  if (typeof value !== 'string' || !value) return {};
  if (value.length <= MAX_TASK_EVENT_TEXT) return { text: value };
  return { text: value.slice(0, MAX_TASK_EVENT_TEXT), truncated: true };
}

function commonTaskEvent(
  sequence: number,
  event: Record<string, unknown>,
): Omit<DelegatedTaskEvent, 'kind'> {
  return {
    sequence,
    method: optionalString(event.method, 128) ?? 'runtime.event',
    ...(optionalString(event.eventId)
      ? { eventId: optionalString(event.eventId) }
      : {}),
    ...(optionalString(event.createdAt, 64)
      ? { createdAt: optionalString(event.createdAt, 64) }
      : {}),
    ...(optionalString(event.turnId)
      ? { turnId: optionalString(event.turnId) }
      : {}),
  };
}

/**
 * Convert canonical runtime history into the deliberately small remote-control
 * vocabulary. Prompts, reasoning text, metadata, tool inputs/outputs, request
 * payloads/responses, raw errors, filesystem paths, and extension payloads are
 * intentionally never copied.
 */
export function projectDelegatedTaskEvent(
  sequence: number,
  rawEvent: unknown,
): DelegatedTaskEvent {
  const event = record(rawEvent);
  const common = commonTaskEvent(sequence, event);
  switch (event.method) {
    case 'content.text-delta':
      return { ...common, kind: 'message', ...visibleText(event.delta) };
    case 'turn.completed':
      return {
        ...common,
        kind: 'message',
        status: 'completed',
        ...visibleText(event.outputText),
      };
    case 'content.reasoning-delta':
    case 'extension.notification':
      return { ...common, kind: 'activity' };
    case 'tool.started':
      return {
        ...common,
        kind: 'tool',
        status: 'running',
        ...(optionalString(event.toolName)
          ? { toolName: optionalString(event.toolName) }
          : {}),
      };
    case 'tool.progress':
      return {
        ...common,
        kind: 'tool',
        status: 'running',
        ...(optionalNumber(event.progress) !== undefined
          ? { progress: optionalNumber(event.progress) }
          : {}),
      };
    case 'tool.completed':
      return {
        ...common,
        kind: 'tool',
        status: optionalString(event.status, 32) ?? 'completed',
        ...(optionalString(event.toolName)
          ? { toolName: optionalString(event.toolName) }
          : {}),
      };
    case 'request.opened':
      return {
        ...common,
        kind: 'request',
        status: 'open',
        ...(optionalString(event.requestId)
          ? { requestId: optionalString(event.requestId) }
          : {}),
        ...(optionalString(event.requestType, 32)
          ? { requestType: optionalString(event.requestType, 32) }
          : {}),
        ...(optionalString(event.title, 200)
          ? { title: optionalString(event.title, 200) }
          : {}),
      };
    case 'request.resolved':
      return {
        ...common,
        kind: 'request',
        status: optionalString(event.status, 32) ?? 'resolved',
        ...(optionalString(event.requestId)
          ? { requestId: optionalString(event.requestId) }
          : {}),
      };
    case 'runtime.error':
      return {
        ...common,
        kind: 'runtime',
        severity: 'error',
        text: 'The delegated runtime reported an error.',
        ...(typeof event.retriable === 'boolean'
          ? { retriable: event.retriable }
          : {}),
      };
    case 'runtime.warning':
      return {
        ...common,
        kind: 'runtime',
        severity: 'warning',
        text: 'The delegated runtime reported a warning.',
      };
    case 'token-usage.updated': {
      const usage = {
        promptTokens: optionalNumber(event.promptTokens),
        completionTokens: optionalNumber(event.completionTokens),
        totalTokens: optionalNumber(event.totalTokens),
        cacheReadTokens: optionalNumber(event.cacheReadTokens),
        cacheWriteTokens: optionalNumber(event.cacheWriteTokens),
      };
      return {
        ...common,
        kind: 'usage',
        ...Object.fromEntries(
          Object.entries(usage).filter(([, value]) => value !== undefined),
        ),
      };
    }
    case 'flow.gate-verdict':
    case 'policy.stop-verdict':
      return {
        ...common,
        kind: 'gate',
        ...(optionalString(event.verdict, 32)
          ? { verdict: optionalString(event.verdict, 32) }
          : {}),
        ...(optionalString(event.gateId)
          ? { gateId: optionalString(event.gateId) }
          : {}),
        ...(optionalString(event.runId)
          ? { runId: optionalString(event.runId) }
          : {}),
      };
    case 'flow.run-attached':
      return {
        ...common,
        kind: 'lifecycle',
        ...(optionalString(event.runId)
          ? { runId: optionalString(event.runId) }
          : {}),
      };
    case 'workflow.state-changed':
      return {
        ...common,
        kind: 'lifecycle',
        ...(optionalString(event.status, 32)
          ? { status: optionalString(event.status, 32) }
          : {}),
        ...(optionalString(event.phase, 64)
          ? { phase: optionalString(event.phase, 64) }
          : {}),
      };
    case 'plan.updated': {
      const counts: Record<string, number> = {};
      if (Array.isArray(event.entries)) {
        for (const entry of event.entries.slice(0, 500)) {
          const status = optionalString(record(entry).status, 32);
          if (status) counts[status] = (counts[status] ?? 0) + 1;
        }
      }
      return { ...common, kind: 'plan', counts };
    }
    case 'platform.mutation':
      return {
        ...common,
        kind: 'tool',
        ...(optionalString(event.tool)
          ? { toolName: optionalString(event.tool) }
          : {}),
        ...(optionalString(event.outcome, 32)
          ? { status: optionalString(event.outcome, 32) }
          : {}),
      };
    case 'session.state-changed':
      return {
        ...common,
        kind: 'lifecycle',
        ...(optionalString(event.to, 32)
          ? { state: optionalString(event.to, 32) }
          : {}),
        ...(optionalString(event.from, 32)
          ? { previousState: optionalString(event.from, 32) }
          : {}),
      };
    case 'session.exited':
    case 'turn.aborted':
      return { ...common, kind: 'lifecycle', status: 'stopped' };
    case 'turn.started':
      return { ...common, kind: 'lifecycle', status: 'running' };
    default:
      return { ...common, kind: 'lifecycle' };
  }
}

interface RawTaskEventPage {
  session?: Record<string, unknown>;
  events?: Array<{ sequence?: unknown; event?: unknown }>;
  hasMore?: unknown;
  nextSequence?: unknown;
}

function taskTargetFromDelegation(
  delegation: Record<string, unknown>,
): DelegatedTaskSnapshot['target'] | undefined {
  const kind = delegation.targetKind;
  const id = optionalString(delegation.targetId);
  // The launch binding event uses `agent`, while the canonical orchestration
  // summary names the same external target `agent-app`. Both remain one public
  // delegated-task target: an Agent. Keep accepting only those two explicit
  // production shapes; task/environment/read-authority checks stay separate.
  if ((kind === 'agent' || kind === 'agent-app') && id) {
    return { kind: 'agent', id };
  }
  return undefined;
}

function delegatedTaskListLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TASK_LIST_LIMIT;
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_TASK_LIST_LIMIT
  ) {
    throw new Error(
      `Delegated task list limit must be between 1 and ${MAX_TASK_LIST_LIMIT}`,
    );
  }
  return value;
}

function delegatedTaskCandidate(
  rawSession: unknown,
  environmentId: string,
): Record<string, unknown> | undefined {
  const session = record(rawSession);
  const delegation = record(session.delegation);
  const taskId = safeIdentifier(delegation.taskId);
  const threadId = safeIdentifier(session.threadId);
  if (
    !taskId ||
    taskId !== threadId ||
    delegation.environmentId !== environmentId ||
    !taskTargetFromDelegation(delegation)
  ) {
    return undefined;
  }
  return session;
}

async function verifyDelegatedTaskListItem(options: {
  target: DelegationTarget;
  session: Record<string, unknown>;
  readAuthority: SessionReadAuthority;
  orchestrationService?: OrchestrationService;
}): Promise<DelegatedTaskListItem | undefined> {
  const taskId = safeIdentifier(record(options.session.delegation).taskId);
  if (!taskId) return undefined;

  let page: RawTaskEventPage | undefined;
  try {
    page =
      options.target.kind === 'current' && options.orchestrationService
        ? (((await options.orchestrationService.readSessionEventPage(taskId, {
            afterSequence: 0,
            limit: TASK_BINDING_EVENT_LIMIT,
            authority: options.readAuthority,
          })) as RawTaskEventPage | null) ?? undefined)
        : await getOrchestrationSessionEventPage<RawTaskEventPage>(
            options.target.apiBase,
            taskId,
            { afterSequence: 0, limit: TASK_BINDING_EVENT_LIMIT },
            options.target.requestOptions,
          );
  } catch {
    return undefined;
  }
  if (!page || !Array.isArray(page.events)) return undefined;

  const events = page.events.map((entry) => record(entry.event));
  const metadata = sessionBinding({ events });
  const boundTarget = delegationTargetBinding(metadata);
  const boundTargetId = safeIdentifier(boundTarget?.id);
  const boundUserId = metadata?.userId;
  if (
    metadata?.taskId !== taskId ||
    metadata?.environmentId !== options.target.environmentId ||
    !boundTarget ||
    !boundTargetId ||
    (typeof boundUserId === 'string' &&
      boundUserId !== options.readAuthority.userId)
  ) {
    return undefined;
  }

  const session = record(page.session);
  if (safeIdentifier(session.threadId) !== taskId) return undefined;
  const eventCount = optionalCount(session.eventCount);
  if (eventCount === undefined) return undefined;
  const status = taskStatus(session);
  const lastEventMethod = optionalString(session.lastEventMethod, 128);
  const lastEventAt = optionalString(session.lastEventAt, 64);
  const provider = safeIdentifier(session.provider);
  const model = safeIdentifier(session.model);
  const projectSlug = safeIdentifier(metadata.projectSlug);
  const parentTaskId = safeIdentifier(metadata.parentTaskId);

  return {
    conversationId: taskId,
    taskId,
    sessionId: taskId,
    currentSessionId: taskId,
    status,
    environment: {
      id: options.target.environmentId,
      name: safeLabel(options.target.environmentName, 'Selected environment'),
      kind: options.target.kind,
    },
    target: { kind: boundTarget.kind, id: boundTargetId },
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(projectSlug ? { projectSlug } : {}),
    ...(parentTaskId ? { parentTaskId } : {}),
    eventCount,
    ...(lastEventMethod
      ? {
          lastEvent: {
            method: lastEventMethod,
            ...(lastEventAt ? { createdAt: lastEventAt } : {}),
          },
        }
      : {}),
    canInterrupt: status === 'queued' || status === 'running',
    resumable: conversationCanAcceptFollowUp(status),
  };
}

/**
 * Recover compact task handles without replaying task history. Candidate
 * summaries are bounded, then the first event page is used only to verify the
 * persisted environment/target/user binding before a task is disclosed.
 */
export async function listDelegatedTasks(
  input: DelegatedTaskListInput,
  orchestrationService?: OrchestrationService,
): Promise<DelegatedTaskInventory> {
  const limit = delegatedTaskListLimit(input.limit);
  const readAuthority = readAuthorityForInput(input);
  const target = await resolveTarget({ environmentId: input.environmentId });
  localServiceRequiredInHostedMode(target, readAuthority, orchestrationService);
  let rawSessions: unknown;
  try {
    rawSessions =
      target.kind === 'current' && orchestrationService
        ? await orchestrationService.listSessionReadModel(readAuthority)
        : await listOrchestrationSessions(
            target.apiBase,
            target.requestOptions,
          );
  } catch {
    throw new Error(
      'Delegated task inventory is unavailable on the selected Station',
    );
  }
  if (!Array.isArray(rawSessions)) {
    throw new Error(
      'Delegated task inventory is unavailable on the selected Station',
    );
  }

  const candidates = rawSessions
    .map((session) => delegatedTaskCandidate(session, target.environmentId))
    .filter((session): session is Record<string, unknown> => Boolean(session))
    .sort((left, right) =>
      (optionalString(right.updatedAt, 64) ?? '').localeCompare(
        optionalString(left.updatedAt, 64) ?? '',
      ),
    );
  const scanLimited = candidates.length > MAX_TASK_LIST_SCAN;
  const scanned = candidates.slice(0, MAX_TASK_LIST_SCAN);
  const tasks: DelegatedTaskListItem[] = [];

  for (let index = 0; index < scanned.length; index += TASK_LIST_VERIFY_BATCH) {
    const batch = await Promise.all(
      scanned.slice(index, index + TASK_LIST_VERIFY_BATCH).map((session) =>
        verifyDelegatedTaskListItem({
          target,
          session,
          readAuthority,
          orchestrationService,
        }),
      ),
    );
    tasks.push(
      ...batch.filter(
        (task): task is DelegatedTaskListItem => task !== undefined,
      ),
    );
    if (tasks.length > limit) break;
  }

  return {
    environment: {
      id: target.environmentId,
      name: safeLabel(target.environmentName, 'Selected environment'),
      kind: target.kind,
    },
    tasks: tasks.slice(0, limit),
    truncated: scanLimited || tasks.length > limit,
  };
}

/** Read one bounded, secret-minimized page of delegated task activity. */
export async function observeDelegatedTaskEvents(
  input: DelegatedTaskEventsInput,
  orchestrationService?: OrchestrationService,
): Promise<DelegatedTaskEventPage> {
  const afterSequence = parseTaskEventCursor(input.cursor);
  const limit = taskEventLimit(input.limit);
  const readAuthority = readAuthorityForInput(input);
  const selectedTarget = await resolveTarget({
    environmentId: input.environmentId,
  });
  localServiceRequiredInHostedMode(
    selectedTarget,
    readAuthority,
    orchestrationService,
  );
  if (selectedTarget.kind !== 'current' || !orchestrationService) {
    const query = new URLSearchParams({
      ...(input.cursor ? { cursor: input.cursor } : {}),
      ...(input.limit !== undefined ? { limit: String(input.limit) } : {}),
    }).toString();
    return normalizeDelegatedIdentity(
      await getCanonical<DelegatedTaskEventPage>(
        selectedTarget,
        `/api/orchestration/delegations/${encodeURIComponent(input.taskId)}/events${
          query ? `?${query}` : ''
        }`,
        'The selected Station could not read delegated task events',
      ),
    );
  }
  const loaded = await loadDelegatedTask(input, orchestrationService);
  const currentSessionId = optionalString(loaded.detail.session?.threadId);
  if (!currentSessionId) {
    throw new Error('Delegated task current session has no identity');
  }
  const page =
    loaded.target.kind === 'current' && orchestrationService
      ? await orchestrationService.readSessionEventPage(currentSessionId, {
          afterSequence,
          limit,
          authority: readAuthority,
        })
      : await getOrchestrationSessionEventPage<RawTaskEventPage>(
          loaded.target.apiBase,
          currentSessionId,
          { afterSequence, limit },
          loaded.target.requestOptions,
        );
  if (!page) {
    throw new Error('Delegated task not found');
  }
  const session = record(page.session);
  const eventCount = optionalCount(session.eventCount);
  if (eventCount === undefined) {
    throw new Error('The selected Station returned invalid task event state');
  }
  if (afterSequence > eventCount) {
    throw new Error(
      'The task event cursor is ahead of the available task history; restart without a cursor',
    );
  }
  const rawNextSequence = optionalCount(page.nextSequence);
  if (
    rawNextSequence === undefined ||
    rawNextSequence < afterSequence ||
    rawNextSequence > eventCount ||
    !Array.isArray(page.events) ||
    page.events.length > limit ||
    typeof page.hasMore !== 'boolean'
  ) {
    throw new Error('The selected Station returned invalid task event state');
  }
  let previousSequence = afterSequence;
  const events = page.events.map((entry) => {
    const sequence = optionalCount(entry.sequence);
    if (
      sequence === undefined ||
      sequence <= previousSequence ||
      sequence > rawNextSequence
    ) {
      throw new Error('The selected Station returned invalid task event state');
    }
    previousSequence = sequence;
    return projectDelegatedTaskEvent(sequence, entry.event);
  });
  if (
    previousSequence !== rawNextSequence ||
    (page.hasMore && events.length === 0)
  ) {
    throw new Error('The selected Station returned invalid task event state');
  }
  const status = taskStatus(session);
  if (optionalString(session.threadId) !== currentSessionId) {
    throw new Error(
      'The selected Station returned a different current Session',
    );
  }
  const snapshot = snapshotFor(loaded);
  return {
    conversationId: snapshot.conversationId,
    taskId: snapshot.taskId,
    sessionId: currentSessionId,
    currentSessionId,
    status,
    environment: {
      id: loaded.target.environmentId,
      name: loaded.target.environmentName,
      kind: loaded.target.kind,
    },
    target: snapshot.target,
    ...(optionalString(session.provider)
      ? { provider: optionalString(session.provider) }
      : {}),
    ...(optionalString(session.model)
      ? { model: optionalString(session.model) }
      : {}),
    eventCount,
    events,
    nextCursor: taskEventCursor(rawNextSequence),
    hasMore: page.hasMore,
    canInterrupt: status === 'queued' || status === 'running',
    resumable: conversationCanAcceptFollowUp(status),
  };
}

/** Read a secret-free, provider-neutral delegated task snapshot. */
export async function observeDelegatedTask(
  input: DelegatedTaskReferenceInput,
  orchestrationService?: OrchestrationService,
): Promise<DelegatedTaskSnapshot> {
  const readAuthority = readAuthorityForInput(input);
  const target = await resolveTarget({ environmentId: input.environmentId });
  localServiceRequiredInHostedMode(target, readAuthority, orchestrationService);
  if (target.kind !== 'current' || !orchestrationService) {
    try {
      return normalizeDelegatedIdentity(
        await getCanonical<DelegatedTaskSnapshot>(
          target,
          `/api/orchestration/delegations/${encodeURIComponent(input.taskId)}`,
          'The selected Station could not read the delegated task',
        ),
      );
    } catch (error) {
      if (
        !(error instanceof CanonicalDelegationReadError) ||
        error.kind !== 'http' ||
        error.status !== 404
      ) {
        throw error;
      }
      // Older target Stations do not expose the conversation-aware delegation
      // projection. Their 1:1 root Session is still a valid compatibility
      // shape, and the SDK normalizer supplies the additive identity aliases.
      return normalizeDelegatedIdentity(
        snapshotFor(await loadDelegatedTask(input, orchestrationService)),
      );
    }
  }
  return snapshotFor(await loadDelegatedTask(input, orchestrationService));
}

/**
 * Continue the durable Conversation through its serving Station's shared
 * foreground seam. A stopped predecessor is intentionally replaced by a
 * child Session; supervision keeps resolving that child separately.
 */
export async function continueDelegatedTask(
  input: ContinueDelegatedTaskInput,
  orchestrationService?: OrchestrationService,
): Promise<DelegatedTaskFollowUpHandle> {
  if (!input.message.trim()) {
    throw new Error('Task follow-up message is required');
  }
  const readAuthority = readAuthorityForInput(input);
  const selectedTarget = await resolveTarget({
    environmentId: input.environmentId,
  });
  localServiceRequiredInHostedMode(
    selectedTarget,
    readAuthority,
    orchestrationService,
  );
  if (selectedTarget.kind !== 'current' || !orchestrationService) {
    return normalizeDelegatedIdentity(
      await postCanonical<DelegatedTaskFollowUpHandle>(
        selectedTarget,
        `/api/orchestration/delegations/${encodeURIComponent(input.taskId)}/continue`,
        {
          message: input.message,
          ...(input.model ? { model: input.model } : {}),
          ...(input.modelOptions ? { modelOptions: input.modelOptions } : {}),
        },
        'The selected Station could not continue the delegated task',
      ),
    );
  }
  const loaded = await loadDelegatedTask(input, orchestrationService);
  const snapshot = snapshotFor(loaded);
  // The shared execution-target resolver owns model-option capability checks.
  // A completed predecessor may be replaced by a child with another provider,
  // so prevalidating against the predecessor snapshot can reject a valid
  // continuation (or accept an invalid one) before the authoritative resolver.
  const handle = await continueExecutionTargetMessage(
    {
      conversationId: snapshot.conversationId,
      message: input.message,
      userId: readAuthority.userId,
      environment:
        input.environmentId === undefined
          ? { kind: 'current' }
          : { kind: 'saved', id: environmentId(input.environmentId) },
      ...(input.model || input.modelOptions
        ? {
            model: {
              ...(input.model ? { override: input.model } : {}),
              ...(input.modelOptions ? { options: input.modelOptions } : {}),
            },
          }
        : {}),
      readAuthority,
    },
    orchestrationService,
  );
  delegatedTaskFollowUps.add(1, {
    target: snapshot.target.kind,
    environment: loaded.target.kind,
  });
  return {
    conversationId: handle.conversationId,
    taskId: snapshot.taskId,
    sessionId: handle.sessionId,
    currentSessionId: handle.sessionId,
    status: 'dispatched',
    environment: snapshot.environment,
    target: snapshot.target,
    ...(input.model || snapshot.model
      ? { model: input.model ?? snapshot.model }
      : {}),
  };
}

/** Resolve one currently open provider request through the task's binding. */
export async function respondToDelegatedTaskRequest(
  input: RespondToDelegatedTaskRequestInput,
  orchestrationService?: OrchestrationService,
): Promise<DelegatedTaskRequestResponseHandle> {
  const readAuthority = readAuthorityForInput(input);
  const selectedTarget = await resolveTarget({
    environmentId: input.environmentId,
  });
  localServiceRequiredInHostedMode(
    selectedTarget,
    readAuthority,
    orchestrationService,
  );
  if (selectedTarget.kind !== 'current' || !orchestrationService) {
    return normalizeDelegatedIdentity(
      await postCanonical<DelegatedTaskRequestResponseHandle>(
        selectedTarget,
        `/api/orchestration/delegations/${encodeURIComponent(input.taskId)}/respond`,
        { requestId: input.requestId, decision: input.decision },
        'The selected Station could not resolve the delegated task request',
      ),
    );
  }
  const loaded = await loadDelegatedTask(input, orchestrationService);
  const events = loaded.detail.events ?? [];
  const requestIsOpen = events.some(
    (event) =>
      event.method === 'request.opened' && event.requestId === input.requestId,
  );
  const requestWasResolved = events.some(
    (event) =>
      event.method === 'request.resolved' &&
      event.requestId === input.requestId,
  );
  if (!requestIsOpen || requestWasResolved) {
    throw new Error('Delegated task request is not open');
  }
  const snapshot = snapshotFor(loaded);
  if (loaded.target.kind === 'current' && orchestrationService) {
    await orchestrationService.dispatchWithReceipt(
      {
        type: 'respondToRequest',
        threadId: snapshot.currentSessionId,
        requestId: input.requestId,
        decision: input.decision,
      },
      dispatchContextForAuthority(readAuthority),
    );
  } else {
    await respondToRequest(
      loaded.target.apiBase,
      {
        threadId: snapshot.currentSessionId,
        requestId: input.requestId,
        decision: input.decision,
      },
      loaded.target.requestOptions,
    );
  }
  delegatedTaskRequestResponses.add(1, {
    target: snapshot.target.kind,
    environment: loaded.target.kind,
    decision: input.decision,
  });
  return {
    conversationId: snapshot.conversationId,
    taskId: snapshot.taskId,
    sessionId: snapshot.sessionId,
    currentSessionId: snapshot.currentSessionId,
    requestId: input.requestId,
    status: 'resolved',
    decision: input.decision,
    environment: snapshot.environment,
    target: snapshot.target,
  };
}

/** Interrupt the active turn after re-verifying environment and user binding. */
export async function interruptDelegatedTask(
  input: DelegatedTaskReferenceInput & { turnId?: string },
  orchestrationService?: OrchestrationService,
): Promise<DelegatedTaskSnapshot & { interruptRequested: true }> {
  const readAuthority = readAuthorityForInput(input);
  const selectedTarget = await resolveTarget({
    environmentId: input.environmentId,
  });
  localServiceRequiredInHostedMode(
    selectedTarget,
    readAuthority,
    orchestrationService,
  );
  if (selectedTarget.kind !== 'current' || !orchestrationService) {
    return normalizeDelegatedIdentity(
      await postCanonical<DelegatedTaskSnapshot & { interruptRequested: true }>(
        selectedTarget,
        `/api/orchestration/delegations/${encodeURIComponent(input.taskId)}/interrupt`,
        input.turnId ? { turnId: input.turnId } : {},
        'The selected Station could not interrupt the delegated task',
      ),
    );
  }
  const loaded = await loadDelegatedTask(input, orchestrationService);
  const snapshot = snapshotFor(loaded);
  if (!snapshot.canInterrupt) {
    throw new Error(
      `Delegated task cannot be interrupted while ${snapshot.status}`,
    );
  }
  if (loaded.target.kind === 'current' && orchestrationService) {
    await orchestrationService.dispatchWithReceipt(
      {
        type: 'interruptTurn',
        threadId: snapshot.currentSessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      },
      dispatchContextForAuthority(readAuthority),
    );
  } else {
    await interruptTurn(
      loaded.target.apiBase,
      {
        threadId: snapshot.currentSessionId,
        ...(input.turnId ? { turnId: input.turnId } : {}),
      },
      loaded.target.requestOptions,
    );
  }
  delegatedTaskInterrupts.add(1, {
    target: snapshot.target.kind,
    environment: loaded.target.kind,
  });
  return { ...snapshot, interruptRequested: true };
}

export async function delegateTask(
  input: DelegateTaskInput,
  orchestrationService?: OrchestrationService,
): Promise<DelegatedTaskHandle> {
  const readAuthority = readAuthorityForInput(input);
  const selectedTarget = await resolveTarget({
    environmentId:
      input.target.environment.kind === 'saved'
        ? input.target.environment.id
        : undefined,
  });
  localServiceRequiredInHostedMode(
    selectedTarget,
    readAuthority,
    orchestrationService,
  );
  if (selectedTarget.kind !== 'current' || !orchestrationService) {
    const pinnedTarget = await pinSshDispatchWorkspace(
      selectedTarget,
      input.target,
    );
    return postCanonical<DelegatedTaskHandle>(
      selectedTarget,
      '/api/orchestration/delegations',
      {
        prompt: input.prompt,
        target: { ...pinnedTarget, environment: { kind: 'current' } },
        ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
      },
      'The selected Station could not start the delegated task',
    );
  }
  // station#4543 LOW-2: a caller-supplied `sessionId` becomes this task's
  // `metadata.conversationId` below (via `conversationIdentity`) — reject a
  // non-conforming custom id here, before any resolution HTTP call, rather
  // than let it be stamped into a reserved key whose contract promises
  // Station resolution. A server-minted id always conforms, so this only
  // ever rejects caller input.
  if (input.sessionId && !TASK_SESSION_ID_PATTERN.test(input.sessionId)) {
    throw new Error(
      `Invalid session id '${input.sessionId}': a custom session id must match the 'task:<uuid>' form Station mints (e.g. 'task:${randomUUID()}').`,
    );
  }
  const resolverDependencies = {
    resolveEnvironmentAccess: async (_executionTarget: ExecutionTarget) => {
      const target = selectedTarget;
      return {
        apiBase: target.apiBase,
        environmentId: target.environmentId,
        environmentName: target.environmentName,
        kind: target.kind,
        ...(target.projectPath
          ? { verifiedProjectPath: target.projectPath }
          : {}),
        ...(target.remoteHome ? { remoteHome: target.remoteHome } : {}),
        ...(target.requestOptions
          ? { requestOptions: target.requestOptions }
          : {}),
      } satisfies EnvironmentAccess;
    },
    getAgent: async (access, id) =>
      (await getAgent(
        access.apiBase,
        id,
        access.requestOptions,
      )) as ExecutionTargetAgentView,
    getConnection: async (access, id) =>
      readConnection(access as DelegationTarget, id),
    getProject: async (access, slug) =>
      (await getProject(access.apiBase, slug, access.requestOptions)) as {
        workingDirectory?: string;
        defaultWorkspaceIsolation?: 'shared' | 'worktree';
      },
    getProviderAdapter: (provider) =>
      orchestrationService.getProviderAdapter(provider),
  } satisfies Parameters<typeof resolveExecutionTarget>[1];
  const resolved = await resolveExecutionTarget(
    input.target,
    resolverDependencies,
  );
  const target: DelegationTarget = {
    apiBase: resolved.access.apiBase,
    environmentId: resolved.access.environmentId,
    environmentName: resolved.access.environmentName,
    kind: resolved.access.kind,
    ...(resolved.access.verifiedProjectPath
      ? { projectPath: resolved.access.verifiedProjectPath }
      : {}),
    ...(resolved.access.requestOptions
      ? { requestOptions: resolved.access.requestOptions }
      : {}),
  };
  const project: ResolvedDelegationProject | undefined = resolved.workspace
    ? {
        ...(resolved.workspace.kind === 'project'
          ? {
              slug: resolved.workspace.projectSlug,
              slugJoin:
                target.kind === 'current'
                  ? ('local' as const)
                  : resolved.projectDirectoryExactMatch
                    ? ('directory-corroborated' as const)
                    : ('unverified-cross-machine' as const),
            }
          : {}),
        path: resolved.workspace.cwd,
      }
    : undefined;
  const sessionId = input.sessionId || `task:${randomUUID()}`;
  const resolvedCwd = resolved.workspace?.cwd;
  const bindingTarget = {
    kind: 'agent' as const,
    id: resolved.agentId,
  };
  const session = await orchestrationService.readSession(
    sessionId,
    readAuthority,
  );
  if (session) {
    assertSessionBinding(session, target, bindingTarget, readAuthority.userId);
  } else {
    // station#4543 fix: `environmentId` (like `conversationId`) is a
    // RESERVED_ORCHESTRATION_METADATA_KEYS entry — `prepareStart` strips it
    // from every public `sessionCommands.execute` caller unconditionally,
    // trusted or not (see provider.ts's docblock). Writing it in the plain
    // `metadata` bag below is silently discarded before it ever reaches the
    // adapter or the persisted `session.started`/`session.configured`
    // event, which is exactly the metadata `sessionBinding()` (this file,
    // above) requires to recognize a delegated-task binding at all — so
    // every `station delegate status`/`events` lookup for a task this
    // function just created failed closed with "does not match a
    // delegated-task binding", regardless of target/provider kind.
    // `executeExecutionTargetMessage`'s own `startSession` closure (below,
    // reached indirectly by `continueDelegatedTask` via
    // `continueExecutionTargetMessage`'s tail call into it) already routes
    // through this exact internal-only escape hatch for the same reason
    // (`conversationIdentity` re-stamps `environmentId`/`conversationId`
    // AFTER the strip runs) — commit a8a2dcb01 introduced BOTH the strip
    // and that escape-hatch fix together, migrating the foreground/continue
    // path in the same change that regressed this one. This create path is
    // now migrated to match it.
    const started = await orchestrationService.startSessionInternal(
      {
        type: 'start-session',
        input: {
          threadId: sessionId,
          provider: resolved.provider,
          ...(resolvedCwd ? { cwd: resolvedCwd } : {}),
          ...(resolved.workspace?.kind === 'project'
            ? { workspaceIsolation: resolved.workspace.workspaceIsolation }
            : {}),
          ...(resolved.modelId ? { modelId: resolved.modelId } : {}),
          ...(resolved.modelOptions
            ? { modelOptions: { ...resolved.modelOptions } }
            : {}),
          metadata: {
            agentId: resolved.agentId,
            agentSlug: resolved.agentId,
            ...(resolved.engine.kind === 'connection'
              ? { connectionId: resolved.engine.connectionId }
              : {}),
            targetKind: bindingTarget.kind,
            targetId: bindingTarget.id,
            environmentId: target.environmentId,
            environmentName: target.environmentName,
            taskId: sessionId,
            ...(project?.slug ? { projectSlug: project.slug } : {}),
            // station#1463: record the resolved project join on every Agent.
            ...(project?.slugJoin ? { projectSlugJoin: project.slugJoin } : {}),
            ...(input.parentTaskId ? { parentTaskId: input.parentTaskId } : {}),
            ...(input.delegation ? { delegation: input.delegation } : {}),
            ...(readAuthority.userId ? { userId: readAuthority.userId } : {}),
          },
        },
      },
      dispatchContextForAuthority(readAuthority),
      {
        conversationIdentity: {
          conversationId: sessionId,
          environmentId: target.environmentId,
        },
      },
    );
    if (started.status === 'indeterminate') {
      throw new Error(
        `${started.message} Session ${started.session.threadId} may already be running; do not retry automatically.`,
      );
    }
    if (started.status !== 'accepted') {
      const error = new Error(started.message) as Error & {
        code?: string;
        retryable?: boolean;
      };
      error.code = started.code;
      error.retryable = started.code === 'resource_posture_critical';
      throw error;
    }
  }
  await orchestrationService.dispatchWithReceipt(
    {
      type: 'sendTurn',
      input: {
        threadId: sessionId,
        input: input.prompt,
        // See the foreground sendTurn: the Agent's declared model is a
        // start-time selection, not a per-turn override.
        ...(input.target.model?.override
          ? { modelId: input.target.model.override }
          : {}),
        ...(resolved.modelOptions
          ? { modelOptions: { ...resolved.modelOptions } }
          : {}),
      },
    },
    dispatchContextForAuthority(readAuthority),
  );
  delegatedTasks.add(1, {
    target: bindingTarget.kind,
    environment: target.kind,
  });
  return {
    ...handleFor(input, target, project, sessionId),
    target: { kind: 'agent', id: resolved.agentId },
    resolution: resolved.receipt,
  };
}

/**
 * Controlling-Station foreground entrypoint. API routes call this function;
 * CLI/UI/MCP callers never receive or construct the target Environment's
 * apiBase, SSH tunnel, credential, or engine connection binding.
 */
export async function executeExecutionTargetMessage(
  input: AuthorityBearingForegroundMessageInput,
  orchestrationService?: OrchestrationService,
): Promise<ForegroundMessageHandle> {
  const readAuthority = readAuthorityForInput(input);
  const selectedTarget = await resolveTarget({
    environmentId:
      input.target.environment.kind === 'saved'
        ? input.target.environment.id
        : undefined,
  });
  localServiceRequiredInHostedMode(
    selectedTarget,
    readAuthority,
    orchestrationService,
  );
  if (selectedTarget.kind !== 'current' || !orchestrationService) {
    if (input.resolveAttachments) {
      throw new Error(
        'Current-host staged attachments cannot be sent to another Station.',
      );
    }
    const pinnedTarget = await pinSshDispatchWorkspace(
      selectedTarget,
      input.target,
    );
    return postForegroundMessage(
      selectedTarget,
      '/api/orchestration/chat',
      {
        ...input,
        target: { ...pinnedTarget, environment: { kind: 'current' } },
      },
      'The selected Station could not execute the Agent message',
    );
  }
  const resolverDependencies = {
    resolveEnvironmentAccess: async (_executionTarget: ExecutionTarget) => {
      const target = selectedTarget;
      return {
        apiBase: target.apiBase,
        environmentId: target.environmentId,
        environmentName: target.environmentName,
        kind: target.kind,
        ...(target.projectPath
          ? { verifiedProjectPath: target.projectPath }
          : {}),
        ...(target.remoteHome ? { remoteHome: target.remoteHome } : {}),
        ...(target.requestOptions
          ? { requestOptions: target.requestOptions }
          : {}),
      } satisfies EnvironmentAccess;
    },
    getAgent: async (access: EnvironmentAccess, id: AgentId) =>
      (await getAgent(
        access.apiBase,
        id,
        access.requestOptions,
      )) as ExecutionTargetAgentView,
    getConnection: async (access: EnvironmentAccess, id) =>
      readConnection(access as DelegationTarget, id),
    getProject: async (access: EnvironmentAccess, slug: string) =>
      (await getProject(access.apiBase, slug, access.requestOptions)) as {
        workingDirectory?: string;
        defaultWorkspaceIsolation?: 'shared' | 'worktree';
      },
    getProviderAdapter: (provider) =>
      orchestrationService.getProviderAdapter(provider),
    readSessionBinding: async (
      _access: EnvironmentAccess,
      sessionId: string,
    ) => {
      const rootDetail = await orchestrationService.readSession(
        sessionId,
        readAuthority,
      );
      if (!rootDetail) return null;
      const currentSessionId =
        orchestrationService.currentConversationSessionId(sessionId);
      const currentDetail = await orchestrationService.readSession(
        currentSessionId,
        readAuthority,
      );
      const metadata = sessionBinding(rootDetail);
      const currentMetadata = currentDetail
        ? sessionBinding(currentDetail)
        : undefined;
      const reservedHandoff = currentDetail
        ? undefined
        : orchestrationService.reservedConversationHandoff(currentSessionId);
      const boundTarget = reservedHandoff
        ? { kind: 'agent' as const, id: reservedHandoff.targetAgentId }
        : delegationTargetBinding(currentMetadata);
      if (
        !metadata ||
        !boundTarget ||
        typeof metadata.environmentId !== 'string'
      ) {
        throw new Error(
          'The requested conversation has no verified execution binding',
        );
      }
      return {
        environmentId: metadata.environmentId,
        agentId: boundTarget.id,
        ...(typeof metadata.projectSlug === 'string'
          ? { projectSlug: metadata.projectSlug }
          : {}),
        ...(typeof rootDetail.session.cwd === 'string'
          ? { cwd: rootDetail.session.cwd }
          : {}),
        ...(metadata.workspaceIsolation &&
        typeof metadata.workspaceIsolation === 'object' &&
        ((metadata.workspaceIsolation as { mode?: unknown }).mode ===
          'shared' ||
          (metadata.workspaceIsolation as { mode?: unknown }).mode ===
            'worktree')
          ? {
              workspaceIsolation: metadata.workspaceIsolation as {
                mode: 'shared' | 'worktree';
              },
            }
          : {}),
        ...(metadata.worktree && typeof metadata.worktree === 'object'
          ? {
              worktree:
                metadata.worktree as import('@kontourai/station-contracts/workspace-isolation').WorktreeSessionMetadata,
            }
          : {}),
        ...(typeof metadata.userId === 'string'
          ? { userId: metadata.userId }
          : {}),
        ...(reservedHandoff?.targetConnectionId
          ? { connectionId: reservedHandoff.targetConnectionId }
          : typeof currentMetadata?.connectionId === 'string'
            ? { connectionId: currentMetadata.connectionId }
            : {}),
      };
    },
    resolveConversationSession: async (
      _access: EnvironmentAccess,
      conversationId: string,
      requested: { provider: ProviderKind; connectionId?: string },
    ) => {
      // The runtime service always owns this seam. Keep explicitly scoped
      // lightweight compatibility doubles (and an older remote Station
      // reached through its own HTTP route) from inventing a child locally.
      if (
        typeof orchestrationService.resolveConversationContinuation !==
        'function'
      ) {
        return { sessionId: conversationId, startRequired: false };
      }
      return await orchestrationService.resolveConversationContinuation(
        conversationId,
        readAuthority,
        requested,
      );
    },
    prepareConversationHandoff: async (access: EnvironmentAccess, handoff) => {
      // The target was resolved by the foreground seam immediately before
      // this call, so configured-agent/engine readiness is proven before the
      // durable marker mutates. Cross-Environment transfer is deliberately
      // not this v1: the immutable conversation binding above requires this
      // exact Environment and workspace.
      const prepared = await orchestrationService.prepareConversationHandoff(
        handoff.conversationId,
        readAuthority,
        {
          agentId: handoff.agentId,
          environmentId: access.environmentId,
          ...(handoff.connectionId
            ? { connectionId: handoff.connectionId }
            : {}),
          ...(handoff.modelId ? { modelId: handoff.modelId } : {}),
          idempotencyKey: handoff.idempotencyKey,
          messageDigest: handoff.messageDigest,
        },
      );
      return {
        marker: prepared.marker,
        ...(prepared.transcriptSeed
          ? { transcriptSeed: prepared.transcriptSeed }
          : {}),
        outcome: prepared.outcome,
        carried: prepared.carried,
        reset: prepared.reset,
        ...(prepared.contextBoundary
          ? { contextBoundary: prepared.contextBoundary }
          : {}),
      };
    },
    readConversationHandoffEffect: async (_access, handoff) =>
      orchestrationService.readConversationHandoffStatus(
        handoff.conversationId,
        handoff.idempotencyKey,
        readAuthority,
      ),
    claimConversationContextBoundaryColdStart: (
      _access,
      boundaryId,
      startCommandId,
    ) => {
      orchestrationService.claimConversationContextBoundaryColdStart(
        boundaryId,
        startCommandId,
      );
    },
    consumeConversationContextBoundary: (
      _access,
      boundaryId,
      startCommandId,
    ) => {
      orchestrationService.consumeConversationContextBoundary(
        boundaryId,
        startCommandId,
      );
    },
    releaseConversationContextBoundaryFailedClaim: (
      _access,
      boundaryId,
      indeterminate,
    ) => {
      orchestrationService.releaseConversationContextBoundaryFailedClaim(
        boundaryId,
        indeterminate,
      );
    },
    startSession: async (_access: EnvironmentAccess, startInput) => {
      // station#2821 hardening L3: `sessionVisibility` is a reserved
      // metadata key (no public startSession command may set it — see
      // RESERVED_ORCHESTRATION_METADATA_KEYS), so the ordinary public
      // command surface strips it unconditionally. This foreground seam is
      // the one legitimate, server-internal writer: `startInput.metadata`
      // was composed entirely by `executeForegroundMessage` above, never by
      // an HTTP caller, so reading it here is safe. Route through the
      // internal-only escape hatch so orchestration re-stamps it after the
      // strip instead of relying on it merely surviving.
      const ephemeral =
        startInput.metadata?.[SESSION_VISIBILITY_METADATA_KEY] === 'ephemeral';
      const conversationId = startInput.metadata?.conversationId;
      const environmentId = startInput.metadata?.environmentId;
      if (
        typeof conversationId !== 'string' ||
        typeof environmentId !== 'string'
      ) {
        throw new Error('Foreground execution identity was not resolved');
      }
      const started = await orchestrationService.startSessionInternal(
        { type: 'start-session', input: startInput },
        dispatchContextForAuthority(readAuthority),
        {
          ...(ephemeral ? { ephemeralSessionVisibility: true } : {}),
          conversationIdentity: { conversationId, environmentId },
          ...(typeof startInput.metadata?.contextBoundary === 'object' &&
          startInput.metadata.contextBoundary !== null &&
          typeof (
            startInput.metadata.contextBoundary as { startCommandId?: unknown }
          ).startCommandId === 'string'
            ? {
                commandId: (
                  startInput.metadata.contextBoundary as {
                    startCommandId: string;
                  }
                ).startCommandId,
              }
            : {}),
        },
      );
      if (started.status === 'indeterminate') {
        throw new ForegroundMessageIndeterminateError(
          {
            code: FOREGROUND_MESSAGE_INDETERMINATE_CODE,
            outcome: 'indeterminate',
            receipt: started.receipt,
            receiptStatus: started.receiptStatus,
            session: started.session,
          },
          `${started.message} Session ${started.session.threadId} may already be running; do not retry automatically.`,
        );
      }
      if (started.status !== 'accepted') {
        const error = new Error(started.message);
        if (started.code) Object.assign(error, { code: started.code });
        throw error;
      }
      return {
        commandId: started.receipt.commandId,
        sessionId: started.session.threadId,
      };
    },
    sendTurn: async (_access: EnvironmentAccess, turnInput, context) => {
      const dispatched = await orchestrationService.dispatchWithReceipt(
        { type: 'sendTurn', input: turnInput },
        dispatchContextForAuthority(
          readAuthority,
          context?.clientOrigin,
          context?.principal,
        ),
      );
      if (!dispatched.result || !('turnId' in dispatched.result)) {
        throw new ForegroundMessageTurnIdentityUnavailableError(
          'Foreground turn acceptance did not include a provider turn id',
        );
      }
      return { turnId: dispatched.result.turnId };
    },
  } satisfies Parameters<typeof executeResolvedForegroundMessage>[1];
  return executeResolvedForegroundMessage(input, resolverDependencies);
}

/**
 * The only public-server entrypoint that can request an Agent/engine change
 * beneath an existing conversation.  It supplies an opaque intent; ordinary
 * foreground chat has no equivalent field or route.
 */
export async function handoffExecutionTargetMessage(
  input: AuthorityBearingForegroundMessageInput & { idempotencyKey: string },
  orchestrationService?: OrchestrationService,
): Promise<ForegroundMessageHandle> {
  if (input.target.environment.kind !== 'current') {
    throw new Error(
      'Agent/engine handoff is available only on the conversation current Environment.',
    );
  }
  return executeExecutionTargetMessage(
    {
      ...input,
      handoffIntent: createConversationHandoffIntent(input.idempotencyKey),
    },
    orchestrationService,
  );
}

export type ContinueForegroundMessageInput = Omit<
  AuthorityBearingForegroundMessageInput,
  'target' | 'conversationId'
> & {
  conversationId: string;
  environment?: EnvironmentRef;
  /** A server-validated next-turn selector for the bound Agent. */
  model?: ExecutionModelRequest;
};

/** Continue only through the Environment+Agent binding persisted at start. */
/**
 * The workspace a resumed conversation runs in, rebuilt from its own session
 * binding. Returns a spreadable fragment so an unbound conversation (a direct
 * chat with no workspace at all) still yields no `workspace` key, which is the
 * one shape the continuation guard accepts as legitimately absent.
 *
 * station#3421: the project shape was rebuilt and the directory shape was not,
 * so every conversation bound to a plain directory failed to resume.
 */
export function resumedWorkspaceBinding(
  metadata: Record<string, unknown> | undefined,
  sessionCwd: unknown,
): { workspace?: WorkspaceTarget } {
  if (typeof metadata?.projectSlug === 'string') {
    const isolation = metadata.workspaceIsolation;
    const mode =
      isolation && typeof isolation === 'object'
        ? (isolation as { mode?: unknown }).mode
        : undefined;
    return {
      workspace: {
        kind: 'project',
        projectSlug: metadata.projectSlug,
        ...(mode === 'shared' || mode === 'worktree'
          ? { workspaceIsolation: isolation as { mode: 'shared' | 'worktree' } }
          : {}),
      },
    };
  }
  // A directory binding is just as durable as a project one; it simply has no
  // slug to name it by. It lives on the session record rather than in the
  // binding metadata -- the same place the SSH branch above reads it from.
  if (typeof sessionCwd === 'string' && sessionCwd.trim() !== '') {
    return { workspace: { kind: 'directory', cwd: sessionCwd } };
  }
  return {};
}

export async function continueExecutionTargetMessage(
  input: ContinueForegroundMessageInput,
  orchestrationService?: OrchestrationService,
): Promise<ForegroundMessageHandle> {
  const readAuthority = readAuthorityForInput(input);
  const selectedTarget = await resolveTarget({
    environmentId:
      input.environment?.kind === 'saved' ? input.environment.id : undefined,
  });
  if (selectedTarget.kind !== 'current' || !orchestrationService) {
    if (selectedTarget.kind === 'ssh') {
      const detail = await existingSession(
        selectedTarget,
        input.conversationId,
      );
      const cwd = detail?.session?.cwd;
      if (typeof cwd !== 'string') {
        throw new Error(
          'The requested conversation has no persisted workspace binding',
        );
      }
      assertVerifiedSshWorkspace(
        selectedTarget,
        cwd,
        'The requested conversation workspace',
      );
    }
    return postForegroundMessage(
      selectedTarget,
      `/api/orchestration/chat/${encodeURIComponent(input.conversationId)}/continue`,
      {
        message: input.message,
        ...(input.attachments ? { attachments: input.attachments } : {}),
        ...(input.ambientContext
          ? { ambientContext: input.ambientContext }
          : {}),
        ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
        ...(input.model ? { model: input.model } : {}),
      },
      'Station could not continue the Agent conversation',
    );
  }
  const rootDetail = await orchestrationService.readSession(
    input.conversationId,
    readAuthority,
  );
  if (!rootDetail) throw new Error('The requested conversation was not found');
  const currentSessionId = orchestrationService.currentConversationSessionId(
    input.conversationId,
  );
  const currentDetail = await orchestrationService.readSession(
    currentSessionId,
    readAuthority,
  );
  const metadata = sessionBinding(rootDetail);
  const currentMetadata = currentDetail
    ? sessionBinding(currentDetail)
    : undefined;
  const reservedHandoff = currentDetail
    ? undefined
    : orchestrationService.reservedConversationHandoff(currentSessionId);
  const boundTarget = reservedHandoff
    ? { kind: 'agent' as const, id: reservedHandoff.targetAgentId }
    : delegationTargetBinding(currentMetadata);
  if (
    !boundTarget ||
    metadata?.environmentId !== selectedTarget.environmentId
  ) {
    throw new Error(
      'The requested conversation has no verified local Environment and Agent binding',
    );
  }
  return executeExecutionTargetMessage(
    {
      ...input,
      conversationId: input.conversationId,
      target: {
        environment: { kind: 'current' },
        agent: agentId(boundTarget.id),
        // station#3421: a continuation names a conversation, and that
        // conversation already knows its workspace -- so it is rebuilt from the
        // binding, never re-supplied by the caller (the CLI deliberately sends
        // none, and refuses workspace flags on a resume).
        //
        // Only the project shape used to be rebuilt. A conversation bound to a
        // DIRECTORY -- which is every chat started outside a registered project,
        // including every `station chat` from a shell -- got no workspace at
        // all, and the continuation guard reads an absent workspace beside a
        // bound cwd as a mismatch. So the resume command the CLI prints in its
        // own success output could never work.
        ...resumedWorkspaceBinding(metadata, record(rootDetail.session).cwd),
        ...(input.model ? { model: input.model } : {}),
      },
    },
    orchestrationService,
  );
}
