/**
 * ACP adapter mapper — pure translation from ACP native shapes
 * (SessionUpdate / extension notifications / permission decisions) into
 * CanonicalRuntimeEvent, mirroring claude-adapter-events.ts.
 *
 * Vocabulary source (read-only reference, NOT imported/modified):
 * acp-bridge-events.ts — same `update.sessionUpdate`/extension-method switch
 * shape, re-expressed here for canonical events instead of chat-SSE
 * activeWriter chunks.
 *
 * Wave 2 Track B: implements the full `mapAcpSessionUpdate`/
 * `mapAcpExtensionNotification` switches (Lifecycle Mapping Table rows 6-12)
 * and the pure `mapAcpStopReasonToFinishReason`/`mapAcpDecisionToOutcome`
 * helpers. Zero dependency on `ACPProcess`/spawn.
 */
import crypto from 'node:crypto';
import type {
  ContentBlock,
  PermissionOption,
  PermissionOptionKind,
  RequestPermissionOutcome,
  SessionUpdate,
  StopReason,
} from '@agentclientprotocol/sdk';
import type {
  ApprovalStatus,
  TurnCompletedEvent,
} from '@kontourai/station-contracts/runtime-events';
import { isValidContextObservation } from '@kontourai/station-shared/usage-fold';
import { extensionNotificationBinding } from '../../../src-shared/extension-notification-bindings.js';
import type {
  CanonicalRuntimeEvent,
  ProviderSession,
} from '../adapter-shape.js';
import type { AcpToolUpdateSupervisor } from './acp-tool-update-supervisor.js';

/**
 * Last-known adapter session state a mapper switch case can mutate directly
 * (Lifecycle Mapping Table row 11: `current_mode_update` /
 * `config_option_update` / `available_commands_update` carry no canonical
 * event — they update adapter-owned session state only, matching the
 * `acp-bridge-events.ts` precedent). Structurally compatible with
 * `AcpSessionRecord` (acp-adapter.ts) by design — Track A can pass the live
 * record itself as `ctx.state` with no cross-file type import required.
 * Optional on `AcpMapperContext` so existing/partial context construction
 * keeps typechecking; when omitted, the corresponding switch cases are
 * no-ops.
 */
export interface AcpMapperState {
  currentModeId?: string;
  configOptions?: unknown[];
  slashCommands?: Array<{
    name: string;
    description: string;
    argumentHint?: string;
  }>;
  /**
   * Extension notifications retained during the in-flight turn window that
   * are bound (via `extensionNotificationBinding` — see
   * `src-shared/extension-notification-bindings.ts`) to the
   * `acp.turn-error-cause` consumer (station#4084, review fix round F1:
   * an EXACT-TUPLE allowlist through the existing registry, not a
   * structural type-prefix guess — "namespace similarity is never
   * authority" is that registry's own rule). Appended by
   * `mapAcpExtensionNotification`; owned — initialized and cleared per turn
   * — by the adapter (`acp-adapter.ts`'s `sendTurn`), which is the only code
   * that knows when a turn starts and settles. A turn's `catch` handler
   * reads the last entry, if any, to enrich an otherwise-generic
   * operator-facing error (e.g. bare JSON-RPC `-32603` "Internal error")
   * with the message the engine sent, over a separate notification, in that
   * same window — capped at `MAX_RETAINED_TURN_ERROR_NOTIFICATIONS` (F4b) so
   * a turn that never settles cannot grow this array unboundedly.
   */
  turnErrorNotifications?: AcpExtensionErrorNotification[];
  /**
   * TurnIds whose `prompt()` was cancelled (`interruptTurn`) but has not yet
   * settled — station#4084 review fix round F2, LEAK-CLEANUP mechanics only
   * (review fix round M1 moved the actual suppression DECISION to
   * `turnErrorNotificationsSuppressed` below — see that field's doc for why).
   * Extension notifications carry no turn id, so a late notification from a
   * cancelled operation is indistinguishable, on the wire, from one
   * belonging to whatever turn is active by the time it arrives. Added by
   * `interruptTurn` before awaiting `process.cancel()`; removed by the
   * cancelled turn's own `.then`/`.catch` handler in `sendTurn` once that
   * specific `prompt()` promise actually settles, purely so this set does
   * not grow forever — that deletion must NOT reopen retention for any turn
   * already snapshotted as suppressed.
   */
  quarantinedTurnIds?: Set<string>;
  /**
   * Whether THIS turn's entire error-cause retention window is suppressed —
   * station#4084 review fix round M1. `quarantinedTurnIds` is a LIVE set:
   * consulting it per-notification reopens a window mid-turn, because the
   * cancelled turn's own settlement handler correctly deletes its id from
   * that set (to avoid a permanent leak) partway through the REPLACEMENT
   * turn's own window — a notification delivered after that deletion would
   * then read as unquarantined even though its provenance is exactly as
   * ambiguous as one delivered before it. Fix: `sendTurn` snapshots
   * `(quarantinedTurnIds?.size ?? 0) > 0` ONCE, at turn start, into this
   * field, and `mapAcpExtensionNotification` consults only this frozen
   * value for the whole turn — immune to any later mutation of the live
   * set. Fail-closed for exactly the turns where provenance is ambiguous at
   * the moment they start; never blocks the user from starting that turn.
   */
  turnErrorNotificationsSuppressed?: boolean;
}

/** One extension notification retained for turn-failure enrichment (station#4084). */
export interface AcpExtensionErrorNotification {
  /** The full extension method, e.g. `_kiro.dev/error/rate_limit`. */
  method: string;
  /** The notification's own human-readable `message` field, verbatim. */
  message: string;
}

/**
 * station#4084 review fix round F4b: cap on `turnErrorNotifications` —
 * `sendTurn`'s `.catch` only ever reads the LAST entry (`.at(-1)`), so a
 * pathological turn that receives many error-shaped notifications before
 * ever settling (or never settles at all) must not grow this array without
 * bound. Keeping the most recent few is enough to preserve "last wins"
 * while bounding memory.
 */
const MAX_RETAINED_TURN_ERROR_NOTIFICATIONS = 4;

/**
 * Extract a human-readable cause from an extension notification payload,
 * never throwing regardless of what actually arrived on the wire
 * (station#4084 review fix round F3: the JSON-RPC decoder does not validate
 * `params` against the `Record<string, unknown>` type this function is
 * declared to receive — a real notification can carry `null`, `undefined`,
 * a primitive, or an array where a well-shaped object was expected).
 * Fail-closed: anything that is not a plain object with a non-empty string
 * `message` field yields `undefined` rather than throwing or fabricating a
 * cause.
 */
function extractTurnErrorCauseMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return undefined;
  const message = (payload as Record<string, unknown>).message;
  if (typeof message !== 'string') return undefined;
  const trimmed = message.trim();
  return trimmed.length > 0 ? message : undefined;
}

export interface AcpMapperContext {
  provider: 'acp';
  session: ProviderSession;
  activeTurnId?: string;
  publish: (event: CanonicalRuntimeEvent) => void;
  state?: AcpMapperState;
  /** Required session-owned bounded authority for every ACP tool update. */
  toolUpdateSupervisor: AcpToolUpdateSupervisor;
}

/**
 * Render an ACP `ContentBlock` as plain text for the canonical
 * `content.text-delta`/`content.reasoning-delta` `delta: string` fields —
 * bridge parity with acp-bridge-events.ts's image/resource rendering
 * (44-73), expressed as text rather than a new canonical event/content
 * type (no contract change). `audio`/`resource_link` are not rendered by
 * the legacy bridge either — an accepted gap (see the plan's Risks).
 */
/**
 * station#1182: extract the ACP agent's own currently-selected model — a
 * genuinely engine-reported signal, not Station's request echoed back.
 * `acp-process.ts`'s `setConfigOption` doc comment ("Set a config option
 * (e.g., model) for the current session") confirms the ACP protocol's
 * `model`-category `SessionConfigOption` is how agents expose and accept a
 * model selection; a `select`-type option's `currentValue` is the agent's
 * own live answer to "what model is this session using." Only read from a
 * fresh `newSession` response (`acp-adapter.ts`) — `loadSession` (resume)
 * returns no config-option snapshot, so a resumed session honestly has no
 * signal here. Absent whenever the connected agent exposes no config
 * options at all (most ACP agents today) or none is categorized "model" —
 * that absence must not be treated as "no model," only as "not reported."
 */
export function extractReportedModelFromConfigOptions(
  configOptions: unknown,
): string | undefined {
  if (!Array.isArray(configOptions)) return undefined;
  for (const option of configOptions) {
    if (
      !option ||
      typeof option !== 'object' ||
      (option as { category?: unknown }).category !== 'model'
    ) {
      continue;
    }
    const currentValue = (option as { currentValue?: unknown }).currentValue;
    if (typeof currentValue === 'string' && currentValue.trim()) {
      return currentValue.trim();
    }
  }
  return undefined;
}

function renderAcpContentBlockAsText(
  content: ContentBlock,
): string | undefined {
  if (content.type === 'text') return content.text;
  if (content.type === 'image') {
    return `\n![image](${content.uri ?? `data:${content.mimeType};base64,${content.data}`})\n`;
  }
  if (content.type === 'resource') {
    const resource = content.resource;
    const text = 'text' in resource ? resource.text : undefined;
    return `\n\`\`\`\n${text ?? resource.uri ?? '[resource]'}\n\`\`\`\n`;
  }
  return undefined;
}

/**
 * Translate an ACP `session/update` notification into zero or more
 * CanonicalRuntimeEvent publishes via `ctx.publish` (Lifecycle Mapping Table
 * rows 6-11).
 */
export function mapAcpSessionUpdate(
  update: SessionUpdate,
  ctx: AcpMapperContext,
): void {
  const createdAt = new Date().toISOString();
  const threadId = ctx.session.threadId;

  switch (update.sessionUpdate) {
    case 'agent_message_chunk': {
      const delta = renderAcpContentBlockAsText(update.content);
      if (delta === undefined) return;
      ctx.publish({
        eventId: crypto.randomUUID(),
        provider: 'acp',
        threadId,
        createdAt,
        turnId: ctx.activeTurnId,
        itemId: update.messageId ?? ctx.activeTurnId ?? threadId,
        method: 'content.text-delta',
        delta,
      });
      return;
    }

    case 'agent_thought_chunk': {
      const delta = renderAcpContentBlockAsText(update.content);
      if (delta === undefined) return;
      ctx.publish({
        eventId: crypto.randomUUID(),
        provider: 'acp',
        threadId,
        createdAt,
        turnId: ctx.activeTurnId,
        itemId: update.messageId ?? ctx.activeTurnId ?? threadId,
        method: 'content.reasoning-delta',
        delta,
      });
      return;
    }

    case 'tool_call': {
      ctx.toolUpdateSupervisor.acceptStarted({
        toolCallId: update.toolCallId,
        title: update.title,
        name: update.name,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        hasTitle: Object.hasOwn(update, 'title'),
        hasName: Object.hasOwn(update, 'name'),
        hasRawInput: Object.hasOwn(update, 'rawInput'),
        hasRawOutput: Object.hasOwn(update, 'rawOutput'),
      });
      return;
    }

    case 'tool_call_update': {
      ctx.toolUpdateSupervisor.acceptUpdate({
        toolCallId: update.toolCallId,
        title: update.title,
        name: update.name,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        content: update.content,
        status: update.status,
        hasTitle: Object.hasOwn(update, 'title'),
        hasName: Object.hasOwn(update, 'name'),
        hasRawInput: Object.hasOwn(update, 'rawInput'),
        hasRawOutput: Object.hasOwn(update, 'rawOutput'),
        hasContent: Object.hasOwn(update, 'content'),
        hasStatus: Object.hasOwn(update, 'status'),
      });
      return;
    }

    case 'plan': {
      ctx.publish({
        eventId: crypto.randomUUID(),
        provider: 'acp',
        threadId,
        createdAt,
        turnId: ctx.activeTurnId,
        method: 'plan.updated',
        entries: update.entries.map((entry) => ({
          content: entry.content,
          status: entry.status,
        })),
      });
      return;
    }

    case 'available_commands_update': {
      if (!ctx.state) return;
      ctx.state.slashCommands = update.availableCommands.map((command) => ({
        name: command.name,
        description: command.description,
        argumentHint: command.input?.hint,
      }));
      return;
    }

    case 'current_mode_update': {
      if (!ctx.state) return;
      ctx.state.currentModeId = update.currentModeId;
      return;
    }

    case 'config_option_update': {
      if (!ctx.state) return;
      ctx.state.configOptions = update.configOptions;
      return;
    }

    case 'usage_update': {
      // ACP reports current context occupancy/window, not per-turn input or
      // output token accounting. Preserve only that exact pair; ACP cost is
      // deliberately excluded because arbitrary ISO currency has no pricing
      // policy in Station yet.
      if (!isValidContextObservation(update.used, update.size)) return;
      ctx.publish({
        eventId: crypto.randomUUID(),
        provider: 'acp',
        threadId,
        createdAt,
        turnId: ctx.activeTurnId,
        method: 'token-usage.updated',
        contextTokens: update.used,
        contextWindowTokens: update.size,
      });
      return;
    }

    // 'user_message_chunk' (echo of the outbound prompt), 'plan_update'/
    // 'plan_removed' (unstable/experimental incremental plan variants —
    // 'plan' above already carries the full-replace shape the canonical
    // PlanUpdatedEvent models), and 'session_info_update' are not part of
    // the Lifecycle Mapping Table's Track B scope.
    default:
      return;
  }
}

/**
 * Translate an ACP extension notification (e.g. `_kiro.dev/*`) into an
 * `extension.notification` CanonicalRuntimeEvent (Lifecycle Mapping Table
 * row 12). Every extension method — `_kiro.dev/commands/available`,
 * `_kiro.dev/mcp/server_initialized`, `_kiro.dev/mcp/oauth_request`,
 * `_kiro.dev/compaction/status`, `_kiro.dev/clear/status`,
 * `_kiro.dev/metadata`, and any other app-specific method — maps uniformly:
 * the canonical contract intentionally carries no app-specific semantics
 * (ADR-0008), only an opaque `namespace`/`type`/`payload` envelope.
 *
 * station#4084: as a side effect (not a canonical event), a notification
 * bound to the `acp.turn-error-cause` consumer (an exact, evidenced tuple —
 * see `src-shared/extension-notification-bindings.ts`) is also retained on
 * `ctx.state.turnErrorNotifications`, unless
 * `ctx.state.turnErrorNotificationsSuppressed` is `true` — a decision frozen
 * once at the current turn's start (review fix round M1: NOT re-derived
 * from the live `quarantinedTurnIds` set per notification, since that set's
 * entries are deleted as soon as their cancelled operation settles, which
 * must not reopen an already-suppressed turn's window) — so the adapter can
 * quote its `message` — as something the engine also reported during the
 * same turn window, not asserted as the failure's proven cause (F5) — if
 * the in-flight turn goes on to fail with an otherwise-generic error.
 */
export function mapAcpExtensionNotification(
  method: string,
  params: Record<string, unknown>,
  ctx: AcpMapperContext,
): void {
  const { namespace, type } = splitExtensionMethod(method);
  const binding = extensionNotificationBinding(namespace, type);
  const suppressed = ctx.state?.turnErrorNotificationsSuppressed === true;
  if (
    ctx.state &&
    !suppressed &&
    binding?.consumer === 'acp.turn-error-cause'
  ) {
    const message = extractTurnErrorCauseMessage(params);
    if (message) {
      const notifications = ctx.state.turnErrorNotifications ?? [];
      notifications.push({ method, message });
      // F4b: retain only the most recent N — see
      // MAX_RETAINED_TURN_ERROR_NOTIFICATIONS's doc comment.
      while (notifications.length > MAX_RETAINED_TURN_ERROR_NOTIFICATIONS) {
        notifications.shift();
      }
      ctx.state.turnErrorNotifications = notifications;
    }
  }
  if (binding?.consumer === 'acp.commands.available' && ctx.state) {
    const commands =
      (
        params as {
          commands?: Array<{
            name: string;
            description?: string;
            input?: { hint?: string };
          }>;
        }
      ).commands ?? [];
    ctx.state.slashCommands = commands.map((command) => ({
      name: command.name,
      description: command.description ?? '',
      argumentHint: command.input?.hint,
    }));
  }

  ctx.publish({
    eventId: crypto.randomUUID(),
    provider: 'acp',
    threadId: ctx.session.threadId,
    createdAt: new Date().toISOString(),
    turnId: ctx.activeTurnId,
    method: 'extension.notification',
    namespace,
    type,
    payload: params,
  });
}

function splitExtensionMethod(method: string): {
  namespace: string;
  type: string;
} {
  const slashIndex = method.indexOf('/');
  if (slashIndex === -1) {
    return { namespace: method, type: method };
  }
  return {
    namespace: method.slice(0, slashIndex),
    type: method.slice(slashIndex + 1),
  };
}

/**
 * Map an ACP `StopReason` to the canonical `turn.completed` finishReason
 * vocabulary (Lifecycle Mapping Table row 13).
 */
export function mapAcpStopReasonToFinishReason(
  reason: StopReason,
): TurnCompletedEvent['finishReason'] {
  switch (reason) {
    case 'end_turn':
      return 'stop';
    case 'max_tokens':
      return 'max-tokens';
    case 'cancelled':
      return 'cancelled';
    case 'max_turn_requests':
    case 'refusal':
      return 'other';
    default:
      return 'other';
  }
}

/**
 * Map an adapter-level permission decision plus the ACP `PermissionOption[]`
 * the agent offered into the ACP `RequestPermissionOutcome` the `Client`
 * must resolve its pending `requestPermission` promise with. Prefers the
 * option kind matching the decision's intent; falls back to the closest
 * available kind, then to `cancelled` if the agent offered none of that
 * polarity (defensive — a well-behaved ACP agent always offers at least one
 * allow and one reject option).
 */
export function mapAcpDecisionToOutcome(
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
  options: PermissionOption[],
): RequestPermissionOutcome {
  if (decision === 'cancel') {
    return { outcome: 'cancelled' };
  }

  const preferredKinds: PermissionOptionKind[] =
    decision === 'accept'
      ? ['allow_once', 'allow_always']
      : decision === 'acceptForSession'
        ? ['allow_always', 'allow_once']
        : ['reject_once', 'reject_always'];

  for (const kind of preferredKinds) {
    const match = options.find((option) => option.kind === kind);
    if (match) {
      return { outcome: 'selected', optionId: match.optionId };
    }
  }

  return { outcome: 'cancelled' };
}

/**
 * Map an adapter-level permission decision to the canonical
 * `request.resolved` ApprovalStatus vocabulary.
 */
export function mapAcpDecisionToApprovalStatus(
  decision: 'accept' | 'acceptForSession' | 'decline' | 'cancel',
): ApprovalStatus {
  if (decision === 'accept' || decision === 'acceptForSession') {
    return 'approved';
  }
  if (decision === 'decline') {
    return 'denied';
  }
  return 'cancelled';
}
