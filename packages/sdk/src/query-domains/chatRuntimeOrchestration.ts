import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import type { ConversationContextBoundaryProjection } from '@kontourai/station-contracts/conversation-context-boundary';
import type {
  AdoptedSessionResult,
  InterruptTurnResult,
  OrchestrationConversationEventWindow,
  OrchestrationSessionEventWindow,
} from '@kontourai/station-contracts/orchestration';
import {
  COOPERATIVE_STOP_BUDGET_MS,
  withNormalizedAnswerability,
} from '@kontourai/station-contracts/orchestration';
import { useMutation } from '@tanstack/react-query';
import { apiErrorMessage } from '../api-core';
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
} from '../client/delegations';
import {
  continueExecutionMessage,
  getConversationContextBoundaryStatus,
} from '../client/execution';
import type { ClientRequestOptions } from '../client/http';
import { authenticatedFetch } from '../client/http';
import {
  getOrchestrationConversationEventWindow,
  getOrchestrationSessionEventWindow,
  getSessionBuilderRun,
  getSessionFlowRun,
  type SessionBuilderRunView,
  type SessionFlowRunView,
} from '../client/orchestration';
import { type QueryConfig, resolveApiBase, useApiQuery } from '../query-core';
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

  constructor(input: {
    failureClass: AdoptSessionFailureClass;
    message: string;
    retryable: boolean;
    status?: number;
    cause?: unknown;
  }) {
    super(input.message);
    this.name = 'AdoptSessionError';
    this.failureClass = input.failureClass;
    this.retryable = input.retryable;
    this.status = input.status;
    this.cause = input.cause;
  }
}

export async function fetchOrchestrationSessionEventWindow(
  threadId: string,
  apiBase?: string,
  input?: { cursor?: string; turnLimit?: number },
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
  input?: { cursor?: string; turnLimit?: number },
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

export function useSessionFlowRunQuery(
  threadId: string,
  apiBase?: string,
  config?: QueryConfig<SessionFlowRunView | null>,
) {
  return useApiQuery(
    ['orchestration-session-flow-run', apiBase ?? 'default', threadId],
    async () => {
      const resolvedApiBase = await resolveApiBase(apiBase);
      return getSessionFlowRun<SessionFlowRunView>(resolvedApiBase, threadId);
    },
    {
      enabled: Boolean(threadId) && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 2_000,
      gcTime: config?.gcTime,
      refetchInterval: config?.refetchInterval ?? 2_000,
    },
  );
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
  return useApiQuery(
    ['orchestration-session-builder-run', apiBase ?? 'default', threadId],
    async () => {
      const resolvedApiBase = await resolveApiBase(apiBase);
      return getSessionBuilderRun<SessionBuilderRunView>(
        resolvedApiBase,
        threadId,
      );
    },
    {
      enabled: Boolean(threadId) && (config?.enabled ?? true),
      staleTime: config?.staleTime ?? 10_000,
      gcTime: config?.gcTime,
      refetchInterval: config?.refetchInterval ?? 10_000,
    },
  );
}

export async function delegateOrchestrationTask(
  input: DelegateTaskInput & { apiBase?: string },
): Promise<DelegatedTaskHandle> {
  const resolvedApiBase = await resolveApiBase(input.apiBase);
  const { apiBase: _apiBase, ...body } = input;
  return delegateTaskClient(resolvedApiBase, body);
}

export function useDelegateOrchestrationTaskMutation(apiBase?: string) {
  return useMutation({
    mutationFn: (input: DelegateTaskInput) =>
      delegateOrchestrationTask({ ...input, apiBase }),
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
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
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
  return Object.freeze({ idempotencyKey: crypto.randomUUID() });
}

export async function adoptOrchestrationSession(input: {
  sourceThreadId: string;
  apiBase?: string;
  intent?: AdoptOrchestrationSessionIntent;
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
  };
  try {
    result = (await response.json()) as typeof result;
  } catch (error) {
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
  if (!response.ok || !result.success) {
    const detail = result.error?.trim();
    const statusMessage =
      response.status === 401 || response.status === 403
        ? `Permission denied by Station (HTTP ${response.status}).`
        : `Station rejected the continuation request (HTTP ${response.status}).`;
    throw new AdoptSessionError({
      failureClass: 'certain-response',
      message: detail ? `${statusMessage} ${detail}` : statusMessage,
      retryable: true,
      status: response.status,
    });
  }
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
  };
  if (!response.ok || !result.success) {
    throw new Error(apiErrorMessage(result, `HTTP ${response.status}`));
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
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel';
  apiBase?: string;
}): Promise<void> {
  await dispatchOrchestrationCommand(
    {
      type: 'respondToRequest',
      threadId: input.threadId,
      requestId: input.requestId,
      decision: input.decision,
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

/** Add user input to the currently open turn; this never queues a future turn. */
export async function steerOrchestrationTurn(input: {
  threadId: string;
  text: string;
  turnId?: string;
  apiBase?: string;
}) {
  return dispatchOrchestrationCommand<
    import('@kontourai/station-contracts/orchestration').SteerTurnResult
  >(
    {
      type: 'steerTurn',
      threadId: input.threadId,
      input: input.text,
      ...(input.turnId ? { turnId: input.turnId } : {}),
    },
    input.apiBase,
  );
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
