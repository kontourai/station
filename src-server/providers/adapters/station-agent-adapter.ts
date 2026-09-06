import crypto from 'node:crypto';
import type { AgentDelegationContext } from '@kontourai/station-contracts/agent';
import { engineId } from '@kontourai/station-contracts/agent-identity';
import type { ChatAttachmentInput } from '@kontourai/station-contracts/chat-attachment';
import { stripReservedOrchestrationMetadata } from '@kontourai/station-contracts/provider';
import {
  type ApprovalStatus,
  type CanonicalRuntimeEvent,
  SERVER_EVENTS,
} from '@kontourai/station-contracts/runtime-events';
import { readWithStallWatchdog } from '@kontourai/station-contracts/stall-watchdog';
import type { TenantExecutionContext } from '@kontourai/station-contracts/tenancy';
import type { Prerequisite } from '@kontourai/station-contracts/tool';
import {
  CONTEXT_INJECTION_METADATA_KEY,
  parseTurnProvenanceContextInjection,
  type TurnProvenanceContextInjection,
} from '@kontourai/station-contracts/turn-provenance-context';
import {
  currentAuthorizedTurnCorrelation,
  INTERNAL_TURN_CORRELATION_HEADER,
  issueAuthorizedTurnCorrelationHandoff,
} from '../../runtime/conversation/authorized-turn-correlation.js';
import { stripOutputDeclarationHandle } from '../../runtime/native-output-declaration.js';
import { currentNativeOutputRelayCompanion } from '../../runtime/native-output-turn-grant.js';
import type { ApprovalRegistry } from '../../services/approvals/approval-registry.js';
import type {
  EventBus,
  ServerEvent,
} from '../../services/orchestration/event-bus.js';
import {
  tenantExecutionContextAttributes,
  tenantExecutionContextOutcomes,
} from '../../telemetry/metrics.js';
import {
  getInternalApiToken,
  INTERNAL_API_TOKEN_HEADER,
  INTERNAL_PROXY_CALLER_HEADER,
  INTERNAL_TENANT_HEADER,
} from '../../utils/internal-api-token.js';
import type {
  ProviderAdapterShape,
  ProviderSendTurnInput,
  ProviderSession,
  ProviderSessionStartInput,
  ProviderTurnStartResult,
} from '../adapter-shape.js';
import { effectiveModelMetadata } from '../llm/effective-model-metadata.js';
import { AsyncEventQueue } from '../sessions/async-event-queue.js';
import { UNRESOLVED_TOOL_OUTPUT } from './unresolved-tool-output.js';

const PROVIDER = 'station-agent' as const;

/**
 * archive#1207 (review HIGH 2, the actual production trigger under
 * `managed-chat-orchestration`): how long `consumeChatStream`'s bridge from
 * the inner `/chat` SSE response onto the orchestration event bus may go
 * completely silent before it is treated as dead. Without this, a silent
 * stall on the inner stream (server crash, dropped connection, no error
 * event) means `reader.read()` never resolves, no `turn.completed` /
 * `runtime.error` is ever published, and the client's own
 * `/api/orchestration/events` stream — correctly timeout-free by design —
 * waits forever with no signal to surface an error.
 *
 * Same margin logic as the direct-path client watchdog
 * (`CHAT_STREAM_STALL_TIMEOUT_MS`, `packages/sdk/.../chatRuntimeStream.ts`):
 * the inner `/chat` response carries the SAME `SSE_KEEPALIVE_INTERVAL_MS`
 * keepalive comments (`stream-orchestrator.ts`) this bridge already reads
 * (and already ignores — see the `!line.startsWith('data: ')` guard below,
 * unchanged), so this timeout resets on every keepalive too and must stay
 * comfortably larger than that interval.
 */
export const STATION_AGENT_STREAM_STALL_TIMEOUT_MS = 45_000;

/**
 * Thrown when the inner `/chat` bridge stream has gone silent for
 * `STATION_AGENT_STREAM_STALL_TIMEOUT_MS`. Deliberately distinguishable
 * from an ordinary read failure so `failTurn`'s published `runtime.error`
 * can carry an honest, specific reason instead of a generic one.
 *
 * The read/race mechanics themselves are the shared
 * `readWithStallWatchdog` (archive#1256, deduplicating archive#1207) —
 * this class is injected as its `makeError`, which is the only thing that
 * differed from the SDK's `ChatStreamStallError` sibling.
 */
export class StationAgentStreamStallError extends Error {
  constructor(timeoutMs: number) {
    super(
      `station-agent chat bridge stalled — no response for ${Math.round(
        timeoutMs / 1000,
      )}s`,
    );
    this.name = 'StationAgentStreamStallError';
  }
}

interface StationAgentResumeCursor {
  agentId: string;
  projectSlug?: string;
  userId?: string;
  delegation?: AgentDelegationContext;
  tenantExecutionContext?: TenantExecutionContext;
}

interface StationAgentSessionRecord {
  session: ProviderSession;
  agentId: string;
  projectSlug?: string;
  userId?: string;
  delegation?: AgentDelegationContext;
  tenantExecutionContext?: TenantExecutionContext;
  activeTurnId?: string;
  activeController?: AbortController;
  abortPublished?: boolean;
  pendingRequests: Map<string, { toolName?: string; turnId?: string }>;
  approvedTools: Set<string>;
  resolvedBeforeOpen: Map<string, ApprovalStatus>;
  /**
   * station#1569 (item 4): `toolCallId → { toolName, turnId }` for calls
   * whose `tool.started` has been published and whose `tool-result` chunk has
   * not arrived. The adapter had no tool-call state at all before this — the
   * SSE relay is stateless — so a call whose stream was abandoned (a stop, a
   * dropped connection) left a row running forever with no terminal from any
   * path.
   *
   * Maintained by `consumeChatStream` from the relay's own `toolOpened` /
   * `toolSettled` reports (the same shape `approvalOpened` already uses), so
   * `mapStationAgentStreamEvent` stays a pure per-chunk translator. Settled
   * only when the SESSION ends (`stopSession`), never at a turn boundary.
   *
   * station#1586 (item 2): id-less calls are in here too, under the id the
   * relay minted for them. They were excluded while an id-less start and its
   * id-less result minted DIFFERENT ids — an entry its own result could not
   * delete would have been settled as a false "no result was reported" — and
   * the relay's FIFO pairing (`pendingIdlessToolCallIds`) is what removed
   * that hazard.
   */
  openToolCalls: Map<string, { toolName: string; turnId: string }>;
}

export interface StationAgentAdapterOptions {
  apiBase: string;
  /**
   * Must recognize any agent the `/api/agents/:slug/chat` route can serve —
   * not just the in-memory active set (archive#1049). A persisted agent that
   * failed to register (e.g. an unresolved model connection) is still a
   * *known* agent to that route (it returns a specific 409), so this check
   * has to agree or the flip pre-empts the route with a factually wrong
   * "unknown agent" instead of letting the route's own availability handling
   * run. `sendTurn`'s non-ok branch reads the route's own reason out of the
   * response body and threads it into both the thrown error and the
   * published `runtime.error` event (archive#1071); this predicate only
   * stops the wrong "unknown agent" rejection from pre-empting that.
   * See `createRegistryAwareHasAgent` for the production predicate.
   */
  hasAgent(agentId: string): boolean | Promise<boolean>;
  /** Recovery starts before the runtime has finished populating activeAgents. */
  isAgentRegistryReady?: () => boolean;
  approvalRegistry: Pick<ApprovalRegistry, 'has' | 'resolve'>;
  eventBus: Pick<EventBus, 'subscribe'>;
  fetch?: typeof fetch;
  now?: () => Date;
}

/**
 * Builds the `hasAgent` predicate the station-agent adapter should use:
 * true for anything in the live active-agent set, OR anything the on-disk
 * agent registry knows about (persisted, even if it didn't make it into the
 * active set). This mirrors what `POST /api/agents/:slug/chat` itself can
 * serve/report on (chat.ts's `resolveUnavailablePersistedAgent`) — a
 * persisted-but-currently-unlaunchable agent gets a specific 409 from that
 * route, not a 404, so the flip must not reject it earlier as "unknown".
 * A slug with no active registration AND no persisted spec is genuinely
 * unknown and still rejected.
 */
export function createRegistryAwareHasAgent(
  activeAgents: { has(agentId: string): boolean },
  loadPersistedAgent: (agentId: string) => Promise<unknown>,
): (agentId: string) => Promise<boolean> {
  return async (agentId: string): Promise<boolean> => {
    if (activeAgents.has(agentId)) return true;
    try {
      await loadPersistedAgent(agentId);
      return true;
    } catch {
      return false;
    }
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * archive#1885: the mutation-budget middleware rejects oversized bodies with
 * `{ error: { code: 'request_too_large', limit_bytes } }` — an OBJECT, not a
 * string. The `stringField` read above silently dropped objects, so a size
 * rejection surfaced as the generic "did not accept the task turn" with no
 * mention of size. The same object shape carries every structured rejection
 * from the security/budget middleware (`rate_limited`, `authentication_required`,
 * `origin_forbidden`, `insufficient_scope`), so this covers all of them, not
 * just 413.
 */
function numberField(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function rejectionReasonFromError(error: unknown): string | undefined {
  if (typeof error === 'string') return error;
  if (!error || typeof error !== 'object') return undefined;
  const record = error as Record<string, unknown>;
  const code = stringField(record.code);
  if (!code) {
    // An object error with no usable code — fall back to the generic message.
    return stringField(record.message);
  }
  if (code === 'request_too_large') {
    const limitBytes = numberField(record.limit_bytes);
    return limitBytes !== undefined
      ? `request body too large (limit ${limitBytes} bytes)`
      : 'request body too large';
  }
  return code;
}

function delegationField(value: unknown): AgentDelegationContext | undefined {
  return value && typeof value === 'object'
    ? (value as AgentDelegationContext)
    : undefined;
}

interface RelayChatPart {
  type: string;
  text?: string;
  url?: string;
  mediaType?: string;
}

interface RelayChatMessage {
  id: string;
  role: string;
  parts: RelayChatPart[];
}

/**
 * archive#1885: composes the `input` field forwarded to `/chat`. When the
 * turn carries attachments, they ride as the multipart message shape `/chat`
 * already accepts — the same shape the direct path built pre-#1418
 * (`buildConversationTurnInput` in chatRuntimeStream.ts), where each
 * attachment becomes a `{type:'file', url, mediaType}` part and `/chat` →
 * `agent.streamText` consumes the array (the ambient/RAG composition seams
 * in chat-context.ts and `extractChatUserText` both preserve it). Without
 * this forwarding, the `image-input` capability declared above would be a
 * silent drop: the gate would pass and the attachment would never reach the
 * engine. The orchestration capability gate remains the authority on which
 * attachment kinds are allowed; this helper forwards whatever survives it.
 */
function buildRelayInput(
  text: string,
  attachments: ChatAttachmentInput[] | undefined,
): string | RelayChatMessage[] {
  if (!attachments || attachments.length === 0) {
    return text;
  }
  const parts: RelayChatPart[] = [];
  if (text) {
    parts.push({ type: 'text', text });
  }
  for (const attachment of attachments) {
    parts.push({
      type: 'file',
      url: attachment.dataUrl,
      mediaType: attachment.mimeType,
    });
  }
  return [{ id: `msg-${Date.now()}`, role: 'user', parts }];
}

function parseResumeCursor(value: unknown): StationAgentResumeCursor | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const agentId = stringField(record.agentId);
  if (!agentId) return null;
  return {
    agentId,
    ...(stringField(record.projectSlug)
      ? { projectSlug: stringField(record.projectSlug) }
      : {}),
    ...(stringField(record.userId)
      ? { userId: stringField(record.userId) }
      : {}),
    ...(delegationField(record.delegation)
      ? { delegation: delegationField(record.delegation) }
      : {}),
  };
}

function finishReason(
  value: unknown,
): 'stop' | 'tool-calls' | 'max-tokens' | 'cancelled' | 'other' {
  if (value === 'stop' || value === 'tool-calls' || value === 'max-tokens') {
    return value;
  }
  if (value === 'cancelled' || value === 'canceled' || value === 'aborted') {
    return 'cancelled';
  }
  return 'other';
}

function turnRejectionMessage(reason?: string): string {
  return reason
    ? `Station agent did not accept the task turn: ${reason}`
    : 'Station agent did not accept the task turn';
}

// A /chat rejection body is a small JSON object; anything bigger than this
// is not the route's error contract and is not worth buffering on the
// turn-failure path.
const REJECTION_BODY_MAX_BYTES = 16 * 1024;
// The rejection body is best-effort context — a body that cannot arrive
// promptly must not hold the turn failure (and its runtime.error) hostage.
const REJECTION_BODY_DEADLINE_MS = 3_000;
// The reason is republished into runtime.error events and CLI output.
const REJECTION_REASON_MAX_CHARS = 500;

/** Single bounded line: no control/ANSI sequences, hard length cap. */
function normalizeRejectionReason(value: string): string | undefined {
  const cleaned = value
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point — the reason is republished into persisted events and raw CLI output. U+2028/U+2029 are line separators too (closure-round LOW).
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > REJECTION_REASON_MAX_CHARS
    ? `${cleaned.slice(0, REJECTION_REASON_MAX_CHARS)}…`
    : cleaned;
}

/**
 * Extracts the `error` field from a /chat rejection's JSON body (archive#1071).
 * The read is bounded (bytes + deadline) and abort-aware, so a degenerate
 * body can never hang or bloat the turn-failure path — the pre-#1071 code
 * never read rejection bodies at all, and surfacing the reason must not
 * cost that property. Anything unusable (oversized, slow, non-JSON, a
 * non-string field) yields undefined and the caller falls back to the
 * generic message.
 *
 * Handles BOTH error shapes this route's middleware can produce: a plain
 * string (`{ error: "..." }`, the route's own 409s) and a structured object
 * (`{ error: { code, limit_bytes } }`, the mutation-budget middleware's 413
 * and the security middleware's 401/403/429 — archive#1885).
 */
export async function readChatRejectionReason(
  response: Response,
  options: {
    signal?: AbortSignal;
    maxBytes?: number;
    deadlineMs?: number;
  } = {},
): Promise<string | undefined> {
  const body = response.body;
  if (!body || options.signal?.aborted) return undefined;
  const reader = body.getReader();
  // Cancelling the reader resolves any pending read() as done, so both the
  // deadline and an interrupt unblock the loop instead of racing it. The
  // flag distinguishes cancellation from natural EOF: a body that did not
  // COMPLETE within the bounds is outside the route's error contract, and a
  // prefix that happens to parse must not be trusted (closure-round MED).
  let cancelled = false;
  const cancelRead = () => {
    cancelled = true;
    void reader.cancel().catch(() => {});
  };
  options.signal?.addEventListener('abort', cancelRead, { once: true });
  const deadline = setTimeout(
    cancelRead,
    options.deadlineMs ?? REJECTION_BODY_DEADLINE_MS,
  );
  try {
    const maxBytes = options.maxBytes ?? REJECTION_BODY_MAX_BYTES;
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      // Enforced on what was actually received, AFTER the read — checking
      // before the read lets a single oversized chunk through whole
      // (closure-round MED: the round-1 loop did exactly that).
      if (bytes > maxBytes) return undefined;
      text += decoder.decode(value, { stream: true });
    }
    if (cancelled) return undefined;
    text += decoder.decode();
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      const reason = rejectionReasonFromError(
        (parsed as Record<string, unknown>).error,
      );
      return reason ? normalizeRejectionReason(reason) : undefined;
    }
  } catch {
    // Rejection bodies are best-effort context; unreadable ones are not
    // worth failing over when a generic message is available.
  } finally {
    clearTimeout(deadline);
    options.signal?.removeEventListener('abort', cancelRead);
    cancelRead();
  }
  return undefined;
}

function safeToolName(event: Record<string, unknown>): string {
  return (
    stringField(event.toolName) ??
    stringField(event.tool) ??
    'Station agent tool'
  );
}

/** Translate Station's existing chat SSE chunks into the canonical task stream. */
export function mapStationAgentStreamEvent(options: {
  event: Record<string, unknown>;
  threadId: string;
  turnId: string;
  publish(event: CanonicalRuntimeEvent): void;
  now?: () => Date;
  /**
   * station#1586 (item 2): caller-owned FIFO of the ids this relay minted for
   * `tool-call` chunks that carried no `toolCallId` and whose id-less
   * `tool-result` has not arrived. Owned by the caller for the same reason
   * `openToolCalls` is — this function stays a per-chunk translator with no
   * session record — and required rather than optional so no caller can
   * accidentally get a `toolOpened` report for a call whose result can never
   * be paired back to it, which is exactly the false-`unresolved` hazard
   * station#1569 (M2) avoided by not tracking id-less calls at all.
   *
   * FIFO because that is the only ordering the chunks themselves support: an
   * id-less result names nothing, so the oldest unanswered id-less call is
   * the only defensible pairing. Concurrent id-less calls whose results
   * arrive out of order would be paired to each other's rows — an engine
   * that runs tools concurrently AND omits ids gives Station nothing better
   * to go on, and the arguments/output on each row are still the engine's
   * own.
   */
  pendingIdlessToolCallIds: string[];
}): {
  outputDelta?: string;
  finishReason?: ReturnType<typeof finishReason>;
  failed?: true;
  approvalOpened?: { requestId: string; toolName?: string };
  /**
   * station#1569 (item 4): this chunk opened a tool call, or closed one.
   * Reported rather than recorded, because this relay is a pure translator
   * with no access to the session record — `consumeChatStream` owns the
   * tracking the session-end settle reads (same split as `approvalOpened`).
   */
  toolOpened?: { toolCallId: string; toolName: string };
  toolSettled?: { toolCallId: string };
  /**
   * station#1586 (item 2): this `tool-result` chunk carried no `toolCallId`
   * and no id-less call was waiting to pair with it, so its `tool.completed`
   * was published under a freshly minted id that no `tool.started` ever
   * used. The row is start-less by necessity — the engine reported an
   * outcome for a call it never identified — and this reports that rather
   * than leaving the shape indistinguishable from a settled pair.
   */
  unpairedToolResult?: true;
  /**
   * archive#2649: `/chat`'s own dispatch-time context receipt, parsed
   * strictly (a malformed record is dropped whole, leaving the honest
   * envelope gap, never a partial claim). Not published as its own canonical
   * event — `consumeChatStream` stamps it on the turn's terminal event,
   * which is where the turn-provenance fold reads it.
   */
  contextInjection?: TurnProvenanceContextInjection;
} {
  const { event, threadId, turnId, publish } = options;
  const createdAt = (options.now ?? (() => new Date()))().toISOString();
  const base = {
    eventId: crypto.randomUUID(),
    provider: PROVIDER,
    threadId,
    turnId,
    createdAt,
  };

  if (event.type === 'text-delta' && typeof event.text === 'string') {
    publish({
      ...base,
      itemId: stringField(event.id) ?? turnId,
      method: 'content.text-delta',
      delta: event.text,
    });
    return { outputDelta: event.text };
  }
  if (event.type === 'reasoning-delta' && typeof event.text === 'string') {
    publish({
      ...base,
      itemId: stringField(event.id) ?? turnId,
      method: 'content.reasoning-delta',
      delta: event.text,
    });
    return {};
  }
  if (event.type === 'tool-call') {
    const reportedCallId = stringField(event.toolCallId);
    // station#1586 (item 2): an id-less chunk still gets a minted id, but the
    // mint now happens ONCE per call and is remembered, so the matching
    // id-less `tool-result` publishes under the SAME id instead of a second
    // one. Before this, the pair produced two rows — a start that never
    // finished beside a result that never started — and station#1569 (M2)
    // had to exclude id-less calls from tracking entirely, because an entry
    // its own result could not delete would have been settled as a false
    // "no result was reported". Paired, the call is ordinary: tracked at the
    // start, deleted by its result, and settled honestly if neither arrives.
    const toolCallId = reportedCallId ?? crypto.randomUUID();
    if (!reportedCallId) options.pendingIdlessToolCallIds.push(toolCallId);
    publish({
      ...base,
      itemId: toolCallId,
      method: 'tool.started',
      toolCallId,
      toolName: safeToolName(event),
      arguments: event.input,
    });
    return {
      toolOpened: {
        toolCallId,
        toolName: safeToolName(event),
      },
    };
  }
  if (event.type === 'tool-result') {
    const reportedCallId = stringField(event.toolCallId);
    // station#1586 (item 2): an id-less result claims the oldest id-less call
    // still waiting, so the pair publishes as ONE row. With no such call
    // waiting there is nothing to claim — the result still publishes under a
    // fresh id (unchanged behavior: withholding an outcome the engine did
    // report would be worse than a start-less row) and says so in
    // `unpairedToolResult`.
    const pairedCallId = reportedCallId
      ? undefined
      : options.pendingIdlessToolCallIds.shift();
    const toolCallId = reportedCallId ?? pairedCallId ?? crypto.randomUUID();
    const error = stringField(event.error);
    // archive#3113/#3117: `event.error` reaching this relay is ALREADY the
    // safe text — both engine adapters (voltagent-adapter.ts's
    // `normalizeVoltAgentToolErrors`, strands-stream-events.ts's
    // `mapStrandsStreamEvent`) lift it from their own internals and decide
    // there what may cross. archive#3210 changed WHICH marker makes that
    // decision: it is `stationComposedReason` (the text was composed by
    // `denial-message.ts`, so its tool name is sanitized and any guardian or
    // hook prose inside it is bounded, quoted and attributed) — not
    // `policyDenied`, which says only that the policy evaluator produced the
    // denial and rides through here independently as the archive#3091 badge.
    // Anything else is the fixed generic message. This relay
    // no longer substitutes its own hardcoded literal — doing so is what
    // discarded the real denial reason before (archive#3117's original complaint)
    // — it forwards exactly what the adapter decided, and nothing else
    // (never `event.output`, which may still hold the raw framework error
    // object with a remote-controlled `.message`).
    const policyDenied = event.policyDenied === true;
    publish({
      ...base,
      itemId: toolCallId,
      method: 'tool.completed',
      toolCallId,
      toolName: safeToolName(event),
      status: error ? 'error' : 'success',
      ...(error
        ? { error, ...(policyDenied ? { policyDenied: true } : {}) }
        : {
            output:
              safeToolName(event) === 'declare_output'
                ? stripOutputDeclarationHandle(event.output)
                : event.output,
          }),
    });
    // Symmetric with the open report above: settle the id the start was
    // tracked under — the engine's own, or the one this relay minted for it.
    // A result that paired with nothing settles nothing, because nothing was
    // ever opened under the id it just published.
    if (reportedCallId !== undefined || pairedCallId !== undefined) {
      return { toolSettled: { toolCallId } };
    }
    return { unpairedToolResult: true };
  }
  if (event.type === 'tool-approval-request') {
    const requestId = stringField(event.approvalId);
    if (!requestId) return {};
    const toolName = stringField(event.toolName);
    publish({
      ...base,
      method: 'request.opened',
      requestId,
      requestType: 'approval',
      title: stringField(event.tool) ?? toolName ?? 'Allow tool call',
      ...(stringField(event.toolDescription)
        ? { description: stringField(event.toolDescription) }
        : {}),
      payload: {
        ...(toolName ? { toolName } : {}),
        ...(stringField(event.server)
          ? { server: stringField(event.server) }
          : {}),
        ...(stringField(event.tool) ? { tool: stringField(event.tool) } : {}),
        ...(event.toolArgs !== undefined ? { toolArgs: event.toolArgs } : {}),
      },
    });
    return { approvalOpened: { requestId, ...(toolName ? { toolName } : {}) } };
  }
  if (event.type === 'context-injection') {
    const contextInjection = parseTurnProvenanceContextInjection(
      event.contextInjection,
    );
    return contextInjection ? { contextInjection } : {};
  }
  if (event.type === 'finish') {
    return { finishReason: finishReason(event.finishReason) };
  }
  if (event.type === 'error') {
    publish({
      ...base,
      method: 'runtime.error',
      severity: 'error',
      message: 'Station agent turn failed',
      code: 'station_agent_turn_failed',
      retriable: true,
    });
    return { failed: true };
  }
  return {};
}

export class StationAgentAdapter implements ProviderAdapterShape {
  readonly provider = PROVIDER;
  readonly metadata = {
    displayName: 'Station',
    description:
      'Station-owned agents with their configured model, skills, tools, and memory.',
    // archive#1885: `image-input` is declared because the relay below
    // forwards `input.attachments` to `/chat` as the same multipart input
    // shape the direct path used pre-#1418 (`buildConversationTurnInput`),
    // and `/chat` → `agent.streamText` consumes it. Declaring a capability
    // the relay does not carry would turn an honest refusal into a silent
    // drop — see `sendTurn`'s `buildRelayInput` for the forwarding both
    // directions. `file-input` is deliberately NOT declared: the UI derives
    // the file affordance from provider capability only
    // (`fileAttachmentsSupported`, useChatDockViewModel.ts), so files are
    // already honestly withheld for Station agents, and the engine's file
    // support is model-dependent rather than uniform.
    capabilities: [
      'agent-runtime',
      'image-input',
      'session-lifecycle',
      'tool-calls',
      'approvals',
      'interrupt',
      'resume',
    ],
    continuity: { resume: 'same-session', fork: 'replay-seed', rewind: 'none' },
    builtin: true,
    engineId: engineId('station'),
    modelLaunch: {
      defaultAtStart: 'engine-selected',
      omissionAtResume: 'retain-session-model',
      omissionPerTurn: 'retain-session-model',
      overrideAtStart: true,
      overrideAtResume: true,
      overridePerTurn: true,
    },
  } as const;

  private readonly events = new AsyncEventQueue<CanonicalRuntimeEvent>();
  private readonly sessions = new Map<string, StationAgentSessionRecord>();
  private readonly resolutionOverrides = new Map<string, ApprovalStatus>();

  constructor(private readonly options: StationAgentAdapterOptions) {
    options.eventBus.subscribe((event) => this.handleApprovalEvent(event));
  }

  async startSession(
    input: ProviderSessionStartInput,
  ): Promise<ProviderSession> {
    const recovered = parseResumeCursor(input.resumeCursor);
    const agentId = stringField(input.metadata?.agentId) ?? recovered?.agentId;
    if (
      !agentId ||
      (this.agentRegistryReady() && !(await this.options.hasAgent(agentId)))
    ) {
      throw new Error(`Unknown Station agent: ${agentId ?? '(none provided)'}`);
    }
    const now = this.now().toISOString();
    const projectSlug =
      stringField(input.metadata?.projectSlug) ?? recovered?.projectSlug;
    const userId = stringField(input.metadata?.userId) ?? recovered?.userId;
    const delegation =
      delegationField(input.metadata?.delegation) ?? recovered?.delegation;
    // A resume cursor is persisted data, but a caller can also present one
    // while starting a session. Authority therefore comes only from the
    // server-owned start input; recovery rehydrates that input from the
    // server session state before it reaches this adapter.
    const tenantExecutionContext = input.tenantExecutionContext;
    const resumeCursor: StationAgentResumeCursor = {
      agentId,
      ...(projectSlug ? { projectSlug } : {}),
      ...(userId ? { userId } : {}),
      ...(delegation ? { delegation } : {}),
    };
    const session: ProviderSession = {
      provider: this.provider,
      threadId: input.threadId,
      status: 'ready',
      ...(input.modelId ? { model: input.modelId } : {}),
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
      resumeCursor,
      createdAt: now,
      updatedAt: now,
    };
    this.sessions.set(input.threadId, {
      session,
      agentId,
      ...(projectSlug ? { projectSlug } : {}),
      ...(userId ? { userId } : {}),
      ...(delegation ? { delegation } : {}),
      ...(tenantExecutionContext ? { tenantExecutionContext } : {}),
      pendingRequests: new Map(),
      approvedTools: new Set(),
      resolvedBeforeOpen: new Map(),
      openToolCalls: new Map(),
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.started',
      sessionId: input.threadId,
      initialState: 'created',
      metadata: { ...input.metadata, agentId, cwd: input.cwd },
    });
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      createdAt: now,
      method: 'session.configured',
      sessionId: input.threadId,
      model: input.modelId,
      cwd: input.cwd,
      // `modelOptions` is public input. It may be reflected for the
      // Station-agent bridge, but must never mint or replace orchestration
      // evidence; server metadata and the resolved agent id win last.
      metadata: {
        ...stripReservedOrchestrationMetadata(input.modelOptions),
        ...input.metadata,
        agentId,
      },
    });
    return session;
  }

  async sendTurn(
    input: ProviderSendTurnInput,
  ): Promise<ProviderTurnStartResult> {
    const record = this.requireSession(input.threadId);
    if (!(await this.options.hasAgent(record.agentId))) {
      throw new Error(`Unknown Station agent: ${record.agentId}`);
    }
    if (record.activeController && !record.activeController.signal.aborted) {
      throw new Error(
        `Station agent task is already running: ${input.threadId}`,
      );
    }
    // A start/resume override is accepted into the adapter-owned session.
    // Later turns may omit the selector, in which case the accepted session
    // model remains the effective model and must still reach `/chat`.
    const requestedModelId =
      typeof input.modelId === 'string' && input.modelId.trim() !== ''
        ? input.modelId
        : undefined;
    const modelId = requestedModelId ?? record.session.model;
    // An authorized orchestration send may carry a server-minted turn id
    // through its request-scoped correlation. Reusing it here makes the
    // Station-agent's canonical event id and the fleet observer coordinate
    // identical. Direct /chat and ownerless/internal paths have no scope and
    // retain the adapter's ordinary random id.
    const turnCorrelation = currentAuthorizedTurnCorrelation();
    const nativeOutputRelay = currentNativeOutputRelayCompanion();
    const turnId = turnCorrelation?.turnId ?? crypto.randomUUID();
    const controller = new AbortController();
    record.activeTurnId = turnId;
    record.activeController = controller;
    record.abortPublished = false;
    // archive#796: a Station agent's session is started without a model — the UI
    // resolves one only when a turn is sent — so the model settles here.
    // `session.configured` is the only event that carries a model into the
    // read model and the persisted session row; without republishing it, the
    // settled model lives in adapter memory alone: right while the session is
    // loaded, gone the moment it is rehydrated, which is what leaves resumed
    // sessions labelled 'Model not reported'.
    //
    // archive#1182 survey finding, archive#1455 fix: this adapter
    // deliberately does not gain a `reportedModel` here (see the
    // `effectiveModelMetadata` call a few lines down for the requested/
    // effective side, which archive#1455 DOES populate). Station agents run
    // on Station's OWN engine (VoltAgent/Strands) — Station resolves the
    // model (`modelId`) AND executes the turn end-to-end via the
    // `/chat` relay below, so "requested" and "what ran" are the same fact
    // by construction, not two independently-observed values. There is no
    // external runtime whose own identity claim could disagree with
    // Station's — surfacing a `reportedModel` here would just restate
    // effective `modelId` under a name implying independent confirmation, the
    // exact anti-pattern this ticket fixes. (The `/chat` relay's own
    // downstream Model connection — Bedrock/Ollama/etc — has its own
    // reported-model story; see those adapters' survey notes. Plumbing that
    // signal back through `/chat`'s HTTP response into this adapter is a
    // deeper cross-cutting change, out of scope here.)
    this.publishSettledModel(record, modelId);
    this.updateSession(record, 'running', modelId);
    this.publishState(record, 'idle', 'running');
    // archive#1455: the requested/effective side of the model identity this
    // adapter otherwise never stamps — see the reportedModel refusal note
    // just above (archive#1182 survey finding) for why only this half is
    // populated. Computed once and reused on the terminal event below so
    // both carry the SAME requested snapshot for this turn, even if a
    // concurrent turn on this session were to change the model before
    // the stream settles.
    const modelMetadata = effectiveModelMetadata(modelId, input.modelOptions);
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: input.threadId,
      turnId,
      createdAt: this.now().toISOString(),
      method: 'turn.started',
      // Transcript-facing: the typed text, never the composed model input.
      prompt: input.displayInput ?? input.input,
      metadata: modelMetadata,
    });

    let response: Response;
    let rejectionReason: string | undefined;
    tenantExecutionContextOutcomes.add(
      1,
      tenantExecutionContextAttributes(
        record.tenantExecutionContext
          ? {
              operation: 'relay',
              source: 'session',
              outcome: 'accepted',
              reason: 'none',
            }
          : {
              operation: 'relay',
              source: 'none',
              outcome: 'skipped',
              reason: 'personal_mode',
            },
      ),
    );
    try {
      response = await (this.options.fetch ?? fetch)(
        `${this.options.apiBase}/api/agents/${encodeURIComponent(record.agentId)}/chat`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [INTERNAL_API_TOKEN_HEADER]: getInternalApiToken(),
            [INTERNAL_PROXY_CALLER_HEADER]: 'local',
            ...(turnCorrelation
              ? {
                  [INTERNAL_TURN_CORRELATION_HEADER]:
                    issueAuthorizedTurnCorrelationHandoff(
                      turnCorrelation,
                      nativeOutputRelay,
                    ),
                }
              : {}),
            ...(record.tenantExecutionContext
              ? {
                  [INTERNAL_TENANT_HEADER]:
                    record.tenantExecutionContext.tenantId,
                }
              : {}),
          },
          body: JSON.stringify({
            // Relay contract (archive#685): forward the TYPED text plus the raw
            // ambient context so /chat's own choke point composes exactly
            // once and its persistence surfaces (conversation title, temp
            // agent messages) keep typed content only. archive#1885: when
            // the turn carries attachments, `buildRelayInput` composes the
            // multipart `input` shape `/chat` consumes so the attachment is
            // forwarded (not silently dropped after the gate passed).
            input: buildRelayInput(
              input.displayInput ?? input.input,
              input.attachments,
            ),
            ...(input.ambientContext
              ? { ambientContext: input.ambientContext }
              : {}),
            options: {
              conversationId: input.threadId,
              ...(record.userId ? { userId: record.userId } : {}),
              ...(record.delegation ? { delegation: record.delegation } : {}),
              ...(modelId ? { model: modelId } : {}),
              // archive#1288: `/chat`'s model-override guard
              // (chat-model-override.ts) 400s any request that carries a
              // bare `options.model` without a resolved provider connection
              // — `chat-request-preparation.ts` only resolves one when
              // `providerManagedFallback` is set. This relay is the ONLY
              // caller of `/chat` that can reach here with `input.modelId`
              // set but no provider connection of its own to hand over (the
              // station-agent adapter has no `providerId` in hand — see
              // `ProviderSendTurnInput`/`ProviderSessionStartInput`, neither
              // carries one), so every flipped managed-chat turn and every
              // `delegateTask` call with an explicit model 400ed. Setting
              // the fallback flag (plus `providerModel` so
              // `resolveProvider`'s `conversationModel` sees the same value
              // `model` already carries) lets `resolveProvider` apply this
              // model against its own resolved default connection
              // (`ProviderService.resolveDefaultProviderId`'s
              // `modelOnlyFallback` branch) instead of rejecting a lone
              // model as a partial override. This is NOT the same shape as
              // the direct managed-chat send path
              // (`useActiveChatSessionMessaging.ts`): that path always
              // pairs an explicit `providerId` with `providerModel` (it has
              // a resolved connection to hand over); this relay never does,
              // by construction, because it has none.
              ...(modelId
                ? {
                    providerManagedFallback: true,
                    providerModel: modelId,
                  }
                : {}),
              // archive#1224 (offline): forward the caller's
              // idempotency key so `/chat`'s own dedup (`chat-turn-dedup.ts`)
              // also recognizes a replayed turn on this relay path — defense
              // in depth alongside the orchestration-service-level dedup
              // that already prevents this adapter's `sendTurn` from being
              // called twice for the same `clientTurnId`.
              ...(input.clientTurnId
                ? { clientTurnId: input.clientTurnId }
                : {}),
            },
            ...(record.projectSlug ? { projectSlug: record.projectSlug } : {}),
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok || !response.body) {
        // archive#1071: /chat rejections carry the actionable reason in their JSON
        // error body — surface it instead of only the generic string. The
        // read is bounded and abort-aware (this branch's hardening of
        // main's edabd771): an unbounded response.json() here would let a
        // degenerate body hang the turn-failure path or buffer without
        // limit, and the republished reason is normalized before it becomes
        // durable event history.
        rejectionReason = await readChatRejectionReason(response, {
          signal: controller.signal,
        });
        throw new Error(turnRejectionMessage(rejectionReason));
      }
    } catch (error) {
      this.failTurn(record, turnId, controller, rejectionReason);
      throw error;
    }

    void this.consumeChatStream(
      record,
      turnId,
      controller,
      response,
      modelMetadata,
    ).catch((error) => {
      this.failTurn(
        record,
        turnId,
        controller,
        error instanceof StationAgentStreamStallError
          ? error.message
          : undefined,
      );
    });
    return {
      threadId: input.threadId,
      turnId,
      resumeCursor: record.session.resumeCursor,
    };
  }

  async interruptTurn(threadId: string, turnId?: string) {
    const record = this.requireSession(threadId);
    const activeTurnId = record.activeTurnId;
    const activeController = record.activeController;
    if (!activeTurnId || !activeController) {
      return { outcome: 'no-active-turn' } as const;
    }
    if (turnId && turnId !== activeTurnId) {
      return { outcome: 'target-mismatch', activeTurnId } as const;
    }
    this.cancelPendingApprovals(record);
    activeController.abort('interrupted');
    if (!record.abortPublished) {
      record.abortPublished = true;
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId,
        turnId: activeTurnId,
        createdAt: this.now().toISOString(),
        method: 'turn.aborted',
        reason: 'interrupted',
      });
    }
    this.updateSession(record, 'ready');
    this.publishState(record, 'running', 'idle');
    return { outcome: 'cancelled', turnId: activeTurnId } as const;
  }

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  ): Promise<void> {
    const record = this.requireSession(threadId);
    const pending = record.pendingRequests.get(requestId);
    if (!pending) {
      throw new Error(`Unknown Station agent approval request: ${requestId}`);
    }
    if (decision === 'acceptForSession' && pending.toolName) {
      record.approvedTools.add(pending.toolName);
    }
    this.resolutionOverrides.set(
      requestId,
      decision === 'accept' || decision === 'acceptForSession'
        ? 'approved'
        : decision === 'decline'
          ? 'denied'
          : 'cancelled',
    );
    const resolved = this.options.approvalRegistry.resolve(
      requestId,
      decision === 'accept' || decision === 'acceptForSession',
    );
    if (!resolved) {
      record.pendingRequests.delete(requestId);
      this.resolutionOverrides.delete(requestId);
      throw new Error(`Stale Station agent approval request: ${requestId}`);
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const record = this.sessions.get(threadId);
    if (!record) return;
    this.cancelPendingApprovals(record);
    record.activeController?.abort('session stopped');
    this.sessions.delete(threadId);
    // station#1569 (item 4): the abort above tears down the SSE stream
    // without publishing anything for the calls it was mid-way through —
    // `consumeChatStream`'s aborted branch returns silently by design. So
    // every call still open here can never report, and this is the last
    // moment anyone can say so. Before `session.exited`, which closes a
    // still-running card client-side (`background-tasks-store.ts`), taking
    // the honest terminal with it.
    this.settleUnresolvedToolCalls(record);
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId,
      createdAt: this.now().toISOString(),
      method: 'session.exited',
      sessionId: threadId,
      reason: 'stopped',
    });
  }

  /**
   * Publishes `tool.completed` status `'unresolved'` for every call still
   * open on this record, each on the turn that ISSUED it — the terminal the
   * Claude adapter publishes for the same moment
   * (`settleUnresolvedClaudeToolCalls`).
   *
   * Session end only. A turn ending is not enough: nothing here proves the
   * engine will never report, and a call outliving its turn is a shape other
   * adapters legitimately produce.
   */
  private settleUnresolvedToolCalls(record: StationAgentSessionRecord): void {
    if (record.openToolCalls.size === 0) return;
    const createdAt = this.now().toISOString();
    const entries = [...record.openToolCalls];
    record.openToolCalls.clear();
    for (const [toolCallId, { toolName, turnId }] of entries) {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.session.threadId,
        createdAt,
        turnId,
        itemId: toolCallId,
        method: 'tool.completed',
        toolCallId,
        toolName,
        status: 'unresolved',
        output: UNRESOLVED_TOOL_OUTPUT,
      });
    }
  }

  async listSessions(): Promise<ProviderSession[]> {
    return [...this.sessions.values()].map((record) => record.session);
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  async stopAll(): Promise<void> {
    try {
      await Promise.all(
        [...this.sessions.keys()].map((threadId) => this.stopSession(threadId)),
      );
    } finally {
      this.events.close();
    }
  }

  streamEvents(options?: {
    signal?: AbortSignal;
  }): AsyncIterable<CanonicalRuntimeEvent> {
    return this.events.iterable(options);
  }

  async getPrerequisites(): Promise<Prerequisite[]> {
    return [];
  }

  private async consumeChatStream(
    record: StationAgentSessionRecord,
    turnId: string,
    controller: AbortController,
    response: Response,
    modelMetadata: ReturnType<typeof effectiveModelMetadata>,
  ): Promise<void> {
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let outputText = '';
    let resolvedFinishReason: ReturnType<typeof finishReason> = 'stop';
    let failed = false;
    // archive#2649: /chat emits at most one context-injection frame per
    // turn; a later frame (should the route ever re-emit) supersedes.
    let contextInjection: TurnProvenanceContextInjection | undefined;
    // station#1586 (item 2): ids this relay minted for id-less `tool-call`
    // chunks, oldest first, so the id-less `tool-result` that follows settles
    // the row the start opened instead of publishing a second one. Scoped to
    // this stream — an id-less result can only belong to a call from the turn
    // it is streaming in, and a leftover entry is simply a call that never
    // reported, which `openToolCalls` already carries to the session-end
    // settle under the same id.
    const pendingIdlessToolCallIds: string[] = [];
    try {
      while (true) {
        const { done, value } = await readWithStallWatchdog(
          reader,
          STATION_AGENT_STREAM_STALL_TIMEOUT_MS,
          (ms) => new StationAgentStreamStallError(ms),
        );
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const encoded = line.slice(6);
          if (encoded === '[DONE]') continue;
          let event: Record<string, unknown>;
          try {
            event = JSON.parse(encoded) as Record<string, unknown>;
          } catch {
            continue;
          }
          const mapped = mapStationAgentStreamEvent({
            event,
            threadId: record.session.threadId,
            turnId,
            publish: (next) => this.publish(next),
            now: this.options.now,
            pendingIdlessToolCallIds,
          });
          if (mapped.approvalOpened) {
            this.trackApproval(record, turnId, mapped.approvalOpened);
          }
          // station#1569 (item 4): what the session-end settle reads. Kept
          // here rather than inside the relay so that function stays pure.
          if (mapped.toolOpened) {
            record.openToolCalls.set(mapped.toolOpened.toolCallId, {
              toolName: mapped.toolOpened.toolName,
              turnId,
            });
          }
          if (mapped.toolSettled) {
            record.openToolCalls.delete(mapped.toolSettled.toolCallId);
          }
          // `mapped.unpairedToolResult` is deliberately not tracked here:
          // nothing was ever opened under the id that result published, so
          // there is no entry to add or delete. It is reported by the relay
          // so the shape stays distinguishable to its callers and tests.
          outputText += mapped.outputDelta ?? '';
          resolvedFinishReason = mapped.finishReason ?? resolvedFinishReason;
          failed ||= mapped.failed === true;
          contextInjection = mapped.contextInjection ?? contextInjection;
        }
      }
    } catch (error) {
      if (error instanceof StationAgentStreamStallError) {
        // Best-effort: stop consuming a stream that has already gone
        // silent. Never let cleanup mask the real stall error below.
        try {
          await reader.cancel();
        } catch {}
      }
      if (!controller.signal.aborted) throw error;
    } finally {
      try {
        reader.releaseLock();
      } catch {}
    }

    if (controller.signal.aborted) {
      if (
        record.activeTurnId === turnId &&
        record.activeController === controller
      ) {
        record.activeTurnId = undefined;
        record.activeController = undefined;
      }
      return;
    }
    if (
      record.activeTurnId !== turnId ||
      record.activeController !== controller
    ) {
      return;
    }
    if (!failed) {
      this.publish({
        eventId: crypto.randomUUID(),
        provider: this.provider,
        threadId: record.session.threadId,
        turnId,
        createdAt: this.now().toISOString(),
        method: 'turn.completed',
        finishReason: resolvedFinishReason,
        ...(outputText ? { outputText } : {}),
        // archive#1455: same requested-model snapshot stamped on
        // turn.started — the turn-provenance fold's terminal event wins
        // over turn.started when both carry a value (archive#1182), so
        // repeating it here (rather than leaving turn.completed silent)
        // keeps the observed slot in place even if a future edit stops
        // reading turn.started for this provider.
        // archive#2649: plus /chat's own context-injection receipt, when
        // the inner stream carried one — the metadata channel the
        // turn-provenance fold reads `contextInjection` from. Only what the
        // frame actually said is stamped; no frame, no claim.
        metadata: {
          ...modelMetadata,
          ...(contextInjection
            ? { [CONTEXT_INJECTION_METADATA_KEY]: contextInjection }
            : {}),
        },
      });
      this.updateSession(record, 'ready');
      this.publishState(record, 'running', 'idle');
    } else {
      this.updateSession(record, 'error');
      this.publishState(record, 'running', 'errored');
    }
    record.activeTurnId = undefined;
    record.activeController = undefined;
  }

  private failTurn(
    record: StationAgentSessionRecord,
    turnId: string,
    controller = record.activeController,
    reason?: string,
  ): void {
    if (
      controller?.signal.aborted ||
      record.activeTurnId !== turnId ||
      record.activeController !== controller
    ) {
      return;
    }
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.session.threadId,
      turnId,
      createdAt: this.now().toISOString(),
      method: 'runtime.error',
      severity: 'error',
      message: turnRejectionMessage(reason),
      code: 'station_agent_turn_unavailable',
      retriable: true,
    });
    this.updateSession(record, 'error');
    this.publishState(record, 'running', 'errored');
    record.activeTurnId = undefined;
    record.activeController = undefined;
  }

  /**
   * Announces a model that a turn settled (or changed), so the read model and
   * the persisted session row learn it — see the archive#796 note at the call site.
   * No-ops when the turn carries no model or repeats the one already recorded.
   */
  private publishSettledModel(
    record: StationAgentSessionRecord,
    model: string | undefined,
  ): void {
    if (!model || model === record.session.model) {
      return;
    }
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.session.threadId,
      createdAt: this.now().toISOString(),
      method: 'session.configured',
      sessionId: record.session.threadId,
      model,
      ...(record.session.cwd ? { cwd: record.session.cwd } : {}),
      metadata: { agentId: record.agentId },
    });
  }

  private updateSession(
    record: StationAgentSessionRecord,
    status: ProviderSession['status'],
    model?: string,
  ): void {
    record.session = {
      ...record.session,
      status,
      updatedAt: this.now().toISOString(),
      ...(model ? { model } : {}),
    };
  }

  private publishState(
    record: StationAgentSessionRecord,
    from: 'idle' | 'running',
    to: 'idle' | 'running' | 'errored',
  ): void {
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.session.threadId,
      createdAt: this.now().toISOString(),
      method: 'session.state-changed',
      sessionId: record.session.threadId,
      from,
      to,
    });
  }

  private publish(event: CanonicalRuntimeEvent): void {
    this.events.push(event);
  }

  private trackApproval(
    record: StationAgentSessionRecord,
    turnId: string,
    approval: { requestId: string; toolName?: string },
  ): void {
    const resolvedStatus = record.resolvedBeforeOpen.get(approval.requestId);
    if (resolvedStatus) {
      record.resolvedBeforeOpen.delete(approval.requestId);
      this.publishResolvedApproval(
        record,
        approval.requestId,
        resolvedStatus,
        turnId,
      );
      return;
    }
    record.pendingRequests.set(approval.requestId, {
      turnId,
      ...(approval.toolName ? { toolName: approval.toolName } : {}),
    });
    if (
      approval.toolName &&
      record.approvedTools.has(approval.toolName) &&
      this.options.approvalRegistry.has(approval.requestId)
    ) {
      this.resolutionOverrides.set(approval.requestId, 'approved');
      this.options.approvalRegistry.resolve(approval.requestId, true);
    }
  }

  private handleApprovalEvent(event: ServerEvent): void {
    if (event.event !== SERVER_EVENTS.APPROVAL_RESOLVED) return;
    const requestId = stringField(event.data?.approvalId);
    const status = approvalStatus(event.data?.status);
    if (!requestId || !status) return;
    const effectiveStatus = this.resolutionOverrides.get(requestId) ?? status;
    this.resolutionOverrides.delete(requestId);
    for (const record of this.sessions.values()) {
      const pending = record.pendingRequests.get(requestId);
      if (!pending) continue;
      record.pendingRequests.delete(requestId);
      this.publishResolvedApproval(
        record,
        requestId,
        effectiveStatus,
        pending.turnId,
      );
      return;
    }
    const conversationId = stringField(event.data?.conversationId);
    const record = conversationId
      ? this.sessions.get(conversationId)
      : undefined;
    if (record) {
      this.rememberResolvedApproval(record, requestId, effectiveStatus);
    }
  }

  private publishResolvedApproval(
    record: StationAgentSessionRecord,
    requestId: string,
    status: ApprovalStatus,
    turnId?: string,
  ): void {
    this.publish({
      eventId: crypto.randomUUID(),
      provider: this.provider,
      threadId: record.session.threadId,
      ...(turnId ? { turnId } : {}),
      createdAt: this.now().toISOString(),
      method: 'request.resolved',
      requestId,
      status,
    });
  }

  private rememberResolvedApproval(
    record: StationAgentSessionRecord,
    requestId: string,
    status: ApprovalStatus,
  ): void {
    record.resolvedBeforeOpen.set(requestId, status);
    if (record.resolvedBeforeOpen.size <= 16) return;
    const oldest = record.resolvedBeforeOpen.keys().next().value;
    if (oldest) record.resolvedBeforeOpen.delete(oldest);
  }

  private cancelPendingApprovals(record: StationAgentSessionRecord): void {
    for (const requestId of [...record.pendingRequests.keys()]) {
      this.resolutionOverrides.set(requestId, 'cancelled');
      if (!this.options.approvalRegistry.resolve(requestId, false)) {
        record.pendingRequests.delete(requestId);
        this.resolutionOverrides.delete(requestId);
      }
    }
  }

  private requireSession(threadId: string): StationAgentSessionRecord {
    const record = this.sessions.get(threadId);
    if (!record) throw new Error(`Unknown Station agent task: ${threadId}`);
    return record;
  }

  private now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  private agentRegistryReady(): boolean {
    return this.options.isAgentRegistryReady?.() ?? true;
  }
}

function approvalStatus(value: unknown): ApprovalStatus | undefined {
  return value === 'approved' ||
    value === 'denied' ||
    value === 'cancelled' ||
    value === 'expired'
    ? value
    : undefined;
}
