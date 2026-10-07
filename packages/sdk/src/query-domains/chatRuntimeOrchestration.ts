import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type { ConversationContextBoundaryProjection } from '@kontourai/station-contracts/conversation-context-boundary';
import type { HarnessQuestionAnswers } from '@kontourai/station-contracts/harness-questions';
import type { InputRequestContent } from '@kontourai/station-contracts/input-request';
import type {
  AdoptedSessionResult,
  AdoptSessionTarget,
  InterruptTurnResult,
  OrchestrationConversationEventWindow,
  OrchestrationSessionEventWindow,
} from '@kontourai/station-contracts/orchestration';
import {
  COOPERATIVE_STOP_BUDGET_MS,
  withNormalizedAnswerability,
} from '@kontourai/station-contracts/orchestration';
import { randomCorrelationId } from '@kontourai/station-shared/random-id';
import { useInfiniteQuery, useMutation, useQuery } from '@tanstack/react-query';
import { apiErrorMessage } from '../api-core';
import { StationHttpError } from '../client/api-error-message';
import { ChatHttpError } from '../client/chatHttpError';
import {
  type DelegatedTaskHandle,
  type DelegatedTaskInterruptResult,
  type DelegateTaskInput,
  type DelegationOptions,
  type DiscoverDelegationOptionsInput,
  delegateTask as delegateTaskClient,
  discoverDelegationOptions as discoverDelegationOptionsClient,
  type InterruptDelegatedTaskInput,
  interruptDelegatedTask as interruptDelegatedTaskClient,
  type ProviderTaskStopResult,
  stopProviderTask as stopProviderTaskClient,
} from '../client/delegations';
import {
  continueExecutionMessage,
  getConversationContextBoundaryStatus,
} from '../client/execution';
import {
  type ApiRequestScope,
  authenticatedFetch,
  type ClientRequestOptions,
  isApiRequestScope,
} from '../client/http';
import {
  getChildWorkTranscript,
  getConversationUsageTree,
  getOrchestrationConversationEventWindow,
  getOrchestrationSessionEventWindow,
  getSessionBuilderRun,
  getSessionFlowRun,
  inspectSteerInput as inspectSteerInputClient,
  type SessionBuilderRunView,
  type SessionFlowRunView,
  steerTurn as steerTurnClient,
} from '../client/orchestration';
import { StationRequestTimeoutError } from '../client/request-deadline';
import { isStationAnswer } from '../client/station-envelope';
import {
  type MutationOptions,
  type QueryConfig,
  resolveApiBase,
  useApiQuery,
  useCancelWhenInactive,
} from '../query-core';
import { orchestrationQueries } from '../queryFactories';
import type {
  OrchestrationCommandDispatchResult,
  OrchestrationCommandInput,
  OrchestrationCommandReceipt,
  OrchestrationEngineId,
  OrchestrationProviderSummary,
  OrchestrationSessionDetail,
  OrchestrationSessionSummary,
  SessionBoardItem,
  TerminalProcessDetail,
  TerminalProcessSummary,
} from './chatRuntimeTypes';

export type {
  DelegatedTaskHandle,
  DelegateTaskInput,
  DelegationOptions,
  DelegationProjectSlugJoin,
  DelegationTargetOption,
} from '../client/delegations';

export type {
  SessionBuilderRunView,
  SessionFlowRunView,
} from '../client/orchestration';
export type {
  OrchestrationCommandDispatchResult,
  OrchestrationCommandInput,
  OrchestrationCommandReceipt,
  OrchestrationEngineId,
  OrchestrationProviderSummary,
  OrchestrationSessionDetail,
  OrchestrationSessionSummary,
  SessionBoardItem,
  SessionControlMode,
  TerminalProcessDetail,
  TerminalProcessSummary,
} from './chatRuntimeTypes';

export type DelegationOptionsInput = DiscoverDelegationOptionsInput;

export type AdoptSessionFailureClass =
  | 'certain-response'
  | 'certain-not-sent'
  | 'uncertain-no-response';

/** A classified adoption failure so callers can make an honest retry decision. */
export class AdoptSessionError extends Error {
  readonly failureClass: AdoptSessionFailureClass;
  readonly retryable: boolean;
  readonly status?: number;
  readonly cause?: unknown;
  /**
   * #3386: Station's own reason for a refusal it says will not change on
   * retry (a folder Station will not continue in), for showing as written.
   */
  readonly refusal?: string;

  constructor(input: {
    failureClass: AdoptSessionFailureClass;
    message: string;
    retryable: boolean;
    status?: number;
    cause?: unknown;
    refusal?: string;
  }) {
    super(input.message);
    this.name = 'AdoptSessionError';
    this.failureClass = input.failureClass;
    this.retryable = input.retryable;
    this.status = input.status;
    this.cause = input.cause;
    if (input.refusal) this.refusal = input.refusal;
  }
}

export async function fetchOrchestrationSessionEventWindow(
  threadId: string,
  apiBase?: string,
  input?: { cursor?: string; turnLimit?: number; direction?: 'newest' },
  opts?: ClientRequestOptions,
): Promise<OrchestrationSessionEventWindow> {
  const page =
    await getOrchestrationSessionEventWindow<OrchestrationSessionEventWindow>(
      await resolveApiBase(apiBase),
      threadId,
      input,
      opts,
    );
  if (page.protocolVersion !== 1) {
    throw new Error('Session history requires a server upgrade');
  }
  return page;
}

export async function fetchOrchestrationConversationEventWindow(
  conversationId: string,
  apiBase?: string,
  input?: { cursor?: string; turnLimit?: number; direction?: 'newest' },
  opts?: ClientRequestOptions,
): Promise<OrchestrationConversationEventWindow> {
  const page =
    await getOrchestrationConversationEventWindow<OrchestrationConversationEventWindow>(
      await resolveApiBase(apiBase),
      conversationId,
      input,
      opts,
    );
  if (page.protocolVersion !== 1) {
    throw new Error('Conversation history requires a server upgrade');
  }
  return page;
}

/**
 * A conversation's usage tree (`getConversationUsageTree`). Enabled by
 * default, and off for an empty id or `config.enabled: false`. It polls only
 * when `config.refetchInterval` is set, and stops polling after a 404 (no
 * orchestration record for this conversation) or a 422 (tree past its
 * bound): neither changes by asking again. Neither is retried.
 */
export function useConversationUsageTreeQuery(
  conversationId: string,
  apiBase?: string,
  config?: { enabled?: boolean; refetchInterval?: number | false },
) {
  return useQuery({
    queryKey: [
      'orchestration-conversation-usage-tree',
      apiBase ?? 'default',
      conversationId,
    ],
    enabled: Boolean(conversationId) && (config?.enabled ?? true),
    queryFn: async ({ signal }) =>
      getConversationUsageTree(await resolveApiBase(apiBase), conversationId, {
        signal,
      }),
    retry: false,
    staleTime: 2_000,
    refetchInterval: (query) =>
      isSettledUsageTreeRefusal(query.state.error)
        ? false
        : (config?.refetchInterval ?? false),
  });
}

/** A usage-tree answer that asking again cannot change. */
function isSettledUsageTreeRefusal(error: unknown): boolean {
  return (
    error instanceof StationHttpError &&
    (error.status === 404 || error.status === 422)
  );
}

/** Reconciles one persisted context-boundary intent after reload or reconnect. */
export async function fetchConversationContextBoundaryStatus(
  conversationId: string,
  idempotencyKey: string,
  apiBase?: string,
): Promise<ConversationContextBoundaryProjection> {
  return getConversationContextBoundaryStatus(
    await resolveApiBase(apiBase),
    conversationId,
    idempotencyKey,
  );
}

export function useConversationContextBoundaryStatusQuery(
  conversationId: string,
  idempotencyKey: string,
  apiBase?: string,
  config?: QueryConfig<ConversationContextBoundaryProjection>,
) {
  const query = orchestrationQueries.contextBoundary(
    conversationId,
    idempotencyKey,
  );
  return useApiQuery(
    [...query.queryKey, apiBase ?? 'default'],
    () =>
      fetchConversationContextBoundaryStatus(
        conversationId,
        idempotencyKey,
        apiBase,
      ),
    {
      enabled:
        Boolean(conversationId && idempotencyKey) && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? query.staleTime,
      gcTime: config?.gcTime,
      refetchOnMount: config?.refetchOnMount ?? 'always',
      refetchInterval: config?.refetchInterval ?? 2_000,
      retry: config?.retry ?? false,
      cancelWhenInactive: config?.cancelWhenInactive ?? true,
    },
  );
}

/** Same retention `useApiQuery` gives an unconfigured read. */
const SESSION_RUN_PROBE_GC_TIME_MS = 10 * 60 * 1000;

/**
 * How often a "no run bound" answer is asked again while a caller still
 * polls. A run can be joined after the first look (a Builder sidecar written
 * mid-task), so a null does not stop the probe outright; it only slows it
 * from the 2s/10s bound-run cadence to this.
 */
const SESSION_RUN_ABSENT_REPROBE_MS = 30_000;

/**
 * The session's Flow/Builder run probes answer `null` only for a 404: the
 * server looked and found no run bound or joined to this session. The detail
 * used to re-ask that every 2s and 10s for as long as it stayed open (two
 * expected 404s per interval for a direct chat or an unjoined task), so a
 * null answer drops to {@link SESSION_RUN_ABSENT_REPROBE_MS}. A caller that
 * passes `refetchInterval: 0` (a finished session) polls neither. A failed
 * read is not an answer: it keeps whatever data it had, so a transient error
 * never slows the poll of a run that was bound.
 *
 * The function forms need `useQuery` directly; `QueryConfig.refetchInterval`
 * is a plain number on the public surface and stays that way.
 */
function pollWhileRunBound(intervalMs: number) {
  return (query: { state: { data: unknown } }) => {
    if (!intervalMs) return false;
    return query.state.data === null
      ? Math.max(intervalMs, SESSION_RUN_ABSENT_REPROBE_MS)
      : intervalMs;
  };
}

/**
 * Reopening a detail whose cached answer was "no run" re-asks once (when
 * stale), so a run joined after the first look is found on the next visit
 * instead of waiting out the cache. A bound run keeps Station's cache-first
 * mount default; its interval already refreshes it.
 */
function reprobeAbsentRunOnMount(query: { state: { data: unknown } }) {
  return query.state.data === null;
}

export function useSessionFlowRunQuery(
  threadId: string,
  apiBase?: string,
  config?: QueryConfig<SessionFlowRunView | null>,
) {
  const queryKey = [
    'orchestration-session-flow-run',
    apiBase ?? 'default',
    threadId,
  ];
  const enabled = Boolean(threadId) && (config?.enabled ?? true);
  useCancelWhenInactive(queryKey, enabled, config?.cancelWhenInactive);
  return useQuery({
    queryKey,
    queryFn: async () => {
      const resolvedApiBase = await resolveApiBase(apiBase);
      return getSessionFlowRun<SessionFlowRunView>(resolvedApiBase, threadId);
    },
    enabled,
    staleTime: config?.staleTime ?? 2_000,
    gcTime: config?.gcTime ?? SESSION_RUN_PROBE_GC_TIME_MS,
    refetchInterval: pollWhileRunBound(config?.refetchInterval ?? 2_000),
    refetchOnMount: reprobeAbsentRunOnMount,
  });
}

/**
 * The Builder run joined to this session (station#189 S4).
 *
 * A SEPARATE query from `useSessionFlowRunQuery`, not a field folded into it:
 * the auto-attached `station-delivery` run and the Builder run are different
 * runs, and a view that merges them cannot tell a stalled one from a live one.
 *
 * Ten seconds, not the Flow-run query's two. Every poll costs the server a
 * whole-workspace sidecar scan (readdir plus a parse of every `state.json`) on
 * its event loop, per open session detail — and the thing being polled is a
 * projection with no currency stamp, so a 2s cadence buys precision this row
 * is not entitled to claim anyway. Paying five times the I/O for it would be
 * pure cost.
 */
export function useSessionBuilderRunQuery(
  threadId: string,
  apiBase?: string,
  config?: QueryConfig<SessionBuilderRunView | null>,
) {
  const queryKey = [
    'orchestration-session-builder-run',
    apiBase ?? 'default',
    threadId,
  ];
  const enabled = Boolean(threadId) && (config?.enabled ?? true);
  useCancelWhenInactive(queryKey, enabled, config?.cancelWhenInactive);
  return useQuery({
    queryKey,
    queryFn: async () => {
      const resolvedApiBase = await resolveApiBase(apiBase);
      return getSessionBuilderRun<SessionBuilderRunView>(
        resolvedApiBase,
        threadId,
      );
    },
    enabled,
    staleTime: config?.staleTime ?? 10_000,
    gcTime: config?.gcTime ?? SESSION_RUN_PROBE_GC_TIME_MS,
    refetchInterval: pollWhileRunBound(config?.refetchInterval ?? 10_000),
    refetchOnMount: reprobeAbsentRunOnMount,
  });
}

/**
 * One delegation dispatch, bound to the authority its caller captured (#480
 * review). `apiBase` + `requestScope` are PER-INVOCATION values, frozen by
 * the caller before the call: an explicit `apiBase` is used verbatim and the
 * ambient `_getApiBase()` is never consulted for that invocation, and the
 * scope travels as `ClientRequestOptions` through the transport's
 * dispatch/body authority guards — never in the public request body, which
 * stays exactly `DelegateTaskInput`. A Home/credential rotation that lands
 * across the awaits therefore refuses (`StationRequestAuthorityError`,
 * nothing sent) instead of dispatching the old intent under new credentials.
 * React Query re-renders likewise cannot redirect an in-flight invocation:
 * the mutation function closes over these variables, not hook options.
 */
export interface DelegateOrchestrationTaskInvocation {
  /** Public request body. Scope and functions never belong here. */
  input: DelegateTaskInput;
  /** Per-invocation Home address; hook default applies only when omitted. */
  apiBase?: string;
  /**
   * Per-invocation authority snapshot. Only the `apiBase`/`authorityKey`
   * scalars are retained (copied at the boundary); functions such as
   * `isCurrent` are transport-local and never cross it.
   */
  requestScope?: ApiRequestScope;
}

/** Snapshot the scope scalars at the invocation boundary; never functions. */
function snapshotInvocationScope(
  scope: ApiRequestScope | undefined,
): ApiRequestScope | undefined {
  if (!isApiRequestScope(scope)) return undefined;
  return { apiBase: scope.apiBase, authorityKey: scope.authorityKey };
}

export async function delegateOrchestrationTask(
  input: DelegateTaskInput & { apiBase?: string },
  opts?: ClientRequestOptions,
): Promise<DelegatedTaskHandle> {
  const invocationApiBase = input.apiBase;
  const resolvedApiBase = await resolveApiBase(invocationApiBase);
  const { apiBase: _apiBase, ...body } = input;
  return delegateTaskClient(resolvedApiBase, body, opts);
}

/**
 * What `useDelegateOrchestrationTaskMutation`'s mutation function accepts.
 * The plain `DelegateTaskInput` form is the ORIGINAL published shape
 * (station-core 0.x, exported from the SDK barrel): it keeps its exact old
 * behavior — the hook's `apiBase` default and the ambient authority, no
 * captured scope — so existing consumers are unaffected. Placement callers
 * (#480) use the explicit per-invocation envelope instead.
 */
export type DelegateOrchestrationTaskMutationVariables =
  | DelegateTaskInput
  | DelegateOrchestrationTaskInvocation;

function isDelegateOrchestrationTaskInvocation(
  variables: DelegateOrchestrationTaskMutationVariables,
): variables is DelegateOrchestrationTaskInvocation {
  return (
    typeof variables === 'object' &&
    variables !== null &&
    'input' in variables &&
    typeof (variables as DelegateOrchestrationTaskInvocation).input === 'object'
  );
}

export function useDelegateOrchestrationTaskMutation(
  apiBase?: string,
  options?: MutationOptions<
    DelegatedTaskHandle,
    DelegateOrchestrationTaskMutationVariables
  >,
) {
  return useMutation({
    mutationFn: (variables: DelegateOrchestrationTaskMutationVariables) => {
      // Legacy published shape: the input IS the request body, resolved
      // against the hook default and ambient authority exactly as before.
      if (!isDelegateOrchestrationTaskInvocation(variables)) {
        return delegateOrchestrationTask({ ...variables, apiBase });
      }
      const scope = snapshotInvocationScope(variables.requestScope);
      const invocationApiBase = variables.apiBase ?? apiBase;
      return delegateOrchestrationTask(
        {
          ...variables.input,
          ...(invocationApiBase === undefined
            ? {}
            : { apiBase: invocationApiBase }),
        },
        scope ? { requestScope: scope } : undefined,
      );
    },
    onSuccess: (data, variables) => options?.onSuccess?.(data, variables),
    onError: (error, variables) =>
      options?.onError?.(error as Error, variables),
  });
}

export interface InterruptOrchestrationDelegatedTaskInput
  extends InterruptDelegatedTaskInput {
  taskId: string;
}

export async function interruptOrchestrationDelegatedTask(
  input: InterruptOrchestrationDelegatedTaskInput & { apiBase?: string },
): Promise<DelegatedTaskInterruptResult> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const { apiBase: _apiBase, taskId, ...body } = input;
  return interruptDelegatedTaskClient(resolvedApiBase, taskId, body);
}

export interface StopProviderTaskInput {
  threadId: string;
  taskId: string;
}

/**
 * station#1877: stop one provider-reported subagent. Distinct from
 * `useInterruptDelegatedTaskMutation`, which targets a Station delegate — a
 * task with its own session — rather than an engine's own subagent.
 */
export async function stopOrchestrationProviderTask(
  input: StopProviderTaskInput & { apiBase?: string },
): Promise<ProviderTaskStopResult> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  return stopProviderTaskClient(resolvedApiBase, input.threadId, input.taskId);
}

export function useStopProviderTaskMutation(apiBase?: string) {
  return useMutation({
    mutationFn: (input: StopProviderTaskInput) =>
      stopOrchestrationProviderTask({ ...input, apiBase }),
  });
}

/** #3163: one page of transcript messages per fetch. */
const CHILD_WORK_TRANSCRIPT_PAGE_SIZE = 30;

/**
 * #3163: an engine subagent's own read-only transcript, paged by message.
 * `fetchNextPage` continues where the last page ended. Off until `enabled`,
 * so a closed row reads nothing; a transcript is history, so it is fetched
 * once and not polled.
 */
export function useChildWorkTranscriptQuery(
  input: { threadId: string; childId: string; enabled?: boolean },
  apiBase?: string,
) {
  return useInfiniteQuery({
    queryKey: [
      'orchestration-child-work-transcript',
      apiBase ?? 'default',
      input.threadId,
      input.childId,
    ],
    enabled:
      (input.enabled ?? true) &&
      input.threadId.length > 0 &&
      input.childId.length > 0,
    initialPageParam: 0,
    queryFn: async ({ pageParam, signal }) =>
      getChildWorkTranscript(
        await resolveApiBase(apiBase),
        input.threadId,
        input.childId,
        { offset: pageParam, limit: CHILD_WORK_TRANSCRIPT_PAGE_SIZE },
        { signal },
      ),
    getNextPageParam: (page) => page.nextOffset,
    retry: false,
    staleTime: 30_000,
  });
}

export function useInterruptDelegatedTaskMutation(apiBase?: string) {
  return useMutation({
    mutationFn: (input: InterruptOrchestrationDelegatedTaskInput) =>
      interruptOrchestrationDelegatedTask({ ...input, apiBase }),
  });
}

export async function fetchDelegationOptions(
  input: DelegationOptionsInput & { apiBase?: string },
): Promise<DelegationOptions> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const { apiBase: _apiBase, ...body } = input;
  return discoverDelegationOptionsClient(resolvedApiBase, body);
}

export function useDelegationOptionsQuery(
  input: DelegationOptionsInput,
  apiBase?: string,
  config?: QueryConfig<DelegationOptions>,
) {
  return useApiQuery(
    [
      'orchestration-delegation-options',
      apiBase ?? 'default',
      input.environmentId ?? 'current',
      input.projectSlug ?? '',
      input.projectPath ?? '',
    ],
    () => fetchDelegationOptions({ ...input, apiBase }),
    {
      staleTime: config?.staleTime ?? 10_000,
      gcTime: config?.gcTime,
      enabled: config?.enabled,
    },
  );
}

export async function fetchOrchestrationProviders(
  apiBase?: string,
): Promise<OrchestrationProviderSummary[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/providers`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: OrchestrationProviderSummary[];
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data ?? [];
}

export async function dispatchOrchestrationCommand<T = unknown>(
  command: OrchestrationCommandInput,
  apiBase?: string,
  /**
   * Per-call request deadline. Only supplied by callers that must not hang
   * forever on a transport that never answers — see
   * {@link interruptOrchestrationTurn}, which is dispatched from a UI control
   * that has to leave its pending state either way.
   */
  timeoutMs?: number,
): Promise<T> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/commands`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: T;
    error?: string;
    code?: string;
    details?: unknown;
  };
  if (!response.ok || !result.success) {
    const message = apiErrorMessage(result, `HTTP ${response.status}`);
    // A stable refusal code (e.g. #2436's `approval-full-access-not-granted`)
    // is kept, so a caller can tell a refusal from a transport failure.
    // Its `details` too (#1796's full-access refusal is rendered from them),
    // on the field `StationHttpError` carries them in.
    throw typeof result.code === 'string'
      ? new ChatHttpError(
          new StationHttpError(response.status, message, {
            code: result.code,
            details: result.details ?? undefined,
          }),
          isStationAnswer(response, result),
        )
      : new Error(message);
  }
  return result.data as T;
}

/** Create a Station-owned continuation from a read-only attached session. */
/**
 * True only for failures that PROVE the request never left this client:
 * request-construction errors and the connection-level refusals the runtime
 * names explicitly. A bare TypeError ('Failed to fetch') is NOT proof — the
 * browser uses it for post-send failures too.
 */
export function isProvablyNotSent(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const name = error.name;
  if (name === 'StationReadOnlyError' || name === 'SyntaxError') return true;
  const message = error.message;
  return (
    /ECONNREFUSED|ENOTFOUND|ERR_NAME_NOT_RESOLVED|refused the connection/i.test(
      message,
    ) && !/timed out|timeout|reset/i.test(message)
  );
}

export interface AdoptOrchestrationSessionIntent {
  readonly idempotencyKey: string;
}

/** One user Continue intent; reuse this object for every retry of that intent. */
export function createAdoptOrchestrationSessionIntent(): AdoptOrchestrationSessionIntent {
  return Object.freeze({ idempotencyKey: randomCorrelationId() });
}

/** Station answered and refused the continuation: certain, with its status. */
function rejectedContinuation(
  status: number,
  detail?: string,
  retryable?: unknown,
): AdoptSessionError {
  const statusMessage =
    status === 401 || status === 403
      ? `Permission denied by Station (HTTP ${status}).`
      : `Station rejected the continuation request (HTTP ${status}).`;
  // #3386: a refusal Station itself marks `retryable: false` (a coded,
  // permanent refusal, such as a folder it will not continue in) is final:
  // the same request is refused again, so no retry is offered. Any other
  // refusal keeps the retryable default.
  const permanent =
    status >= 400 && status < 500 && retryable === false && Boolean(detail);
  return new AdoptSessionError({
    failureClass: 'certain-response',
    message: detail ? `${statusMessage} ${detail}` : statusMessage,
    retryable: !permanent,
    status,
    ...(permanent && detail ? { refusal: detail } : {}),
  });
}

export async function adoptOrchestrationSession(input: {
  sourceThreadId: string;
  apiBase?: string;
  intent?: AdoptOrchestrationSessionIntent;
  /** #3386: where a conversation no project claims continues. */
  target?: AdoptSessionTarget;
}): Promise<AdoptedSessionResult> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const intent = input.intent ?? createAdoptOrchestrationSessionIntent();
  let response: Response;
  try {
    response = await authenticatedFetch(
      `${resolvedApiBase}/api/orchestration/commands`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'adoptSession',
          sourceThreadId: input.sourceThreadId,
          idempotencyKey: intent.idempotencyKey,
          ...(input.target ? { target: input.target } : {}),
        }),
      },
    );
  } catch (error) {
    // Fail closed toward UNCERTAIN: the browser rejects many failure modes
    // as bare TypeError, and the native relay surfaces its own
    // timeout/reset outcomes as generic coded Errors. The intent key is held
    // across retries, so ambiguity remains classified honestly but is safe to
    // retry without creating a second continuation.
    if (isProvablyNotSent(error)) {
      throw new AdoptSessionError({
        failureClass: 'certain-not-sent',
        message: 'The continuation request could not reach Station.',
        retryable: true,
        cause: error,
      });
    }
    throw new AdoptSessionError({
      failureClass: 'uncertain-no-response',
      message: 'Station did not answer before the request ended.',
      retryable: true,
      cause: error,
    });
  }

  let result: {
    success?: boolean;
    data?: AdoptedSessionResult;
    error?: string;
    retryable?: unknown;
  };
  try {
    result = (await response.json()) as typeof result;
  } catch (error) {
    // A request deadline that fired while the body was read. After 2xx
    // headers Station may have created the continuation (uncertain, as when
    // it fires before the headers); after a refusal Station did answer, so
    // the refusal is certain and carries its status.
    if (error instanceof StationRequestTimeoutError)
      throw response.ok
        ? new AdoptSessionError({
            failureClass: 'uncertain-no-response',
            message: 'Station did not answer before the request ended.',
            retryable: true,
            cause: error,
          })
        : rejectedContinuation(response.status);
    if (response.ok) {
      // A 2xx whose body cannot be read may have CREATED the continuation
      // (the native relay resolves on headers; the stream can reset while
      // the JSON is still arriving). Retrying could duplicate — uncertain.
      throw new AdoptSessionError({
        failureClass: 'uncertain-no-response',
        message:
          'Station accepted the request but the confirmation could not be read.',
        retryable: true,
        cause: error,
      });
    }
    result = {};
  }
  if (!response.ok || !result.success)
    throw rejectedContinuation(
      response.status,
      result.error?.trim(),
      result.retryable,
    );
  return result.data as AdoptedSessionResult;
}

export async function dispatchOrchestrationCommandWithReceipt<T = unknown>(
  command: OrchestrationCommandInput,
  apiBase?: string,
  timeoutMs?: number,
): Promise<OrchestrationCommandDispatchResult<T>> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/commands`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: T;
    receipt?: OrchestrationCommandReceipt;
    receiptStatus?: unknown;
    error?: string;
    code?: unknown;
  };
  if (!response.ok || !result.success) {
    // The server's typed refusal code (e.g. #2312's `draft_busy`) rides on
    // the error, so a caller can tell a retryable refusal from a failure.
    throw Object.assign(
      new Error(apiErrorMessage(result, `HTTP ${response.status}`)),
      typeof result.code === 'string' ? { code: result.code } : {},
    );
  }
  if (!result.receipt) {
    throw new Error('Orchestration command response missing receipt');
  }
  return {
    receipt: result.receipt,
    result: result.data as T,
    ...(result.receiptStatus === 'unavailable'
      ? { receiptStatus: 'unavailable' as const }
      : {}),
  };
}

export async function fetchOrchestrationCommandReceipts(input?: {
  threadId?: string;
  apiBase?: string;
}): Promise<OrchestrationCommandReceipt[]> {
  const resolvedApiBase = await resolveApiBase(input?.apiBase);
  const params = new URLSearchParams();
  if (input?.threadId) params.set('threadId', input.threadId);
  const query = params.toString();
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/commands/receipts${query ? `?${query}` : ''}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: OrchestrationCommandReceipt[];
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data ?? [];
}

export async function fetchOrchestrationCommandReceipt(
  commandId: string,
  apiBase?: string,
): Promise<OrchestrationCommandReceipt> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/commands/receipts/${encodeURIComponent(commandId)}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: OrchestrationCommandReceipt;
    error?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data;
}

export async function fetchOrchestrationSessions(
  apiBase?: string,
): Promise<OrchestrationSessionSummary[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/sessions/read-model`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: OrchestrationSessionSummary[];
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  // station#1778: the cast above is an ASSERTION over HTTP, not a
  // validation. A Station older than ADR 0012 sends no `answerability`,
  // and this is the PUBLISHED package — the real version-skew surface.
  return (result.data ?? []).map(withNormalizedAnswerability);
}

export async function fetchLoadedOrchestrationSessions(
  apiBase?: string,
): Promise<OrchestrationSessionSummary[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/sessions/loaded`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: OrchestrationSessionSummary[];
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  // station#1778: the cast above is an ASSERTION over HTTP, not a
  // validation. A Station older than ADR 0012 sends no `answerability`,
  // and this is the PUBLISHED package — the real version-skew surface.
  return (result.data ?? []).map(withNormalizedAnswerability);
}

export async function fetchProjectSessionBoard(
  projectSlug: string,
  apiBase?: string,
): Promise<SessionBoardItem[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/session-board/projects/${encodeURIComponent(projectSlug)}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: SessionBoardItem[];
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  // station#1778: the cast above is an ASSERTION over HTTP, not a
  // validation. A Station older than ADR 0012 sends no `answerability`,
  // and this is the PUBLISHED package — the real version-skew surface.
  return (result.data ?? []).map(withNormalizedAnswerability);
}

export async function fetchOrchestrationSession(
  threadId: string,
  apiBase?: string,
): Promise<OrchestrationSessionDetail> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: OrchestrationSessionDetail;
    error?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  // station#1778: the cast above is an ASSERTION over HTTP, not a
  // validation. A Station older than ADR 0012 sends no `answerability`,
  // and this is the PUBLISHED package — the real version-skew surface.
  return {
    ...result.data,
    session: withNormalizedAnswerability(result.data.session),
  };
}

export interface ProviderCommandDescriptor {
  name: string;
  description: string;
  argumentHint?: string;
  passthrough: boolean;
}

export async function fetchProviderCommands(
  provider: OrchestrationEngineId,
  apiBase?: string,
): Promise<ProviderCommandDescriptor[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/providers/${encodeURIComponent(provider)}/commands`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: ProviderCommandDescriptor[];
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data ?? [];
}

export async function fetchTerminalProcesses(
  apiBase?: string,
): Promise<TerminalProcessSummary[]> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/processes/terminals`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: TerminalProcessSummary[];
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data ?? [];
}

export async function fetchTerminalProcess(
  sessionId: string,
  apiBase?: string,
): Promise<TerminalProcessDetail> {
  const resolvedApiBase = await resolveApiBase(apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/processes/terminals/${encodeURIComponent(sessionId)}`,
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: TerminalProcessDetail;
    error?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  return result.data;
}

export async function cleanupTerminalProcess(input: {
  sessionId: string;
  apiBase?: string;
}): Promise<void> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/processes/terminals/${encodeURIComponent(input.sessionId)}`,
    {
      method: 'DELETE',
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    error?: string;
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
}

export async function transitionOrchestrationSessionState(input: {
  threadId: string;
  state: SessionBoardItem['lifecycleState'];
  reason?:
    | 'blocked_by_user'
    | 'retry_requested'
    | 'request_resolved'
    | 'manual_update'
    | 'system_recovered';
  message?: string;
  apiBase?: string;
}): Promise<OrchestrationSessionSummary> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const response = await authenticatedFetch(
    `${resolvedApiBase}/api/orchestration/sessions/${encodeURIComponent(input.threadId)}/lifecycle`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        state: input.state,
        reason: input.reason,
        message: input.message,
      }),
    },
  );
  const result = (await response.json()) as {
    success: boolean;
    data?: OrchestrationSessionSummary;
    error?: string;
  };
  if (!response.ok || !result.success || !result.data) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
  }
  // station#1778: the cast above is an ASSERTION over HTTP, not a
  // validation. A Station older than ADR 0012 sends no `answerability`,
  // and this is the PUBLISHED package — the real version-skew surface.
  return withNormalizedAnswerability(result.data);
}

export async function resolveOrchestrationRequest(input: {
  threadId: string;
  requestId: string;
  expectedRequestEventId?: string;
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
  /** @deprecated since 0.9.0; removed in 0.10.0. Use `content`. */
  answers?: HarnessQuestionAnswers;
  /** #3390: accepted content for a form input request. */
  content?: InputRequestContent;
  apiBase?: string;
}): Promise<void> {
  await dispatchOrchestrationCommand(
    {
      type: 'respondToRequest',
      threadId: input.threadId,
      requestId: input.requestId,
      ...(input.expectedRequestEventId
        ? { expectedRequestEventId: input.expectedRequestEventId }
        : {}),
      decision: input.decision,
      ...(input.answers ? { answers: input.answers } : {}),
      ...(input.content ? { content: input.content } : {}),
    },
    input.apiBase,
  );
}

export async function sendOrchestrationTurn(input: {
  threadId: string;
  text: string;
  attachments?: ChatAttachmentInput[];
  modelId?: string;
  modelOptions?: Record<string, unknown>;
  /**
   * Ambient, model-facing context (timezone, geolocation, …) delivered
   * out-of-band (#685). The server composes it into the model input only;
   * the persisted user turn stays `text`.
   */
  ambientContext?: string;
  /**
   * station#1224 (offline slice 2): the per-turn idempotency key minted by
   * station#1207 (`useActiveChatSessionMessaging.ts`'s `resolvedTurnId`).
   * Reused verbatim on retry/replay so the dispatch-layer dedup
   * (`OrchestrationService`'s `sendTurn` case) recognizes a turn that
   * already landed instead of re-executing it. Never put on
   * `modelOptions` — that bag is forwarded verbatim into external-engine
   * invocations.
   */
  clientTurnId?: string;
  apiBase?: string;
}) {
  const apiBase = await resolveApiBase(input.apiBase);
  return continueExecutionMessage(apiBase, input.threadId, {
    message: input.text,
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.ambientContext ? { ambientContext: input.ambientContext } : {}),
    ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
    ...(input.modelId || Object.keys(input.modelOptions ?? {}).length > 0
      ? {
          model: {
            ...(input.modelId ? { override: input.modelId } : {}),
            ...(Object.keys(input.modelOptions ?? {}).length > 0
              ? { options: input.modelOptions }
              : {}),
          },
        }
      : {}),
  });
}

/**
 * The browser's budget for a Stop round-trip. It must OUTWAIT the server's own
 * cancel-acknowledgement budget, because the forced path only begins after
 * that budget expires and then still has to tear the engine process down — a
 * shorter client deadline would abort a stop that is working and let the UI
 * report a failure that did not happen (UX audit T1). Derived from the shared
 * contract constant rather than re-typed here, so the two cannot drift.
 */
export const STOP_REQUEST_BUDGET_MS = COOPERATIVE_STOP_BUDGET_MS * 2;

/**
 * Interrupt the active turn without closing its resumable task session.
 *
 * Resolves with the outcome the SERVER derived (see {@link InterruptTurnResult});
 * rejects when the request failed or outlived {@link STOP_REQUEST_BUDGET_MS}.
 * A rejection is never proof the turn kept running — the request may have
 * landed — so callers must report an indeterminate stop, not a failed one.
 */
export async function interruptOrchestrationTurn(input: {
  threadId: string;
  turnId?: string;
  /** See the command contract: binds a pre-start cancel to one dispatch. */
  clientTurnId?: string;
  apiBase?: string;
  timeoutMs?: number;
}): Promise<InterruptTurnResult> {
  return dispatchOrchestrationCommand<InterruptTurnResult>(
    {
      type: 'interruptTurn',
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      ...(input.clientTurnId ? { clientTurnId: input.clientTurnId } : {}),
    },
    input.apiBase,
    input.timeoutMs ?? STOP_REQUEST_BUDGET_MS,
  );
}

/**
 * #2436: record the conversation's approval posture. The server orders it by
 * receipt and applies it at the next session start or turn start, whatever
 * path sends that turn; every client folds it from the event stream. The
 * result's `sequence` is the recorded event's server global sequence.
 */
export async function setOrchestrationApprovalMode(input: {
  threadId: string;
  approvalMode: import('@kontourai/station-contracts/provider').ApprovalMode;
  /**
   * The sequence of the latest decision this client had folded when the
   * user picked (`null`: none). The server records the pick only if no newer
   * decision exists; otherwise the result has `recorded: false` and names
   * the decision that stands.
   */
  basedOnSequence: number | null;
  apiBase?: string;
}): Promise<
  import('@kontourai/station-contracts/orchestration').SetApprovalModeResult
> {
  return dispatchOrchestrationCommand(
    {
      type: 'setApprovalMode',
      threadId: input.threadId,
      approvalMode: input.approvalMode,
      basedOnSequence: input.basedOnSequence,
    },
    input.apiBase,
  );
}

/** Receipt inspection is safe against older servers: an unknown command never steers. */
export async function inspectOrchestrationSteerInput(input: {
  threadId: string;
  text: string;
  turnId?: string;
  clientInputId: string;
  apiBase?: string;
}) {
  return inspectSteerInputClient(await resolveApiBase(input.apiBase), input);
}

/** Add user input to the currently open turn; this never queues a future turn. */
export async function steerOrchestrationTurn(input: {
  threadId: string;
  text: string;
  turnId?: string;
  clientInputId?: string;
  apiBase?: string;
}) {
  return steerTurnClient(await resolveApiBase(input.apiBase), input);
}

export function useOrchestrationProvidersQuery(
  config?: QueryConfig<OrchestrationProviderSummary[]>,
) {
  return useApiQuery(
    orchestrationQueries.providers().queryKey,
    () => fetchOrchestrationProviders(),
    {
      staleTime:
        config?.staleTime ?? orchestrationQueries.providers().staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled,
    },
  );
}

export function useOrchestrationSessionsQuery(
  config?: QueryConfig<OrchestrationSessionSummary[]>,
) {
  return useApiQuery(
    orchestrationQueries.sessions().queryKey,
    () => fetchOrchestrationSessions(),
    {
      staleTime: config?.staleTime ?? orchestrationQueries.sessions().staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled,
      refetchInterval: config?.refetchInterval,
    },
  );
}

export function useLoadedOrchestrationSessionsQuery(
  config?: QueryConfig<OrchestrationSessionSummary[]>,
) {
  return useApiQuery(
    orchestrationQueries.loadedSessions().queryKey,
    () => fetchLoadedOrchestrationSessions(),
    {
      staleTime:
        config?.staleTime ?? orchestrationQueries.loadedSessions().staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled,
    },
  );
}

export function useProjectSessionBoardQuery(
  projectSlug: string,
  config?: QueryConfig<SessionBoardItem[]>,
) {
  return useApiQuery(
    orchestrationQueries.sessionBoard(projectSlug).queryKey,
    () => fetchProjectSessionBoard(projectSlug),
    {
      staleTime:
        config?.staleTime ??
        orchestrationQueries.sessionBoard(projectSlug).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? projectSlug.length > 0,
    },
  );
}

export function useOrchestrationSessionQuery(
  threadId: string,
  config?: QueryConfig<OrchestrationSessionDetail>,
) {
  return useApiQuery(
    orchestrationQueries.session(threadId).queryKey,
    () => fetchOrchestrationSession(threadId),
    {
      staleTime:
        config?.staleTime ?? orchestrationQueries.session(threadId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? threadId.length > 0,
      refetchInterval: config?.refetchInterval,
      retry: config?.retry,
      retryDelay: config?.retryDelay,
      cancelWhenInactive: config?.cancelWhenInactive,
    },
  );
}

export function useOrchestrationCommandReceiptsQuery(
  threadId?: string,
  config?: QueryConfig<OrchestrationCommandReceipt[]>,
) {
  return useApiQuery(
    orchestrationQueries.commandReceipts(threadId).queryKey,
    () => fetchOrchestrationCommandReceipts({ threadId }),
    {
      staleTime:
        config?.staleTime ??
        orchestrationQueries.commandReceipts(threadId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled,
    },
  );
}

export function useOrchestrationCommandReceiptQuery(
  commandId: string,
  config?: QueryConfig<OrchestrationCommandReceipt>,
) {
  return useApiQuery(
    orchestrationQueries.commandReceipt(commandId).queryKey,
    () => fetchOrchestrationCommandReceipt(commandId),
    {
      staleTime:
        config?.staleTime ??
        orchestrationQueries.commandReceipt(commandId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? commandId.length > 0,
    },
  );
}

export function useProviderCommandsQuery(
  provider: OrchestrationEngineId | null | undefined,
  config?: QueryConfig<ProviderCommandDescriptor[]>,
) {
  return useApiQuery(
    ['orchestration-provider-commands', provider ?? 'unknown'],
    () => fetchProviderCommands(provider!),
    { ...config, enabled: !!provider && (config?.enabled ?? true) },
  );
}

export function useTerminalProcessesQuery(
  config?: QueryConfig<TerminalProcessSummary[]>,
) {
  return useApiQuery(
    orchestrationQueries.terminalProcesses().queryKey,
    () => fetchTerminalProcesses(),
    {
      staleTime:
        config?.staleTime ?? orchestrationQueries.terminalProcesses().staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled,
    },
  );
}

export function useTerminalProcessQuery(
  sessionId: string,
  config?: QueryConfig<TerminalProcessDetail>,
) {
  return useApiQuery(
    orchestrationQueries.terminalProcess(sessionId).queryKey,
    () => fetchTerminalProcess(sessionId),
    {
      staleTime:
        config?.staleTime ??
        orchestrationQueries.terminalProcess(sessionId).staleTime,
      gcTime: config?.gcTime,
      enabled: config?.enabled ?? sessionId.length > 0,
    },
  );
}
