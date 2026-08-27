import {
  type ConnectionConfig,
  type ConnectionRecoveryProjection,
  type ProviderKind,
} from '@kontourai/station-contracts';
import {
  type AgentId,
  type EngineConnectionId,
  engineConnectionId,
} from '@kontourai/station-contracts/agent-identity';
import type { ExecutionTarget } from '@kontourai/station-contracts/execution-target';
import {
  authenticatedFetch,
  continueExecutionMessage,
  sendExecutionMessage,
} from '@kontourai/station-sdk/client';
import { describeApiError, printJson, requestJson } from './core-api.js';
import { EXIT_ON_REQUEST_FAIL, type OnRequestMode } from './model-options.js';

export interface CliSessionSummary {
  id: string;
  agent: AgentId;
  kind: 'managed' | 'runtime' | 'agent';
  status?: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  isLoaded?: boolean;
  isPersisted?: boolean;
  eventCount?: number;
  lastEventMethod?: string;
}

export interface CliSessionDetail {
  session: CliSessionSummary;
  entries: Array<Record<string, unknown>>;
  recovery?: ConnectionRecoveryProjection;
}

export interface CliSessionClient {
  listSessions(): Promise<CliSessionSummary[]>;
  readSession(id: string): Promise<CliSessionDetail>;
  interruptSession(id: string, turnId?: string): Promise<void>;
}

/**
 * station#979: the shape a `request.opened` (runtime) or `tool-approval-
 * request` (managed) event is normalized into for CLI surfacing, regardless
 * of which dispatch path produced it.
 */
export interface PendingRequestNotice {
  requestId: string;
  requestType: string;
  title: string;
}

/**
 * The exact ready-to-run command a `station approvals respond` notice
 * points at — the decision itself is left as a placeholder for the operator
 * to fill in, since only they know which of the four is correct.
 */
function buildApprovalsRespondCommand(
  threadId: string,
  requestId: string,
): string {
  return `station approvals respond ${shellQuote(threadId)} ${shellQuote(
    requestId,
  )} <accept|acceptForSession|decline|cancel>`;
}

/**
 * station#979 AC1/AC3: printed once per `request.opened` event on the
 * orchestration (runtime) dispatch path — always to stderr, in EVERY mode
 * (including `--json`, unlike `printResumeHint` below, which is text-mode
 * only): this is a live operational signal that the turn is stalled on a
 * pending request, not the structured result itself, so `--json` callers
 * need it just as much — dropping it there would reproduce the exact silent
 * hang this feature exists to fix.
 */
function printPendingRequestNotice({
  requestId,
  requestType,
  title,
  threadId,
}: PendingRequestNotice & { threadId: string }): void {
  process.stderr.write(
    `Pending ${requestType} request${
      title ? `: ${title}` : ''
    } (id: ${requestId}) on thread ${threadId} — the turn is waiting for a response.\n` +
      `Respond: ${buildApprovalsRespondCommand(threadId, requestId)}\n`,
  );
}

export async function createSessionClient(
  apiBase: string,
  target: {
    agentSlug: AgentId;
    /**
     * station#1155: when the caller has ALREADY classified a plain agent
     * slug via `resolveManagedAgentExternalEngineTarget` (the CLI's
     * per-invocation-engine-settings guard in core.ts does this to decide
     * whether to allow `--cwd`/`--approval-mode`/etc.), pass the result here
     * so `resolveSessionTarget` below reuses it instead of repeating the same
     * `GET .../binding` (+ connection) lookup a second time. `undefined`
     * (the default) means "not classified yet, resolve it here" — unchanged
     * behavior for every caller that never classifies up front. An explicit
     * `null` means "classified as NOT external", which still falls through
     * to the managed path exactly like an uncomputed lookup would.
     */
    classifiedExternalTarget?: RuntimeSessionTarget | null;
  },
): Promise<CliSessionClient> {
  const resolved = await resolveSessionTarget(apiBase, target);
  if (resolved.kind === 'runtime') {
    return createRuntimeSessionClient(apiBase, resolved);
  }
  return createManagedSessionClient(apiBase, resolved.agentSlug);
}

export type RuntimeSessionTarget = {
  kind: 'runtime';
  agentSlug: AgentId;
  connectionId: EngineConnectionId;
  provider: ProviderKind;
  metadata?: Record<string, unknown>;
};

type ResolvedSessionTarget =
  | { kind: 'managed'; agentSlug: AgentId }
  | RuntimeSessionTarget;

/**
 * station#977: resolves the full `RuntimeSessionTarget` for a known
 * `connectionId` discovered from a persisted Agent's own
 * `execution.agentConnectionId` binding. Factored out so an Agent
 * bound to an external engine gets the same provider derivation used by
 * Agent-scoped session reads. Provider comes from `config.provider` (or the
 * ACP capability's literal `acp`), never from connection type or engine id.
 *
 * The caller keeps the real Agent ID in both `agentSlug` and
 * `metadata.agentSlug`, so the
 * server's `resolveSessionAgent` still enriches skills/prompt/tools for it
 * exactly as it would for a Station-engine session.
 */
async function resolveRuntimeSessionTargetForConnection(
  apiBase: string,
  connectionId: EngineConnectionId,
  agentSlug: AgentId,
): Promise<RuntimeSessionTarget> {
  const connection = (await requestJson<ConnectionConfig>(
    apiBase,
    `/api/connections/${encodeURIComponent(connectionId)}`,
  )) as ConnectionConfig;
  if (connection.kind !== 'agent') {
    throw new Error(`Connection '${connectionId}' is not an agent connection.`);
  }
  if (!connection.enabled || connection.status === 'disabled') {
    throw new Error(`Connection '${connectionId}' is disabled.`);
  }
  if (
    connection.status === 'missing_prerequisites' ||
    connection.status === 'error'
  ) {
    throw new Error(
      `Connection '${connectionId}' is not ready (${connection.status}). Run station connections test ${connectionId} for diagnostics.`,
    );
  }
  if (!connection.capabilities.includes('agent-runtime')) {
    throw new Error(
      `Connection '${connectionId}' does not provide an agent runtime.`,
    );
  }

  const isAcp =
    connection.type === 'acp' || connection.capabilities.includes('acp');
  const configuredProvider = connection.config.provider;
  if (!isAcp && typeof configuredProvider !== 'string') {
    throw new Error(
      `Connection '${connectionId}' has no runtime provider configured.`,
    );
  }
  const provider: ProviderKind = isAcp ? 'acp' : (configuredProvider as string);

  return {
    kind: 'runtime',
    connectionId,
    agentSlug,
    provider,
    metadata: {
      agentSlug,
    },
  };
}

/**
 * Looks up an Agent's own persisted binding via the cheap, reload-free
 * `GET /api/agents/:slug/binding` (station#977 review fix — HIGH,
 * performance: the full `GET /api/agents` listing unconditionally triggers
 * a server-side `reloadAgents()` that re-lists every agent from disk and
 * rebuilds every Station-engine agent's runtime instance; paying that cost
 * on every `station chat <slug>`, including the dominant pre-existing
 * "Station agent by name" path, was the regression this endpoint exists to
 * avoid — see `enriched-agents.ts`'s `/:slug/binding` route docblock).
 * Returns a `RuntimeSessionTarget` when the agent is bound to an external
 * engine connection; `null` for an unbound agent, a Station-engine-bound
 * agent, or any lookup failure. This classifier only selects the appropriate
 * Agent-scoped session read model; execution uses ExecutionTarget.
 */
export async function resolveManagedAgentExternalEngineTarget(
  apiBase: string,
  agentSlug: AgentId,
  options?: { strict?: boolean },
): Promise<RuntimeSessionTarget | null> {
  try {
    const binding = (await requestJson<{
      agentConnectionId?: string;
      engineId?: string;
    }>(apiBase, `/api/agents/${encodeURIComponent(agentSlug)}/binding`)) as {
      agentConnectionId?: string;
      engineId?: string;
    };
    const connectionId = binding.agentConnectionId;
    const engineId = binding.engineId;
    // `engineId` here is the exact same field `enriched-agents.ts`'s
    // `isHonestlyAvailableConnectedAgent`/`isExternalEngineConnection` use
    // to distinguish Station's own engine from every external one — 'station'
    // means this agent is (or would be) Station-engine-bound and must fall
    // through unchanged to the existing managed `/chat` path.
    if (
      typeof connectionId !== 'string' ||
      !connectionId ||
      typeof engineId !== 'string' ||
      engineId === 'station'
    ) {
      return null;
    }
    return await resolveRuntimeSessionTargetForConnection(
      apiBase,
      engineConnectionId(connectionId),
      agentSlug,
    );
  } catch (error) {
    if (options?.strict) throw error;
    // A non-strict session listing can still use the Station-managed read
    // model when binding metadata is unavailable.
    return null;
  }
}

async function resolveSessionTarget(
  apiBase: string,
  target: {
    agentSlug: AgentId;
    classifiedExternalTarget?: RuntimeSessionTarget | null;
  },
): Promise<ResolvedSessionTarget> {
  // A persisted Agent can bind either Station's engine or an external one.
  // Reuse an earlier classification when the flag boundary already resolved
  // it; otherwise classify the Agent once here.
  const externalTarget =
    target.classifiedExternalTarget !== undefined
      ? target.classifiedExternalTarget
      : await resolveManagedAgentExternalEngineTarget(
          apiBase,
          target.agentSlug,
        );
  if (externalTarget) return externalTarget;
  return { kind: 'managed', agentSlug: target.agentSlug };
}

function createManagedSessionClient(
  apiBase: string,
  agentSlug: AgentId,
): CliSessionClient {
  return {
    async listSessions() {
      const conversations = (await requestJson<Array<Record<string, unknown>>>(
        apiBase,
        `/agents/${encodeURIComponent(agentSlug)}/conversations`,
      )) as Array<Record<string, unknown>>;

      return conversations.map((conversation) => ({
        id: String(conversation.id),
        agent: agentSlug,
        kind: 'managed',
        title:
          typeof conversation.title === 'string'
            ? conversation.title
            : undefined,
        createdAt:
          typeof conversation.createdAt === 'string'
            ? conversation.createdAt
            : undefined,
        updatedAt:
          typeof conversation.updatedAt === 'string'
            ? conversation.updatedAt
            : undefined,
        status: 'persisted',
        isLoaded: false,
        isPersisted: true,
      }));
    },

    async readSession(id: string) {
      const messages = (await requestJson<Array<Record<string, unknown>>>(
        apiBase,
        `/agents/${encodeURIComponent(agentSlug)}/conversations/${encodeURIComponent(id)}/messages`,
      )) as Array<Record<string, unknown>>;

      return {
        session: {
          id,
          agent: agentSlug,
          kind: 'managed',
          status: 'persisted',
          isLoaded: false,
          isPersisted: true,
        },
        entries: messages.map((message) => ({
          kind: 'message',
          ...message,
        })),
      };
    },

    async interruptSession() {
      throw new Error(
        'Interrupt is only supported for orchestration-backed runtime sessions.',
      );
    },
  };
}

/**
 * Canonical #1418 foreground chat surface. The CLI opens the controlling
 * Station's event stream for presentation, but target selection and all
 * Environment/Agent/engine/model/workspace resolution happen server-side.
 */
export async function sendExecutionTargetChat(
  apiBase: string,
  target: ExecutionTarget,
  options: {
    message: string;
    conversationId?: string;
    jsonMode: boolean;
    onRequest?: OnRequestMode;
  },
): Promise<void> {
  return sendOrchestrationChat(apiBase, target.agent, {
    ...options,
    executionTarget: target,
  });
}

async function sendOrchestrationChat(
  apiBase: string,
  agentSlug: AgentId,
  {
    message,
    conversationId,
    jsonMode,
    onRequest = 'wait',
    executionTarget,
  }: {
    message: string;
    conversationId?: string;
    jsonMode: boolean;
    onRequest?: OnRequestMode;
    executionTarget: ExecutionTarget;
  },
): Promise<void> {
  const threadId =
    typeof conversationId === 'string'
      ? conversationId
      : `cli:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;

  const abortController = new AbortController();
  const response = await authenticatedFetch(
    `${apiBase}/api/orchestration/events`,
    { signal: abortController.signal },
  );
  if (!response.ok) {
    throw new Error(
      `Orchestration event stream failed with HTTP ${response.status}`,
    );
  }

  let finishReason: string | undefined;
  let accumulatedText = '';
  let lifecycleState: string | undefined;
  let pendingRequest: PendingRequestNotice | undefined;
  let onRequestFailTriggered = false;

  const eventsTask = consumeOrchestrationEvents({
    response,
    threadId,
    signal: abortController.signal,
    onTextDelta: (delta) => {
      accumulatedText += delta;
      if (!jsonMode) {
        process.stdout.write(delta);
      }
    },
    onFinish: (reason) => {
      finishReason = reason;
      abortController.abort();
    },
    onError: (error) => {
      throw new Error(error);
    },
    onSessionState: (state) => {
      lifecycleState = state;
    },
    onRequestOpened: (info) => {
      pendingRequest = info;
      printPendingRequestNotice({ ...info, threadId });
      if (onRequest === 'fail') {
        onRequestFailTriggered = true;
        abortController.abort();
        return true;
      }
      return undefined;
    },
  });

  try {
    if (conversationId) {
      if (executionTarget.workspace) {
        throw new Error(
          'A resumed conversation retains its workspace binding; omit workspace flags or start a new chat.',
        );
      }
      await continueExecutionMessage(apiBase, threadId, {
        environment: executionTarget.environment,
        message,
        ...(executionTarget.model ? { model: executionTarget.model } : {}),
      });
    } else {
      await sendExecutionMessage(apiBase, {
        target: executionTarget,
        message,
        conversationId: threadId,
      });
    }

    await eventsTask;
  } finally {
    // Always close this invocation's event stream. Deliberately do NOT stop
    // the Station session: its provider cursor is the durable continuation
    // contract for a later `chat --session` invocation.
    abortController.abort();
    await eventsTask.catch(() => {});
  }

  if (onRequestFailTriggered && pendingRequest) {
    if (jsonMode) {
      printJson({
        agent: agentSlug,
        sessionId: threadId,
        conversationId: threadId,
        pendingRequest: {
          requestId: pendingRequest.requestId,
          requestType: pendingRequest.requestType,
          title: pendingRequest.title,
          respondCommand: buildApprovalsRespondCommand(
            threadId,
            pendingRequest.requestId,
          ),
        },
        ...(lifecycleState ? { lifecycleState } : {}),
      });
    }
    process.exit(EXIT_ON_REQUEST_FAIL);
    return;
  }

  if (jsonMode) {
    printJson({
      agent: agentSlug,
      sessionId: threadId,
      conversationId: threadId,
      finishReason,
      text: accumulatedText,
      ...(pendingRequest
        ? {
            pendingRequest: {
              requestId: pendingRequest.requestId,
              requestType: pendingRequest.requestType,
              title: pendingRequest.title,
              respondCommand: buildApprovalsRespondCommand(
                threadId,
                pendingRequest.requestId,
              ),
            },
          }
        : {}),
      ...(lifecycleState ? { lifecycleState } : {}),
    });
    return;
  }

  if (accumulatedText.length > 0) {
    process.stdout.write('\n');
  }
  printResumeHint({ agentSlug, sessionId: threadId });
}

function createRuntimeSessionClient(
  apiBase: string,
  target: RuntimeSessionTarget,
): CliSessionClient {
  const { agentSlug, provider } = target;
  return {
    async listSessions() {
      const sessions = (await requestJson<Array<Record<string, unknown>>>(
        apiBase,
        '/api/orchestration/sessions/read-model',
      )) as Array<Record<string, unknown>>;

      const providerSessions = sessions.filter(
        (session) => session.provider === provider,
      );
      const matchingSessions =
        provider === 'acp'
          ? (
              await Promise.all(
                providerSessions.map(async (session) => {
                  const detail = await readRuntimeSessionOrNull(
                    apiBase,
                    String(session.threadId),
                  );
                  return runtimeSessionMatchesTarget(detail, target)
                    ? session
                    : null;
                }),
              )
            ).filter((session): session is Record<string, unknown> => !!session)
          : providerSessions;

      return matchingSessions.map((session) => ({
        id: String(session.threadId),
        agent: agentSlug,
        kind: 'agent',
        status: typeof session.status === 'string' ? session.status : undefined,
        createdAt:
          typeof session.createdAt === 'string' ? session.createdAt : undefined,
        updatedAt:
          typeof session.updatedAt === 'string' ? session.updatedAt : undefined,
        isLoaded:
          typeof session.isLoaded === 'boolean' ? session.isLoaded : undefined,
        isPersisted:
          typeof session.isPersisted === 'boolean'
            ? session.isPersisted
            : undefined,
        eventCount:
          typeof session.eventCount === 'number'
            ? session.eventCount
            : undefined,
        lastEventMethod:
          typeof session.lastEventMethod === 'string'
            ? session.lastEventMethod
            : undefined,
      }));
    },

    async readSession(id: string) {
      const detail = (await requestJson<Record<string, unknown>>(
        apiBase,
        `/api/orchestration/sessions/${encodeURIComponent(id)}`,
      )) as Record<string, unknown>;
      const session = detail.session as Record<string, unknown>;
      const events = Array.isArray(detail.events)
        ? (detail.events as Array<Record<string, unknown>>)
        : [];
      assertRuntimeSessionMatchesTarget(detail, target);

      return {
        session: {
          id,
          agent: agentSlug,
          kind: 'agent',
          status:
            typeof session.status === 'string' ? session.status : undefined,
          createdAt:
            typeof session.createdAt === 'string'
              ? session.createdAt
              : undefined,
          updatedAt:
            typeof session.updatedAt === 'string'
              ? session.updatedAt
              : undefined,
          isLoaded:
            typeof session.isLoaded === 'boolean'
              ? session.isLoaded
              : undefined,
          isPersisted:
            typeof session.isPersisted === 'boolean'
              ? session.isPersisted
              : undefined,
          eventCount:
            typeof session.eventCount === 'number'
              ? session.eventCount
              : undefined,
          lastEventMethod:
            typeof session.lastEventMethod === 'string'
              ? session.lastEventMethod
              : undefined,
        },
        entries: events.map((event) => ({
          kind: 'event',
          ...event,
        })),
        ...(detail.recovery && typeof detail.recovery === 'object'
          ? { recovery: detail.recovery as ConnectionRecoveryProjection }
          : {}),
      };
    },

    async interruptSession(id: string, turnId?: string) {
      const detail = await readRuntimeSessionOrNull(apiBase, id);
      if (!detail) {
        throw new Error(`Runtime session '${id}' was not found.`);
      }
      assertRuntimeSessionMatchesTarget(detail, target);
      await requestJson(apiBase, '/api/orchestration/commands', {
        method: 'POST',
        body: JSON.stringify({
          type: 'interruptTurn',
          threadId: id,
          ...(typeof turnId === 'string' && turnId.length > 0
            ? { turnId }
            : {}),
        }),
      });
    },
  };
}

async function readRuntimeSessionOrNull(apiBase: string, threadId: string) {
  const response = await authenticatedFetch(
    `${apiBase}/api/orchestration/sessions/${encodeURIComponent(threadId)}`,
  );
  if (response.status === 404) {
    return null;
  }
  const payload = (await response.json()) as {
    success: boolean;
    data?: Record<string, unknown>;
    error?: unknown;
  };
  if (!response.ok || !payload.success) {
    throw new Error(
      describeApiError(
        payload.error,
        `Request failed with HTTP ${response.status}`,
      ),
    );
  }
  return payload.data ?? null;
}

function assertRuntimeSessionMatchesTarget(
  detail: Record<string, unknown>,
  target: RuntimeSessionTarget,
): void {
  if (!runtimeSessionMatchesTarget(detail, target)) {
    throw new Error(
      `Runtime session does not belong to Agent '${target.agentSlug}'.`,
    );
  }
}

function runtimeSessionMatchesTarget(
  detail: Record<string, unknown> | null,
  target: RuntimeSessionTarget,
): boolean {
  if (!detail) return false;
  const session = detail.session as Record<string, unknown> | undefined;
  if (session?.provider !== target.provider) return false;

  const events = Array.isArray(detail.events)
    ? (detail.events as Array<Record<string, unknown>>)
    : [];
  const configured = [...events]
    .reverse()
    .find((event) => event.method === 'session.configured');
  const configuredMetadata = configured?.metadata as
    | Record<string, unknown>
    | undefined;
  const configuredAgentId = configuredMetadata?.agentSlug;
  if (typeof configuredAgentId === 'string') {
    return configuredAgentId === target.agentSlug;
  }

  // ACP providers share one orchestration provider id across multiple CLI
  // agents (for example Kiro and OpenCode), so an unscoped ACP session must
  // never leak into another Agent's list/read/interrupt surface.
  return target.provider !== 'acp';
}

/**
 * station#979 AC5: resolves an agent-runtime connection's canonical
 * provider from the fetched connection's `config.provider` (or `'acp'` for
 * an ACP-transported connection).
 * Returns `null` for a 404/missing connection or a non-agent/unresolvable
 * provider; any other failure (5xx, malformed body) propagates as an
 * actionable error, matching `readRuntimeSessionOrNull`'s status split.
 */
async function resolveProviderForConnectionId(
  apiBase: string,
  connectionId: EngineConnectionId,
): Promise<ProviderKind | null> {
  const response = await authenticatedFetch(
    `${apiBase}/api/connections/${encodeURIComponent(connectionId)}`,
  );
  if (response.status === 404) {
    return null;
  }
  const payload = (await response.json()) as {
    success: boolean;
    data?: ConnectionConfig;
    error?: unknown;
  };
  if (!response.ok || !payload.success) {
    throw new Error(
      describeApiError(
        payload.error,
        `Request failed with HTTP ${response.status}`,
      ),
    );
  }
  const connection = payload.data;
  if (connection?.kind !== 'agent') {
    return null;
  }
  const isAcp =
    connection.type === 'acp' || connection.capabilities.includes('acp');
  if (isAcp) return 'acp';
  return typeof connection.config.provider === 'string'
    ? connection.config.provider
    : null;
}

/**
 * Resolve an Agent ID to its bound external engine's orchestration provider.
 */
export async function resolveApprovalsAgentProvider(
  apiBase: string,
  agentSlug: AgentId,
): Promise<ProviderKind | null> {
  // 404 → unsupported-slug (the caller's configuration diagnosis); any other
  // failure is operational and must propagate as its own actionable error
  // (same status split as `readRuntimeSessionOrNull` above).
  const response = await authenticatedFetch(
    `${apiBase}/api/agents/${encodeURIComponent(agentSlug)}`,
  );
  if (response.status === 404) {
    return null;
  }
  const payload = (await response.json()) as {
    success: boolean;
    data?: { execution?: { agentConnectionId?: string } };
    error?: unknown;
  };
  if (!response.ok || !payload.success) {
    throw new Error(
      describeApiError(
        payload.error,
        `Request failed with HTTP ${response.status}`,
      ),
    );
  }
  const boundConnectionId = payload.data?.execution?.agentConnectionId;
  if (!boundConnectionId) {
    return null;
  }
  const resolved = await resolveProviderForConnectionId(
    apiBase,
    engineConnectionId(boundConnectionId),
  );
  return resolved;
}

function printResumeHint({
  agentSlug,
  sessionId,
}: {
  agentSlug: AgentId;
  sessionId: string;
}): void {
  process.stderr.write(
    `Session: ${sessionId}\nResume: station chat ${shellQuote(agentSlug)} --session=${shellQuote(
      sessionId,
    )} <message>\n`,
  );
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function consumeOrchestrationEvents({
  response,
  threadId,
  signal,
  onTextDelta,
  onFinish,
  onError,
  onRequestOpened,
  onSessionState,
}: {
  response: Response;
  threadId: string;
  signal: AbortSignal;
  onTextDelta: (delta: string) => void;
  onFinish: (reason?: string) => void;
  onError: (message: string) => never;
  /**
   * station#979 AC1/AC3/AC4: called once per `request.opened` event on this
   * thread. Returning `true` stops consuming further frames immediately
   * (mirrors `turn.completed`'s own early-stop) — used by
   * `--on-request=fail` to end the wait without tearing the session down;
   * `--on-request=wait` (default) returns nothing and the loop continues
   * exactly as it did before this event existed.
   */
  onRequestOpened?: (info: PendingRequestNotice) => boolean | undefined;
  /** station#979 AC7: the latest `sessionState` seen on any frame this turn. */
  onSessionState?: (state: string) => void;
}) {
  await consumeSseFrames({
    response,
    threadId,
    signal,
    onFrame: (event) => {
      if (typeof event.sessionState === 'string') {
        onSessionState?.(event.sessionState);
      }

      if (
        event.method === 'content.text-delta' &&
        typeof event.delta === 'string'
      ) {
        onTextDelta(event.delta);
        return;
      }

      if (event.method === 'runtime.error') {
        onError(
          typeof event.message === 'string'
            ? event.message
            : 'Connected runtime failed',
        );
      }

      if (event.method === 'turn.aborted') {
        onError(
          typeof event.reason === 'string'
            ? event.reason
            : 'Connected runtime turn aborted',
        );
      }

      if (event.method === 'request.opened') {
        const requestId =
          typeof event.requestId === 'string' ? event.requestId : undefined;
        if (!requestId || !onRequestOpened) {
          return;
        }
        return (
          onRequestOpened({
            requestId,
            requestType:
              typeof event.requestType === 'string'
                ? event.requestType
                : 'unknown',
            title: typeof event.title === 'string' ? event.title : '',
          }) === true
        );
      }

      if (event.method === 'turn.completed') {
        onFinish(
          typeof event.finishReason === 'string'
            ? event.finishReason
            : undefined,
        );
        return true;
      }
    },
  });
}

export interface ConsumeSseFramesOptions {
  response: Response;
  /**
   * Filters dispatched frames to one thread's events, matching today's
   * behavior exactly when supplied. Omitted (`undefined`) puts this call in
   * "global" mode (#168 `station operate`): every event frame on the
   * connection reaches `onFrame` unfiltered — used when one connection
   * serves an all-sessions board plus a client-side-filtered transcript,
   * rather than opening a fresh per-thread connection.
   */
  threadId?: string;
  /**
   * The same `AbortSignal` the caller passed to the `fetch()` that produced
   * `response`. Used to tell an intentional, caller-initiated teardown apart
   * from a genuine stream failure: a `reader.read()` that rejects with
   * `AbortError` after `signal.aborted` is already `true` is treated as a
   * clean stop rather than re-thrown.
   */
  signal: AbortSignal;
  /**
   * Called once per parsed orchestration event whose `threadId` matches
   * (or every event, in global mode). Return `true` to stop consuming
   * immediately (no further `reader.read()` calls); any other return value
   * keeps the loop going.
   */
  onFrame: (event: Record<string, unknown>) => boolean | undefined;
  /**
   * Called once for the initial `orchestration:snapshot` frame
   * (`{sessions}`, `src-server/routes/orchestration/orchestration.ts:305-309`) — the only
   * frame shape on this connection with no `method` field. When supplied,
   * this frame is dispatched here and `continue`d past (never reaches
   * `onFrame`). When omitted, the snapshot frame is silently skipped
   * exactly as it always has been for every pre-#168 caller
   * (`sendMessage`, `watchApprovalEvents`), since neither filters it out by
   * `threadId` today (the snapshot frame carries no `threadId` field, so
   * the existing `event.threadId !== threadId` filter already dropped it).
   */
  onSnapshot?: (sessions: Array<Record<string, unknown>>) => void;
}

/**
 * Shared SSE frame-parsing skeleton for `/api/orchestration/events`
 * consumers (#165 iteration-2 code-review MEDIUM+HIGH fix). Owns
 * `response.body.getReader()` + the decoder/buffer/`\n\n`-segment-split
 * loop, the `data: `-line extraction, the `[DONE]`/empty-payload skip, the
 * `{event:...}`-vs-flat unwrap, the `threadId` filter, and the
 * `finally { reader.releaseLock() }` cleanup — the ~25-30 line skeleton
 * `sendMessage`'s event loop and `approvals.ts`'s `watchApprovalEvents` used
 * to duplicate byte-for-byte. Each call site supplies its own
 * `method`-dispatch via `onFrame` and decides when to stop by returning
 * `true`; callers own calling `AbortController.abort()` on their own exit
 * conditions (this helper only reads and dispatches frames — it does not
 * abort the connection itself).
 *
 * #168 extension (`station operate`): `threadId` is now optional and
 * `onSnapshot` is new — see `ConsumeSseFramesOptions`'s docblocks. Frame
 * classification order per parsed frame: (1) the snapshot shape (`sessions`
 * array present, no `method` field) is checked first and dispatched to
 * `onSnapshot`/`continue`d past regardless of `threadId`; (2) when
 * `threadId` is supplied, the exact pre-#168 filter applies
 * (`event.threadId !== threadId` -> `continue`); (3) when `threadId` is
 * omitted, every remaining frame reaches `onFrame` unfiltered. This
 * preserves both pre-#168 callers' behavior byte-for-byte (they always pass
 * `threadId`, and neither passes `onSnapshot`, so the snapshot frame is
 * silently skipped for them exactly as before).
 */
export async function consumeSseFrames({
  response,
  threadId,
  signal,
  onFrame,
  onSnapshot,
}: ConsumeSseFramesOptions): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('No orchestration event stream body available');
  }

  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }

      buffer += decoder.decode(value, { stream: true });
      const segments = buffer.split('\n\n');
      buffer = segments.pop() || '';

      for (const segment of segments) {
        const payload = extractSseData(segment);
        if (!payload || payload === '[DONE]') {
          continue;
        }

        const parsed = JSON.parse(payload) as Record<string, unknown>;
        const event =
          parsed.event && typeof parsed.event === 'object'
            ? (parsed.event as Record<string, unknown>)
            : parsed;

        if (Array.isArray(event.sessions) && typeof event.method !== 'string') {
          onSnapshot?.(event.sessions as Array<Record<string, unknown>>);
          continue;
        }

        if (threadId !== undefined && event.threadId !== threadId) {
          continue;
        }

        if (onFrame(event) === true) {
          return;
        }
      }
    }
  } catch (error: unknown) {
    if (
      signal.aborted &&
      error instanceof Error &&
      error.name === 'AbortError'
    ) {
      return;
    }
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
}

function extractSseData(segment: string): string | null {
  const line = segment.split('\n').find((entry) => entry.startsWith('data: '));
  return line ? line.slice(6) : null;
}
